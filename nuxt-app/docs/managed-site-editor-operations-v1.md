# Managed-site Media Vault and Page Editor V1 operations

This document describes source behavior. It is not evidence that a production database was migrated, a real object was stored, a scanner/provider was called, or a customer site was deployed.

## Authority and roles

Every `/api/managed-sites/editor/**` request reconstructs the existing managed-site project and active membership from the owner/customer session. Email, request-body actor fields, bucket names, object keys, release IDs and publication target IDs are not accepted as authority. Responses are private, `no-store`, `noindex`, `noarchive` and `no-referrer`. Mutations require exact same-origin checks.

| Existing role | Read | Edit/upload | Publish/rollback | Billing/domain/credentials |
| --- | --- | --- | --- | --- |
| owner / administrator | yes | yes | yes | only through existing separately governed products |
| editor | yes | yes | no | no |
| reviewer / analyst | yes | no | no | no |

The editor never delivers platform source code. Customer export includes canonical PageDocuments, customer media metadata, collections/tags and audit receipt identities; it excludes source, storage object keys, credentials and provider secrets. Original-byte downloads require a short-lived site-scoped signed read.

## Storage and processing configuration

Production storage is S3-compatible. A platform owner records a fixed bucket, region, prefix and optional HTTPS endpoint/CDN origin plus an opaque uppercase credential reference. The referenced environment value is server-only JSON containing `accessKeyId`, `secretAccessKey` and optional `sessionToken`. Caller-provided URLs, buckets and keys are rejected. Local filesystem storage is development-only and cannot resolve in `NODE_ENV=production`.

An optional HTTP security scanner uses `NUXT_MEDIA_SCANNER_ENDPOINT` and `NUXT_MEDIA_SCANNER_CREDENTIAL_REF`. The endpoint must be one exact server-owned public HTTPS scheme/hostname/port/path authority. Credentials, query, fragment, redirects, IP literals, localhost, `.local`, `.onion`, `.example` and IANA/special-use hostnames are rejected. Requests use manual redirect handling, bounded timeouts/retries and responses limited to 32 KiB. The durable connection must also hold a matching authority fingerprint and successful health receipt. DNS rebinding and ultimate egress control must additionally be enforced by the deployment network/proxy. If scanner settings or verified health authority are absent, uploads remain quarantined. External credential tests are explicit opt-in; normal tests use injected deterministic adapters and make no provider calls.

Allowed source formats are JPEG, PNG, WebP and AVIF. SVG, archives, executables, PDF/polyglot markers, extension mismatch and images over 50 MiB, 12,000 pixels per side or 40 megapixels fail closed. Bulk intent limit is 25 files and 100 MiB. Upload grants expire after ten minutes; private reads and editor thumbnails use at most five minutes. Filename is display metadata only; server-generated keys contain numeric tenant/project authority and random identities, not customer email or filenames.

The server decoder applies orientation, strips EXIF/GPS and other metadata, and writes exact hash/dimension lineage for:

- `thumbnail` up to 240 px WebP
- `small` up to 640 px WebP
- `medium` up to 1280 px WebP
- `large` up to 2048 px AVIF
- `original_policy` at the bounded transformed size, preserving an allowlisted raster format

If a codec cannot produce a format, the operation fails truthfully; tests do not relabel mock bytes as real conversion. Crop presets are free, 1:1, 4:3, 3:2, 16:9 and portrait. The server recomputes crop bounds from the decoded image and normalized focal point. A crop, rotation, replacement or retry creates a new version/variant lineage and never overwrites the original object.

## State machines

Media:

`intent issued → object uploaded → completing → magic/hash/decode validation → scanner → variants → ready`

Any validation failure is quarantined. Missing scanner is `not_configured`, not passed. A retry uses a single status claim and immutable original hash. A blocked replacement preserves the prior ready version. Ready assets can move to reversible trash; permanent deletion requires retention expiry, explicit `DELETE:<assetId>` confirmation, elevated role, zero active usage and a receipt for every object deletion.

Page:

`append-only draft → short-lived noindex preview → durable publication work/intent → leased revalidation → existing first-party executor → exact verified receipt → published`

Editor commands require `expectedPageVersion` and idempotency identity. CAS conflicts never overwrite newer drafts. Publish resolves the existing approved managed-site release and active first-party targets on the server, compiles exact page/media fingerprints, reserves usage bindings and atomically queues one work item per target. The production scheduler leases those records and invokes the existing injected first-party executor. It rechecks the page, exact artifact bytes/hash, media version/hash/rights/visibility, release and target immediately before delivery. Retryable failures remain queued; blocked or partially failed multi-target deliveries do not advance the page. Rollback follows the same new-work/new-receipt path.

Media storage counters and monthly upload/processing counters use unique atomic reservation claims. Completion commits only the bytes/count actually retained; validation failure releases the claim, dedupe does not retain original-byte usage, retry cannot charge twice, and permanent deletion credits the per-upload committed original bytes exactly once. AI request/token budgets use the same reserve/commit/release principle with a unique daily bucket.

AI:

`scoped request → intent classification → bounded tenant context → structured plan → normalize/validate → dry-run → diff/warnings → customer confirmation → draft only`

The allowlist is `update_text`, `update_link`, `replace_media`, `add_block`, `remove_block`, `duplicate_block`, `move_block`, `update_block_variant`, `update_items`, `toggle_visibility`, `schedule_visibility`, `update_seo` and customer-requested restore. Unknown operations and malformed/truthy provider output fail closed. Payment, price, domain, credential, permission and high-risk claims are refused. Unrelated chat is refused without provider work. Page/media text is marked inert untrusted content. Vision is optional metadata-only fallback; it performs no facial recognition, identity or health inference. V1 never publishes directly.

## Block and artifact contract

The catalog contains hero, rich text, image/text, services, case studies, gallery, carousel, team, testimonials, FAQ, CTA, article list, contact, booking intent, spacer and divider. Raw HTML/CSS/JS, unknown layouts, duplicate IDs, invalid nesting, unsafe URLs and missing informative alt text fail closed. Design tokens select only controlled palette, type scale, spacing, radius, width and contrast combinations.

Desktop/tablet/mobile projections are deterministic. The first hero image is eager with high fetch priority; other images are lazy. Artifacts include width/height, `srcset`, `sizes`, exact asset version/hash, page fingerprint and media-set fingerprint. Public compilation rejects private/internal, unready, cross-site, stale, AI-unapproved, rights-unconfirmed or rights-expired media. Private media never enters sitemap/public artifacts. The public Astro project has no editor, storage, Sharp or AWS runtime import.

## Private routes

- Workspace/quota/export: `workspace`, `quota`, `export`
- Media: list/detail, upload intent/complete, replacement intent, transform, signed read/original download, governance, organize, retry, trash/restore/permanent delete
- Organization: collections and tags
- Pages: list/create/detail, commands, versions/diff, preview, restore, publish and rollback
- AI: propose and apply-to-draft
- Owner-only storage connection configuration

The Drizzle scheduler claims bounded tenants and jobs per tick with CAS leases, stale recovery, bounded exponential retry and append-only attempt receipts. Its handlers cover durable media-object cleanup, upload expiry, processing retry, scheduled visibility, trash-retention notification and publication retry. Any external action is made only through the governed injected storage/scanner/first-party adapter. It never permanently deletes retained assets automatically; an explicitly confirmed post-retention deletion first enters `deletion_pending`, retries object cleanup, and only then finalizes quota and database state.

Editor media responses strip object keys. Ready thumbnail variants receive ephemeral tenant-scoped signed reads and are rendered in the media grid and bound page blocks. Expiry refreshes workspace authority; signed URLs are never serialized into PageDocument, artifacts or permanent HTML. Preview may label otherwise-valid private or rights-unapproved media as not publishable, while public compilation rejects it.

## Deployment boundary

Run the generated Drizzle migrations through the repository's governed migration workflow only after review and backup. This feature work generates migrations but does not apply them to production. Configure storage/scanner secrets in the deployment secret manager, validate health with non-customer fixtures, and separately exercise real upload, CDN delivery, scanner, database, browser and device paths. Provider calls, production migration apply, deployment and real customer writes remain outside this source delivery.
