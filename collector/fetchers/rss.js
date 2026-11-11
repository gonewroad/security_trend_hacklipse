// RSS 소스 수집기.
// 파서는 Atom도 처리하므로 소스가 포맷을 바꿔도 조용히 비지 않는다.

import { fetchWithPolicy } from '../http.js';
import { parseFeedXml } from './feed-xml.js';

export async function fetchRss(source, options = {}) {
  const response = await fetchWithPolicy(source.url, options);
  if (response.notModified) return { notModified: true, entries: [], response };

  const { kind, entries } = parseFeedXml(response.text);
  return { notModified: false, entries, parsedKind: kind, response };
}
