FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN npm install -g corepack@latest \
  && corepack pnpm install --ignore-scripts=false \
  && corepack pnpm rebuild better-sqlite3 \
  && corepack pnpm run build

ENV NODE_ENV=production
CMD ["node", ".output/server/index.mjs"]
