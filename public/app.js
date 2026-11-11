// Phase 1 뷰어. 스타일 없이 목록만 출력한다.
// 제목과 요약은 textContent로만 넣는다. innerHTML은 쓰지 않는다.

const FEED_URL = 'data/feed.json';

function renderItems(feed) {
  const list = document.getElementById('items');
  list.textContent = ''; // DOM은 누적하지 않고 교체한다

  for (const item of feed.items) {
    const row = document.createElement('li');

    const title = document.createElement('strong');
    title.textContent = item.title;
    row.append(title);

    const meta = document.createElement('div');
    const badges = item.badges.length > 0 ? ` [${item.badges.join(' ')}]` : '';
    meta.textContent = `${item.sourceName} · ${item.tier} · ${item.publishedAt}${badges}`;
    row.append(meta);

    list.append(row);
  }
}

function renderStatus(feed) {
  const status = document.getElementById('status');
  status.textContent = `generatedAt ${feed.generatedAt} · ${feed.items.length}건 · ${feed.sources
    .map((source) => `${source.id}:${source.status}`)
    .join(' ')}`;
}

async function load() {
  // cache: no-cache로 두면 브라우저가 If-None-Match를 붙여 조건부 요청을 보낸다.
  const response = await fetch(FEED_URL, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const feed = await response.json();
  document.getElementById('fallback').remove();
  renderStatus(feed);
  renderItems(feed);
}

load().catch((error) => {
  document.getElementById('status').textContent = `불러오기 실패: ${error.message}`;
});
