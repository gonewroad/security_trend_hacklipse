// sources.yml의 모든 항목을 한 번에 확인해 표로 출력한다.
//
// 피드는 조용히 죽거나 주소를 옮긴다. 화면이 비기 전에 알아채기 위한 스크립트다.
// 출력: HTTP 상태, 리다이렉트 여부와 최종 URL, Content-Type, 파싱된 항목 수, 가장 최신 항목의 발행 시각.
//
// 조건부 요청 캐시(cache/http.json)는 일부러 쓰지 않는다. 매번 실제 응답을 확인한다.

import fs from 'node:fs/promises';
import YAML from 'yaml';

import { createLimiter, shortErrorReason } from '../collector/http.js';
import { parseDateLenient, toIsoSeconds } from '../collector/normalize.js';
import { fetchRss } from '../collector/fetchers/rss.js';
import { fetchAtom } from '../collector/fetchers/atom.js';
import { fetchJson } from '../collector/fetchers/json.js';
import { fetchBsky } from '../collector/fetchers/bsky.js';

const FETCHERS = { rss: fetchRss, atom: fetchAtom, json: fetchJson, bsky: fetchBsky };
const TIMEOUT_MS = 15_000; // 확인용이므로 수집보다 넉넉하게 준다

// 전각 문자(한글)는 터미널에서 두 칸을 차지한다. 표를 맞추기 위해 폭을 따로 센다.
function displayWidth(text) {
  let width = 0;
  for (const character of String(text)) {
    width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(character) ? 2 : 1;
  }
  return width;
}

function pad(text, width) {
  const value = String(text);
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

function truncateForTable(text, limit) {
  const value = String(text ?? '');
  return displayWidth(value) <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

async function verifySource(source) {
  const fetcher = FETCHERS[source.type];
  if (!fetcher) {
    return { source, ok: false, note: `알 수 없는 타입: ${source.type}` };
  }

  try {
    const result = await fetcher(source, { timeoutMs: TIMEOUT_MS });
    const { response, entries } = result;

    // 가장 최신 항목의 발행 시각. 관대한 파싱을 그대로 쓴다.
    let newest = null;
    for (const entry of entries) {
      const parsed = parseDateLenient(entry.publishedAtRaw);
      if (parsed && (newest === null || parsed > newest)) newest = parsed;
    }

    return {
      source,
      ok: entries.length > 0,
      status: response.status,
      redirected: response.redirectCount > 0,
      finalUrl: response.finalUrl,
      contentType: response.contentType.split(';')[0].trim(),
      parsedKind: result.parsedKind,
      itemCount: entries.length,
      newestPublishedAt: newest ? toIsoSeconds(newest) : null,
      note: entries.length === 0 ? '파싱된 항목이 0건이다' : '',
    };
  } catch (error) {
    return { source, ok: false, note: shortErrorReason(error) };
  }
}

async function main() {
  const parsed = YAML.parse(await fs.readFile('sources.yml', 'utf8'));
  const sources = parsed?.sources ?? [];
  if (sources.length === 0) {
    console.error('sources.yml에 소스가 없다');
    process.exitCode = 1;
    return;
  }

  const limit = createLimiter(6);
  const results = await Promise.all(sources.map((source) => limit(() => verifySource(source))));

  const columns = [
    ['소스', 22],
    ['티어', 5],
    ['상태', 5],
    ['리다이렉트', 11],
    ['Content-Type', 26],
    ['포맷', 10],
    ['항목', 5],
    ['최신 발행', 21],
  ];

  console.log(columns.map(([title, width]) => pad(title, width)).join(' '));
  console.log(columns.map(([, width]) => '-'.repeat(width)).join(' '));

  for (const result of results) {
    const { source } = result;
    const disabled = source.enabled === true ? '' : ' (비활성)';
    console.log(
      [
        pad(truncateForTable(source.id + disabled, 22), 22),
        pad(source.tier ?? '-', 5),
        pad(result.status ?? 'ERR', 5),
        pad(result.redirected ? '예' : result.status ? '아니오' : '-', 11),
        pad(truncateForTable(result.contentType ?? '-', 26), 26),
        pad(result.parsedKind ?? '-', 10),
        pad(result.itemCount ?? '-', 5),
        pad(result.newestPublishedAt ?? '-', 21),
      ].join(' '),
    );

    // 리다이렉트된 소스는 최종 URL을 반드시 보여준다. 주소를 옮긴 피드를 찾는 목적이다.
    if (result.redirected) console.log(`${' '.repeat(23)}└ 최종 URL: ${result.finalUrl}`);
    if (result.note) console.log(`${' '.repeat(23)}└ ${result.note}`);
  }

  const enabledFailures = results.filter((result) => result.source.enabled === true && !result.ok);
  console.log('');
  console.log(
    `확인 ${results.length}개 중 활성 소스 실패 ${enabledFailures.length}개` +
      (enabledFailures.length > 0 ? `: ${enabledFailures.map((r) => r.source.id).join(', ')}` : ''),
  );

  // CI에서 쓸 수 있도록 활성 소스가 하나라도 실패하면 종료 코드 1로 끝낸다.
  if (enabledFailures.length > 0) process.exitCode = 1;
}

await main();
