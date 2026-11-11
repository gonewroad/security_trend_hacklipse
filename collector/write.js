// 유효성 게이트와 원자적 쓰기.
//
// 수집 실패가 화면을 비우지 않게 만드는 장치가 모두 이 파일에 있다.
// 게이트를 통과하지 못하면 기존 feed.json을 건드리지 않는다. 화면은 직전 데이터로 계속 돌아간다.

import fs from 'node:fs/promises';
import path from 'node:path';
import { toIsoSeconds } from './normalize.js';

export const SCHEMA_VERSION = 1;
export const FEED_PATH = path.join('public', 'data', 'feed.json');
const TMP_PATH = `${FEED_PATH}.tmp`;

const MAX_ITEMS_PER_SOURCE = 50;   // 소스별 최신 50건만 유지한다
const MAX_FILE_BYTES = 1_000_000;  // 전체 파일은 1MB를 넘지 않게 한다
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// feed.json에 쓰지 않는 내부 필드. 수집 과정에서만 쓴다.
const INTERNAL_FIELDS = ['_description', '_normalizedUrl'];

export async function loadPreviousFeed() {
  try {
    const parsed = JSON.parse(await fs.readFile(FEED_PATH, 'utf8'));
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
      generatedAt: parsed.generatedAt ?? null,
    };
  } catch {
    // 첫 실행이거나 파일이 깨졌으면 비교 대상이 없다.
    return null;
  }
}

function stripInternalFields(item) {
  const copy = { ...item };
  for (const field of INTERNAL_FIELDS) delete copy[field];
  return copy;
}

/**
 * 소스별 상태를 판정한다.
 * stale은 수집은 성공했지만 새 항목이 24시간 이상 없는 경우다.
 * 이걸 ok로 처리하면 고장을 모르게 되므로 따로 둔다.
 */
export function decideSourceStatus({ ok, newestPublishedAt, now }) {
  if (!ok) return 'failed';
  if (!newestPublishedAt) return 'stale';
  const ageMs = now.getTime() - new Date(newestPublishedAt).getTime();
  return ageMs > STALE_AFTER_MS ? 'stale' : 'ok';
}

/**
 * 항목을 소스별 상한과 전체 파일 크기 상한에 맞춘다.
 * 소스별로는 최신순 50건, 전체가 1MB를 넘으면 score가 낮은 항목부터 버린다.
 */
function capItems(items) {
  const bySource = new Map();
  for (const item of items) {
    const list = bySource.get(item.sourceId) ?? [];
    list.push(item);
    bySource.set(item.sourceId, list);
  }

  let capped = [];
  for (const list of bySource.values()) {
    list.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    capped.push(...list.slice(0, MAX_ITEMS_PER_SOURCE));
  }

  // 화면은 score 순으로 읽으므로 저장도 같은 순서로 둔다.
  capped.sort((a, b) => b.score - a.score || new Date(b.publishedAt) - new Date(a.publishedAt));

  // 1MB를 넘으면 뒤(낮은 score)부터 덜어낸다.
  while (capped.length > 1 && Buffer.byteLength(JSON.stringify(capped), 'utf8') > MAX_FILE_BYTES) {
    capped = capped.slice(0, Math.floor(capped.length * 0.9));
  }

  return capped;
}

export function buildFeed({ items, sources, now }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: toIsoSeconds(now),
    sources,
    items: capItems(items).map(stripInternalFields),
  };
}

/**
 * 쓰기 전 세 가지를 검사한다.
 * 1. items 길이가 0보다 크다.
 * 2. T1 소스 중 최소 한 개가 ok다.
 * 3. items 길이가 직전 파일의 50% 이상이다.
 * 상대 서버가 장애일 때 화면이 통째로 비는 것을 막는 장치다.
 */
export function runValidationGate(feed, previousFeed) {
  const failures = [];

  if (feed.items.length === 0) {
    failures.push('수집된 항목이 0건이다');
  }

  const tierOneSources = feed.sources.filter((source) => source.tier === 'T1');
  if (tierOneSources.length > 0 && !tierOneSources.some((source) => source.status === 'ok')) {
    failures.push(
      `T1 소스가 모두 ok가 아니다 (${tierOneSources.map((s) => `${s.id}:${s.status}`).join(', ')})`,
    );
  }

  if (previousFeed && previousFeed.items.length > 0) {
    const threshold = previousFeed.items.length * 0.5;
    if (feed.items.length < threshold) {
      failures.push(
        `항목 수가 직전 파일의 50% 미만이다 (${feed.items.length}건 < ${Math.ceil(threshold)}건)`,
      );
    }
  }

  return failures;
}

/**
 * feed.json.tmp에 전부 쓰고, 다시 읽어 JSON으로 파싱되는지까지 확인한 뒤에만 rename으로 교체한다.
 * 뷰어가 반쪽만 쓴 JSON을 읽는 상황을 만들지 않는다.
 */
export async function writeFeedAtomically(feed, previousFeed) {
  await fs.mkdir(path.dirname(FEED_PATH), { recursive: true });

  const serialized = `${JSON.stringify(feed, null, 2)}\n`;
  await fs.writeFile(TMP_PATH, serialized, 'utf8');

  try {
    // 임시 파일을 되읽어 실제로 온전한 JSON인지 확인한다.
    const verified = JSON.parse(await fs.readFile(TMP_PATH, 'utf8'));

    const failures = runValidationGate(verified, previousFeed);
    if (failures.length > 0) {
      await fs.rm(TMP_PATH, { force: true });
      return { written: false, failures };
    }

    await fs.rename(TMP_PATH, FEED_PATH);
    return { written: true, failures: [], bytes: Buffer.byteLength(serialized, 'utf8') };
  } catch (error) {
    await fs.rm(TMP_PATH, { force: true });
    return { written: false, failures: [`임시 파일 검증 실패: ${error.message}`] };
  }
}
