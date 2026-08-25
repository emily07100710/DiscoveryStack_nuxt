# AutoGEO upstream runtime snapshot

This directory contains an audited, byte-for-byte snapshot of the Python source
under `autogeo/**` from the pinned upstream commit recorded in
`UPSTREAM.lock.json`. It is intended only as source material for a future,
isolated Python worker/service that implements AutoGEO-style rewrite and rule
extraction adapters.

The snapshot is not part of the Astro or Nuxt client bundle. It is not wired to
an API route, model provider, Qwen, Bailian, a database, or a customer website.
No upstream package is imported by the integrity tests.

## Selection policy

Selection policy `autogeo-runtime-source-v1` keeps the complete upstream
`autogeo/**` Python source layer so relative imports and future source review
remain reproducible. It excludes the recursive research/training repository:
datasets, LLaMA-Factory, open-r1, model artifacts, outputs, media, environment
files, shell scripts, workflows, archives, and caches. No rule JSON was selected
because no small rule file could be shown to be required by the future adapter.

Vendored files must never be edited in place. See `ADAPTATION_BOUNDARY.md`.

## Offline verification

Run from the repository root:

```sh
python3 services/autogeo/scripts/verify_vendor_integrity.py
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s services/autogeo/tests -p 'test_*.py'
```

These checks verify inventory, hashes, sizes, missing/extra files, and symlink
boundaries. They do not prove that upstream code is non-malicious or safe to
execute. Read `SECURITY_AUDIT.md` before any future runtime work.
