# AutoGEO upstream runtime snapshot

This directory contains an audited, byte-for-byte snapshot of exactly 35 runtime
Python source files under `autogeo/**` from the pinned upstream commit recorded
in `UPSTREAM.lock.json`. It is not the complete AutoGEO research/training
repository. The snapshot is intended only as source material for a future,
isolated Python worker/service that implements AutoGEO-style rewrite and rule
extraction adapters outside `vendor/**`.

The snapshot must not be imported into a Nuxt, Astro, or PHP web process or
shipped in a client bundle. It is not connected to an API route, model provider,
Qwen, Bailian, a database, or a customer website. It is not evidence that
AutoGEO is usable, has optimized an article, or is production-ready. No upstream
package is imported by the integrity verifier or tests.

## Selection policy

Selection policy `autogeo-runtime-source-v1` keeps the complete upstream
`autogeo/**` Python source layer so relative imports and future source review
remain reproducible. It excludes the recursive research/training repository:
datasets, LLaMA-Factory, open-r1, models, checkpoints, weights, outputs, media,
environment files, shell scripts, workflows, archives, and caches. No rule JSON
was selected because no small rule file could be shown to be required by the
future adapter.

Vendored files must never be edited in place. Their import graph has import-time
environment, provider, and network side effects, including provider setup and an
NLTK download path. A future adapter must run in an isolated Python worker or
service, keep `trust_remote_code` false by default, and receive Qwen/Bailian
credentials only at the service boundary. See `ADAPTATION_BOUNDARY.md`.

Every upstream update must start in quarantine, pin a new commit and tree,
review the complete source diff, and repeat the security audit before a new
candidate is accepted. A future one-click updater may create a candidate only;
it must never execute upstream code or automatically upgrade the accepted
snapshot.

## Offline verification

Run from the repository root:

```sh
python3 services/autogeo/scripts/verify_vendor_integrity.py
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s services/autogeo/tests -p 'test_*.py'
```

These checks strictly bind lock identity, manifest schema and mapping, exact
inventory, hashes, sizes, filesystem object types, binary/model/archive/LFS
boundaries, and Python AST syntax. They do not prove that upstream code is
non-malicious or safe to execute. Read `SECURITY_AUDIT.md` before any future
runtime work.
