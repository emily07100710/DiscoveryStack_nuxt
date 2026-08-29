# Frappe / ERPNext runtime notice

DiscoveryStack uses the pinned upstream Frappe Framework and ERPNext releases recorded in `UPSTREAM.lock.json` as a private hosted operational engine. No upstream source tree, Git history, database dump, container layer, logo, or trademark asset is committed here.

- Frappe Framework is distributed by its authors under the MIT License.
- ERPNext is distributed by its authors under GPL-3.0-only. Its attribution and trademark policy remain applicable.
- DiscoveryStack and its custom Frappe app are independent work. The repository does not claim sponsorship, endorsement, or certification by Frappe Technologies or ERPNext contributors.
- A future source-code, appliance, container, or customer-copy delivery has a different distribution boundary and requires a fresh license, attribution, source-offer, dependency, and trademark review before delivery.

The exact official URLs and SHA-256 hashes used for verification are in `UPSTREAM.lock.json`. Runtime retrieval must verify the exact tags, commits, and image digest before use.

The official `erpnext:v16.33.0` image records ERPNext `v16.33.0` at the exact locked commit, but its embedded `frappe` entry reports version `16.31.0` and no commit hash. The separately reviewed Frappe source pin is `v16.32.0`. This difference is explicit and fail-closed: a production image may not be approved until its embedded Frappe source commit is independently recorded and matched to a reviewed lock. The disposable smoke proves compatibility only for the stated image digest; it does not convert the absent embedded commit into provenance proof.
