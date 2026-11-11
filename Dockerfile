# 수집기 컨테이너. 뷰어는 nginx가 public/을 그대로 제공하므로 여기에 들어가지 않는다.
FROM node:22-alpine

WORKDIR /app

# 의존성 레이어를 따로 두어 소스만 바뀔 때 재설치하지 않게 한다.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 수집에 필요한 것만 복사한다. node_modules와 .env는 복사하지 않는다.
COPY collector/ ./collector/
COPY scripts/ ./scripts/
COPY scheduler.js sources.yml keywords.yml ./

# 볼륨으로 덮이지만, 볼륨 없이 띄워도 동작하도록 미리 만들어 둔다.
RUN mkdir -p /app/public/data /app/cache

# 로그 시각을 한국 시간으로 읽기 위한 기본값. compose에서 덮어쓸 수 있다.
ENV TZ=Asia/Seoul

CMD ["node", "scheduler.js"]
