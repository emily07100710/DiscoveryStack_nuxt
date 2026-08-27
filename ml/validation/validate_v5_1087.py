#!/usr/bin/env python3
"""Fail-closed validator for a private DiscoveryStack v5-1087 manifest.

The input files are intentionally supplied by the caller and are not part of
this repository. The script prints aggregate evidence only; it never prints
training text, URLs, source cards, or other row content.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True, help="private JSONL manifest")
    parser.add_argument("--manifest", type=Path, required=True, help="private manifest metadata JSON")
    args = parser.parse_args()

    rows_raw = [line.rstrip("\n") for line in args.data.read_text(encoding="utf-8").splitlines() if line.strip()]
    rows = [json.loads(line) for line in rows_raw]
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))

    required_tasks = {
        "journeyStage", "searchIntents", "contentTypes", "audienceRoles",
        "geoSignals", "citationReadiness", "technicalSeoSignals",
        "frictionSignals", "actionPriority",
    }
    allowed_stages = {"discovery", "understanding", "response", "progression", "conversion"}
    allowed_reviews = {"reviewed", "needs_adjudication"}
    allowed_label_methods = {"owner_approved_legacy", "assistant_rule_candidate", "human", "human_amended"}
    allowed_rights = {"approved", "public_access_only_pending_human_review"}
    expected_splits = Counter({"train": 761, "validation": 163, "test_legacy_v1": 32, "test_v2": 131})
    expected_sources = Counter({"google_search_central": 250, "web_dev": 500, "google_developers": 137, "mdn": 200})

    assert len(rows) == 1087, len(rows)
    assert len({int(row["id"]) for row in rows}) == 1087
    assert hashlib.sha256("\n".join(rows_raw).encode()).hexdigest() == manifest["datasetDigest"]
    assert {row["manifestHash"] for row in rows} == {manifest["manifestHash"]}
    assert Counter(row["split"] for row in rows) == expected_splits
    assert Counter(row.get("sourceFamily") for row in rows) == expected_sources
    assert manifest["manifestVersion"] == "manifest-v5-1087"
    assert manifest["parentManifestVersion"] == "manifest-v4-500"
    assert manifest["parentManifestHash"] == "d1868ebd13ebf5b489e551afba2c047c19af5022e83c101e23a9927beaf02977"
    assert manifest["baseDatasetRows"] == 500
    assert manifest["addedRows"] == 587
    assert manifest["developmentOnly"] is True
    assert manifest["rightsReviewPending"] is True
    assert manifest["humanAdjudicationRequiredBeforeProduction"] is True
    assert manifest["splitCounts"] == dict(expected_splits)
    assert manifest["sourceCounts"] == dict(expected_sources)
    assert min(Counter(row["targets"]["journeyStage"] for row in rows).values()) >= 80

    email_re = re.compile(r"(?i)[\w.\-+]+@[\w.\-]+\.[a-z]{2,}")
    phone_re = re.compile(r"(?<!\d)(?:\+?\d[\d .()\-]{8,}\d)(?!\d)")
    for index, row in enumerate(rows):
        assert isinstance(row["trainingText"], str) and row["trainingText"].strip(), index
        if int(row["id"]) >= 5_000_001:
            summary_text = row["trainingText"]
            markers = ["Title: ", "Page type: ", "Focus: ", "Summary: ", "Source signals: "]
            positions = [summary_text.find(marker) for marker in markers]
            assert positions[0] == 0 and all(pos >= 0 for pos in positions) and positions == sorted(positions), index
        assert not email_re.search(row["trainingText"]), index
        assert not phone_re.search(row["trainingText"]), index
        assert set(row["targets"]) >= required_tasks, index
        assert row["targets"]["journeyStage"] in allowed_stages, index
        assert row["reviewState"] in allowed_reviews, index
        assert row["labelMethod"] in allowed_label_methods, index
        assert row["taxonomyVersion"] == "journey-v3", index
        assert row["featureContractVersion"] == "features-v1", index
        assert row["governance"]["rightsStatus"] in allowed_rights, index
        assert row["governance"]["robotsChecked"] is True, index
        assert row["governance"]["piiStatus"] in {"none_detected", "masked"}, index
        assert row["governance"]["dedupeStatus"] in {"unique", "cluster_reviewed"}, index
        assert 1 <= int(row["labelConfidence"]) <= 5, index
        assert row["stageEvidence"], index

    print(json.dumps({
        "validated": True,
        "rows": len(rows),
        "manifestHash": manifest["manifestHash"],
        "datasetDigest": manifest["datasetDigest"],
        "splits": dict(Counter(row["split"] for row in rows)),
        "stageCounts": dict(Counter(row["targets"]["journeyStage"] for row in rows)),
        "sourceCounts": dict(Counter(row["sourceFamily"] for row in rows)),
        "reviewStateCounts": dict(Counter(row["reviewState"] for row in rows)),
        "developmentOnly": manifest["developmentOnly"],
        "rightsReviewPending": manifest["rightsReviewPending"],
        "humanAdjudicationRequiredBeforeProduction": manifest["humanAdjudicationRequiredBeforeProduction"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
