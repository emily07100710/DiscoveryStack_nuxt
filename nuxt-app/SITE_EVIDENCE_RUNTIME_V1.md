# Site Evidence Runtime V1

## Purpose

Site Evidence V1 is an owner-scoped, server-side inventory and diagnostic engine for public sites. It fills the site-level gap described by `GEO_ENGINEERING_SPEC_V2.md` §9: multi-source URL discovery, raw evidence, bounded rendered evidence, canonical/normalization checks, sitemap reconciliation, and deterministic findings.

Phase 1 contains schema, engine code, and tests only. HTTP routes, pages, tasks, cron, migration generation/application, and deployment are outside this slice. The service exports are deliberately callable from thin owner-authenticated H3 handlers in Phase 2.

## Data model

- `siteEvidenceScans`: owner-scoped run ledger, progress heartbeat, caps, terminal status, error code, and honest limitations.
- `siteEvidenceUrls`: persistent owner inventory merged by SHA-256 of normalized URL; the original URL is never used as a unique key.
- `siteEvidenceSnapshots`: capped raw or Firecrawl-rendered HTML, hashes, response metadata, and extracted signals.
- `siteEvidenceSitemaps`: every fetched or failed sitemap document and its bounded parse result.
- `siteEvidenceFindings`: deterministic reconciliation findings with `detected` or `unknown` status.

All read APIs require `ownerUserId`. Repository reads and writes preserve owner predicates at tenant-facing boundaries. The only unscoped scan lookup is the internal background-run entry point, which receives an opaque durable scan ID created by an authenticated caller.

## Crawl algorithm and limits

1. Validate a public HTTP/HTTPS origin and create or replay the owner/idempotency ledger row.
2. Mark the run `running` and write a heartbeat.
3. Fetch `/robots.txt`; record availability, rules, and absolute `Sitemap:` directives.
4. Fetch declared sitemaps first, otherwise `/sitemap.xml`; if declared documents yield no URLs, try the well-known sitemap.
5. Follow a sitemap index one level. Parse at most 5,000 entries per document and consider at most `maxPages * 5` sitemap URLs.
6. Seed the queue with the origin root and same-site sitemap URLs.
7. Crawl same-site internal links breadth-first to depth 3 with two workers, at least 250ms spacing per worker, and no more than 200 page attempts.
8. Persist progress at least every five page attempts. Stop after 15 minutes with `completed_partial` and a limitation.
9. Render the homepage plus the ten highest internal-in-degree pages; ties sort by ascending normalized URL.
10. Reconcile inventory, sitemap, canonical, redirects, duplicates, soft-404 signals, and raw/rendered evidence; then finish with a terminal status.

Rendered capture uses Firecrawl v2 single-URL `POST /scrape` with `formats: ['html']`. No local JavaScript is executed. Missing configuration or provider failure produces an unavailable snapshot, `rendered_snapshots_unavailable`, and a truthful `completed_partial` run; HTML is never fabricated.

## §28.1 safety mapping

| Threat / requirement | V1 control |
| --- | --- |
| SSRF, private/reserved IP, metadata | Existing `assertSafeAuditTarget`; DNS results checked against the existing `isPublicIpAddress` policy before every request and redirect hop |
| Scheme, credentials, ports | HTTP/HTTPS only; no URL credentials; ports limited to 80/443 |
| Redirect abuse | `redirect: manual`; at most five redirects; every resolved hop is guard- and DNS-checked |
| Timeout | 10 seconds per page/robots/sitemap request; 30 seconds per renderer request; 15-minute scan deadline |
| Oversized/decompression response | Streamed hard read cap of 1MB; no unbounded `text()` read |
| Malicious MIME | Purpose-specific content-type allowlists; HTML-tolerant sitemap parsing still fails honestly when invalid |
| Script execution | Raw HTML is parsed as inert text; no DOM or JavaScript execution |
| Credential leakage | Requests contain only `Accept` and `User-Agent`; no cookies, customer auth, or reused browser state |
| Unbounded load | 200 pages, depth 3, concurrency 2, per-worker spacing, one-level sitemap index, bounded render set |

`assertPublicDns` is currently private to `publicSiteAnalysis.ts`. Because that existing file is outside this phase's allowed edit scope, V1 reuses its exported `isPublicIpAddress` authority with the same `lookup(all: true, verbatim: true)` fail-closed rule. This does not weaken the existing policy.

## Explicit evidence policies

### Stored HTML departure

This engine stores raw and rendered HTML bodies capped to 512KB before insertion. This is a deliberate departure from the public-intelligence “hashes/features only” rule. Site Evidence is an owner-requested diagnostic record of the owner’s or customer’s own public site, and raw-versus-rendered diagnosis must remain reproducible. Bodies remain owner-scoped. The fetch layer may inspect up to 1MB, but only the capped body is persisted; `bodyTruncated` records the loss.

### robots.txt evidence, not a gate

Robots rules are parsed and stored as `allowed`, `disallowed`, or `unavailable` evidence. They do not block fetching. This is a fixed owner-product decision for a bounded diagnostic tool, compensated by the page/depth/concurrency/deadline limits and request spacing. A disallowed URL is still fetched and its verdict remains visible.

### Honest unknown

- Raw/rendered checks are `unknown` whenever rendered evidence is unavailable or the page was not selected for the bounded rendered set.
- Provider configuration is not proof of successful capture.
- A missing or failed robots response is `unavailable`, never inferred as an explicit allow.
- Failed fetches retain stable reason codes and do not acquire invented HTTP, canonical, hash, or body evidence.
- Local/unit proof does not establish live DNS, Firecrawl, database migration, deployment, or customer-site behavior.

## Known limitations

- DNS validation is check-then-fetch. The HTTP client may re-resolve after the public-IP check, leaving DNS-rebinding TOCTOU risk. This matches the repo-wide existing guard and is not worsened here; true socket-address pinning requires a separate transport change.
- There is no local browser or JavaScript execution. Rendered truth depends on Firecrawl availability and its returned HTML.
- Nitro/Render free-tier sleep can strand a detached `running` scan. Status reads report heartbeats older than three minutes as `stale_scan`; `markStaleScans` can persist that terminal state when called explicitly. V1 adds no cron.
- Sitemap parsing is intentionally hand-written and bounded. It handles common namespaces, CDATA, whitespace, and plain text, not arbitrary XML features or compressed sitemap files.
- URL site scope is exact host plus the direct `www`/apex twin only. Subdomains and non-standard ports are excluded.
- Render ranking uses observed raw internal links, not analytics importance or verified business value.

## Verification contract

Default tests inject fetch and DNS implementations and make no real network calls. The only live test is skipped unless `DS_RUN_SITE_EVIDENCE_LIVE=1`; it is a bounded, read-only broad-invariant check. Migration generation and every `db:*` command remain a lead-owned follow-up.
