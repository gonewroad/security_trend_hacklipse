/*
 * 보안 동향 월보드 뷰어.
 *
 * 절대 규칙:
 * - 자기 호스트의 data/feed.json 하나만 받는다. 외부 도메인에 요청하지 않는다.
 * - 제목과 요약은 textContent로만 넣는다. innerHTML은 쓰지 않는다(외부 피드를 신뢰하지 않는다).
 * - 페이지 전체를 새로고침하지 않는다. feed.json만 다시 읽고 DOM을 교체한다.
 * - DOM은 누적하지 않고 교체한다. 장기 구동에서 누수를 만들지 않기 위함이다.
 */

'use strict';

const FEED_URL = 'data/feed.json';

// 뷰어가 아는 스키마 번호. 수집기가 더 큰 번호를 쓰면 화면이 스스로 알린다.
const KNOWN_SCHEMA_VERSION = 1;

const TIER1_CARD_COUNT = 4;      // 왼쪽 열에 고정 표시할 건수
/*
 * 가운데 타임라인 한 페이지 건수.
 *
 * 사양은 8건이지만 지정된 글자 크기로는 940px 안에 8건이 들어가지 않는다.
 * 본문 영역 940px에서 열 제목과 여백을 빼면 약 880px이 남는데,
 * 항목 하나에 한글 제목(26px) + 원문 제목(16px) + 한 줄 요약(20px) + 출처·시간(16px)이
 * 들어가므로 최소 127px, 제목이 두 줄이면 153px이 필요하다. 8건이면 1,016px 이상으로 넘친다.
 * 실제로 8건을 넣으면 글자가 가로로 잘려 읽을 수 없었다.
 *
 * "지나가는 사람이 3~5초 안에 판단할 수 있어야 한다"가 글자 크기·정보 밀도 판단의 기준이므로
 * 글자 크기를 지키고 건수를 줄였다. 6건이면 제목이 두 줄인 항목도 잘리지 않는다.
 */
const TIMELINE_PAGE_SIZE = 6;
const SOCIAL_ITEM_COUNT = 6;     // 오른쪽 소셜 열 표시 건수
const TICKER_SPEED_PX_PER_SEC = 35; // 초당 40px 이하로 느리게 흘린다

const FEED_POLL_MS = 60_000;     // 60초마다 feed.json 재조회
const PAGE_FLIP_MS = 15_000;     // 15초마다 타임라인 페이지 전환
const CLOCK_TICK_MS = 1_000;     // 1초마다 시계와 경과 시간 갱신
const PIXEL_SHIFT_MS = 600_000;  // 10분마다 픽셀 시프트
const HARD_RELOAD_HOUR = 4;      // 매일 04:00 화면 전체 하드 새로고침

const STALE_WARN_MS = 30 * 60 * 1000;    // 30분 경과: 노랑
const STALE_URGENT_MS = 2 * 60 * 60 * 1000; // 2시간 경과: 빨강 + 갱신 중단 배너
const MAX_CONSECUTIVE_FAILURES = 5;      // 연속 5회 실패: 데이터 연결 끊김

const BADGE_LABELS = {
  kev: '악용 확인',
  ransomware: '랜섬웨어',
  activeExploit: '공격 진행',
  krcert: 'KrCERT',
  patchAvailable: '패치 있음',
};

// ---------------------------------------------------------------- 상태

const state = {
  feed: null,
  timelinePages: [],
  currentPageIndex: 0,
  visibleLayer: 0,
  consecutiveFailures: 0,
  lastGeneratedAt: null,
  lastHardReloadDay: new Date().getDate(),
};

// ---------------------------------------------------------------- 유틸

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // 외부 피드 문자열은 textContent로만 넣는다.
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function formatClock(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// 경과 시간은 "방금", "12분 전", "3시간 전", "2일 전"으로 짧게 보여준다.
function formatElapsed(fromIso, now) {
  const deltaMs = now.getTime() - new Date(fromIso).getTime();
  if (!Number.isFinite(deltaMs)) return '';
  if (deltaMs < 60_000) return '방금';

  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}분 전`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;

  return `${Math.floor(hours / 24)}일 전`;
}

function isUrgent(item) {
  return item.badges.includes('kev') || item.badges.includes('activeExploit') || item.badges.includes('ransomware');
}

// ---------------------------------------------------------------- 공통 조각

function buildBadges(item) {
  const wrapper = element('div', 'badges');
  for (const badge of item.badges) {
    const label = BADGE_LABELS[badge];
    if (!label) continue; // 모르는 배지는 무시한다
    const node = element('span', 'badge', label);
    node.dataset.badge = badge;
    wrapper.append(node);
  }
  return wrapper;
}

/**
 * 출처 매체명과 경과 시간. 출처는 항목마다 반드시 표시한다.
 * 여러 매체가 같이 다룬 사건은 alsoFrom을 덧붙여 "혼자 하는 주장이 아님"을 보인다.
 */
function buildMeta(item, now) {
  const meta = element('div', 'meta');
  meta.append(element('span', 'meta-source', item.sourceName));
  meta.append(element('span', null, formatElapsed(item.publishedAt, now)));

  if (item.dateEstimated) {
    // 발행 시각을 못 읽어 수집 시각을 쓴 항목임을 숨기지 않는다.
    meta.append(element('span', 'meta-estimated', '시각 추정'));
  }

  if (item.alsoFrom.length > 0) {
    meta.append(element('span', null, `+${item.alsoFrom.join(', ')}`));
  }

  meta.append(buildBadges(item));
  return meta;
}

// ---------------------------------------------------------------- 왼쪽 T1 열

/**
 * T1 항목을 소스별로 번갈아 뽑는다.
 *
 * 그냥 최신순으로 자르면 시각이 분 단위로 찍히는 KNVD가 상단을 전부 차지하고,
 * 날짜만 있는(= 자정으로 읽히는) CISA KEV가 화면에서 사라진다.
 * T1 두 소스는 반드시 화면에 보여야 하므로 소스별 최신순으로 번갈아 채운다.
 */
function selectTier1Items(items) {
  const bySource = new Map();
  for (const item of items) {
    if (item.tier !== 'T1') continue;
    const list = bySource.get(item.sourceId) ?? [];
    list.push(item);
    bySource.set(item.sourceId, list);
  }

  for (const list of bySource.values()) {
    list.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  }

  const queues = [...bySource.values()];
  const selected = [];
  let cursor = 0;

  while (selected.length < TIER1_CARD_COUNT && queues.some((queue) => queue.length > 0)) {
    const queue = queues[cursor % queues.length];
    if (queue.length > 0) selected.push(queue.shift());
    cursor += 1;
  }

  return selected;
}

function renderTier1(items, now) {
  const container = document.getElementById('tier1-cards');
  container.textContent = ''; // 교체. 누적하지 않는다

  const selected = selectTier1Items(items);
  if (selected.length === 0) {
    container.append(element('div', 'column-empty', 'T1 항목이 없다. 상단 상태 점을 확인한다.'));
    return;
  }

  for (const item of selected) {
    const card = element('div', 't1-card');
    card.dataset.urgent = String(isUrgent(item));

    // 한글 제목이 있으면 그것을, 없으면 원문 제목을 크게 쓴다.
    card.append(element('div', 't1-title', item.titleKo ?? item.title));

    // 번역된 경우에만 원문 제목을 작게 함께 보여준다. 오역을 상쇄하는 장치다.
    if (item.titleKo) card.append(element('div', 't1-source-title', item.title));

    if (item.summaryKo) card.append(element('div', 'timeline-summary', item.summaryKo));

    card.append(buildMeta(item, now));
    container.append(card);
  }
}

// ---------------------------------------------------------------- 가운데 타임라인

function buildTimelineItem(item, now) {
  const node = element('div', 'timeline-item');

  node.append(element('div', 'timeline-title', item.titleKo ?? item.title));
  if (item.titleKo) node.append(element('div', 'timeline-source-title', item.title));
  if (item.summaryKo) node.append(element('div', 'timeline-summary', item.summaryKo));

  node.append(buildMeta(item, now));
  return node;
}

/**
 * 타임라인은 T1·T2·T3만 담는다. T4(소셜)는 오른쪽 보조 열에만 둔다.
 * score 순으로 정렬해 8건씩 페이지로 나눈다.
 */
function buildTimelinePages(items) {
  const timelineItems = items
    .filter((item) => item.tier !== 'T4')
    .sort((a, b) => b.score - a.score || new Date(b.publishedAt) - new Date(a.publishedAt));

  const pages = [];
  for (let index = 0; index < timelineItems.length; index += TIMELINE_PAGE_SIZE) {
    pages.push(timelineItems.slice(index, index + TIMELINE_PAGE_SIZE));
  }
  return pages;
}

/**
 * 400ms 크로스페이드를 위해 두 겹을 겹쳐 두고 번갈아 보여준다.
 * 연속 스크롤은 쓰지 않는다. 움직이는 글자는 걸으면서 읽을 수 없다.
 */
function ensureTimelineLayers() {
  const viewport = document.getElementById('timeline-viewport');
  if (viewport.childElementCount === 2) return [...viewport.children];

  viewport.textContent = '';
  const layers = [element('div', 'timeline-page'), element('div', 'timeline-page')];
  for (const layer of layers) {
    layer.dataset.visible = 'false';
    viewport.append(layer);
  }
  return layers;
}

function showTimelinePage(pageIndex, now) {
  const layers = ensureTimelineLayers();
  if (state.timelinePages.length === 0) {
    for (const layer of layers) {
      layer.textContent = '';
      layer.dataset.visible = 'false';
    }
    layers[0].append(element('div', 'column-empty', '표시할 항목이 없다.'));
    layers[0].dataset.visible = 'true';
    return;
  }

  const normalizedIndex = ((pageIndex % state.timelinePages.length) + state.timelinePages.length) %
    state.timelinePages.length;
  state.currentPageIndex = normalizedIndex;

  const nextLayerIndex = state.visibleLayer === 0 ? 1 : 0;
  const nextLayer = layers[nextLayerIndex];

  nextLayer.textContent = '';
  for (const item of state.timelinePages[normalizedIndex]) {
    nextLayer.append(buildTimelineItem(item, now));
  }

  layers[state.visibleLayer].dataset.visible = 'false';
  nextLayer.dataset.visible = 'true';
  state.visibleLayer = nextLayerIndex;
}

// ---------------------------------------------------------------- 오른쪽 소셜 열

function renderSocial(items, now) {
  const container = document.getElementById('social-items');
  container.textContent = '';

  const socialItems = items
    .filter((item) => item.tier === 'T4')
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, SOCIAL_ITEM_COUNT);

  if (socialItems.length === 0) {
    container.append(element('div', 'column-empty', '소셜 항목이 없다.'));
    return;
  }

  for (const item of socialItems) {
    const node = element('div', 'social-item');
    node.append(element('div', 'social-text', item.titleKo ?? item.title));
    node.append(buildMeta(item, now));
    container.append(node);
  }
}

// ---------------------------------------------------------------- 하단 티커

/**
 * KEV에 새로 등재된 CVE 번호만 흘린다.
 * 내용을 두 벌 이어 붙이고 -50%까지 움직여 이음매 없이 반복시킨다.
 */
function renderTicker(items) {
  const track = document.getElementById('ticker-track');
  track.textContent = '';
  track.style.animation = 'none';

  const kevCves = [];
  const seen = new Set();
  for (const item of items.filter((candidate) => candidate.badges.includes('kev'))
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))) {
    for (const cve of item.cve) {
      if (seen.has(cve)) continue;
      seen.add(cve);
      kevCves.push(cve);
    }
  }

  const label = document.getElementById('ticker-label');
  if (kevCves.length === 0) {
    label.textContent = 'KEV 신규 등재 없음';
    return;
  }
  label.textContent = 'KEV 신규 등재';

  // 같은 내용을 두 벌 넣는다.
  for (let copy = 0; copy < 2; copy += 1) {
    const run = element('div', 'ticker-run');
    for (const cve of kevCves) run.append(element('span', 'ticker-cve', cve));
    track.append(run);
  }

  // 한 벌의 폭을 기준으로 지속 시간을 정해 속도를 고정한다.
  requestAnimationFrame(() => {
    const oneRunWidth = track.scrollWidth / 2;
    if (oneRunWidth <= 0) return;
    const durationSec = oneRunWidth / TICKER_SPEED_PX_PER_SEC;
    track.style.animation = `ticker-scroll ${durationSec}s linear infinite`;
  });
}

// ---------------------------------------------------------------- 상단 바와 자기 진단

function renderTopbar(feed, now) {
  const dots = document.getElementById('status-dots');
  dots.textContent = '';

  const failedNames = [];
  for (const source of feed.sources) {
    const dot = element('div', 'dot');
    dot.dataset.status = source.status;
    // 색만으로 알리지 않도록 접근성 속성에 사유를 남긴다.
    dot.title = `${source.name}: ${source.status}${source.error ? ` (${source.error})` : ''}`;
    dots.append(dot);
    if (source.status === 'failed') failedNames.push(source.name);
  }

  // failed가 있을 때만 그 소스명을 함께 띄운다. 정상일 때는 아무 말도 하지 않는다.
  document.getElementById('failed-sources').textContent =
    failedNames.length > 0 ? `수집 실패: ${failedNames.join(', ')}` : '';

  const ageMs = now.getTime() - new Date(feed.generatedAt).getTime();
  const freshness = document.getElementById('freshness');
  freshness.textContent = `갱신 ${formatElapsed(feed.generatedAt, now)}`;
  freshness.dataset.level = ageMs >= STALE_URGENT_MS ? 'urgent' : ageMs >= STALE_WARN_MS ? 'warn' : 'ok';
}

function setBanner(message, level) {
  const banner = document.getElementById('banner');
  if (!message) {
    banner.dataset.visible = 'false';
    banner.textContent = '';
    return;
  }
  banner.textContent = message;
  banner.dataset.level = level;
  banner.dataset.visible = 'true';
}

/**
 * 화면이 자신의 상태를 스스로 말해주어야 한다.
 * 우선순위가 높은 문제 하나만 띄운다. 기사는 어느 경우에도 그대로 남긴다.
 */
function renderDiagnostics(now) {
  const feed = state.feed;

  if (feed && feed.schemaVersion > KNOWN_SCHEMA_VERSION) {
    setBanner('뷰어 업데이트 필요', 'urgent');
    return;
  }

  if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    setBanner('데이터 연결 끊김', 'urgent');
    return;
  }

  if (feed) {
    const ageMs = now.getTime() - new Date(feed.generatedAt).getTime();
    if (ageMs >= STALE_URGENT_MS) {
      setBanner('갱신 중단', 'urgent');
      return;
    }
  }

  setBanner(null);
}

// ---------------------------------------------------------------- 렌더링

function renderAll(now) {
  const feed = state.feed;
  if (!feed) return;

  renderTopbar(feed, now);
  renderTier1(feed.items, now);
  renderSocial(feed.items, now);
  renderTicker(feed.items);

  state.timelinePages = buildTimelinePages(feed.items);
  state.currentPageIndex = 0;
  showTimelinePage(0, now);

  renderDiagnostics(now);

  const fallback = document.getElementById('fallback');
  if (fallback) fallback.remove();
}

// ---------------------------------------------------------------- 데이터 읽기

async function loadFeed() {
  try {
    // cache: no-cache로 두면 브라우저가 If-None-Match를 붙여 조건부 요청을 보낸다.
    // 쿼리스트링 캐시 버스터를 쓰면 조건부 요청이 무의미해지므로 쓰지 않는다.
    const response = await fetch(FEED_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const feed = await response.json();
    if (!feed || !Array.isArray(feed.items)) throw new Error('feed.json 형태가 올바르지 않다');

    state.consecutiveFailures = 0;

    // 내용이 그대로면 DOM을 건드리지 않는다. 15초 페이지 전환이 끊기지 않게 하기 위함이다.
    // schemaVersion도 함께 본다. generatedAt이 같은데 스키마만 바뀐 응답을 놓치지 않기 위함이다.
    if (feed.generatedAt === state.lastGeneratedAt && feed.schemaVersion === state.feed?.schemaVersion) {
      renderDiagnostics(new Date());
      return;
    }

    state.feed = feed;
    state.lastGeneratedAt = feed.generatedAt;
    renderAll(new Date());
  } catch (error) {
    // fetch 실패는 직전 화면을 그대로 남긴다. 기사는 지우지 않는다.
    state.consecutiveFailures += 1;
    console.error('[wallboard] feed.json 조회 실패:', error.message);
    renderDiagnostics(new Date());
  }
}

// ---------------------------------------------------------------- 주기 작업

function startClock() {
  const tick = () => {
    const now = new Date();
    document.getElementById('clock').textContent = formatClock(now);

    // 경과 시간 표시가 멈춰 보이지 않도록 상단 바만 1초마다 다시 그린다.
    if (state.feed) renderTopbar(state.feed, now);

    // 매일 04:00에 화면 전체를 하드 새로고침한다.
    // 누수나 상태 오염은 장기 구동에서 결국 생기므로 마지막 보험으로 둔다.
    if (now.getHours() === HARD_RELOAD_HOUR && now.getDate() !== state.lastHardReloadDay) {
      state.lastHardReloadDay = now.getDate();
      location.reload();
    }
  };

  tick();
  setInterval(tick, CLOCK_TICK_MS);
}

function startPageFlip() {
  setInterval(() => {
    if (state.timelinePages.length <= 1) return;
    showTimelinePage(state.currentPageIndex + 1, new Date());
  }, PAGE_FLIP_MS);
}

/**
 * 픽셀 시프트. 24시간 고정 레이아웃은 번인을 일으키므로
 * 10분마다 ±4px 범위에서 전체 컨테이너를 천천히 움직인다.
 */
function startPixelShift() {
  const offsets = [
    [0, 0],
    [4, 2],
    [-4, 3],
    [3, -4],
    [-3, -2],
    [2, 4],
  ];
  let index = 0;

  setInterval(() => {
    index = (index + 1) % offsets.length;
    const [x, y] = offsets[index];
    document.getElementById('shell').style.transform = `translate(${x}px, ${y}px)`;
  }, PIXEL_SHIFT_MS);
}

function start() {
  startClock();
  startPageFlip();
  startPixelShift();

  loadFeed();
  setInterval(loadFeed, FEED_POLL_MS);
}

start();
