# Frappe System Factory runtime

This directory is a disposable local/CI scaffold for the private operational engine. It is not a deployment manifest and does not expose ports or credentials. Every paid tenant is expected to receive a separate Frappe site and database boundary.

The source revisions are exact-pinned in `UPSTREAM.lock.json`. `Dockerfile.system-factory` replaces the legacy official image's app sources with those exact commits and bakes the DiscoveryStack app into a project-owned image. The Administrator password, database password, and HMAC key are runtime-only secrets. The browser never receives them. The Nuxt executor resolves opaque credential references and invokes only fixed allowlisted operations.

The lock retains the former official image only as a base-image provenance record. It is explicitly not runtime authority because its embedded Frappe revision differs from the reviewed source pin. The project-owned build recipe still pins Frappe 16.32.0, ERPNext 16.33.0 and DiscoveryStack 0.1.0, but the current custom-app source hash changed after the last local image build. Because the Docker daemon was unavailable in this repair environment, the stale local image digests were removed from authority instead of being reused. Live execution therefore fails closed until the image is rebuilt, its installed source markers and custom-app tree hash are verified, immutable manifest/config digests are recorded, and production publication is separately approved.

The stack supplies MariaDB, separate Redis cache/queue services, Frappe web, workers, scheduler and Socket.IO. No app source mount can override the image.

No automatic updater is present. Upgrades begin as reviewed intents, require a backup receipt, use a newly pinned lock, verify health, and produce rollback receipts on failure.

Run `./build-immutable-image.sh` first, then `./disposable-smoke.sh`, only against a disposable Docker daemon. The smoke generates runtime-only random passwords, verifies the image authority from inside the container, creates an isolated site, installs ERPNext plus the DiscoveryStack app, and migrates app metadata. It then materializes CRM, appointment-booking and custom-bounded plans and reads the actual Frappe DocType fields, Custom DocPerm rows, Workflow transitions, Report/View records, applied-unit fingerprints and health projection. It also covers replay, collision, reserved/type/link/permission rejection, rollback, drift detection and suspension, then always removes its containers, network, site volume and database volume.
