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
ENV SHEETS_WEBAPP_URL=$SHEETS_WEBAPP_URL
ENV SHEETS_TOKEN=$SHEETS_TOKEN
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /src/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
