# ADR-0042: Frappe Framework and ERPNext v16 system factory

Status: accepted for V1 repository foundation

DiscoveryStack uses exact-pinned Frappe Framework v16 plus ERPNext v16 as a private operational engine. Custom behavior lives in the `discovery_stack` Frappe app and in the Nuxt server adapter. ERPNext core is not forked or patched.

Each paid customer defaults to an isolated Frappe site and database. DiscoveryStack retains owner/client/website/Managed Site/order/payment authority and projects an allowlisted compiled SystemSpec into that site. Customer access is an account and hosted-service right; it does not include this Git repository, server/container credentials, an Administrator secret, or a source archive.

An LLM may only propose a strict structured SystemSpec. Provider output is normalized and validated again. A deterministic compiler emits typed metadata; it never evaluates Python, SQL, JavaScript, shell, Docker instructions, migrations, imports, or expressions supplied by a user or provider.

Twenty is an optional UX research reference only. No Twenty/Odoo dependency, code, asset, trademark, API compatibility claim, or data model is included.

Public content remains governed by Content Operations, risk/review/autopilot and publication receipts. Private CRM/ERP records are excluded from GEO/model learning by default. Only explicitly consented, purpose-limited, retention-bounded and owner-governed aggregate outcomes may enter an existing evidence pipeline.

Hosted use and any future distribution are different license boundaries. `infrastructure/frappe/NOTICE.md` and `UPSTREAM.lock.json` record the current source, license and trademark evidence. A future customer-copy delivery requires a new legal and license review.
