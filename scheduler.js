// NAS Docker용 스케줄러.
//
// 호스트 cron에 의존하지 않고 컨테이너 안에서 직접 주기를 돈다.
// 그래야 NAS 기종이나 OS에 상관없이 똑같이 동작한다.
//
// 티어별 주기: T1·T2는 15분, T3·T4는 30분.
//
// 수집은 별도 프로세스로 띄운다. 몇 주씩 떠 있는 프로세스에서
// 누수나 상태 오염이 쌓이는 것을 피하고, 수집이 죽어도 스케줄러는 살아남는다.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const collectorPath = path.join(projectRoot, 'collector', 'index.js');

// 한국 시간 기준으로 돈다. UTC로 두면 운영자가 로그를 읽을 때 9시간이 어긋난다.
const TIMEZONE = process.env.TZ || 'Asia/Seoul';

// 동시에 두 수집이 돌면 서로의 결과를 덮어쓴다.
// 원자적 쓰기는 읽는 쪽만 보호하므로, 쓰는 쪽은 여기서 직렬화한다.
let running = false;
const queue = [];

function runCollector(tiers) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const label = tiers.join(',');
    console.log(`[scheduler] ${new Date().toISOString()} 수집 시작 tiers=${label}`);

    // --env-file-if-exists로 .env를 읽는다. 파일이 없으면 그냥 넘어가고,
    // 컨테이너가 넘겨준 환경변수가 파일보다 우선한다(Docker·Actions 경로를 깨지 않는다).
    const child = spawn(process.execPath, ['--env-file-if-exists=.env', collectorPath, `--tiers=${label}`], {
      cwd: projectRoot,
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      const elapsedMs = Date.now() - startedAt;
      // 종료 코드 1은 유효성 게이트가 막았다는 뜻이다. 화면은 직전 데이터로 계속 돈다.
      const verdict = code === 0 ? '완료' : `게이트 실패 또는 오류(코드 ${code}) — 기존 feed.json 유지`;
      console.log(`[scheduler] 수집 ${verdict} tiers=${label} ${elapsedMs}ms`);
      resolve();
    });

    child.on('error', (error) => {
      console.error(`[scheduler] 수집 프로세스 실행 실패: ${error.message}`);
      resolve();
    });
  });
}

async function drainQueue() {
  if (running) return;
  running = true;

  while (queue.length > 0) {
    const tiers = queue.shift();
    await runCollector(tiers);
  }

  running = false;
}

function enqueue(tiers) {
  const label = tiers.join(',');
  // 같은 조합이 이미 대기 중이면 중복해서 쌓지 않는다.
  if (queue.some((pending) => pending.join(',') === label)) {
    console.log(`[scheduler] tiers=${label} 이(가) 이미 대기 중이라 건너뛴다`);
    return;
  }
  queue.push(tiers);
  drainQueue();
}

// 컨테이너가 다시 떴을 때 화면이 비어 있지 않도록 시작하자마자 한 번 전체를 돈다.
enqueue(['T1', 'T2', 'T3', 'T4']);

cron.schedule('*/15 * * * *', () => enqueue(['T1', 'T2']), { timezone: TIMEZONE });
cron.schedule('*/30 * * * *', () => enqueue(['T3', 'T4']), { timezone: TIMEZONE });

console.log(`[scheduler] 기동 완료. T1·T2 15분, T3·T4 30분 주기 (${TIMEZONE})`);
