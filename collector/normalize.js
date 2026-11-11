// 수집한 원시 항목을 feed.json 스키마의 항목으로 바꾼다.
// 항목 ID 생성 규칙이 요약 캐시의 전제이므로 이 파일의 규칙은 함부로 바꾸지 않는다.

import crypto from 'node:crypto';

// 추적 파라미터는 같은 기사에 다른 URL을 만들어 ID를 흔든다. 반드시 제거한다.
const TRACKING_PARAM_EXACT = new Set(['fbclid', 'ref', 'gclid', 'igshid', 'mc_cid', 'mc_eid']);
const CVE_PATTERN = /CVE-\d{4}-\d{4,7}/gi;

// 피드가 제공하는 요약을 표시할 때의 상한. 저작권 경계상 본문 전문을 쓰지 않는다.
export const FEED_SUMMARY_DISPLAY_LIMIT = 200;
// LLM에 보내는 본문 길이 상한.
export const LLM_INPUT_LIMIT = 500;

/**
 * 링크 URL 정규화.
 * 소문자 호스트, 마지막 슬래시 제거, utm_*·fbclid·ref 추적 파라미터 제거, 프래그먼트 제거.
 * https: 스키마가 아니면 null을 반환해 버린다(외부 피드를 신뢰하지 않는다).
 */
export function normalizeUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return null;

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  // 링크는 https만 허용한다. http·javascript·data 등은 전부 버린다.
  if (parsed.protocol !== 'https:') return null;

  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = '';

  for (const key of [...parsed.searchParams.keys()]) {
    const lowered = key.toLowerCase();
    if (lowered.startsWith('utm_') || TRACKING_PARAM_EXACT.has(lowered)) {
      parsed.searchParams.delete(key);
    }
  }

  // 마지막 슬래시 제거. 루트 경로(/)는 그대로 둔다.
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  return parsed.toString();
}

function sha256Prefix(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 항목 ID. 같은 기사는 언제 다시 수집해도 항상 같은 값이 나와야 한다.
 * 링크가 있으면 정규화 URL을, 없으면 sourceId + 제목 + 발행일자를 해싱한다.
 */
export function makeItemId({ normalizedUrl, sourceId, title, publishedAt }) {
  if (normalizedUrl) return sha256Prefix(normalizedUrl);
  const publishedDate = typeof publishedAt === 'string' ? publishedAt.slice(0, 10) : '';
  return sha256Prefix(`${sourceId}\u0000${title ?? ''}\u0000${publishedDate}`);
}

// 제목 정규화는 중복 제거에만 쓴다. 소문자 변환, 연속 공백 압축, 구두점 제거만 한다.
export function normalizeTitle(title) {
  if (typeof title !== 'string') return '';
  return title
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…',
  ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'", mdash: '—', ndash: '–',
};

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

/**
 * 피드 본문에서 태그와 엔티티를 걷어내 평문으로 만든다.
 * KNVD는 description에 <br>이 escape되어 들어오므로 두 번 정리한다.
 * 뷰어는 textContent만 쓰므로 여기서 남은 태그가 실행될 일은 없지만, 읽히는 글자를 위해 정리한다.
 */
export function stripHtml(raw) {
  if (typeof raw !== 'string') return '';
  let text = decodeEntities(raw);
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeEntities(text);
  return text.replace(/\s+/g, ' ').trim();
}

export function truncate(text, limit) {
  if (typeof text !== 'string') return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

export function extractCves(...texts) {
  const found = new Set();
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    for (const match of text.matchAll(CVE_PATTERN)) {
      found.add(match[0].toUpperCase());
    }
  }
  return [...found].sort();
}

// 국내 매체는 naive 형식을 KST로 내보낸다. 아래 패턴을 +09:00으로 해석한다.
// 근거(2026-11-11 확인): 보안뉴스 최신 항목이 "2026-11-11 17:56:11"인데 당시 UTC는 13:32였다.
// UTC로 읽으면 4시간 뒤 미래가 되어 성립하지 않는다. 데일리시큐도 같은 형식을 쓴다.
const NAIVE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const KST_OFFSET = '+09:00';

/**
 * 관대한 날짜 파싱.
 * RSS 2.0이 요구하는 RFC 822가 아니어도 버리지 않는다.
 * 파싱에 실패하면 null을 반환하고, 호출한 쪽에서 수집 시각을 넣고 dateEstimated를 세운다.
 */
export function parseDateLenient(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '') return null;

  const naive = value.match(NAIVE_DATETIME);
  if (naive) {
    const [, y, mo, d, h, mi, s = '00'] = naive;
    const candidate = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${KST_OFFSET}`);
    return Number.isNaN(candidate.getTime()) ? null : candidate;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function toIsoSeconds(date) {
  return `${new Date(date).toISOString().slice(0, 19)}Z`;
}

/**
 * 원시 항목 하나를 스키마 항목으로 바꾼다.
 * title은 어떤 경우에도 생략하지 않는다. 제목이 없는 항목은 호출한 쪽에서 버린다.
 */
export function normalizeItem(raw, source, collectedAt) {
  const title = stripHtml(raw.title ?? '');
  if (title === '') return null;

  const normalizedUrl = normalizeUrl(raw.url);
  const parsedDate = parseDateLenient(raw.publishedAtRaw);

  // 발행 시각을 못 읽으면 항목을 버리는 대신 수집 시각을 넣고 추정값으로 표시한다.
  let publishedDate = parsedDate ?? collectedAt;
  let dateEstimated = parsedDate === null;

  // 서버 시계가 앞서 있거나 표준시 표기가 빠진 경우 미래 시각이 들어온다.
  // 미래는 경과 시간이 음수가 되고 신선도 가산점을 왜곡하므로 수집 시각으로 당긴다.
  if (publishedDate.getTime() > collectedAt.getTime() + 60_000) {
    publishedDate = collectedAt;
    dateEstimated = true;
  }

  const descriptionText = stripHtml(raw.description ?? '');

  return {
    id: makeItemId({
      normalizedUrl,
      sourceId: source.id,
      title,
      publishedAt: toIsoSeconds(publishedDate),
    }),
    tier: source.tier,
    sourceId: source.id,
    sourceName: source.name,
    title,
    titleKo: null,
    summaryKo: null,
    url: normalizedUrl,
    publishedAt: toIsoSeconds(publishedDate),
    dateEstimated,
    lang: source.lang,
    score: 0,
    badges: [...new Set(raw.badges ?? [])],
    // 소스가 CVE 번호를 메타데이터로 제공하면 그것만 쓴다.
    // 본문에서 긁으면 "CVE-A와 연계될 수 있다" 같은 상호 참조까지 끌려와
    // 서로 다른 취약점이 같은 CVE를 공유하는 것처럼 보이고, 중복 제거가 둘을 하나로 합쳐 버린다.
    // (CISA KEV의 shortDescription이 실제로 다른 CVE를 언급한다.)
    cve:
      Array.isArray(raw.authoritativeCves) && raw.authoritativeCves.length > 0
        ? [...new Set(raw.authoritativeCves.map((cve) => String(cve).toUpperCase()))].sort()
        : extractCves(title, descriptionText, raw.cveHint ?? ''),
    alsoFrom: [],

    // 아래 두 필드는 파일에 쓰지 않는다. 요약·중복 제거 단계에서만 쓰는 내부 값이다.
    _description: descriptionText,
    _normalizedUrl: normalizedUrl,
  };
}
