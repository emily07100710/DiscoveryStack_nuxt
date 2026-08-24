# DiscoveryStack public-site

`public-site` is the public-facing Astro static website for DiscoveryStack. It owns public pages, SEO/GEO explanations, brand content, public forms and the bounded free website-analysis interface. It does not contain a database, owner authentication, Audit Lab, training pipeline, private API routes, Nitro runtime, or provider SDK.

## Local development

Use Node `>=22.12` and pnpm `10.24.0`.

```bash
pnpm install
pnpm install --frozen-lockfile
PUBLIC_SITE_URL=http://localhost:4321 \
PUBLIC_OPS_API_ORIGIN=http://localhost:3000 \
pnpm dev
```

The public site runs on port `4321` and the private Nuxt ops/API app runs independently on port `3000`. In production, both public-site origin variables must use HTTPS origins. Localhost is permitted only during development.

## Public API boundary

The browser may call only `POST /api/leads` and `POST /api/site-analysis` at `PUBLIC_OPS_API_ORIGIN`. The shared `publicApiFetch` helper accepts only those two paths, uses `credentials: 'omit'`, does not forward owner cookies, and returns safe public errors without exposing server/provider details.

The private Nuxt app is the only owner-authenticated application. The public site does not link customers into the owner workbench and never shares owner session cookies.

## Verification

```bash
pnpm astro check
pnpm test
pnpm build
pnpm preview
```

The build is static and writes only `dist/`. The formal `pnpm test` script first runs one placeholder-origin static build and then runs all Vitest contracts, so it is self-contained even when `dist/` and `.astro/` do not exist. Placeholder builds must remain noindex: `robots.txt` is `Disallow: /` and the sitemap contains no indexable production URLs. `dist/` is a temporary verification artifact and must not be committed. Sitemap, robots, `llms.txt`, canonical links, hreflang links and JSON-LD are generated from public routes and content only.
