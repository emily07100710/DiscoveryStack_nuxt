# Private Page Evidence Collector V1

Status: **development-only; code review candidate; no real URL collection has run.**

This collector creates private page evidence without changing the frozen 1,087-row parent dataset. It does not adjudicate labels, convert `unknown` to a negative, treat a candidate signal as `present`, or start v5.2 training.

## Non-negotiable execution boundary

Live browser collection is blocked unless both of these are explicit:

1. `DISCOVERYSTACK_PRIVATE_EVIDENCE_DEV=1` and `--development-only`;
2. `--network-sandbox-attested`, meaning the process is inside a container or namespace with no route to private, loopback, link-local, metadata, or other internal networks, and outbound traffic is independently enforced by an egress proxy or equivalent control.

Playwright routing re-resolves and validates every document, redirect, and subresource request, and allows only GET/HEAD. Service workers are disabled. An init script disables WebSocket, EventSource, and `sendBeacon`, and any observed WebSocket fails the viewport. That browser-level interception is still not a complete defense against DNS rebinding or unroutable-channel races. Therefore the no-internal-route sandbox is a hard blocker, not an optional recommendation. Without attestation, records are written only as `sandbox_required` and no browser starts.

Lighthouse cannot use Playwright request routing. It is therefore allowed only behind the same independently enforced network sandbox. The collector never invokes `npx`, downloads packages, or searches `PATH` for an arbitrary version. `--lighthouse-binary` must be an absolute, non-symlink, preinstalled executable whose `--version` output is exactly `12.8.2`; missing or mismatched runtime produces `runtime_unavailable`. Lighthouse is opt-in with `--run-lighthouse` and is not run by default.

## Exact parent mapping and authority

The target bundle is one private JSON document, stored outside every Git worktree. It contains:

- exact `parentManifestHash`, `parentDatasetDigest`, and parent row count;
- an unexpired owner authorization scope, explicit allowed hosts, rights basis, `robotsPolicy: respect`, retention of 1–30 days, and `allowAuthenticatedAccess: false`;
- unique exact `rowId + split` mappings that must exist in the supplied parent JSONL;
- `mappingProvenance.method: owner_supplied_exact_url`, mapped-by/time/evidence reference, and `robotsDecision: allowed`;
- optional private query contexts with unique IDs.

Unknown or extra fields fail closed. Domain hashes, semantic search, artifact strings, source-family fields, and candidate labels cannot supply or guess a URL. A missing exact mapping cannot bind evidence back to an old row. Login, cookie/session reuse, CAPTCHA/WAF bypass, robots bypass, payment, checkout, booking, and form submission are outside V1.

Example shape (illustrative only; do not commit a populated copy):

```json
{
  "contractVersion": "page-evidence-targets-v1",
  "parentLineage": {
    "parentManifestHash": "<sha256>",
    "parentDatasetDigest": "<sha256>",
    "parentRowCount": 1087
  },
  "authorization": {
    "scopeId": "owner-scope-20260828",
    "ownerId": "<owner>",
    "approvedAt": "2026-08-28T00:00:00+00:00",
    "expiresAt": "2026-09-04T00:00:00+00:00",
    "allowedHosts": ["www.owner-authorized.example"],
    "rightsBasis": "owner-authorized public page observation",
    "robotsPolicy": "respect",
    "retentionDays": 7,
    "allowAuthenticatedAccess": false
  },
  "targets": [
    {
      "rowId": 570001,
      "split": "train",
      "url": "https://www.owner-authorized.example/exact-page",
      "mappingProvenance": {
        "method": "owner_supplied_exact_url",
        "mappedBy": "<owner>",
        "mappedAt": "2026-08-28T00:00:00+00:00",
        "evidenceRef": "<private exact mapping reference>",
        "robotsDecision": "allowed"
      },
      "queryContexts": []
    }
  ]
}
```

## URL and egress policy

- Missing schemes canonicalize to HTTPS. HTTP is off by default and requires the explicit development-only `--allow-http` flag.
- Userinfo, malformed/nonstandard ports, fragments, localhost, single-label and special-use names are rejected.
- Hostnames are NFC/IDNA canonicalized before authorization and DNS checks.
- DNS failure or an empty answer is blocked. Every A/AAAA answer must be globally routable. A mixed public/private answer fails the whole request.
- Private, loopback, link-local, reserved, multicast, unspecified, and IPv4-mapped IPv6 addresses are rejected.
- The guard runs for every Playwright request; redirects and subresources do not inherit trust from the first URL.
- Collection is sequential. A per-host delay of at least one second, a maximum request count, and bounded `Retry-After` handling are mandatory.

DNS can change between policy resolution and the actual socket connection. The independently enforced no-internal-route sandbox/egress proxy is required to contain that rebinding risk.

## Interaction limits

V1 permits only DOM inspection, scrolling, screenshots, and reading native `<details>` text through DOM inspection without toggling it or dispatching a click. It does not call `.click()`, fill inputs, submit forms, or activate generic buttons/`role=button`. Booking and checkout remain `unknown`. Any future interaction needs a separate owner-authorized staging plan and must not reuse this public-page collector contract.

## Private filesystem and quarantine

The collector sets umask `077`. Run directories are `0700`; files are `0600`. Run IDs are strict lowercase tokens. Output must be an absolute path outside every Git worktree. Traversal, absolute artifact paths, symlinks, overwrite, pre-existing run collisions, excessive inputs/artifacts, and total run-budget overflow fail closed. Writes are same-directory atomic replaces; JSONL appends use `O_NOFOLLOW` where available.

Raw URLs remain only in the external private target bundle. Raw page text, screenshots, query sidecars, and Lighthouse reports remain in the private run directory and are excluded from Git and model artifacts. Email, phone, credit-card/SSN-like text, API-key-like values, or credential forms cause every page artifact to move to `quarantined_sensitive_evidence/`. Sensitive title/headings/details are omitted from the evidence manifest. Quarantined evidence cannot enter general adjudication or model projection.

Retention is recorded in `run_metadata.json` with `retentionDays` and `deleteAfter`. The owner/operator is responsible for deletion at that deadline; this V1 collector deliberately does not run a background deletion service.

## Invocation

The following is a shape, not authorization to run a real collection:

```bash
DISCOVERYSTACK_PRIVATE_EVIDENCE_DEV=1 python3 ml/tools/private_page_evidence_collector.py \
  --development-only \
  --network-sandbox-attested \
  --targets /private/outside-git/page-evidence-targets.private.json \
  --parent-dataset /trusted/read-only/v5-1087.jsonl \
  --parent-manifest /trusted/read-only/v5-1087-manifest.json \
  --output-dir /private/outside-git/page-evidence-runs \
  --run-id owner-authorized-run-20260828 \
  --chromium-binary /opt/pinned/chromium
```

Lighthouse additionally requires `--run-lighthouse --lighthouse-binary /opt/pinned/lighthouse`. A replay uses a new run ID plus `--replay-of <old-run-id>`; the collector verifies identical target-bundle, parent, configuration, and collector-version digests and refuses drift or overwrite.

Validate a private run with:

```bash
python3 ml/tools/validate_page_evidence_contract.py /private/outside-git/page-evidence-runs/<run-id>
```

The validator applies the complete checked-in schema and then verifies parent/run lineage, unique IDs, relative path containment, no symlinks, private modes, exact file bytes and SHA-256, per-kind sizes, status semantics, query-sidecar hashes, quarantine routing, exact replay, and a raw-URL/raw-evidence-free model projection. Every projected friction signal remains `unknown`.

## Rights and operational conduct

Only collect hosts within the current owner authorization scope and a documented rights basis. Respect robots decisions, rate limits, and `Retry-After`. Stop on authentication or WAF challenges and do not bypass them. Never load saved browser storage, cookies, credentials, OAuth state, or payment data.

## Current evidence status

- 1,087 real URL mapping: **NOT RUN**
- Real page collection: **NOT RUN**
- v5.2 adjudication: **NOT RUN**
- v5.2 training: **NOT RUN**
- Real Playwright/Lighthouse/network execution: **NOT RUN**

Unit and adversarial tests use only mocked DNS, mocked browser routing/events, mocked Lighthouse version checks, and temporary local files.
