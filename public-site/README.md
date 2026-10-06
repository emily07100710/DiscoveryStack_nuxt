# DiscoveryStack public-site

`public-site` is the public-facing Astro static website for DiscoveryStack. It owns public pages, SEO/GEO explanations, brand content, public forms and the bounded free website-analysis interface. It does not contain a database, owner authentication, Audit Lab, training pipeline, private API routes, Nitro runtime, or provider SDK.

## Local development

Use Node `>=22.12` and pnpm `10.24.0`.

```bash
pnpm install
pnpm install --frozen-lockfile
PUBLIC_SITE_URL=http://localhost:4321 \
PUBLIC_OPS_API_ORIGIN=http://localhost:3000 \
PUBLIC_OPS_UI_ORIGIN=http://localhost:3000 \
pnpm dev
```

The public site runs on port `4321` and the private Nuxt ops/API app runs independently on port `3000`. In production, all three public-site origin variables must use HTTPS origins. Localhost is permitted only during development. `PUBLIC_OPS_UI_ORIGIN` may point at a separate Nuxt UI origin; when omitted it falls back to `PUBLIC_OPS_API_ORIGIN` because the current Nuxt service serves both surfaces.

## Production journey configuration

The target Render wiring after deploying this source uses only non-secret HTTPS origins:

| Service | Variable | Value |
| --- | --- | --- |
| `discoverystack-web` | `PUBLIC_SITE_URL` | `https://discoverystack-web.onrender.com` |
| `discoverystack-web` | `PUBLIC_OPS_API_ORIGIN` | `https://discoverystack-api.onrender.com` |
| `discoverystack-web` | `PUBLIC_OPS_UI_ORIGIN` | `https://discoverystack-api.onrender.com` |
| `discoverystack-api` | `DISCOVERYSTACK_PUBLIC_SITE_ORIGIN` | `https://discoverystack-web.onrender.com` |

After deployment with these values, public contact and analysis requests go to the Nuxt API, while the completed website-preview handoff links to `https://discoverystack-api.onrender.com/customer/managed-sites/start`. This is source/configuration guidance, not confirmation of the currently deployed version. A placeholder-origin build remains intentionally `noindex` and is suitable for static verification only; it is not launch-ready. A production site origin paired with a placeholder API/UI origin is rejected. This wiring does not prove Stripe, AI provider, domain purchase, DNS, TLS or customer-site deployment against real external services.

## Public API boundary

The browser may call only `POST /api/leads` and `POST /api/site-analysis` at `PUBLIC_OPS_API_ORIGIN`. The shared `publicApiFetch` helper accepts only those two paths, uses `credentials: 'omit'`, does not forward owner cookies, and returns safe public errors without exposing server/provider details.

The private Nuxt app is the only owner-authenticated application. The public site links only to the unauthenticated customer managed-site start flow, never to the owner workbench, and never shares owner session cookies.

## Verification

```bash
pnpm astro check
pnpm test
pnpm build
pnpm preview
```

The build is static and writes only `dist/`. The formal `pnpm test` script first runs one placeholder-origin static build and then runs all Vitest contracts, so it is self-contained even when `dist/` and `.astro/` do not exist. Placeholder builds must remain noindex: `robots.txt` is `Disallow: /` and the sitemap contains no indexable production URLs. `dist/` is a temporary verification artifact and must not be committed. Sitemap, robots, `llms.txt`, canonical links, hreflang links and JSON-LD are generated from public routes and content only.
