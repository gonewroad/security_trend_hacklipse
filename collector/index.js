// 수집기 엔트리포인트.
//
// sources.yml을 읽어 병렬로 수집하고, 정규화한 뒤 feed.json을 원자적으로 쓴다.
// 하나의 소스가 실패해도 전체 수집을 중단하지 않는다(Promise.allSettled).
//
// 사용법:
//   node collector/index.js              모든 소스
//   node collector/index.js --tiers=T1,T2  지정한 티어만. 나머지는 직전 결과를 유지한다

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { createLimiter, loadHttpCache, saveHttpCache, shortErrorReason } from './http.js';
import { normalizeItem, toIsoSeconds } from './normalize.js';
import { dedupeItems } from './dedupe.js';
import { loadKeywords, scoreItems } from './score.js';
import { summarize } from './summarize.js';
import {
  buildFeed,
  decideSourceStatus,
  loadPreviousFeed,
  writeFeedAtomically,
} from './write.js';
import { fetchRss } from './fetchers/rss.js';
import { fetchAtom } from './fetchers/atom.js';
import { fetchJson } from './fetchers/json.js';
import { fetchBsky } from './fetchers/bsky.js';

const MAX_CONCURRENT_REQUESTS = 6; // 동시 요청 6개로 제한한다
const SOURCE_TIMEOUT_MS = 10_000;  // 소스별 타임아웃 10초

const FETCHERS = {
  rss: fetchRss,
  atom: fetchAtom,
  json: fetchJson,
  bsky: fetchBsky,
};

function parseTierFilter(argv) {
  const argument = argv.find((value) => value.startsWith('--tiers='));
  if (!argument) return null;
  const tiers = argument
    .slice('--tiers='.length)
    .split(',')
    .map((tier) => tier.trim().toUpperCase())
    .filter((tier) => tier !== '');
  return tiers.length > 0 ? new Set(tiers) : null;
}

export async function loadSources(filePath = 'sources.yml') {
  const parsed = YAML.parse(await fs.readFile(filePath, 'utf8'));
  if (!parsed || !Array.isArray(parsed.sources)) throw new Error('sources.yml에 sources 배열이 없다');

  // 피드 목록을 코드에 하드코딩하지 않는다. 소스 추가는 YAML 한 블록 추가로 끝난다.
  return parsed.sources.filter((source) => source.enabled === true);
}

// 한 소스를 수집해 항목 배열과 상태를 돌려준다. 예외를 바깥으로 던지지 않는다.
async function collectSource(source, { httpCache, now }) {
  const fetcher = FETCHERS[source.type];
  if (!fetcher) {
    return { source, ok: false, items: [], error: `알 수 없는 소스 타입: ${source.type}`, notModified: false };
  }

  const cached = httpCache[source.id] ?? {};

  try {
    const result = await fetcher(source, {
      etag: cached.etag,
      lastModified: cached.lastModified,
      timeoutMs: SOURCE_TIMEOUT_MS,
    });

    // 304면 본문이 없다. 지난번 결과를 그대로 쓴다.
    if (result.notModified) {
      return { source, ok: true, items: [], error: null, notModified: true };
    }

    // 다음 요청에 쓸 검증자를 보관한다.
    httpCache[source.id] = {
      etag: result.response.etag ?? undefined,
      lastModified: result.response.lastModified ?? undefined,
    };

    const items = result.entries
      .map((entry) => normalizeItem(entry, source, now))
      .filter((item) => item !== null);

    return { source, ok: true, items, error: null, notModified: false, parsedKind: result.parsedKind };
  } catch (error) {
    return { source, ok: false, items: [], error: shortErrorReason(error), notModified: false };
  }
}

function newestPublishedAt(items) {
  let newest = null;
  for (const item of items) {
    if (newest === null || item.publishedAt > newest) newest = item.publishedAt;
  }
  return newest;
}

export async function runCollection({ tierFilter = null, now = new Date() } = {}) {
  const sources = await loadSources();
  const keywords = await loadKeywords();
  const previousFeed = await loadPreviousFeed();
  const httpCache = await loadHttpCache();
  const limit = createLimiter(MAX_CONCURRENT_REQUESTS);

  // 티어 필터가 걸린 소스는 건너뛰고 직전 결과를 유지한다.
  const targets = sources.filter((source) => tierFilter === null || tierFilter.has(source.tier));
  const skipped = sources.filter((source) => tierFilter !== null && !tierFilter.has(source.tier));

  const settled = await Promise.allSettled(
    targets.map((source) => limit(() => collectSource(source, { httpCache, now }))),
  );

  const items = [];
  const sourceStates = [];

  for (const [index, outcome] of settled.entries()) {
    const source = targets[index];

    // collectSource는 예외를 삼키므로 rejected는 사실상 버그 상황이다. 그래도 화면은 살린다.
    const result =
      outcome.status === 'fulfilled'
        ? outcome.value
        : { source, ok: false, items: [], error: shortErrorReason(outcome.reason), notModified: false };

    const previousItems = (previousFeed?.items ?? []).filter((item) => item.sourceId === source.id);
    const previousState = (previousFeed?.sources ?? []).find((state) => state.id === source.id);

    // 실패했거나 304를 받았으면 직전 항목을 그대로 살린다.
    const effectiveItems = result.ok && !result.notModified ? result.items : previousItems;
    items.push(...effectiveItems);

    sourceStates.push({
      id: source.id,
      name: source.name,
      tier: source.tier,
      status: decideSourceStatus({
        ok: result.ok,
        newestPublishedAt: newestPublishedAt(effectiveItems),
        now,
      }),
      // 실패한 소스는 직전 성공 시각을 유지한다. 언제부터 끊겼는지 알 수 있다.
      lastSuccessAt: result.ok ? toIsoSeconds(now) : previousState?.lastSuccessAt ?? null,
      itemCount: effectiveItems.length,
      error: result.ok ? null : result.error,
    });

    const label = result.ok ? (result.notModified ? '304 변경없음' : `${result.items.length}건`) : `실패: ${result.error}`;
    console.log(`  ${source.id.padEnd(20)} ${source.tier}  ${label}`);
  }

  // 수집 대상이 아니었던 소스는 직전 상태와 항목을 그대로 둔다.
  for (const source of skipped) {
    const previousItems = (previousFeed?.items ?? []).filter((item) => item.sourceId === source.id);
    const previousState = (previousFeed?.sources ?? []).find((state) => state.id === source.id);
    items.push(...previousItems);
    sourceStates.push(
      previousState ?? {
        id: source.id,
        name: source.name,
        tier: source.tier,
        status: 'failed',
        lastSuccessAt: null,
        itemCount: 0,
        error: '아직 수집된 적이 없다',
      },
    );
  }

  await saveHttpCache(httpCache);

  // 정규화 -> 중복 제거 -> 스코어링 순서로 처리한다.
  // 스코어링은 중복 제거 뒤에 해야 alsoFrom 가산점이 반영된다.
  const beforeDedupe = items.length;
  const deduped = dedupeItems(items);
  scoreItems(deduped, { keywords, now });
  console.log(`  중복 제거: ${beforeDedupe}건 -> ${deduped.length}건`);

  // 요약 모듈. 실패해도 수집을 멈추지 않는다. 요약은 편의 기능이고 원문 제목이 진짜 데이터다.
  try {
    const summaryStats = await summarize(deduped, { now });
    console.log(
      `  요약: 캐시 ${summaryStats.fromCache}건, 피드 ${summaryStats.fromFeed}건, ` +
        `신규 ${summaryStats.applied}건(${summaryStats.requested}요청), ` +
        `폐기 ${summaryStats.rejected}건, 예산 초과 ${summaryStats.skippedByBudget}건`,
    );
  } catch (error) {
    console.log(`  요약 단계 건너뜀(계속 진행): ${shortErrorReason(error)}`);
  }

  const feed = buildFeed({ items: deduped, sources: sourceStates, now });
  const writeResult = await writeFeedAtomically(feed, previousFeed);

  return { feed, writeResult, previousFeed };
}

async function main() {
  const tierFilter = parseTierFilter(process.argv.slice(2));
  const startedAt = Date.now();

  console.log(`[collect] 시작 ${new Date().toISOString()}${tierFilter ? ` tiers=${[...tierFilter].join(',')}` : ''}`);

  const { feed, writeResult } = await runCollection({ tierFilter });

  if (!writeResult.written) {
    // 게이트 실패. 기존 feed.json을 건드리지 않고 종료 코드 1로 끝낸다.
    console.error('[collect] 유효성 게이트 실패로 feed.json을 교체하지 않았다:');
    for (const failure of writeResult.failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[collect] 완료 ${feed.items.length}건, ${writeResult.bytes.toLocaleString()}바이트, ${elapsedMs}ms`,
  );
}

// 직접 실행했을 때만 main을 돌린다. 테스트에서 import할 수 있게 둔다.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
