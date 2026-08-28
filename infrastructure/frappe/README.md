# Frappe System Factory runtime

This directory is a disposable local/CI scaffold for the private operational engine. It is not a deployment manifest and does not expose ports or credentials. Every paid tenant is expected to receive a separate Frappe site and database boundary.

The image and upstream revisions are exact-pinned in `UPSTREAM.lock.json`. The Administrator password, database password, and HMAC key are runtime-only secrets. The browser never receives them. The Nuxt executor resolves opaque credential references and invokes only fixed allowlisted operations.

The lock also records the versions embedded in the official image. Its ERPNext commit is exact; the image reports Frappe 16.31.0 without a commit while the reviewed current source pin is Frappe v16.32.0. This is a production image approval blocker, not hidden drift. A reviewed immutable production build must record and match both embedded commits.

The stack supplies MariaDB, separate Redis cache/queue services, Frappe web, workers, scheduler and Socket.IO. The DiscoveryStack app source is mounted read-only for disposable validation; a reviewed production image must build it into an immutable image and record a new digest.

No automatic updater is present. Upgrades begin as reviewed intents, require a backup receipt, use a newly pinned lock, verify health, and produce rollback receipts on failure.

Run `./disposable-smoke.sh` only against a disposable Docker daemon. It generates runtime-only random passwords, creates an isolated site, installs exact-pinned ERPNext plus the DiscoveryStack app, migrates app metadata, applies one fixed compiled plan twice to prove replay safety, verifies tenant health, and always removes its containers, network, site volume, and database volume.
