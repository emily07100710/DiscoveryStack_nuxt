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

# `pnpm install` runs the package prepare hook before the application source is
# copied into this layer. Start from clean generated output after the full source
# tree exists, then verify the live Nitro SSR server contains the current OAuth
# release marker rather than a stale artifact.
RUN rm -rf .nuxt .output \
  && corepack pnpm exec nuxt prepare \
  && DISCOVERYSTACK_SKIP_PRERENDER=1 corepack pnpm run build \
  && grep -R -q 'nitro-oauth-20260816-r4' .output/server

ENV NODE_ENV=production
ENV NITRO_HOST=0.0.0.0

CMD ["node", ".output/server/index.mjs"]
