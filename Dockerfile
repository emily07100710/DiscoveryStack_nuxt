FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The Nuxt application is deliberately isolated under nuxt-app/ so the hosting
# project metadata and its secrets never become part of the application source.
COPY nuxt-app/package.json nuxt-app/pnpm-lock.yaml nuxt-app/pnpm-workspace.yaml ./
COPY nuxt-app/patches ./patches

RUN npm install -g corepack@latest \
  && corepack pnpm install --frozen-lockfile --ignore-scripts=false \
  && corepack pnpm rebuild better-sqlite3

COPY nuxt-app/ ./

# This creates .output/server/index.mjs and preserves live Nitro API routes.
RUN DISCOVERYSTACK_SKIP_PRERENDER=1 corepack pnpm run build

ENV NODE_ENV=production
ENV NITRO_HOST=0.0.0.0

CMD ["node", ".output/server/index.mjs"]
