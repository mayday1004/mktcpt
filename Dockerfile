FROM node:20-alpine AS build
WORKDIR /src
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY index.html build.js ./
COPY app ./app
COPY apps-script ./apps-script
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /src/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
