// 로컬 확인용 정적 파일 서버.
//
// 운영에서는 nginx가 public/을 그대로 제공한다(docker-compose.yml 참고).
// 이 스크립트는 개발 중 `npm run serve`로 화면을 띄워 보기 위한 것이다.
// 의존성을 더하지 않기 위해 node:http로만 만들었다.
// 뷰어의 조건부 요청을 확인할 수 있도록 ETag와 304 응답을 지원한다.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'public');
const port = Number.parseInt(process.env.PORT ?? '8080', 10);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);
    const relativePath = decodeURIComponent(requestUrl.pathname);
    const target = path.join(root, relativePath === '/' ? 'index.html' : relativePath);

    // 루트 밖으로 나가는 경로는 거부한다.
    if (!target.startsWith(root)) {
      response.writeHead(403).end('403');
      return;
    }

    const stats = await fs.stat(target);
    const etag = `W/"${stats.size}-${Number(stats.mtimeMs).toString(16)}"`;

    // 조건부 요청: 바뀐 게 없으면 304로 끝낸다.
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { ETag: etag }).end();
      return;
    }

    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stats.size,
      ETag: etag,
      // feed.json은 항상 재검증하게 둔다. 그래야 60초 폴링이 의미가 있다.
      'Cache-Control': 'no-cache',
    });
    response.end(await fs.readFile(target));
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
  }
});

server.listen(port, () => {
  console.log(`[serve] ${root} -> http://localhost:${port}/`);
});
