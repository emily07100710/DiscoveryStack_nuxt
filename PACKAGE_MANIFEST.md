# DiscoveryStack Astro/Public–Private Split Package Manifest

## Package identity

| Field | Value |
|---|---|
| Base commit | `6a24ace4e1924307b82adbaa809c2d8fc4914158` |
| Working branch | `feature/astro-public-private-split` |
| Current state | Source state prepared for the one ordinary commit permitted after every acceptance gate passes; the exact final commit/remote SHA is recorded in the delivery report |
| Public app | `public-site/` — Astro static output |
| Private app | `nuxt-app/` — Nuxt/Nitro private operations and API runtime |
| Visual evidence | `review-evidence/visual-parity/` |

## Included source and evidence

This package includes the standalone Astro source, its pinned package manifest and lockfile, public content collection, public Vue islands, static route generators, public API allowlist, public tests and README; the private Nuxt source, CORS middleware/policy, owner layout, private API/server code, tests and README; the root split architecture document; and the authoritative visual evidence README, capture/compare/stability scripts, 24-row final matrix, 48-row screenshot SHA-256 manifest and capture metadata.

The public-site test script is self-contained: `pnpm test` first creates a placeholder-origin static build and then runs all Vitest tests. Placeholder output is required to remain noindex and is not a production deployment artifact.

## Validation status

The strict visual gate passed with 5 baseline stability rounds (192/192 comparisons) and 3 independent candidate rounds (72/72 comparisons); the final candidate matrix is 24/24 under the homepage `≤1.0%` and content/privacy `≤0.5%` thresholds. Public Astro tests passed 17/17, the exact SEO/GEO targeted suite passed 15 files/82 tests, and private boundary targets passed 7 files/32 tests. Full Nuxt Vitest still reports five external provider credential failures, identical to the known base/environment condition; no split-specific test failure was observed.

The final decision is recorded in `FINAL_NOT_READY_REPORT.md` using the historical filename retained from the previous not-ready stage. The filename is historical; the report records the exact final decision, commands, evidence and limitations and must not be interpreted as permission to bypass any gate.

## Explicit exclusions

The package excludes `.git/`, `node_modules/`, `public-site/dist/`, `public-site/.astro/`, `nuxt-app/.nuxt/`, `nuxt-app/.output/`, screenshots, browser profiles, temporary capture directories, logs, Python bytecode, `.env` files, secrets, credentials, production database content, migrations and schema changes. `.env.example` files are retained only as placeholder configuration templates without real domains or secrets.

No commit, push, deployment, DNS/domain change, production database access, migration application/creation, provider write, CMS/WordPress write or generic HTTP delivery write is performed merely by preparing this package.
