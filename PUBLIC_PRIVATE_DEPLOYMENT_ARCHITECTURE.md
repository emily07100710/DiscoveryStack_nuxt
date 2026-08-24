# Public / Private Deployment Architecture

## Scope and ownership

DiscoveryStack is split into two independently deployable applications. The public website is owned by the standalone static Astro application under `public-site/`. The private operational console and backend APIs remain owned by the Nuxt/Nitro application under `nuxt-app/`.

The split is architectural, not a public/private CSS or route convention. Public pages, public Markdown, public SEO metadata, public GEO copy, brand presentation, consent UI and the two intentionally public form/analysis calls belong to Astro. Nuxt no longer owns or prerenders the public marketing/content website.

| Area | Public Astro site | Private Nuxt/Nitro application |
|---|---|---|
| Source directory | `public-site/` | `nuxt-app/` |
| Runtime | Static files served by a static host/CDN | Node/Nitro server runtime |
| Public pages | `/`, `/en`, `/zh-hant`, bilingual privacy, services, methodology, glossary and publication pages | None of the public marketing/content routes |
| Private UI | None | `/audit-lab`, `/audit-lab/**`, `/leads`, `/training-pipeline`, `/ml-lab-preview` and owner-only operations |
| Data/auth | No database, owner auth, session access, training data or model weights | Existing owner auth, database, schema/migrations, providers, training and operational APIs |
| Public API calls | Only `POST /api/leads` and `POST /api/site-analysis` through the strict client allowlist | Nitro handlers for those two calls plus private APIs without public CORS |
| Deployment artifact | `public-site/dist/` | Nuxt/Nitro production output |

The sole public content source is Astro content under `public-site/src/content/pages/`. Nuxt does not retain a second copy of the public Markdown source or the public page components.

## Deployments and origins

The intended production topology has two separate origins, represented below by placeholders rather than real domains:

```text
PUBLIC_SITE_ORIGIN  = https://<public-site-origin>
PRIVATE_OPS_ORIGIN   = https://<private-ops-origin>

Browser
  ├── public pages and public assets → PUBLIC_SITE_ORIGIN (static Astro host)
  └── owner console / APIs          → PRIVATE_OPS_ORIGIN (Nuxt/Nitro server)
```

The Astro site does not link customers into the private workbench, embed the private app, share an owner session, or read the private origin's cookies. The private app's owner layout links back to the configured public origin without restoring public routes inside Nuxt.

There is **no cross-site owner cookie**. Owner authentication/session cookies are private-origin cookies handled only by Nuxt/Nitro. The Astro site has no database/auth session access and sends `credentials: 'omit'` for both public API calls. Any public consent cookie is first-party to the public origin and is not an owner credential.

## Public API and CORS boundary

Exactly two browser-callable API routes cross the public/private boundary:

| Method | Route | Purpose | CORS |
|---|---|---|---|
| `POST` | `/api/leads` | Public fit-review or report-unlock submission, retaining the existing body contract | Exact configured public origin only |
| `POST` | `/api/site-analysis` | Bounded public-homepage structural analysis, retaining the existing body contract | Exact configured public origin only |
| `OPTIONS` | The two routes above | Preflight only; must terminate before handler/DB work | Exact configured public origin only |

The client-side `publicApiFetch` allowlist accepts only those two path literals. It does not accept an arbitrary URL or path, always sends JSON, and uses `credentials: 'omit'`. Public errors are generic and do not expose private implementation details.

The Nitro CORS middleware is fail-closed. It permits only an exact origin match, `POST`/`OPTIONS`, and `Content-Type` as the allowed request header. It never emits `Access-Control-Allow-Credentials: true` or a wildcard origin. Origin mismatch, missing production origin configuration and an invalid preflight method are rejected. Private routes such as `/api/audit`, `/api/intelligence`, `/api/seo-geo/**`, `/api/geo/**`, auth, owner and lead-management GET/PATCH routes receive no public CORS allow header.

## Environment variables

Production values must be supplied by the hosting environments; no values are committed in this repository. The following are the relevant split variables:

| Application | Variable | Exposure | Requirement |
|---|---|---|---|
| Astro | `PUBLIC_SITE_URL` | Public build-time URL | Absolute HTTPS origin in production; localhost is allowed only for local development |
| Astro | `PUBLIC_OPS_API_ORIGIN` | Public build-time API target | Absolute HTTPS private API origin in production; used only to construct the two allowed public calls |
| Nuxt | `DISCOVERYSTACK_PUBLIC_SITE_ORIGIN` | Server runtime plus a non-sensitive public mirror | Absolute HTTPS public origin in production; used by exact-origin CORS and owner exit link |
| Nuxt | Existing private runtime variables | Server-only | Auth, database, provider and model-improvement settings stay private and are not copied to Astro |

Do not put `DATABASE_URL`, `JWT_SECRET`, OAuth secrets, provider API keys, training credentials, model artifacts or private API configuration in `public-site/`. Do not commit `.env` files or replace the placeholder values in `.env.example` with real deployment values.

## Local development ports and commands

The following ports are conventional local defaults and are not production URLs:

| Service | Port | Command |
|---|---:|---|
| Static Astro dev server | `4321` | `cd public-site && pnpm dev -- --port 4321` |
| Nuxt private dev server | `3000` | `cd nuxt-app && pnpm dev -- --port 3000` |

For local cross-origin testing, set the Astro API origin to the local Nuxt origin and use a local HTTP exception only where the application explicitly permits development. Do not carry localhost exceptions into production.

Astro validation/build:

```bash
cd public-site
pnpm install --frozen-lockfile
pnpm astro check
pnpm test
PUBLIC_SITE_URL=https://<public-site-origin> \
PUBLIC_OPS_API_ORIGIN=https://<private-ops-origin> \
pnpm build
```

Nuxt private validation/build:

```bash
cd nuxt-app
pnpm install --frozen-lockfile
pnpm typecheck
NITRO_PRESET=node-server pnpm build
```

The Nuxt build is a private server artifact. It must not be used as the public static website build and must not prerender the public marketing/content route set.

## Deployment order

1. Build and validate the private Nuxt/Nitro artifact. Configure `DISCOVERYSTACK_PUBLIC_SITE_ORIGIN` and the private runtime secrets in the private host only. Verify that root `/` redirects to `/audit-lab`, private routes remain protected/noindex, and the two public POST handlers are available.
2. Deploy the private API/runtime artifact to the private operations origin. Verify exact-origin `OPTIONS` and `POST` behavior for `/api/leads` and `/api/site-analysis`, and verify that a representative private route has no public CORS allow header.
3. Build the Astro artifact with the public origin and private API origin. Deploy only `public-site/dist/` to the public static host/CDN.
4. Verify public routes, canonical/hreflang/robots/sitemap/llms output, public forms, and browser calls from the public origin. Verify that no `/api`, owner, Audit Lab, training or private strings are present in the public static artifact.
5. Only after both artifacts pass their independent checks should traffic/DNS configuration be changed by the deployment owner. This repository task does not perform that change.

No deployment, DNS change, provider write, CMS write, WordPress write or generic HTTP delivery write is part of this change.

## Rollback

Rollback is independently reversible because public pages and private runtime are separate artifacts.

If the public site fails, restore the previous known-good Astro static artifact on the public host while leaving the private Nuxt runtime unchanged. If the private API/runtime fails, restore the previous known-good Nuxt/Nitro artifact and temporarily restore the previous public artifact if the API contract is not compatible. Re-run the two-route CORS smoke checks after either rollback.

This split introduces **no database migration** and no schema change. Rollback therefore does not require a database rollback. Do not apply an unapplied migration as part of deployment or rollback for this change. If a future unrelated migration is needed, it must be reviewed, tested against a throwaway database, and deployed through its own approved process.

## Explicit non-actions for this change

This repository operation does not deploy either application, does not change DNS or domains, does not edit secrets or `.env` files, does not access a production database, does not apply or create a migration, does not modify schema, clients, training data, model weights or database content, and does not call an external content provider/CMS/WordPress/HTTP delivery target for a write.
