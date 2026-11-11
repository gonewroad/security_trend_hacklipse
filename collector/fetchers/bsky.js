// Bluesky 공개 API 수집기. 인증이 필요 없다.
//
// X(트위터) API는 쓰지 않는다. 2026년 2월부터 게시물 읽기가 건당 과금으로 바뀌어
// 상시 폴링과 비용이 맞지 않는다. 그 자리를 Bluesky 공개 API와 Mastodon RSS가 대신한다.
//
// Bluesky는 공격적인 요청을 조절하므로 요청 사이에 최소 간격을 두고,
// 429가 오면 http.js의 지수 백오프에 맡긴다.

import { fetchWithPolicy, sleep } from '../http.js';

const MIN_REQUEST_GAP_MS = 300;
// 소셜 게시물은 제목이 없다. 본문을 제목 자리에 쓰되 저작권 경계상 길이를 제한한다.
const POST_TITLE_LIMIT = 200;

let lastRequestAt = 0;

// 이 모듈을 통한 모든 요청 사이에 300ms 간격을 강제한다.
async function throttle() {
  const waitMs = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
  if (waitMs > 0) await sleep(waitMs);
  lastRequestAt = Date.now();
}

// at://did:plc:xxx/app.bsky.feed.post/3kabc 형태의 URI에서 웹 링크를 만든다.
function postWebUrl(uri, handle) {
  if (typeof uri !== 'string' || typeof handle !== 'string') return '';
  const rkey = uri.split('/').pop();
  if (!rkey || handle === '') return '';
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

function mapPost(feedEntry) {
  const post = feedEntry?.post;
  if (!post) return null;

  const text = typeof post.record?.text === 'string' ? post.record.text.replace(/\s+/g, ' ').trim() : '';
  if (text === '') return null;

  const handle = typeof post.author?.handle === 'string' ? post.author.handle : '';
  const truncated = text.length > POST_TITLE_LIMIT ? `${text.slice(0, POST_TITLE_LIMIT - 1).trimEnd()}…` : text;

  return {
    // 소셜 항목은 작성자가 곧 신뢰도 정보다. 스키마에 작성자 필드가 없어 제목 앞에 둔다.
    title: handle === '' ? truncated : `@${handle}: ${truncated}`,
    url: postWebUrl(post.uri, handle),
    description: text,
    publishedAtRaw: typeof post.record?.createdAt === 'string' ? post.record.createdAt : post.indexedAt ?? '',
    cveHint: '',
  };
}

export async function fetchBsky(source, options = {}) {
  await throttle();

  const response = await fetchWithPolicy(source.url, { ...options, accept: 'application/json, */*' });
  if (response.notModified) return { notModified: true, entries: [], response };

  const payload = JSON.parse(response.text);
  if (!Array.isArray(payload.feed)) throw new Error('Bluesky 응답에 feed 배열이 없다');

  const entries = payload.feed.map(mapPost).filter((entry) => entry !== null);
  return { notModified: false, entries, parsedKind: 'bsky', response };
}
