# ADR-0042: Frappe Framework and ERPNext v16 system factory

Status: accepted for V1 repository foundation

DiscoveryStack uses exact-pinned Frappe Framework v16 plus ERPNext v16 as a private operational engine. Custom behavior lives in the `discovery_stack` Frappe app and in the Nuxt server adapter. ERPNext core is not forked or patched.

Bench and site lifecycle commands are control-plane authority, never tenant-site whitelisted API methods. A server-only `SystemFactoryControlPlanePort` receives fixed reviewed command templates and opaque credentials. Tenant-app HTTP exposes only methods actually implemented in the custom app, with Frappe authentication plus raw-body HMAC, atomic nonce and exact tenant/idempotency/receipt lineage.

The official ERPNext image tag/digest is base provenance, not proof that its embedded Frappe source matches the separately reviewed source tag. A project-owned Dockerfile replaces both app trees with exact commits and bakes an exact custom-app content hash. Live production execution stays disabled until an independently reviewed immutable image manifest digest and installed source identities match the lock.

Each paid customer defaults to an isolated Frappe site and database. DiscoveryStack retains owner/client/website/Managed Site/order/payment authority and projects an allowlisted compiled SystemSpec into that site. Customer access is an account and hosted-service right; it does not include this Git repository, server/container credentials, an Administrator secret, or a source archive.

An LLM may only propose a strict structured SystemSpec. Provider output is normalized and validated again. A deterministic compiler emits a versioned materialization manifest; it never evaluates Python, SQL, JavaScript, shell, Docker instructions, migrations, imports, or expressions supplied by a user or provider.

The custom app independently validates and materializes that manifest through Frappe metadata APIs. MariaDB/MySQL DDL is not treated as transactionally rollback-safe. The executor therefore performs a complete preflight, persists a materialization run and per-unit journal before each possible DDL write, stages plan-scoped UI metadata, verifies every actual record, and only then changes the tenant policy active-plan pointer. Initial failures reverse-compensate newly created and safely identifiable DiscoveryStack-owned metadata in journal order; upgrade failures keep the old plan active and retain append-only optional fields as an incomplete staged run that can deterministically resume.

Existing ERPNext DocTypes are read-only bindings. Tenant custom entities become app-namespaced Custom DocTypes with allowlisted field types; exact tenant roles receive Custom DocPerm rows with delete disabled; statuses and transitions become Workflow metadata; and reports become safe Report Builder definitions. Each active plan has a private tenant- and plan-scoped Frappe Workspace with role-scoped DocType/Report shortcuts, Number Cards and Dashboard Charts. List and form views are Desk-ready; calendar and kanban definitions are explicitly `registry_only` in V1 until their pinned Frappe navigation contracts are runtime-verified. Notification and integration intents remain disabled app-owned records. Every unit stores a server-computed applied fingerprint. Replays verify current metadata before returning a no-op receipt; conflicting definitions, destructive updates, permission escalation, workflow orphaning and cross-tenant lineage are blocked.

Health is a projection check, not an existence check: it reads the active run, journal-derived unit records and actual Frappe DocType, permission, workflow, report, Workspace, Number Card and Dashboard Chart metadata again and compares their count and fingerprints with the active compiled plan. Incomplete/staged runs are reported separately and never make the new plan healthy. Suspension sets the app-owned tenant policy gate and disables only users carrying that tenant's generated roles. Invitation preparation and activation may grant only an exact role already materialized for that plan.

Provisioning workers claim at most 20 distinct tenants and 100 steps per tick, with at most 10 steps for one tenant. Each step renews its durable lease to exceed its server-owned operation timeout plus a safety margin. Success/failure commits require the same unexpired lease, so a stale worker cannot commit after recovery; provider retries retain the exact operation idempotency key.

Twenty is an optional UX research reference only. No Twenty/Odoo dependency, code, asset, trademark, API compatibility claim, or data model is included.

Public content remains governed by Content Operations, risk/review/autopilot and publication receipts. Private CRM/ERP records are excluded from GEO/model learning by default. Only explicitly consented, purpose-limited, retention-bounded and owner-governed aggregate outcomes may enter an existing evidence pipeline.

Hosted use and any future distribution are different license boundaries. `infrastructure/frappe/NOTICE.md` and `UPSTREAM.lock.json` record the current source, license and trademark evidence. A future customer-copy delivery requires a new legal and license review.
