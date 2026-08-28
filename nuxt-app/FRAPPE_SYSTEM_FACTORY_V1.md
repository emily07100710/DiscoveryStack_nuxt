# Frappe Framework + ERPNext v16 AI System Factory V1

## Product boundary

System Factory turns owner-scoped requirements into a strict `system-spec-v1`, a deterministic metadata plan, a synthetic interactive preview, and—only after the existing Managed Site server quote/order and signature-verified payment receipt—an isolated Frappe site. Preview, order intent, configuration, dry-run, and provisioning plan are never shown as deployed, paid, healthy, or active.

Customers receive accounts and hosted-service use. They do not receive the DiscoveryStack repository, container/server credentials, Frappe Administrator credential, source archive, or another tenant's data. Frappe Desk is disabled or restricted; the branded Nuxt customer experience remains primary.

## Authority reuse

- Owner identity: existing owner session and database admin identity.
- Client/website: existing Content Operations client and website identity.
- Managed website: existing Managed Site project, version, preview and site vault.
- Commerce: existing server price catalog, quote, draft order and verified payment event. Browser input cannot mark paid.
- Content publication: existing risk/review/autopilot, routing, executor and append-only receipts. Frappe projections cannot bypass them.
- GEO/ModelOps: private CRM/ERP records are excluded. Only explicit-consent, PII-admitted, purpose/retention-bounded aggregates with a denominator and limitations may be admitted as observational outcomes.

## Flow and states

`requirements → versioned SystemSpec → interactive preview → quote/order → payment verified → provisioning plan → isolated Frappe site → pinned ERPNext + DiscoveryStack app → compiled spec → health receipt → one-time admin invitation → active`

Durable states are `draft`, `preview_ready`, `quote_ready`, `awaiting_payment`, `payment_verified`, `provisioning_planned`, `provisioning`, `health_checking`, `invitation_pending`, `active`, `failed`, `retry_wait`, `suspended`, `deprovision_pending`, and `deprovisioned`. State transitions derive from stored state plus a verified event. Deprovisioned is terminal.

## Compiler

The parser performs NFKC/trim normalization, normalized duplicate rejection, exact object fields, bounded arrays, template/capability/DocType allowlists, reserved DocType protection, permission escalation rejection, and executable/code/path rejection. Canonical JSON recursively sorts object keys; SHA-256 binds the normalized spec, parent, compiler plan, preview fixtures, tenant binding and every receipt. The compiler emits typed metadata only and cannot execute Python, SQL, JavaScript, shell, Docker or migrations.

Templates: `light_crm`, `appointment_booking`, `membership_course`, `service_project`, `inventory_sales`, `retail_light`, and `custom_bounded`. Exact required/allowed entities, roles, module mappings, constraints and limitations live in `server/system-factory/catalog.ts` and are exposed through the owner-only template endpoint.

## Runtime and security

`../infrastructure/frappe/UPSTREAM.lock.json` pins official repositories, exact tags/commits and licenses. The former official image is retained only as base-image provenance because its embedded Frappe revision does not match the reviewed source revision. `Dockerfile.system-factory` builds a project-owned image from the exact Frappe and ERPNext commits plus an exact DiscoveryStack app content hash. Production live execution remains blocked until the resulting manifest/config digests are independently reviewed and recorded. The private compose scaffold uses only that project image and includes MariaDB, separate Redis cache/queue, web, workers, scheduler and Socket.IO on an internal network. Secrets are runtime injected; `.env.example` has names only.

Nuxt↔Frappe requests use a raw-body SHA-256 and HMAC envelope bound to method, fixed path, timestamp, nonce, sender, receiver and key ID. Hash and signature are verified before payload parsing, tenant lookup or nonce write. Nonces are atomically unique. External origins are exact server allowlists and reject credentials, non-HTTPS, private/link-local/loopback/special-use hosts, redirects, oversized responses and unbounded timeouts. Errors and receipts are secret-free.

Provisioning has fixed operations, leases, maximum attempts, bounded exponential retry, stale recovery, exact response identity and append-only receipts. One scheduler tick claims at most 20 tenants, executes at most 10 ordered steps per tenant and at most 100 steps total. Disabled execution makes no external call. Health must pass before invitation.

Bench/site lifecycle authority and tenant-app authority are separate. `create_site`, `install_apps`, `migrate_site`, `backup_site`, `restore_site`, and `apply_upgrade` exist only on the injected `SystemFactoryControlPlanePort`; its reviewed transport receives fixed command templates and opaque credential references. The tenant app exposes only these implemented authenticated methods:

- `discovery_stack.api.apply_compiled_spec`
- `discovery_stack.api.configure_roles`
- `discovery_stack.api.configure_modules`
- `discovery_stack.api.health`
- `discovery_stack.api.prepare_admin_invitation`
- `discovery_stack.api.activate_admin_invitation`
- `discovery_stack.api.suspend_tenant`

Tenant methods require both Frappe API authentication and a raw-body HMAC envelope. No Administrator credential is sent to the browser. Unknown response fields, redirects, malformed bodies, authority drift, request collisions, 401/403/409, exhausted retries and unhealthy responses fail closed.

Invitations store token/email hashes only and expire/revoke fail closed. Acceptance is durable: claim a leased activation run, call the idempotent tenant activation with the password held only in request memory, verify exact tenant/principal/role/user receipt identity, then atomically consume the token, append the receipt/event, activate the tenant, revoke older portal sessions and create one hashed customer session. External failure leaves the token safely retryable; Frappe replay cannot create a second account.

Upgrades are reviewed version-lock intents, never a remote self-updater. Backup precedes apply; verification failure produces a rollback receipt and the prior tenant remains active.

## Tables and migration

Migration `0031_pale_the_fury.sql` creates `systemSpecs`, `systemSpecVersions`, `systemPreviews`, `systemTenants`, `systemTenantBindings`, `systemProvisioningPlans`, `systemProvisioningRuns`, `systemProvisioningAttempts`, `systemEvents`, `systemReceipts`, `systemAdminInvitations`, `systemConnectionRefs`, `systemUpgradeIntents`, `systemUpgradeRuns`, and `systemUpgradeReceipts`. It is generated repository evidence only; it is not applied to production in this work.

## Owner and customer surfaces

Owner APIs under `/api/system-factory/**` use owner session, exact same-origin mutation checks, strict field allowlists, private/no-store/noindex headers, bounded pagination and owner/tenant scope. They cover provenance/templates, draft/compile/preview, list/detail, payment-bound planning, retry, lifecycle intents, invitations, health, upgrade plans and audit/receipts.

The owner layout adds exactly one `系統工廠` entry. The workbench includes Overview, Requirements/SystemSpec, Templates/Modules, Preview, Quote/Payment, Provisioning, Health, Users/Roles/Invitations, Integrations, Upgrade/Backup/Rollback and Audit/Receipts/Advanced, plus explicit loading/empty/error/unauthorized/saving/success/retry/collision/stale wording. No fake KPI, income, deployment or health value is shown.

The existing customer portal adds only a safe system status projection. It exposes no server credential, Administrator secret or sensitive upstream provenance. Invitation activation uses the configured server-only tenant adapter and returns a customer session only after the Frappe receipt and local transaction both verify.

## Runtime limitations

Mock executor success proves orchestration contracts, not a real Frappe site. A disposable Docker smoke is separate evidence. Until the project image is successfully built and its installed source identities and digest are recorded, production image authority is `BLOCKED` and live adapters refuse approval. Production migration apply, database runtime validation, deployment, payment/provider calls, customer-site writes, real invitation mail and real upgrade/rollback remain explicit environment-controlled operations.
