// 중복 제거.
//
// 해외 매체는 같은 사건을 비슷한 시각에 보도한다. 정리하지 않으면 화면이 같은 뉴스로 덮인다.
// 세 단계로 거르고, 흡수된 출처명은 alsoFrom에 남겨 화면에서 "여러 곳이 같이 다룬 사건"임을 보인다.

import { normalizeTitle } from './normalize.js';

// DEDUPE_DEBUG=1을 주면 어떤 항목이 어떤 항목에 흡수되었는지 찍는다.
// 중복 제거가 과하게 묶는지 확인할 때 쓴다.
const DEBUG = process.env.DEDUPE_DEBUG === '1';

const CVE_MERGE_WINDOW_MS = 6 * 60 * 60 * 1000; // 같은 CVE를 다룬 기사는 6시간 이내면 한 건으로 본다
const TIER_RANK = { T1: 1, T2: 2, T3: 3, T4: 4 };

function tierRank(tier) {
  return TIER_RANK[tier] ?? 99;
}

/**
 * 남길 쪽을 고른다. 티어가 높은 쪽, 티어가 같으면 먼저 발행된 쪽이다.
 */
function pickWinner(left, right) {
  const rankDifference = tierRank(left.tier) - tierRank(right.tier);
  if (rankDifference !== 0) return rankDifference < 0 ? left : right;
  return new Date(left.publishedAt) <= new Date(right.publishedAt) ? left : right;
}

/**
 * 진 쪽을 이긴 쪽에 흡수한다.
 * 출처명을 alsoFrom에 모으고, CVE와 배지는 합집합으로 둔다.
 * 같은 사건에 대해 한쪽만 CVE를 달고 있는 경우가 흔하다.
 */
function absorb(winner, loser, stage = '') {
  if (DEBUG) {
    console.log(`  [dedupe:${stage}] 흡수`);
    console.log(`      남김: [${winner.tier}] ${winner.sourceName} | ${winner.title.slice(0, 80)}`);
    console.log(`      버림: [${loser.tier}] ${loser.sourceName} | ${loser.title.slice(0, 80)}`);
  }

  const names = new Set(winner.alsoFrom);
  if (loser.sourceName !== winner.sourceName) names.add(loser.sourceName);
  for (const name of loser.alsoFrom) {
    if (name !== winner.sourceName) names.add(name);
  }
  winner.alsoFrom = [...names].sort();

  winner.cve = [...new Set([...winner.cve, ...loser.cve])].sort();
  winner.badges = [...new Set([...winner.badges, ...loser.badges])].sort();

  // 요약 입력으로 쓸 본문은 더 긴 쪽을 남긴다.
  if ((loser._description?.length ?? 0) > (winner._description?.length ?? 0)) {
    winner._description = loser._description;
  }

  return winner;
}

// 1·2단계: 키가 같으면 같은 항목으로 합친다.
function mergeByKey(items, keyOf, stage = 'key') {
  const byKey = new Map();
  const passthrough = [];

  for (const item of items) {
    const key = keyOf(item);
    if (key === null || key === '') {
      passthrough.push(item); // 키를 만들 수 없는 항목은 그대로 통과시킨다
      continue;
    }

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }

    const winner = pickWinner(existing, item);
    const loser = winner === existing ? item : existing;
    byKey.set(key, absorb(winner, loser, stage));
  }

  return [...byKey.values(), ...passthrough];
}

/**
 * 3단계: 같은 CVE를 언급하고 발행 시각 차이가 6시간 이내면 한 항목으로 합친다.
 *
 * T4(소셜)는 이 단계에서 제외한다. T4는 오른쪽 보조 열에만 두고 T1·T2·T3과 섞지 않는 것이
 * 화면 사양이므로, T1 묶음에 흡수시키면 보조 열이 비어 버린다.
 * T4끼리의 완전 중복은 1·2단계에서 이미 걸린다.
 */
function mergeByCve(items) {
  const mergeable = items.filter((item) => item.tier !== 'T4' && item.cve.length > 0);
  const untouched = items.filter((item) => item.tier === 'T4' || item.cve.length === 0);

  // 먼저 발행된 항목이 묶음의 기준이 되도록 시간순으로 본다.
  mergeable.sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));

  const bundles = [];
  for (const item of mergeable) {
    const publishedAt = new Date(item.publishedAt).getTime();

    const target = bundles.find((bundle) => {
      if (Math.abs(new Date(bundle.publishedAt).getTime() - publishedAt) > CVE_MERGE_WINDOW_MS) return false;
      return bundle.cve.some((cve) => item.cve.includes(cve));
    });

    if (!target) {
      bundles.push(item);
      continue;
    }

    const winner = pickWinner(target, item);
    const loser = winner === target ? item : target;
    const merged = absorb(winner, loser, 'cve');
    bundles[bundles.indexOf(target)] = merged;
  }

  return [...bundles, ...untouched];
}

export function dedupeItems(items) {
  // 1. 정규화 URL이 같으면 같은 항목이다.
  let result = mergeByKey(items, (item) => item._normalizedUrl ?? null, 'url');

  // 2. 정규화 제목이 같으면 같은 항목이다.
  result = mergeByKey(result, (item) => normalizeTitle(item.title), 'title');

  // 3. 같은 CVE + 6시간 이내.
  result = mergeByCve(result);

  return result;
}
