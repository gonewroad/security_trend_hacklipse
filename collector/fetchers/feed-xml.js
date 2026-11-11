// RSS와 Atom을 모두 처리하는 공용 XML 파서.
// 두 포맷의 차이는 필드 이름뿐이므로 파서를 하나로 두고 매핑만 나눈다.
// Project Zero처럼 포맷이 바뀔 수 있는 소스를 위해 루트 요소로 자동 판별한다.

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,   // dc:date, content:encoded 같은 접두사를 걷어낸다
  parseTagValue: false,   // "2026" 같은 제목이 숫자로 바뀌는 것을 막는다
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
});

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// 텍스트 노드는 문자열일 수도, 속성을 가진 객체일 수도 있다.
function pickText(node) {
  for (const candidate of asArray(node)) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
    if (typeof candidate === 'number') return String(candidate);
    if (candidate && typeof candidate === 'object') {
      const text = candidate['#text'];
      if (typeof text === 'string' && text.trim() !== '') return text.trim();
      if (typeof text === 'number') return String(text);
    }
  }
  return '';
}

// RSS의 link는 텍스트, Atom의 link는 href 속성을 가진 빈 요소다. 둘 다 받는다.
function pickLink(item) {
  const candidates = asArray(item.link);

  // Atom: rel이 alternate이거나 없는 것을 먼저 고른다.
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      const rel = candidate['@_rel'];
      const href = candidate['@_href'];
      if (typeof href === 'string' && (rel === undefined || rel === 'alternate')) return href.trim();
    }
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && typeof candidate['@_href'] === 'string') {
      return candidate['@_href'].trim();
    }
  }

  // RSS: link가 텍스트다.
  const text = pickText(item.link);
  if (text !== '') return text;

  // link가 없으면 guid가 퍼머링크인 경우가 있다.
  const guid = asArray(item.guid)[0];
  if (guid && typeof guid === 'object' && guid['@_isPermaLink'] === 'false') return '';
  const guidText = pickText(item.guid);
  if (/^https?:\/\//i.test(guidText)) return guidText;

  const idText = pickText(item.id);
  return /^https?:\/\//i.test(idText) ? idText : '';
}

function pickFirstNonEmpty(item, keys) {
  for (const key of keys) {
    const text = pickText(item[key]);
    if (text !== '') return text;
  }
  return '';
}

// 카테고리에 CVE 번호가 들어오는 피드가 있어 CVE 추출 힌트로 넘긴다.
function collectCategories(item) {
  return asArray(item.category)
    .map((candidate) =>
      typeof candidate === 'object' && candidate !== null
        ? candidate['@_term'] ?? pickText(candidate)
        : pickText(candidate),
    )
    .filter((text) => typeof text === 'string' && text !== '')
    .join(' ');
}

function mapEntry(entry) {
  return {
    title: pickFirstNonEmpty(entry, ['title']),
    url: pickLink(entry),
    // 본문 후보는 요약 우선이다. content:encoded에는 전문이 들어와 있을 수 있다.
    description: pickFirstNonEmpty(entry, ['description', 'summary', 'content', 'encoded', 'subtitle']),
    publishedAtRaw: pickFirstNonEmpty(entry, ['pubDate', 'published', 'date', 'updated', 'issued', 'created']),
    cveHint: collectCategories(entry),
  };
}

/**
 * RSS 2.0, RSS 1.0(RDF), Atom을 모두 받아 공통 항목 배열로 반환한다.
 * 어떤 포맷으로 읽었는지도 함께 돌려준다. verify-sources가 표에 쓴다.
 */
export function parseFeedXml(xmlText) {
  const document = parser.parse(xmlText);

  // Atom
  if (document.feed) {
    return { kind: 'atom', entries: asArray(document.feed.entry).map(mapEntry) };
  }

  // RSS 2.0
  if (document.rss?.channel) {
    const channels = asArray(document.rss.channel);
    const items = channels.flatMap((channel) => asArray(channel.item));
    return { kind: 'rss', entries: items.map(mapEntry) };
  }

  // RSS 1.0 (RDF). item이 채널 밖에 평평하게 놓인다.
  if (document.RDF) {
    return { kind: 'rdf', entries: asArray(document.RDF.item).map(mapEntry) };
  }

  throw new Error('RSS·Atom 루트 요소를 찾지 못했다');
}
