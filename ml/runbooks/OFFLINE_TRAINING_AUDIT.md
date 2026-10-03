# Offline training audit and recovery preparation

Use the newer v5-1087 development handoff as the next candidate input and keep
v4-500 frozen as a regression baseline. The 101-row route remains a separate
development proof of concept. Their taxonomy, feature and split contracts are
different; an external notebook receipt does not establish owner-approved
database lineage.

The audit below uses Python's standard library and the existing local evidence
schema validator. It never executes notebook cells, imports a Transformer,
installs a dependency, resolves a URL, calls a database/provider, changes a row,
reviews a label, submits training or uploads an artifact.

## Check source without a private dataset

From the repository root:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 ml/validation/audit_training_assets.py --profile v4-500
PYTHONDONTWRITEBYTECODE=1 python3 ml/validation/audit_training_assets.py --profile v5-1087
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s ml/tests -p test_training_assets_audit.py -v
```

Notebook `PASS` means source syntax and recovery gates were inspected. Dataset
status is `NOT_RUN` without supplied files. It is not evidence of GPU access,
successful imports, training, model quality, a checkpoint or cloud permission.

## Audit supplied private data and create the real review queue

Keep the data, manifest and output outside every Git worktree. Supply the exact
owner-private snapshot and its metadata; no file is downloaded by this tool.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 ml/validation/audit_training_assets.py \
  --profile v5-1087 \
  --data /private/outside-git/discoverystack-manifest-v5-1087-private.jsonl \
  --manifest /private/outside-git/manifest-v5-1087.json \
  --report /private/outside-git/new-training-audit.json
```

The frozen hash, digest, row count and split counts must match the selected
profile. For v5 the frozen parent, source counts and development-only flags are
checked too. The local audit checks the versioned row schema, all nine heads,
recorded human review, rights, robots, PII, stage evidence, numeric features,
duplicate IDs/text and cross-split domain/near-duplicate/evidence groups.
`technicalIntegrityStatus` reports frozen-file/schema integrity separately from
`productionDataPolicyStatus`, which includes pending adjudication and source
coverage. A frozen development candidate may have intact bytes while still
failing the production data policy; neither status authorizes a training run.

The report contains aggregate counts and `pendingReviewRows` with row ordinal,
safe numeric ID, split and reason codes. It omits training text, source URLs,
evidence locators, source-card values, credentials and exception details. CLI
output excludes the per-row queue. The report is created with mode `0600`, outside
Git, and refuses symlinks or an existing destination.

The production data policy from `500_EXECUTION_RUNBOOK.md` includes source-group
isolation and a 20% source-family cap. Existing v4/v5 source-family aggregates
do not meet that cap. The v5 schema currently allows four source families, which
cannot by themselves satisfy a cap of 20% per family. This is a policy/data
coverage gap to resolve explicitly, not a reason to weaken the audit or rename
the frozen dataset. A failed audit preserves all original rows and review states.

`productionReady` remains false even when every local check passes. A local
manifest cannot prove current source rights, durable consent, reviewed evidence,
holdout quality, cloud artifact existence or owner approval.

## Prepare a recovery notebook without the previous machine

The v4 source generator defaults to the tracked output-free recovery notebook.
Both generators require a new output path and refuse to overwrite existing files.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 ml/notebooks/make_recovery_notebook.py \
  --output /private/outside-git/recovery-v4.ipynb
PYTHONDONTWRITEBYTECODE=1 python3 ml/notebooks/make_v5_1087_notebook.py \
  --source /private/outside-git/recovery-v4.ipynb \
  --output /private/outside-git/recovery-v5.ipynb
PYTHONDONTWRITEBYTECODE=1 python3 ml/notebooks/check_v5_1087_notebook.py \
  /private/outside-git/recovery-v5.ipynb
```

The prepared sources preserve the fixed data contracts, validation-only model
selection, final-test boundary, development-only output and raw-data exclusion.
The smoke loss must be finite before backward. Unsupported modes are rejected;
full ablation requires CUDA. Each training-cell attempt gets a new directory,
preserving prior checkpoints. Completed runs save `run_records.json` and the
selected checkpoint metadata, so re-entering the cell cannot erase earlier
completed comparisons. This does not resume a partially completed epoch or claim
that an interrupted epoch produced a checkpoint.

## Immediately runnable CPU proof

The existing Nuxt tests use synthetic owner-scoped fixtures and the memory
repository. They cover deterministic logistic/pairwise fitting, inference
standardization, split/leakage gates, evaluation, ModelOps cycles, shadow advisory
and rollback. No production data, DB or provider is called:

```sh
cd nuxt-app
pnpm vitest run tests/geo-outcome-model.test.ts tests/geo-outcome-modelops.test.ts \
  tests/geo-outcome-modelops-advisory.test.ts tests/geo-outcome-modelops-scheduler.test.ts \
  tests/colab-local.contract.test.ts tests/colab-v2-head-modes.contract.test.ts
```

Passing these tests proves local engine behavior on synthetic fixtures. It does
not add a real observation, a human-reviewed label or a production artifact.

## Remaining external/data gates

- Recover the exact private v4/v5 snapshot and metadata; recheck frozen hashes,
  cloud ownership and current permissions. No raw JSONL exists in this repo.
- Complete page-level rights and journeyStage adjudication with evidence. The
  documented v5 has 837 pending rows and 587 pending rights reviews; these are
  historical document counts until the actual snapshot is audited.
- The second-layer friction labels require explicit reviewed `present`/`absent`
  evidence. Candidate/unknown rows remain masked; booking, speed, mobile and
  checkout require the relevant measured/interaction evidence.
- Acquire a usable GPU, run bounded preflight and then the full comparison,
  validation selection, one final test, legacy regression and checkpoint reload.
  A completed Colab run alone cannot activate a production model.
- The citation ranker uses different, verified query/page/engine/run outcome
  observations and CPU baselines. Read actual readiness; document examples are
  not citation labels. Its development and shadow time/span/holdout gates remain.
- The 101-only Colab API cannot be widened safely by row count alone: database
  manifests use `public-intelligence-v1`/`seo-geo-journey-v1`/three splits while
  private v4/v5 use `features-v1`/`journey-v3`/four splits. An independently
  approved versioned adapter is needed before importing those external receipts.
