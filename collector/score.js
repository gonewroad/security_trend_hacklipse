// 우선순위 스코어링과 배지 판정.
//
// score는 정렬에만 쓰이므로 절대값의 의미는 없다. 전부 가산으로 구현한다.
// 키워드는 운영하면서 가장 자주 바뀌는 부분이므로 코드가 아니라 keywords.yml에서 읽는다.

import fs from 'node:fs/promises';
import YAML from 'yaml';

const TIER_SCORE = { T1: 50, T2: 25, T3: 20, T4: 5 };

const SCORE_KEV = 20;
const SCORE_RANSOMWARE = 15;
const SCORE_HAS_CVE = 10;
const SCORE_URGENT_KEYWORD = 10;

// 신선도는 배타적 구간으로 둔다. 30분 전 항목에 1시간 가산과 6시간 가산을 같이 주면
// 구간을 나눈 의미가 없어진다.
const SCORE_WITHIN_1H = 15;
const SCORE_WITHIN_6H = 8;
const SCORE_OLDER_THAN_24H = -10;

const SCORE_PER_EXTRA_SOURCE = 5;
const SCORE_EXTRA_SOURCE_CAP = 15;

const HOUR_MS = 60 * 60 * 1000;

// feed.json에 쓸 수 있는 배지는 이 다섯 개뿐이다.
const ALLOWED_BADGES = new Set(['kev', 'ransomware', 'activeExploit', 'krcert', 'patchAvailable']);

export async function loadKeywords(filePath = 'keywords.yml') {
  const parsed = YAML.parse(await fs.readFile(filePath, 'utf8')) ?? {};
  const toLowerList = (list) =>
    (Array.isArray(list) ? list : []).map((keyword) => String(keyword).toLowerCase()).filter((k) => k !== '');

  return {
    urgentKeywords: toLowerList(parsed.urgentKeywords),
    activeExploitKeywords: toLowerList(parsed.activeExploitKeywords),
    patchAvailableKeywords: toLowerList(parsed.patchAvailableKeywords),
  };
}

function containsAny(haystack, keywords) {
  const lowered = haystack.toLowerCase();
  return keywords.some((keyword) => lowered.includes(keyword));
}

/**
 * KEV 항목에서 CVE -> 랜섬웨어 악용 여부 색인을 만든다.
 * 해외 매체가 같은 CVE를 다룬 기사에도 KEV 사실을 그대로 옮겨 붙이기 위한 것이다.
 * 추정이 아니라 KEV가 명시한 사실만 전파한다.
 */
export function buildKevIndex(items) {
  const index = new Map();
  for (const item of items) {
    if (!item.badges.includes('kev')) continue;
    for (const cve of item.cve) {
      const ransomware = index.get(cve)?.ransomware === true || item.badges.includes('ransomware');
      index.set(cve, { ransomware });
    }
  }
  return index;
}

/**
 * 배지를 판정한다. 색만으로 긴급도를 표현하지 않기 위해 화면은 이 배지 텍스트를 함께 쓴다.
 */
export function deriveBadges(item, { keywords, kevIndex }) {
  const badges = new Set(item.badges);
  const haystack = `${item.title} ${item._description ?? ''}`;

  // KEV 등재 사실은 CVE 번호로 이어 붙인다.
  for (const cve of item.cve) {
    const kevEntry = kevIndex.get(cve);
    if (!kevEntry) continue;
    badges.add('kev');
    if (kevEntry.ransomware) badges.add('ransomware');
  }

  if (containsAny(haystack, keywords.activeExploitKeywords)) badges.add('activeExploit');
  if (containsAny(haystack, keywords.patchAvailableKeywords)) badges.add('patchAvailable');

  // KrCERT(KNVD) 공지는 링크 호스트로 판정한다. 소스 ID를 코드에 박지 않는다.
  if (typeof item.url === 'string' && item.url !== '') {
    try {
      const host = new URL(item.url).hostname.toLowerCase();
      if (host === 'krcert.or.kr' || host.endsWith('.krcert.or.kr')) badges.add('krcert');
    } catch {
      // 링크가 없거나 깨졌으면 판정하지 않는다.
    }
  }

  return [...badges].filter((badge) => ALLOWED_BADGES.has(badge)).sort();
}

export function scoreItem(item, { keywords, now }) {
  let score = TIER_SCORE[item.tier] ?? 0;

  if (item.badges.includes('kev')) score += SCORE_KEV;
  if (item.badges.includes('ransomware')) score += SCORE_RANSOMWARE;
  if (item.cve.length > 0) score += SCORE_HAS_CVE;

  // 긴급 키워드는 제목에서만 본다. 본문까지 보면 거의 모든 기사가 걸린다.
  if (containsAny(item.title, keywords.urgentKeywords)) score += SCORE_URGENT_KEYWORD;

  const ageMs = now.getTime() - new Date(item.publishedAt).getTime();
  if (ageMs <= HOUR_MS) score += SCORE_WITHIN_1H;
  else if (ageMs <= 6 * HOUR_MS) score += SCORE_WITHIN_6H;
  else if (ageMs >= 24 * HOUR_MS) score += SCORE_OLDER_THAN_24H;

  // 여러 매체가 같이 다룬 사건은 그만큼 중요하다. 다만 상한을 둔다.
  score += Math.min(item.alsoFrom.length * SCORE_PER_EXTRA_SOURCE, SCORE_EXTRA_SOURCE_CAP);

  return score;
}

/**
 * 배지를 판정하고 점수를 매긴다. 중복 제거가 끝난 뒤에 호출해야
 * alsoFrom 가산점이 제대로 반영된다.
 */
export function scoreItems(items, { keywords, now }) {
  const kevIndex = buildKevIndex(items);

  for (const item of items) {
    item.badges = deriveBadges(item, { keywords, kevIndex });
    item.score = scoreItem(item, { keywords, now });
  }

  return items;
}
