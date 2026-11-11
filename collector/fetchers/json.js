// JSON 소스 수집기. 현재 등록된 JSON 소스는 CISA KEV 하나다.
//
// KEV는 증분 피드가 아니라 전체 목록을 담은 단일 JSON이다.
// 매번 전체를 받으므로 dateAdded 기준으로 정렬해 최신 20건만 취한다.

import { fetchWithPolicy } from '../http.js';

const KEV_RECENT_LIMIT = 20;

// CISA KEV는 CVE 번호만 주므로 원문 링크를 NVD 상세 페이지로 만든다.
function nvdDetailUrl(cveId) {
  return `https://nvd.nist.gov/vuln/detail/${cveId}`;
}

function mapKevEntry(entry) {
  const cveId = typeof entry.cveID === 'string' ? entry.cveID.trim().toUpperCase() : '';

  const vendorAndProduct = [entry.vendorProject, entry.product]
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join(' ')
    .trim();

  const title =
    (typeof entry.vulnerabilityName === 'string' && entry.vulnerabilityName.trim() !== ''
      ? entry.vulnerabilityName.trim()
      : vendorAndProduct) || cveId;

  // 악용이 확인되어 KEV에 등재된 항목이므로 kev 배지를 항상 붙인다.
  const badges = ['kev'];
  // 랜섬웨어 캠페인에 쓰인 것으로 표기된 항목만 ransomware 배지를 붙인다.
  if (entry.knownRansomwareCampaignUse === 'Known') badges.push('ransomware');

  return {
    title,
    url: cveId === '' ? '' : nvdDetailUrl(cveId),
    description: typeof entry.shortDescription === 'string' ? entry.shortDescription : '',
    publishedAtRaw: typeof entry.dateAdded === 'string' ? entry.dateAdded : '',
    // KEV는 항목당 CVE가 하나로 정해져 있다. 본문의 상호 참조 CVE를 끌어오지 않도록
    // 권위 있는 값으로 넘긴다.
    authoritativeCves: cveId === '' ? [] : [cveId],
    badges,
  };
}

export async function fetchJson(source, options = {}) {
  const response = await fetchWithPolicy(source.url, { ...options, accept: 'application/json, */*' });
  if (response.notModified) return { notModified: true, entries: [], response };

  const payload = JSON.parse(response.text);

  // CISA KEV 형태
  if (Array.isArray(payload.vulnerabilities)) {
    const entries = payload.vulnerabilities
      .filter((entry) => entry && typeof entry === 'object')
      // dateAdded는 YYYY-MM-DD 문자열이라 사전순 정렬이 시간순 정렬과 같다.
      .sort((a, b) => String(b.dateAdded ?? '').localeCompare(String(a.dateAdded ?? '')))
      .slice(0, KEV_RECENT_LIMIT)
      .map(mapKevEntry);

    return { notModified: false, entries, parsedKind: 'json:kev', response };
  }

  // 그 외 JSON 소스를 위한 일반 처리. 배열이거나 items 배열을 담은 객체를 받는다.
  const list = Array.isArray(payload) ? payload : payload.items;
  if (!Array.isArray(list)) throw new Error('JSON에서 항목 배열을 찾지 못했다');

  const entries = list.map((entry) => ({
    title: String(entry.title ?? ''),
    url: String(entry.url ?? entry.link ?? ''),
    description: String(entry.description ?? entry.summary ?? ''),
    publishedAtRaw: String(entry.publishedAt ?? entry.published ?? entry.date ?? ''),
    cveHint: '',
  }));

  return { notModified: false, entries, parsedKind: 'json', response };
}
