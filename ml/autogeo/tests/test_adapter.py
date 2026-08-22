from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "synthetic_product_page.txt"


def run(*arguments: str) -> dict:
    completed = subprocess.run([sys.executable, *arguments], check=True, capture_output=True, text=True)
    return json.loads(completed.stdout)


class AdapterTests(unittest.TestCase):
    def test_fixture_only_vanilla_baseline_has_audit_fields(self) -> None:
        result = run(str(ROOT / "rewrite_document.py"), "--fixture", str(FIXTURE))
        self.assertEqual(result["status"], "completed_fixture_baseline")
        self.assertEqual(result["engine"], "vanilla")
        self.assertFalse(result["auto_publish"])
        self.assertIsNone(result["geo_score"])

    def test_api_path_is_blocked_without_explicit_opt_in(self) -> None:
        result = run(str(ROOT / "rewrite_document.py"), "--fixture", str(FIXTURE), "--engine", "autogeo_api")
        self.assertEqual(result["status"], "blocked_explicit_opt_in_required")

    def test_customer_path_is_refused(self) -> None:
        completed = subprocess.run([sys.executable, str(ROOT / "rewrite_document.py"), "--fixture", "/tmp/not-a-fixture.txt"], capture_output=True, text=True)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("Only synthetic files", completed.stderr)

    def test_example_manifest_is_deliberately_not_passed_as_observed_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manifest = pathlib.Path(directory) / "manifest.json"
            manifest.write_text(json.dumps({"schema_version": "autogeo-asset-manifest-v1", "datasets": [], "models": []}), encoding="utf-8")
            result = run(str(ROOT / "verify_assets.py"), "--manifest", str(manifest))
            self.assertEqual(result["status"], "passed")


if __name__ == "__main__":
    unittest.main()
