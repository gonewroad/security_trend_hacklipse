// 한글 요약 모듈. 제공자를 바꾸려면 이 파일 하나만 고치면 된다.
//
// 설계의 핵심은 무료 한도를 넘지 않는 것이다. 장치가 네 겹이다.
//   1. 캐시: 항목 하나는 평생 한 번만 요약한다.
//   2. 배치: 기사 10건을 한 요청에 묶는다. 무료 한도는 토큰보다 요청 수에서 먼저 막힌다.
//   3. 실행당 상한: 한 번 실행에서 최대 5요청(= 50건).
//   4. 일일 상한: 누적 요청 수를 캐시에 기록하고 상한에 닿으면 그날은 중단한다.
//
// 요약은 편의 기능이고 원문 제목이 진짜 데이터다.
// 어떤 실패도 수집을 멈추지 않는다. 실패하면 요약을 null로 두고 화면은 원문 제목을 보여준다.
//
// --- 무료 한도 확인 기록 (2026-11-11) ---
// 공식 수치를 이 환경에서 확인하지 못했다. 확인한 내용은 다음과 같다.
//   - Google은 더 이상 모든 프로젝트에 공통으로 적용되는 RPM/RPD 표를 공개하지 않는다.
//     한도는 프로젝트 단위로 배정되며 Google AI Studio의 rate limits 페이지에서 확인해야 한다.
//   - 2026년 4월 1일부터 무료 등급에서 Pro 계열이 빠지고 Flash·Flash-Lite만 남았다.
//   - 2026년에 보고된 gemini-2.5-flash 무료 등급 일일 요청 수는 자료마다 크게 갈린다.
//     가장 최근 보고는 하루 20요청, 그 전 자료들은 약 1,500요청이라고 적고 있다.
//     어느 쪽도 공식 문서로 확인하지 못했으므로 코드에 수치를 박지 않는다.
// 따라서 SUMMARY_DAILY_REQUEST_LIMIT의 기본값 100은 안전한 가정이 아니라 단순한 기본값이다.
// 운영 전에 반드시 자기 프로젝트의 실제 한도를 확인해 .env에서 맞춰야 한다.
// 배치가 10건이므로 100요청이면 하루 1,000건까지 요약할 수 있고,
// 한도가 하루 20요청이라면 SUMMARY_DAILY_REQUEST_LIMIT=20으로 두면 하루 200건이 된다.

import fs from 'node:fs/promises';
import path from 'node:path';
import { extractCves, truncate, LLM_INPUT_LIMIT } from './normalize.js';

const CACHE_PATH = path.join('cache', 'summaries.json');

const BATCH_SIZE = 10;              // 한 요청에 묶는 기사 수
const MAX_REQUESTS_PER_RUN = 5;     // 한 번 실행에서 최대 5요청(= 50건)
const DEFAULT_DAILY_REQUEST_LIMIT = 100;
const PROVIDER_TIMEOUT_MS = 30_000;

// 생성 결과 검사 상한. 프롬프트는 더 짧게(40자·60자) 요구하고 검사는 여유를 둔다.
const MAX_TITLE_KO_LENGTH = 60;
const MAX_SUMMARY_KO_LENGTH = 90;

// 국내 기사는 번역이 필요 없다. 피드가 준 요약을 그대로 쓰되 저작권 경계상 길이를 제한한다.
const KOREAN_SUMMARY_LIMIT = 90;

const PROMPT_HEADER = `당신은 보안 관제 담당자에게 해외 보안 기사를 전달하는 번역·요약 도구다.

아래 JSON 배열의 각 항목에 대해 다음을 생성하라.
- titleKo: 제목의 한글 번역. 40자 이내.
- summaryKo: 본문 설명의 한 줄 한글 요약. 60자 이내.

지킬 제약:
1. 입력에 없는 사실, 날짜, 제품명, CVE 번호를 만들지 마라.
2. 심각도를 스스로 판단하거나 대응 방안을 제안하지 마라.
3. "충격적", "사상 최대" 같은 과장 표현을 쓰지 마라.
4. 제품명과 기업명은 원문 표기를 그대로 남긴다. 예: PAN-OS, Fortinet.
5. 정보가 부족해 요약할 수 없으면 summaryKo를 null로 달라.

지정한 형식의 JSON 배열로만 답하라. 설명을 덧붙이지 마라.
[{"id": "...", "titleKo": "...", "summaryKo": "..."}]

입력:
`;

// ---------------------------------------------------------------- 캐시

function todayKey(now) {
  return now.toISOString().slice(0, 10);
}

export async function loadSummaryCache() {
  try {
    const parsed = JSON.parse(await fs.readFile(CACHE_PATH, 'utf8'));
    return {
      entries: parsed.entries ?? {},
      daily: parsed.daily ?? { date: null, requestCount: 0 },
    };
  } catch {
    return { entries: {}, daily: { date: null, requestCount: 0 } };
  }
}

export async function saveSummaryCache(cache) {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------- 제공자

/**
 * 제공자 호출. 교체 지점은 이 함수 하나다.
 * 기본값은 Google Gemini generateContent이며 키는 LLM_API_KEY로 받는다.
 * 키를 프론트엔드에 두지 않는다. 이 코드는 수집기에서만 돈다.
 */
async function callProvider(promptText) {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error('LLM_API_KEY가 없다');

  const model = process.env.LLM_MODEL || 'gemini-2.5-flash';
  // LLM_ENDPOINT로 덮어쓸 수 있다. 사내 게이트웨이를 거치거나 테스트용 대역을 쓸 때 쓴다.
  const endpoint =
    process.env.LLM_ENDPOINT ||
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: {
        temperature: 0,          // 번역이므로 흔들릴 이유가 없다
        responseMimeType: 'application/json',
      },
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`제공자 HTTP ${response.status} ${detail.slice(0, 120)}`);
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string') throw new Error('제공자 응답에 텍스트가 없다');
  return text;
}

// ---------------------------------------------------------------- 검사

/**
 * 생성 직후 네 가지를 검사한다. 하나라도 실패하면 그 배치의 요약을 전부 버린다.
 * 1. JSON 파싱에 성공하고 생성 개수가 요청 개수와 같다.
 * 2. 모든 id가 요청한 id 집합 안에 있다.
 * 3. titleKo가 60자, summaryKo가 90자를 넘지 않는다.
 * 4. 입력에 없는 CVE 번호가 생성 결과에 없다.
 */
export function validateBatchResult(rawText, batch) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, reason: 'JSON 파싱 실패', results: [] };
  }

  if (!Array.isArray(parsed)) return { ok: false, reason: '배열이 아니다', results: [] };
  if (parsed.length !== batch.length) {
    return { ok: false, reason: `개수 불일치 (${parsed.length} != ${batch.length})`, results: [] };
  }

  const requestedIds = new Set(batch.map((entry) => entry.id));
  const inputById = new Map(batch.map((entry) => [entry.id, entry]));
  const results = [];

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') return { ok: false, reason: '항목이 객체가 아니다', results: [] };

    const { id } = entry;
    if (!requestedIds.has(id)) return { ok: false, reason: `요청하지 않은 id: ${id}`, results: [] };

    const titleKo = typeof entry.titleKo === 'string' ? entry.titleKo.trim() : null;
    const summaryKo = typeof entry.summaryKo === 'string' ? entry.summaryKo.trim() : null;

    if (titleKo !== null && titleKo.length > MAX_TITLE_KO_LENGTH) {
      return { ok: false, reason: `titleKo가 ${MAX_TITLE_KO_LENGTH}자를 넘는다`, results: [] };
    }
    if (summaryKo !== null && summaryKo.length > MAX_SUMMARY_KO_LENGTH) {
      return { ok: false, reason: `summaryKo가 ${MAX_SUMMARY_KO_LENGTH}자를 넘는다`, results: [] };
    }

    // 입력으로 보낸 제목과 본문에 없던 CVE 번호가 생성 결과에 나오면 지어낸 것이다.
    const source = inputById.get(id);
    const allowedCves = new Set(extractCves(source.title, source.description));
    const producedCves = extractCves(titleKo ?? '', summaryKo ?? '');
    for (const cve of producedCves) {
      if (!allowedCves.has(cve)) {
        return { ok: false, reason: `입력에 없는 CVE 생성: ${cve}`, results: [] };
      }
    }

    results.push({ id, titleKo: titleKo || null, summaryKo: summaryKo || null });
  }

  return { ok: true, reason: null, results };
}

// ---------------------------------------------------------------- 본체

function buildPrompt(batch) {
  const input = batch.map((entry) => ({
    id: entry.id,
    title: entry.title,
    description: entry.description,
  }));
  return `${PROMPT_HEADER}${JSON.stringify(input, null, 2)}`;
}

/**
 * 요약을 붙인다. items를 그 자리에서 수정하고 적용 결과를 돌려준다.
 *
 * 처리 순서:
 *   1. 캐시에 있으면 그대로 쓴다(API 호출 없음).
 *   2. 국내 기사는 피드가 준 요약을 쓴다(API 호출 없음).
 *   3. 남은 해외 기사를 score 높은 순으로 예산 안에서만 요약한다.
 *      T1은 예산과 관계없이 언제나 처리한다. 가장 중요한 항목이
 *      예산 부족으로 번역되지 않는 상황은 허용하지 않는다.
 */
export async function summarize(items, { now = new Date() } = {}) {
  const cache = await loadSummaryCache();

  // 날짜가 바뀌면 일일 카운터를 초기화한다.
  const today = todayKey(now);
  if (cache.daily.date !== today) cache.daily = { date: today, requestCount: 0 };

  // 0을 유효한 값으로 받아야 한다. || 로 기본값을 주면 0이 falsy라서 조용히 100이 되어
  // 요약을 끄려고 0을 넣은 운영자가 정반대 결과를 얻는다.
  const parsedLimit = Number.parseInt(process.env.SUMMARY_DAILY_REQUEST_LIMIT ?? '', 10);
  const dailyLimit =
    Number.isFinite(parsedLimit) && parsedLimit >= 0 ? parsedLimit : DEFAULT_DAILY_REQUEST_LIMIT;

  const stats = { fromCache: 0, fromFeed: 0, requested: 0, applied: 0, rejected: 0, skippedByBudget: 0 };
  const pending = [];

  for (const item of items) {
    const cached = cache.entries[item.id];
    if (cached) {
      item.titleKo = cached.titleKo ?? null;
      item.summaryKo = cached.summaryKo ?? null;
      stats.fromCache += 1;
      continue;
    }

    // 국내 기사는 번역이 필요 없다. 제목은 이미 한글이므로 titleKo를 비우고,
    // 한 줄 요약만 피드가 준 설명에서 가져온다. API를 쓰지 않는다.
    if (item.lang === 'ko') {
      const summary = truncate(item._description ?? '', KOREAN_SUMMARY_LIMIT) || null;
      item.titleKo = null;
      item.summaryKo = summary;
      cache.entries[item.id] = { titleKo: null, summaryKo: summary };
      stats.fromFeed += 1;
      continue;
    }

    pending.push(item);
  }

  if (pending.length === 0) {
    await saveSummaryCache(cache);
    return stats;
  }

  // score가 높은 순서로 처리한다. 예산이 모자라면 중요도가 낮은 쪽이 다음 주기로 넘어간다.
  pending.sort((a, b) => b.score - a.score);

  const tierOne = pending.filter((item) => item.tier === 'T1');
  const rest = pending.filter((item) => item.tier !== 'T1');

  // T1은 상한과 관계없이 모두 넣는다. 나머지는 남은 예산만큼만 넣는다.
  const remainingDaily = Math.max(0, dailyLimit - cache.daily.requestCount);
  const tierOneRequests = Math.ceil(tierOne.length / BATCH_SIZE);
  const restRequestBudget = Math.max(0, Math.min(MAX_REQUESTS_PER_RUN - tierOneRequests, remainingDaily));

  const selected = [...tierOne, ...rest.slice(0, restRequestBudget * BATCH_SIZE)];
  stats.skippedByBudget = pending.length - selected.length;

  if (remainingDaily === 0 && tierOne.length === 0) {
    console.log(`  요약: 일일 상한(${dailyLimit}요청)에 닿아 건너뛴다. 수집은 계속한다`);
    await saveSummaryCache(cache);
    return stats;
  }

  for (let offset = 0; offset < selected.length; offset += BATCH_SIZE) {
    const chunk = selected.slice(offset, offset + BATCH_SIZE);
    const batch = chunk.map((item) => ({
      id: item.id,
      title: item.title,
      // 피드의 description을 상위 500자로 자른 것만 보낸다. 원문 페이지를 따로 긁지 않는다.
      description: truncate(item._description ?? '', LLM_INPUT_LIMIT),
    }));

    try {
      const rawText = await callProvider(buildPrompt(batch));
      cache.daily.requestCount += 1;
      stats.requested += 1;

      const { ok, reason, results } = validateBatchResult(rawText, batch);
      if (!ok) {
        // 검사를 통과하지 못하면 그 배치의 요약을 버리고 null로 둔다. 화면은 원문 제목을 쓴다.
        console.log(`  요약 배치 ${chunk.length}건 폐기: ${reason}`);
        stats.rejected += chunk.length;
        continue;
      }

      const byId = new Map(results.map((entry) => [entry.id, entry]));
      for (const item of chunk) {
        const result = byId.get(item.id);
        if (!result) continue;
        item.titleKo = result.titleKo;
        item.summaryKo = result.summaryKo;
        // 항목 하나는 평생 한 번만 요약한다. 결과가 null이어도 캐시해 재호출을 막는다.
        cache.entries[item.id] = { titleKo: result.titleKo, summaryKo: result.summaryKo };
        stats.applied += 1;
      }
    } catch (error) {
      // 요약 실패가 화면 장애로 번지지 않아야 한다. 로그만 남기고 계속한다.
      console.log(`  요약 호출 실패(계속 진행): ${String(error.message).slice(0, 120)}`);
      stats.rejected += chunk.length;
    }
  }

  await saveSummaryCache(cache);
  return stats;
}
