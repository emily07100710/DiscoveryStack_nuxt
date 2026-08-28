# ADR: Multi-tenant Media Vault and Structured Page Editor V1

Status: accepted for feature implementation. Runtime deployment and migration apply remain separately governed.

## Decision

DiscoveryStack extends the existing managed-site tenant (`managedSiteProjects`), customer membership/session authority, subscription, immutable version, preview, release projection, first-party publication target, deployment attempt and receipt lineage. It does not create a parallel customer, billing, domain, credential or publishing authority.

Page content is a canonical `PageDocument` containing only allowlisted blocks, safe rich-text nodes, controlled design tokens and exact media-version bindings. Commands create append-only draft versions with optimistic concurrency. Preview is short-lived, site-scoped and non-indexable. Publish creates an intent/receipt bound to the existing managed-site release and first-party publication systems; it never edits a live site, Git checkout or provider directly. Rollback publishes a prior validated snapshot as a new governed action.

Media bytes live outside Git and MySQL. MySQL stores asset identity, immutable versions, hashes, object/variant metadata, usage bindings, upload/processing leases, quota projections and append-only receipts. The default production contract is S3-compatible (Cloudflare R2, AWS S3 or MinIO). Bucket, endpoint and prefix are server configuration; callers can never supply them. Credentials are referenced by opaque server-only names and resolved only at runtime. A deterministic in-memory adapter is test-only and a fixed-root local adapter is development-only. Production without a valid storage connection, credential resolver, security scanner or image processor fails closed or quarantines according to policy.

Browser uploads and private downloads use server-issued short-lived authorizations bound to tenant, project, asset version, object key, size and MIME. Public pages receive only approved CDN projections. Private/internal assets receive short-lived signed reads with `private, no-store` semantics. Filenames are sanitized display metadata, never path authority.

The editor is a constrained Vue/Nuxt product surface. No WYSIWYG dependency is added. Public Astro source and visual styling remain unchanged. The compiler creates deterministic responsive Astro/Nuxt-neutral artifacts with media hashes, dimensions, `srcset`, alt rules and hero/LCP policy; editor, storage and provider code stays in private Nuxt/Nitro.

AI is a scoped proposal engine, not general chat. It receives only the selected tenant/page, approved media projections, design tokens and command catalog. Provider output must parse as a strict allowlisted operation list, then normalize, validate, dry-run, diff and pass risk gates. It cannot publish, execute code, fetch arbitrary URLs, alter credentials, billing, permissions, domains or payment. V1 requires customer confirmation before applying to draft; governed low-risk auto-publish remains off by default.

## Security and lifecycle constraints

- Exact same-tenant/project authority is reconstructed from owner or customer session on every mutation; email is never authority.
- Upload validation distrusts declared MIME, filename, size, hash and dimensions. Executables, archives, SVG, polyglots and decode-bomb dimensions fail closed.
- Scanner and metadata-scrubbing/image-processing results are explicit. Missing production capability is not recorded as passed.
- Original objects are immutable. Crop, focal point and rotation are transformation specs producing derived variants.
- In-use assets cannot be permanently deleted. Trash is reversible until retention expires; permanent deletion requires explicit publisher-capable customer or platform-owner authority plus per-object receipts.
- Customer export includes their content and assets under policy, never platform source, secrets or other tenants.

## Dependency and license decision

One server-only dependency is added: `sharp` 0.34.3 (Apache-2.0) for authoritative decode bounds, orientation, metadata/GPS stripping, crop/focal transforms and WebP/AVIF variants. It is imported only by Nitro runtime code and is excluded from both the private editor browser bundle and public Astro. Existing Nuxt/Vue/Zod, Drizzle, Node crypto/filesystem APIs and the already-pinned Apache-2.0 AWS SDK cover the remaining contracts and S3-compatible transport. The security scanner remains an injected port; missing production scanner configuration quarantines rather than claiming a pass. No WYSIWYG dependency is added.
