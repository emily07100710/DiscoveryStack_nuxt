from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT / "scripts"))

from verify_vendor_integrity import verify_snapshot  # noqa: E402


class VendorIntegrityTests(unittest.TestCase):
    def copy_snapshot(self, destination: Path) -> Path:
        copy = destination / "autogeo"
        shutil.copytree(SERVICE_ROOT, copy)
        return copy

    def test_committed_snapshot_passes(self) -> None:
        self.assertEqual(verify_snapshot(SERVICE_ROOT), [])

    def test_hash_tampering_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            copy = self.copy_snapshot(Path(directory))
            target = copy / "vendor" / "autogeo" / "config.py"
            target.write_bytes(target.read_bytes() + b"\n# tampered\n")
            errors = verify_snapshot(copy)
            self.assertTrue(any("sha256 mismatch" in error for error in errors), errors)

    def test_unmanifested_vendor_file_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            copy = self.copy_snapshot(Path(directory))
            (copy / "vendor" / "autogeo" / "unexpected.py").write_text(
                "# not in manifest\n", encoding="utf-8"
            )
            errors = verify_snapshot(copy)
            self.assertTrue(any("unmanifested vendored file" in error for error in errors), errors)

    def test_vendor_symlink_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            copy = self.copy_snapshot(Path(directory))
            os_link = copy / "vendor" / "autogeo" / "linked.py"
            os_link.symlink_to(copy / "vendor" / "autogeo" / "config.py")
            errors = verify_snapshot(copy)
            self.assertTrue(any("symlink is forbidden" in error for error in errors), errors)


if __name__ == "__main__":
    unittest.main()
