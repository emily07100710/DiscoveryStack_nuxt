# DiscoveryStack Import Metadata

## Pinned source

- Upstream: https://github.com/yaojingang/GEOFlow.git
- Default branch at acquisition: `main`
- Exact upstream SHA: `9d70db04ee9c5d308f5fa29b4c65834229af9eea`
- Acquisition/import date: 2026-08-25
- Nearest verified release: `v2.3.0` at `97119662325b1d6d88ff6a3f390567bcfa91eedd`; the pinned SHA is six commits after that tag and is not itself tagged.

## Reproducible import method

The import was made only from the official upstream Git repository. A full Git clone was acquired without checking out a moving branch into DiscoveryStack. The remote `main` reference was resolved to the exact SHA above, and the pinned Git tree was exported through the Git index:

```sh
git clone --no-checkout https://github.com/yaojingang/GEOFlow.git /tmp/geoflow-upstream
git -C /tmp/geoflow-upstream rev-parse refs/remotes/origin/main
git -C /tmp/geoflow-upstream read-tree 9d70db04ee9c5d308f5fa29b4c65834229af9eea
git -C /tmp/geoflow-upstream checkout-index --all --force --prefix=/absolute/path/to/DiscoveryStack_nuxt/services/geoflow/
```

`checkout-index` was used so every tracked blob is included even when upstream archive attributes mark a file `export-ignore`. No release ZIP, mirror, submodule, nested `.git`, or unpinned branch snapshot was used.

## Boundary and preservation policy

`services/geoflow` is a vendored source snapshot and an independent Laravel/PHP runtime boundary inside the DiscoveryStack monorepo. It is not a Git submodule and has no nested repository metadata. The upstream application code, migrations, tests, documentation, deployment scripts, manifests, necessary public assets, `LICENSE`, and `NOTICE` are preserved. This import adds only `DISCOVERYSTACK_IMPORT.md` and `UPSTREAM_VERSION` inside the boundary; it does not modify upstream product logic.

The upstream `LICENSE` and `NOTICE` must remain unmodified and byte-identical on future syncs. Attribution must also remain in the root `THIRD_PARTY_NOTICES.md`.

Some pinned browser assets contain upstream trailing whitespace. The root
`.gitattributes` disables whitespace diagnostics only for those exact generated
or vendored asset paths so the imported blobs stay byte-identical. Do not use
that exception for DiscoveryStack-authored source or documentation.

## Suggested future upstream sync

Perform a future sync only in a new clean feature-branch worktree. Fetch the official URL into a separate temporary clone, resolve and record a new exact SHA, repeat the pre-import secret/artifact/symlink scans, and export that exact tree into an empty temporary staging directory with `read-tree` plus `checkout-index`. Compare the staged manifest and licenses before replacing the existing vendor boundary, then review all upstream changes and refresh the provenance hashes. Do not sync from a moving branch name or an unverified archive.

## Runtime safety requirements

Any future deployment must explicitly set `GEOFLOW_TELEMETRY_ENABLED=false`; the production example upstream currently enables telemetry and is not an approved DiscoveryStack deployment configuration. Provider credentials, outbound targets, updater behavior, identity, database access, queues, schedules, and publishing channels require separate review before use.

For this V1 import, GEOFlow was not deployed or started. No migration, seed, installer, queue, scheduler, Reverb process, production container, remote updater, external provider, publishing channel, or client-site call was run.
