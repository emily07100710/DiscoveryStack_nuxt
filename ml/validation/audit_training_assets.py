#!/usr/bin/env python3
"""Offline, redacted audit of frozen v4/v5 data and recovery notebooks.

No browser, provider, database, package installation, training, or approval is
performed. A passed technical check never grants human review or production use.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import math
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path

ML_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_ROOT / "tools"))
from validate_page_evidence_contract import SENSITIVE_SIDECAR_PATTERNS, ValidationError, validate_schema  # noqa: E402

PROFILES = {
    "v4-500": {
        "rows": 500,
        "manifestHash": "d1868ebd13ebf5b489e551afba2c047c19af5022e83c101e23a9927beaf02977",
        "datasetDigest": "6aaf9e6c57f4d930ba220575bc1a5f7cb0ba6145373e7a8b629f89403c85c474",
        "splits": {"train": 350, "validation": 75, "test_legacy_v1": 32, "test_v2": 43},
        "schema": "dataset-v4-500.schema.json",
        "notebook": "DiscoveryStack_SEO_GEO_500_OPTIMIZED_RECOVERY.ipynb",
    },
    "v5-1087": {
        "rows": 1087,
        "manifestHash": "08931b3827f37d9254c9d8d0555aa635babc26d6c94c218bac523cc4a86f2003",
        "datasetDigest": "c787aad7f775a3f4db705c171b22f968bd1fff09b3ee3ee7e99557afccea60a6",
        "splits": {"train": 761, "validation": 163, "test_legacy_v1": 32, "test_v2": 131},
        "schema": "dataset-v5-1087.schema.json",
        "notebook": "DiscoveryStack_SEO_GEO_1087_CPU_FALLBACK_R2.ipynb",
    },
}
STAGES = ("discovery", "understanding", "response", "progression", "conversion")
HEADS = ("journeyStage", "searchIntents", "contentTypes", "audienceRoles", "geoSignals", "citationReadiness", "technicalSeoSignals", "frictionSignals", "actionPriority")
SOURCES = ("google_search_central", "web_dev", "google_developers", "mdn")


def _json(value: str):
    def invalid_constant(_value):
        raise ValueError("nonfinite_json")
    return json.loads(value, parse_constant=invalid_constant)


def _source(cell):
    value = cell.get("source", [])
    return value if isinstance(value, str) else "".join(value)


def audit_notebook(notebook: dict, profile: str) -> dict:
    """Inspect source only. Never execute notebook cells or import ML packages."""
    expected = PROFILES[profile]
    code = [cell for cell in notebook.get("cells", []) if cell.get("cell_type") == "code"]
    syntax_failures = []
    for index, cell in enumerate(code):
        try:
            ast.parse("\n".join(line for line in _source(cell).splitlines() if not line.lstrip().startswith(("!", "%"))))
        except (SyntaxError, ValueError):
            syntax_failures.append(index)
    source = "\n".join(_source(cell) for cell in code)
    schema = _json((ML_ROOT / "schemas" / expected["schema"]).read_text())
    target_schema = schema["properties"]["targets"]
    checks = {
        "pythonSyntax": not syntax_failures,
        "outputsCleared": all(not cell.get("outputs") and cell.get("execution_count") is None for cell in code),
        "frozenRowCount": f"EXPECTED_ROW_COUNT = {expected['rows']}" in source,
        "frozenManifestHash": expected["manifestHash"] in source,
        "frozenDatasetDigest": expected["datasetDigest"] in source,
        "allNineHeadsInSchema": all(head in target_schema["properties"] and head in target_schema["required"] for head in HEADS),
        "selfContainedImports": "from pathlib import Path" in source and "from datetime import datetime, timezone" in source,
        "boundedDefault": "RUN_MODE = 'fast_path'" in source,
        "finiteSmokeGate": "assert bool(torch.isfinite(smoke_loss).item())" in source,
        "fullAblationRequiresGpu": "assert DEVICE.type == 'cuda', 'FAIL-CLOSED: full ablation requires CUDA GPU'" in source,
        "unknownRunModeRejected": "FAIL-CLOSED: unsupported RUN_MODE" in source,
        "priorCheckpointsPreserved": "shutil.rmtree(run_root" not in source and "tempfile.mkdtemp(" in source,
        "runLedgerSaved": "run_records.json" in source and "selected.json" in source,
        "selectionUsesValidation": "run_records[i]['validation']['macroF1']" in source,
        "rawDataExcluded": "'containsRawDataset':False" in source and "'containsHtml':False" in source,
    }
    return {"profile": profile, "status": "PASS" if all(checks.values()) else "FAIL", "proof": "static_notebook_source_only", "codeCells": len(code), "checks": checks, "syntaxFailureCellIndexes": syntax_failures, "trainingExecuted": False, "productionReady": False}


def _counts(values, allowed):
    counts = Counter(value if isinstance(value, str) and value in allowed else "unknown" for value in values)
    return dict(sorted(counts.items()))


def audit_rows(rows: list, raw_lines: list[str], manifest: dict, profile: str) -> dict:
    """Return safe aggregates and ordinal/ID-only review needs, never raw values."""
    expected = PROFILES[profile]
    schema = _json((ML_ROOT / "schemas" / expected["schema"]).read_text())
    pending = []
    row_checks = Counter()
    ids = []
    splits = []
    stages = []
    reviews = []
    rights = []
    sources = []
    groups = {name: defaultdict(list) for name in ("normalizedText", "canonicalDomainHash", "nearDuplicateCluster", "evidenceHash")}
    for ordinal, candidate in enumerate(rows, 1):
        row = candidate if isinstance(candidate, dict) else {}
        row_id = row.get("id")
        safe_id = row_id if isinstance(row_id, int) and not isinstance(row_id, bool) and row_id > 0 else None
        reasons = set()
        try:
            validate_schema(candidate, schema)
            vector = row.get("stageCueVector", {})
            if not isinstance(vector, dict) or any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in vector.values()):
                raise ValidationError("invalid_vector")
        except (ValidationError, ValueError, TypeError):
            reasons.add("row_schema_invalid")
        split = row.get("split")
        safe_split = split if isinstance(split, str) and split in expected["splits"] else "unknown"
        targets = row.get("targets") if isinstance(row.get("targets"), dict) else {}
        governance = row.get("governance") if isinstance(row.get("governance"), dict) else {}
        ids.append(safe_id)
        splits.append(safe_split)
        stages.append(targets.get("journeyStage"))
        reviews.append(row.get("reviewState"))
        rights.append(governance.get("rightsStatus"))
        sources.append(row.get("sourceFamily"))
        if row.get("manifestHash") != expected["manifestHash"]:
            reasons.add("row_manifest_hash_mismatch")
        if row.get("taxonomyVersion") != "journey-v3" or row.get("featureContractVersion") != "features-v1":
            reasons.add("version_contract_mismatch")
        if row.get("reviewState") != "reviewed":
            reasons.add("human_stage_adjudication_required")
        if row.get("labelMethod") not in {"human", "human_amended", "owner_approved_legacy"}:
            reasons.add("candidate_label_not_human_reviewed")
        if governance.get("rightsStatus") != "approved":
            reasons.add("page_rights_review_required")
        if governance.get("robotsChecked") is not True:
            reasons.add("robots_review_required")
        if governance.get("piiStatus") not in {"none_detected", "masked"}:
            reasons.add("pii_review_required")
        if governance.get("dedupeStatus") not in {"unique", "cluster_reviewed"}:
            reasons.add("dedupe_review_required")
        evidence = row.get("stageEvidence")
        if not isinstance(evidence, list) or not evidence:
            reasons.add("page_stage_evidence_required")
        text = row.get("trainingText")
        if isinstance(text, str):
            if any(pattern.search(text) for pattern in SENSITIVE_SIDECAR_PATTERNS):
                reasons.add("sensitive_training_text")
            text_digest = hashlib.sha256(" ".join(text.split()).casefold().encode()).hexdigest()
            groups["normalizedText"][text_digest].append((ordinal, safe_split))
        for key in ("canonicalDomainHash", "nearDuplicateCluster"):
            value = row.get(key)
            if isinstance(value, str) and value:
                groups[key][value].append((ordinal, safe_split))
            else:
                reasons.add("group_lineage_missing")
        for item in evidence if isinstance(evidence, list) else []:
            if isinstance(item, dict) and isinstance(item.get("evidenceHash"), str):
                groups["evidenceHash"][item["evidenceHash"]].append((ordinal, safe_split))
        pending.append({"rowOrdinal": ordinal, "rowId": safe_id, "split": safe_split, "reasonCodes": reasons})

    duplicate_groups = {}
    for kind, grouped in groups.items():
        cross = [members for members in grouped.values() if len({split for _, split in members}) > 1]
        duplicate_groups[kind] = {"repeatedGroupCount": sum(len(items) > 1 for items in grouped.values()), "crossSplitGroupCount": len(cross)}
        for members in cross:
            for ordinal, _ in members:
                pending[ordinal - 1]["reasonCodes"].add(f"cross_split_{kind}")
    for items in groups["normalizedText"].values():
        if len(items) > 1:
            for ordinal, _ in items:
                pending[ordinal - 1]["reasonCodes"].add("duplicate_training_text")
    id_counts = Counter(row_id for row_id in ids if row_id is not None)
    for item in pending:
        if item["rowId"] is None or id_counts[item["rowId"]] != 1:
            item["reasonCodes"].add("invalid_or_duplicate_row_id")
        row_checks.update(item["reasonCodes"])
        item["reasonCodes"] = sorted(item["reasonCodes"])
    pending = [item for item in pending if item["reasonCodes"]]
    dataset_digest = hashlib.sha256("\n".join(raw_lines).encode()).hexdigest()
    source_counts = _counts(sources, SOURCES)
    stage_counts = _counts(stages, STAGES)
    checks = {
        "frozenRowCount": len(rows) == expected["rows"],
        "frozenDatasetDigest": dataset_digest == expected["datasetDigest"] == manifest.get("datasetDigest"),
        "frozenManifestHash": manifest.get("manifestHash") == expected["manifestHash"],
        "manifestVersion": manifest.get("manifestVersion") == f"manifest-{profile}",
        "manifestSplitCounts": manifest.get("splitCounts") == expected["splits"],
        "uniqueIds": len(ids) == len(set(ids)) and None not in ids,
        "frozenSplits": dict(Counter(splits)) == expected["splits"],
        "rowSchema": row_checks["row_schema_invalid"] == 0,
        "rowLineage": row_checks["row_manifest_hash_mismatch"] == 0 and row_checks["version_contract_mismatch"] == 0,
        "allStagesAtLeast80": all(stage_counts.get(stage, 0) >= 80 for stage in STAGES),
        "allLabelsHumanReviewed": row_checks["human_stage_adjudication_required"] == 0 and row_checks["candidate_label_not_human_reviewed"] == 0,
        "allPageRightsApproved": row_checks["page_rights_review_required"] == 0,
        "noSensitiveTrainingText": row_checks["sensitive_training_text"] == 0,
        "completeGovernance": all(row_checks[key] == 0 for key in ("robots_review_required", "pii_review_required", "dedupe_review_required", "page_stage_evidence_required", "group_lineage_missing")),
        "noRepeatedTrainingText": row_checks["duplicate_training_text"] == 0,
        "groupSplitIsolation": all(group["crossSplitGroupCount"] == 0 for group in duplicate_groups.values()),
        "sourceFamilyAtMost20Percent": bool(rows) and all(count / len(rows) <= 0.2 for count in source_counts.values()),
    }
    if profile == "v5-1087":
        expected_sources = {"google_search_central": 250, "web_dev": 500, "google_developers": 137, "mdn": 200}
        checks.update({
            "frozenSourceCounts": source_counts == expected_sources == manifest.get("sourceCounts"),
            "frozenParentLineage": manifest.get("parentManifestVersion") == "manifest-v4-500" and manifest.get("parentManifestHash") == PROFILES["v4-500"]["manifestHash"] and manifest.get("baseDatasetRows") == 500 and manifest.get("addedRows") == 587,
            "developmentFlagsPreserved": all(manifest.get(key) is True for key in ("developmentOnly", "rightsReviewPending", "humanAdjudicationRequiredBeforeProduction")),
        })
    integrity_keys = ["frozenRowCount", "frozenDatasetDigest", "frozenManifestHash", "manifestVersion", "manifestSplitCounts", "uniqueIds", "frozenSplits", "rowSchema", "rowLineage", "noSensitiveTrainingText"]
    if profile == "v5-1087":
        integrity_keys += ["frozenSourceCounts", "frozenParentLineage", "developmentFlagsPreserved"]
    return {"profile": profile, "status": "PASS" if all(checks.values()) else "FAIL", "technicalIntegrityStatus": "PASS" if all(checks[key] for key in integrity_keys) else "FAIL", "productionDataPolicyStatus": "PASS" if all(checks.values()) else "FAIL", "proof": "local_private_dataset_audit_only", "rows": len(rows), "datasetDigest": dataset_digest, "checks": checks, "splitCounts": dict(Counter(splits)), "stageCounts": stage_counts, "reviewStateCounts": _counts(reviews, ("reviewed", "needs_adjudication", "blocked")), "rightsCounts": _counts(rights, ("approved", "public_access_only_pending_human_review", "needs_policy_review", "blocked")), "sourceCounts": source_counts, "duplicateGroups": duplicate_groups, "reviewReasonCounts": dict(sorted(row_checks.items())), "pendingReviewRows": pending, "productionReady": False, "humanReviewPerformed": False, "trainingExecuted": False}


def audit_dataset(data: Path, manifest_path: Path, profile: str) -> dict:
    if data.is_symlink() or manifest_path.is_symlink() or data.stat().st_size > 16 * 1024 * 1024 or manifest_path.stat().st_size > 1024 * 1024:
        raise ValueError("invalid_input_file")
    raw_lines = [line for line in data.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(raw_lines) > 2000 or any(len(line.encode()) > 512 * 1024 for line in raw_lines):
        raise ValueError("input_limits_exceeded")
    rows = [_json(line) for line in raw_lines]
    manifest = _json(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("invalid_manifest")
    return audit_rows(rows, raw_lines, manifest, profile)


def write_private_report(path: Path, report: dict) -> None:
    """Create one new private report. Never overwrite a prior report or follow symlinks."""
    if not path.is_absolute():
        raise ValueError("absolute_output_required")
    current = path.parent
    while current != current.parent:
        if current.is_symlink() or (current / ".git").exists():
            raise ValueError("report_must_be_outside_git_and_symlinks")
        current = current.parent
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=tuple(PROFILES), default="v5-1087")
    parser.add_argument("--data", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--report", type=Path, help="new private report outside every Git checkout; contains row IDs/reason codes only")
    args = parser.parse_args(argv)
    if bool(args.data) != bool(args.manifest):
        parser.error("--data and --manifest must be supplied together")
    expected = PROFILES[args.profile]
    notebook = _json((ML_ROOT / "notebooks" / expected["notebook"]).read_text())
    report = {"reportVersion": "training-assets-audit-v1", "notebook": audit_notebook(notebook, args.profile), "dataset": {"status": "NOT_RUN", "reasonCode": "private_dataset_not_supplied", "productionReady": False}}
    try:
        if args.data:
            report["dataset"] = audit_dataset(args.data, args.manifest, args.profile)
        if args.report:
            write_private_report(args.report, report)
    except (OSError, ValueError, TypeError, KeyError, RecursionError):
        # Deliberately omit exception text, input paths, row values and JSON snippets.
        print(json.dumps({"status": "FAIL", "reasonCode": "audit_input_or_output_invalid", "productionReady": False}))
        return 1
    public = dict(report)
    public["dataset"] = {key: value for key, value in report["dataset"].items() if key != "pendingReviewRows"}
    print(json.dumps(public, ensure_ascii=False, indent=2, allow_nan=False))
    return int(report["notebook"]["status"] != "PASS" or report["dataset"]["status"] == "FAIL")


if __name__ == "__main__":
    raise SystemExit(main())
