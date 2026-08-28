# Frappe System Factory runtime

This directory is a disposable local/CI scaffold for the private operational engine. It is not a deployment manifest and does not expose ports or credentials. Every paid tenant is expected to receive a separate Frappe site and database boundary.

The source revisions are exact-pinned in `UPSTREAM.lock.json`. `Dockerfile.system-factory` replaces the legacy official image's app sources with those exact commits and bakes the DiscoveryStack app into a project-owned image. The Administrator password, database password, and HMAC key are runtime-only secrets. The browser never receives them. The Nuxt executor resolves opaque credential references and invokes only fixed allowlisted operations.

The lock retains the former official image only as a base-image provenance record. It is explicitly not runtime authority because its embedded Frappe revision differs from the reviewed source pin. The locally built project image has verified installed Frappe 16.32.0, ERPNext 16.33.0, DiscoveryStack 0.1.0, exact source markers and custom-app content. Its local manifest/config digests are recorded. Production still remains blocked until that image is published to a controlled immutable registry and separately approved.

The stack supplies MariaDB, separate Redis cache/queue services, Frappe web, workers, scheduler and Socket.IO. No app source mount can override the image.

No automatic updater is present. Upgrades begin as reviewed intents, require a backup receipt, use a newly pinned lock, verify health, and produce rollback receipts on failure.

Run `./build-immutable-image.sh` first, then `./disposable-smoke.sh`, only against a disposable Docker daemon. The smoke generates runtime-only random passwords, verifies the image authority from inside the container, creates an isolated site, installs ERPNext plus the DiscoveryStack app, migrates app metadata, applies one fixed compiled plan twice to prove replay safety, verifies tenant health, and always removes its containers, network, site volume, and database volume.
