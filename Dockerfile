FROM node:20-alpine AS build
WORKDIR /src
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY index.html build.js ./
COPY app ./app
COPY apps-script ./apps-script
# Build-time secrets injected by Railway Variables.
# ARG declarations are required for Railway/Docker to forward variables into
# the build stage; ENV makes them visible to process.env inside build.js.
# Changing these values in Railway invalidates this layer's cache automatically.
ARG SHEETS_WEBAPP_URL=""
ARG SHEETS_TOKEN=""
ARG YOURLS_WAKE_URL=""
ARG YOURLS_WAKE_TOKEN=""
ENV SHEETS_WEBAPP_URL=$SHEETS_WEBAPP_URL
ENV SHEETS_TOKEN=$SHEETS_TOKEN
ENV YOURLS_WAKE_URL=$YOURLS_WAKE_URL
ENV YOURLS_WAKE_TOKEN=$YOURLS_WAKE_TOKEN
# 把 commit SHA 傳進 build 階段,讓 build.js 用真正的 commit id 當 build identifier。
# 沒傳就會 fallback 到 Date.now().toString(36) → 每次 deploy(即使 code 沒變)都生不同 id,
# 前端 cold-start gate 觸發 → 清掉本機資料(尤其 JSON 匯入後 reload 會看到資料消失)。
# Railway 預設注入 RAILWAY_GIT_COMMIT_SHA;其他 CI 可改傳 GIT_SHA / COMMIT_SHA。
ARG RAILWAY_GIT_COMMIT_SHA=""
ENV RAILWAY_GIT_COMMIT_SHA=$RAILWAY_GIT_COMMIT_SHA
RUN npm run build

FROM caddy:2-alpine
ARG SHEETS_WEBAPP_URL=""
ARG SHEETS_TOKEN=""
ARG YOURLS_WAKE_URL=""
ARG YOURLS_WAKE_TOKEN=""
ENV SHEETS_WEBAPP_URL=$SHEETS_WEBAPP_URL
ENV SHEETS_TOKEN=$SHEETS_TOKEN
ENV YOURLS_WAKE_URL=$YOURLS_WAKE_URL
ENV YOURLS_WAKE_TOKEN=$YOURLS_WAKE_TOKEN
COPY --from=build /src/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
COPY docker-entrypoint.sh /usr/local/bin/buyads-entrypoint
CMD ["sh", "/usr/local/bin/buyads-entrypoint"]
