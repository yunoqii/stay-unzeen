# syntax=docker/dockerfile:1.7
# Unzeen adapters (relayer, indexer, hood relayer, operator scripts). Context: adapters/.
# Scripts run with tsx from source, as in the RUNBOOK (pnpm relayer:run == tsx scripts/relayer-run.ts).
FROM node:22-bookworm-slim
RUN npm install -g pnpm@10.20.0 \
 && groupadd -g 10001 app \
 && useradd -u 10001 -g app -d /data/home -M -s /usr/sbin/nologin app
WORKDIR /app/adapters
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# No .env in the image: env comes from /etc/unzeen/<instance>.env (compose env_file).
ENV NODE_ENV=production UNZEEN_HOME=/data/home HOME=/data/home
USER 10001:10001
CMD ["node_modules/.bin/tsx", "scripts/relayer-run.ts"]
