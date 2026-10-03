"""Offline adversarial tests. All rows below are synthetic, never training data."""
from __future__ import annotations

import contextlib
import io
import json
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ML_ROOT = Path(__file__).resolve().parents[1]
PRIVATE_TMP = str(Path(tempfile.gettempdir()).resolve())
sys.path.insert(0, str(ML_ROOT / "validation"))
sys.path.insert(0, str(ML_ROOT / "notebooks"))
from audit_training_assets import HEADS, PROFILES, audit_notebook, audit_rows, main, write_private_report
from harden_recovery_notebooks import harden_notebook
from validate_page_evidence_contract import ValidationError, validate_schema


def row(row_id=1, split="train", **patch):
    value = {
        "id": row_id, "manifestHash": PROFILES["v4-500"]["manifestHash"], "split": split,
        "trainingText": f"Synthetic example alpha {chr(96 + row_id)}.",
        "targets": {"journeyStage": "discovery", "secondaryStages": [], "stageCueTypes": [], "searchIntents": ["informational"], "contentTypes": ["editorial"], "audienceRoles": ["practitioner"], "geoSignals": ["global"], "citationReadiness": ["source_links"], "technicalSeoSignals": ["title_present"], "frictionSignals": ["weak_cta"], "actionPriority": "monitor"},
        "stageEvidence": [{"evidenceArtifactId": row_id, "evidenceLocator": "synthetic-only", "evidenceHash": str(row_id) * 64}],
        "labelConfidence": 4, "labelMethod": "human", "reviewState": "reviewed", "taxonomyVersion": "journey-v3", "featureContractVersion": "features-v1",
        "sourceFamily": "google_search_central", "canonicalDomainHash": str(row_id) * 64,
        "nearDuplicateCluster": f"synthetic-{row_id}", "contentType": "article", "language": "en",
        "governance": {"sourceCardId": "synthetic-source", "rightsStatus": "approved", "robotsChecked": True, "piiStatus": "none_detected", "dedupeStatus": "unique"},
    }
    value.update(patch)
    return value


def audit(rows, profile="v4-500", **manifest_patch):
    expected = PROFILES[profile]
    manifest = {"manifestVersion": f"manifest-{profile}", "manifestHash": expected["manifestHash"], "datasetDigest": expected["datasetDigest"], "splitCounts": expected["splits"], **manifest_patch}
    return audit_rows(rows, [json.dumps(value, allow_nan=False) for value in rows], manifest, profile)


class TrainingAuditTests(unittest.TestCase):
    def test_v4_schema_accepts_all_nine_heads_and_rejects_unknown_or_missing_targets(self):
        schema = json.loads((ML_ROOT / "schemas/dataset-v4-500.schema.json").read_text())
        validate_schema(row(), schema)
        self.assertTrue(set(HEADS) <= set(schema["properties"]["targets"]["required"]))
        invalid = row()
        invalid["targets"]["invented_label"] = "unknown"
        with self.assertRaises(ValidationError):
            validate_schema(invalid, schema)
        del invalid["targets"]["invented_label"]
        del invalid["targets"]["actionPriority"]
        with self.assertRaises(ValidationError):
            validate_schema(invalid, schema)

    def test_governance_and_candidate_labels_never_become_human_adjudication(self):
        candidate = row(reviewState="needs_adjudication", labelMethod="assistant_rule_candidate")
        result = audit([candidate])
        self.assertEqual(result["reviewReasonCounts"]["human_stage_adjudication_required"], 1)
        self.assertEqual(result["reviewReasonCounts"]["candidate_label_not_human_reviewed"], 1)
        self.assertFalse(result["humanReviewPerformed"])
        self.assertFalse(result["productionReady"])
        self.assertEqual(candidate["reviewState"], "needs_adjudication")

    def test_pending_rights_and_sensitive_text_are_redacted_in_review_queue(self):
        candidate = row(trainingText="fake.person@example.invalid password=FAKE_ONLY_TEST_VALUE")
        candidate["governance"]["rightsStatus"] = "public_access_only_pending_human_review"
        candidate["stageEvidence"][0]["evidenceLocator"] = "https://example.invalid/private-locator"
        result = audit([candidate], "v5-1087")
        output = json.dumps(result)
        self.assertNotIn("FAKE_ONLY_TEST_VALUE", output)
        self.assertNotIn("example.invalid", output)
        self.assertEqual(result["reviewReasonCounts"]["page_rights_review_required"], 1)
        self.assertEqual(result["reviewReasonCounts"]["sensitive_training_text"], 1)

    def test_split_leakage_and_text_duplicates_block_both_rows(self):
        first = row(1)
        second = row(2, "validation", trainingText="  SYNTHETIC   EXAMPLE ALPHA a. ", canonicalDomainHash=first["canonicalDomainHash"], nearDuplicateCluster=first["nearDuplicateCluster"], stageEvidence=first["stageEvidence"])
        result = audit([first, second])
        self.assertEqual(result["duplicateGroups"]["normalizedText"]["crossSplitGroupCount"], 1)
        self.assertEqual(result["reviewReasonCounts"]["duplicate_training_text"], 2)
        self.assertFalse(result["checks"]["groupSplitIsolation"])
        self.assertTrue(all("cross_split_evidenceHash" in item["reasonCodes"] for item in result["pendingReviewRows"]))

    def test_ids_vectors_schema_and_frozen_digest_fail_closed(self):
        result = audit([row(), row(trainingText="another synthetic sample", stageCueVector={"bad": "never a number"})])
        self.assertFalse(result["checks"]["uniqueIds"])
        self.assertFalse(result["checks"]["rowSchema"])
        self.assertFalse(result["checks"]["frozenDatasetDigest"])
        boolean_id = audit([row(row_id=True)])
        self.assertIsNone(boolean_id["pendingReviewRows"][0]["rowId"])

    def test_v5_parent_lineage_and_development_flags_cannot_be_forged(self):
        result = audit([row()], "v5-1087", developmentOnly=False)
        self.assertFalse(result["checks"]["developmentFlagsPreserved"])
        self.assertFalse(result["checks"]["frozenParentLineage"])
        self.assertFalse(result["checks"]["frozenSourceCounts"])

    def test_cli_without_data_reports_not_run_and_static_checks_only(self):
        for profile in PROFILES:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                status = main(["--profile", profile])
            report = json.loads(output.getvalue())
            self.assertEqual(status, 0)
            self.assertEqual(report["notebook"]["status"], "PASS")
            self.assertEqual(report["dataset"]["status"], "NOT_RUN")
            self.assertFalse(report["notebook"]["trainingExecuted"])

    def test_malformed_private_json_never_prints_input_or_error_text(self):
        with tempfile.TemporaryDirectory(dir=PRIVATE_TMP) as directory:
            data, manifest = Path(directory) / "rows.jsonl", Path(directory) / "manifest.json"
            data.write_text('{"secret":"FAKE_TEST_ONLY" invalid_json}')
            manifest.write_text("{}")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                status = main(["--data", str(data), "--manifest", str(manifest)])
            self.assertEqual(status, 1)
            self.assertNotIn("FAKE_TEST_ONLY", output.getvalue())
            self.assertNotIn(str(data), output.getvalue())

    def test_private_reports_never_overwrite_or_follow_symlinks(self):
        with tempfile.TemporaryDirectory(dir=PRIVATE_TMP) as directory:
            path = Path(directory) / "safe.json"
            write_private_report(path, {"productionReady": False})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                write_private_report(path, {})
            symlink = Path(directory) / "link.json"
            symlink.symlink_to(path)
            with self.assertRaises(FileExistsError):
                write_private_report(symlink, {})

    def test_reports_cannot_be_written_into_a_git_checkout(self):
        with tempfile.TemporaryDirectory(dir=PRIVATE_TMP) as directory:
            (Path(directory) / ".git").mkdir()
            with self.assertRaises(ValueError):
                write_private_report(Path(directory) / "safe.json", {})


class NotebookRecoveryTests(unittest.TestCase):
    def test_hardening_is_idempotent_and_both_notebooks_pass_static_audit(self):
        for profile, expected in PROFILES.items():
            notebook = json.loads((ML_ROOT / "notebooks" / expected["notebook"]).read_text())
            self.assertEqual(harden_notebook(notebook), notebook)
            self.assertEqual(audit_notebook(notebook, profile)["status"], "PASS")

    def test_unknown_training_mode_and_full_cpu_run_stop_before_training(self):
        notebook = json.loads((ML_ROOT / "notebooks" / PROFILES["v5-1087"]["notebook"]).read_text())
        source = next("".join(cell["source"]) for cell in notebook["cells"] if "RUN_MODE = 'fast_path'" in "".join(cell["source"]))
        branch = source[source.index("if RUN_MODE == 'full_ablation':"):source.index("print({'training_mode'")]
        for mode, exception in [("typo", ValueError), ("full_ablation", AssertionError)]:
            with self.assertRaises(exception):
                exec(branch, {"RUN_MODE": mode, "DEVICE": type("Device", (), {"type": "cpu"})(), "SEEDS": [1, 2, 3], "MAX_EPOCHS": 8})

    def test_source_generators_work_without_old_machine_and_refuse_overwrite(self):
        with tempfile.TemporaryDirectory(dir=PRIVATE_TMP) as directory:
            v4, v5 = Path(directory) / "v4.ipynb", Path(directory) / "v5.ipynb"
            generator = ML_ROOT / "notebooks/make_recovery_notebook.py"
            result = subprocess.run([sys.executable, str(generator), "--output", str(v4)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(audit_notebook(json.loads(v4.read_text()), "v4-500")["status"], "PASS")
            result = subprocess.run([sys.executable, str(ML_ROOT / "notebooks/make_v5_1087_notebook.py"), "--source", str(v4), "--output", str(v5)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(audit_notebook(json.loads(v5.read_text()), "v5-1087")["status"], "PASS")
            result = subprocess.run([sys.executable, str(ML_ROOT / "notebooks/check_v5_1087_notebook.py"), str(v5)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            before = v4.read_bytes()
            result = subprocess.run([sys.executable, str(generator), "--output", str(v4)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(v4.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
