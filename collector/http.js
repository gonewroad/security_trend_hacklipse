// HTTP 요청을 한곳에서 담당한다.
// 조건부 요청(ETag·Last-Modified), 소스별 타임아웃, 리다이렉트 추적, 1회 재시도를
// 모두 이 모듈에서 처리한다. 수집 예절(조건부 요청, 명시적 User-Agent)의 구현 지점이다.

import fs from 'node:fs/promises';
import path from 'node:path';

// 기본 User-Agent로는 상당수 사이트가 차단한다. 반드시 명시한다.
export const USER_AGENT = 'SecurityWallboard/1.0';

const DEFAULT_TIMEOUT_MS = 10_000; // 소스별 타임아웃 10초
const MAX_REDIRECTS = 3;           // 리다이렉트는 최대 3홉까지 따라간다
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const HTTP_CACHE_PATH = path.join('cache', 'http.json');

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 동시 요청 수를 제한하는 최소 구현 세마포어. 라이브러리를 더하지 않기 위해 직접 만든다.
export function createLimiter(maxConcurrent) {
  let active = 0;
  const queue = [];

  const pump = () => {
    if (active >= maxConcurrent || queue.length === 0) return;
    active += 1;
    const { task, resolve, reject } = queue.shift();
    task().then(resolve, reject).finally(() => {
      active -= 1;
      pump();
    });
  };

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
}

// cache/http.json 은 소스 ID -> { etag, lastModified } 형태다.
export async function loadHttpCache() {
  try {
    return JSON.parse(await fs.readFile(HTTP_CACHE_PATH, 'utf8'));
  } catch {
    return {}; // 캐시가 없거나 깨졌으면 조건부 요청 없이 새로 받는다
  }
}

export async function saveHttpCache(cache) {
  await fs.mkdir(path.dirname(HTTP_CACHE_PATH), { recursive: true });
  await fs.writeFile(HTTP_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

// 사람이 읽을 짧은 사유만 남긴다. 스택 트레이스는 feed.json에 넣지 않는다.
export function shortErrorReason(error) {
  if (!error) return '알 수 없는 오류';
  const name = error.name === 'TimeoutError' || error.name === 'AbortError' ? '타임아웃' : null;
  const message = name ?? String(error.message ?? error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function isRetryable(status) {
  // 429와 5xx만 재시도한다. 4xx는 다시 보내도 같은 답이 온다.
  return status === 429 || (status >= 500 && status <= 599);
}

async function requestFollowingRedirects(url, { etag, lastModified, accept, deadline }) {
  let currentUrl = url;
  let redirectCount = 0;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const error = new Error('타임아웃');
      error.name = 'TimeoutError';
      throw error;
    }

    const headers = { 'User-Agent': USER_AGENT, Accept: accept };
    // 지난번 응답의 검증자를 붙여 변경이 없으면 304를 받는다.
    if (etag) headers['If-None-Match'] = etag;
    if (lastModified) headers['If-Modified-Since'] = lastModified;

    const response = await fetch(currentUrl, {
      headers,
      redirect: 'manual', // 홉 수를 직접 세기 위해 수동으로 따라간다
      signal: AbortSignal.timeout(remaining),
    });

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`리다이렉트 응답에 location 헤더가 없다 (${response.status})`);
      if (redirectCount >= MAX_REDIRECTS) throw new Error(`리다이렉트 ${MAX_REDIRECTS}홉을 초과했다`);
      redirectCount += 1;
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return { response, finalUrl: currentUrl, redirectCount };
  }
}

/**
 * 조건부 요청을 지원하는 단일 요청 함수.
 * 반환값의 notModified가 true면 본문이 없으므로 지난번 결과를 그대로 써야 한다.
 */
export async function fetchWithPolicy(url, options = {}) {
  const {
    etag,
    lastModified,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    accept = 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, */*',
    retries = 1, // 지수 백오프로 1회만 재시도한다
    backoffMs = 1000,
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const deadline = Date.now() + timeoutMs;
    try {
      const { response, finalUrl, redirectCount } = await requestFollowingRedirects(url, {
        etag,
        lastModified,
        accept,
        deadline,
      });

      if (response.status === 304) {
        return {
          status: 304,
          notModified: true,
          text: null,
          etag,
          lastModified,
          contentType: response.headers.get('content-type') ?? '',
          finalUrl,
          redirectCount,
        };
      }

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        error.retryAfter = response.headers.get('retry-after');
        // 본문을 읽어 소켓을 정리한다. 내용은 쓰지 않는다.
        await response.arrayBuffer().catch(() => {});
        throw error;
      }

      return {
        status: response.status,
        notModified: false,
        text: await response.text(),
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        contentType: response.headers.get('content-type') ?? '',
        finalUrl,
        redirectCount,
      };
    } catch (error) {
      lastError = error;
      const retryable = error.status === undefined || isRetryable(error.status);
      if (attempt >= retries || !retryable) break;

      // 429는 서버가 알려준 대기 시간을 우선 따른다.
      const retryAfterSeconds = Number.parseInt(error.retryAfter ?? '', 10);
      const waitMs = Number.isFinite(retryAfterSeconds)
        ? Math.min(retryAfterSeconds * 1000, timeoutMs)
        : backoffMs * 2 ** attempt;
      await sleep(waitMs);
    }
  }

  throw lastError;
}
