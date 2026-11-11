// Atom 소스 수집기.
// RSS와 같은 파서를 쓴다. Project Zero는 도메인을 옮긴 전례가 있어
// 포맷이 바뀌어도 자동 판별로 계속 읽히게 둔다.

import { fetchWithPolicy } from '../http.js';
import { parseFeedXml } from './feed-xml.js';

export async function fetchAtom(source, options = {}) {
  const response = await fetchWithPolicy(source.url, options);
  if (response.notModified) return { notModified: true, entries: [], response };

  const { kind, entries } = parseFeedXml(response.text);
  return { notModified: false, entries, parsedKind: kind, response };
}
