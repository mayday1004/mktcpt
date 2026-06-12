FROM node:20-alpine AS build
WORKDIR /src
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY index.html build.js ./
COPY app ./app
COPY apps-script ./apps-script
# Secrets are not baked into app.js. server.mjs serves /config.js from
# runtime env vars each time the container starts.
# 把 commit SHA 傳進 build 階段,讓 build.js 用真正的 commit id 當 build identifier。
# 沒傳就會 fallback 到 Date.now().toString(36) → 每次 deploy(即使 code 沒變)都生不同 id,
# 前端 cold-start gate 觸發 → 清掉本機資料(尤其 JSON 匯入後 reload 會看到資料消失)。
# Railway 預設注入 RAILWAY_GIT_COMMIT_SHA;其他 CI 可改傳 GIT_SHA / COMMIT_SHA。
ARG RAILWAY_GIT_COMMIT_SHA=""
ENV RAILWAY_GIT_COMMIT_SHA=$RAILWAY_GIT_COMMIT_SHA
RUN npm run build

FROM node:20-alpine
COPY --from=build /src/dist /srv
COPY server.mjs /app/server.mjs
CMD ["node", "/app/server.mjs"]
