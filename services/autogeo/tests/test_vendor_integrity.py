from __future__ import annotations

import hashlib
import json
import os
import shutil
import socket
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT / "scripts"))

from verify_vendor_integrity import (  # noqa: E402
    MANIFEST_NAME,
    MAX_FILE_BYTES,
    verify_snapshot,
)


class VendorIntegrityTests(unittest.TestCase):
    @contextmanager
    def copied_snapshot(self) -> Iterator[Path]:
        with tempfile.TemporaryDirectory() as directory:
            copy = Path(directory) / "autogeo"
            shutil.copytree(SERVICE_ROOT, copy)
            yield copy

    def read_json(self, root: Path, relative: str) -> dict:
        return json.loads((root / relative).read_text(encoding="utf-8"))

    def write_json(self, root: Path, relative: str, value: object) -> None:
        (root / relative).write_text(
            json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )

    def manifest_entry(self, manifest: dict, local_path: str) -> dict:
        return next(entry for entry in manifest["files"] if entry["localPath"] == local_path)

    def refresh_manifest_entry(self, root: Path, local_path: str) -> None:
        manifest = self.read_json(root, MANIFEST_NAME)
        entry = self.manifest_entry(manifest, local_path)
        data = (root / local_path).read_bytes()
        entry["byteSize"] = len(data)
        entry["sha256"] = hashlib.sha256(data).hexdigest()
        self.write_json(root, MANIFEST_NAME, manifest)

    def assert_rejected(self, root: Path, reason: str) -> list[str]:
        errors = verify_snapshot(root)
        self.assertTrue(errors, "mutated snapshot unexpectedly passed")
        self.assertTrue(any(reason in error for error in errors), errors)
        return errors

    def test_01_committed_snapshot_passes(self) -> None:
        self.assertEqual(verify_snapshot(SERVICE_ROOT), [])

    def test_02_vendor_byte_tamper_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            target = root / "vendor/autogeo/config.py"
            target.write_bytes(target.read_bytes() + b"\n# tampered\n")
            self.assert_rejected(root, "manifest sha256 mismatch")

    def test_03_unmanifested_vendor_file_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / "vendor/autogeo/unexpected.py").write_text("# extra\n", encoding="utf-8")
            self.assert_rejected(root, "unexpected regular file")

    def test_04_vendor_file_symlink_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / "vendor/autogeo/linked.py").symlink_to(root / "vendor/autogeo/config.py")
            self.assert_rejected(root, "symlink is forbidden")

    def test_05_lock_repository_tamper_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            lock = self.read_json(root, "UPSTREAM.lock.json")
            lock["repository"] = "https://example.invalid/AutoGEO.git"
            self.write_json(root, "UPSTREAM.lock.json", lock)
            self.assert_rejected(root, "repository does not match the pinned identity")

    def test_06_pinned_commit_tamper_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            lock = self.read_json(root, "UPSTREAM.lock.json")
            lock["pinnedCommit"] = "0" * 40
            self.write_json(root, "UPSTREAM.lock.json", lock)
            self.assert_rejected(root, "pinnedCommit does not match the pinned identity")

    def test_07_tree_tamper_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            lock = self.read_json(root, "UPSTREAM.lock.json")
            lock["treeSha"] = "0" * 40
            self.write_json(root, "UPSTREAM.lock.json", lock)
            self.assert_rejected(root, "treeSha does not match the pinned identity")

    def test_08_lock_license_hash_tamper_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            lock = self.read_json(root, "UPSTREAM.lock.json")
            lock["license"]["sha256"] = "0" * 64
            self.write_json(root, "UPSTREAM.lock.json", lock)
            self.assert_rejected(root, "license sha256 does not match the pinned identity")

    def test_09_lock_unknown_field_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            lock = self.read_json(root, "UPSTREAM.lock.json")
            lock["unexpected"] = True
            self.write_json(root, "UPSTREAM.lock.json", lock)
            self.assert_rejected(root, "unknown top-level field")

    def test_10_malformed_imported_at_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            lock = self.read_json(root, "UPSTREAM.lock.json")
            lock["importedAt"] = "not-a-timestamp"
            self.write_json(root, "UPSTREAM.lock.json", lock)
            self.assert_rejected(root, "importedAt must be canonical")

    def test_11_non_z_offset_time_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            lock = self.read_json(root, "UPSTREAM.lock.json")
            lock["importedAt"] = "2026-08-25T16:21:12+08:00"
            self.write_json(root, "UPSTREAM.lock.json", lock)
            self.assert_rejected(root, "importedAt must be canonical")

    def test_12_manifest_top_level_unknown_field_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            manifest = self.read_json(root, MANIFEST_NAME)
            manifest["unexpected"] = []
            self.write_json(root, MANIFEST_NAME, manifest)
            self.assert_rejected(root, "unknown top-level field")

    def test_13_manifest_entry_unknown_field_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            manifest = self.read_json(root, MANIFEST_NAME)
            manifest["files"][0]["unexpected"] = "value"
            self.write_json(root, MANIFEST_NAME, manifest)
            self.assert_rejected(root, "entry has an unknown field")

    def test_14_manifest_byte_size_boolean_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            manifest = self.read_json(root, MANIFEST_NAME)
            manifest["files"][0]["byteSize"] = True
            self.write_json(root, MANIFEST_NAME, manifest)
            self.assert_rejected(root, "byteSize must be a non-negative integer")

    def test_15_manifest_uppercase_hash_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            manifest = self.read_json(root, MANIFEST_NAME)
            manifest["files"][0]["sha256"] = manifest["files"][0]["sha256"].upper()
            self.write_json(root, MANIFEST_NAME, manifest)
            self.assert_rejected(root, "sha256 must be 64 lowercase")

    def test_16_duplicate_local_path_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            manifest = self.read_json(root, MANIFEST_NAME)
            manifest["files"][2]["localPath"] = manifest["files"][1]["localPath"]
            self.write_json(root, MANIFEST_NAME, manifest)
            self.assert_rejected(root, "duplicate localPath")

    def test_17_duplicate_upstream_path_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            manifest = self.read_json(root, MANIFEST_NAME)
            manifest["files"][2]["upstreamPath"] = manifest["files"][1]["upstreamPath"]
            self.write_json(root, MANIFEST_NAME, manifest)
            self.assert_rejected(root, "duplicate upstreamPath")

    def test_18_manifest_unordered_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            manifest = self.read_json(root, MANIFEST_NAME)
            manifest["files"] = list(reversed(manifest["files"]))
            self.write_json(root, MANIFEST_NAME, manifest)
            self.assert_rejected(root, "entries are not in deterministic code-point order")

    def test_19_removed_license_entry_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            manifest = self.read_json(root, MANIFEST_NAME)
            manifest["files"] = [e for e in manifest["files"] if e["upstreamPath"] != "LICENSE"]
            self.write_json(root, MANIFEST_NAME, manifest)
            self.assert_rejected(root, "exactly one LICENSE entry is required")

    def test_20_license_byte_tamper_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / "LICENSE.autogeo").write_bytes(b"tampered license\n")
            self.assert_rejected(root, "license and manifest hashes do not match")

    def test_21_lock_manifest_license_mismatch_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            manifest = self.read_json(root, MANIFEST_NAME)
            self.manifest_entry(manifest, "LICENSE.autogeo")["sha256"] = "0" * 64
            self.write_json(root, MANIFEST_NAME, manifest)
            self.assert_rejected(root, "lock and manifest license hashes do not match")

    def test_22_license_mapping_mismatch_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            manifest = self.read_json(root, MANIFEST_NAME)
            self.manifest_entry(manifest, "LICENSE.autogeo")["localPath"] = "README.md"
            self.write_json(root, MANIFEST_NAME, manifest)
            self.assert_rejected(root, "LICENSE mapping must be exact")

    def test_23_python_mapping_mismatch_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            manifest = self.read_json(root, MANIFEST_NAME)
            self.manifest_entry(manifest, "vendor/autogeo/config.py")["localPath"] = (
                "vendor/autogeo/config-copy.py"
            )
            self.write_json(root, MANIFEST_NAME, manifest)
            self.assert_rejected(root, "upstream and local Python paths must map exactly")

    def test_24_root_extra_file_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / "EXTRA.txt").write_text("extra\n", encoding="utf-8")
            self.assert_rejected(root, "unexpected regular file")

    def test_25_scripts_extra_file_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / "scripts/extra.py").write_text("# extra\n", encoding="utf-8")
            self.assert_rejected(root, "unexpected regular file")

    def test_26_dataset_artifact_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / "datasets").mkdir()
            (root / "datasets/payload.json").write_text("{}\n", encoding="utf-8")
            self.assert_rejected(root, "forbidden artifact path")

    def test_27_nested_git_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / ".git").mkdir()
            (root / ".git/config").write_text("[core]\n", encoding="utf-8")
            self.assert_rejected(root, "forbidden artifact path")

    def test_28_env_example_is_rejected_without_reading_it(self) -> None:
        with self.copied_snapshot() as root:
            (root / ".env.example").write_text("SECRET=do-not-read\n", encoding="utf-8")
            self.assert_rejected(root, "environment file is forbidden")

    def test_29_broken_symlink_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / "broken-link").symlink_to(root / "does-not-exist")
            self.assert_rejected(root, "symlink is forbidden")

    def test_30_directory_symlink_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / "linked-directory").symlink_to(
                root / "vendor/autogeo", target_is_directory=True
            )
            self.assert_rejected(root, "symlink is forbidden")

    def test_31_lfs_pointer_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / "README.md").write_bytes(
                b"version https://git-lfs.github.com/spec/v1\n"
                b"oid sha256:" + b"0" * 64 + b"\nsize 1\n"
            )
            self.assert_rejected(root, "Git LFS pointer is forbidden")

    def test_32_archive_magic_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / "README.md").write_bytes(b"PK\x03\x04not-an-allowed-archive")
            self.assert_rejected(root, "archive magic is forbidden")

    def test_33_nul_binary_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / "README.md").write_bytes(b"text\x00binary")
            self.assert_rejected(root, "NUL binary content is forbidden")

    def test_34_model_suffix_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / "model.pt").write_bytes(b"model")
            self.assert_rejected(root, "model or executable artifact is forbidden")

    def test_35_non_utf8_python_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / "vendor/autogeo/config.py").write_bytes(b"# invalid: \xff\n")
            self.refresh_manifest_entry(root, "vendor/autogeo/config.py")
            self.assert_rejected(root, "vendored Python is not strict UTF-8")

    def test_36_python_syntax_error_with_updated_hash_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / "vendor/autogeo/config.py").write_text("def broken(:\n", encoding="utf-8")
            self.refresh_manifest_entry(root, "vendor/autogeo/config.py")
            self.assert_rejected(root, "vendored Python syntax is invalid")

    def test_37_single_file_oversize_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / "README.md").write_bytes(b"a" * (MAX_FILE_BYTES + 1))
            self.assert_rejected(root, "file exceeds 1 MiB limit")

    def test_38_total_size_oversize_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            owned = [
                ".gitattributes",
                "ADAPTATION_BOUNDARY.md",
                "README.md",
                "SECURITY_AUDIT.md",
                "scripts/verify_vendor_integrity.py",
                "tests/test_vendor_integrity.py",
            ]
            for relative in owned:
                (root / relative).write_bytes(b"#" + b"a" * 899_998 + b"\n")
            manifest = self.read_json(root, MANIFEST_NAME)
            vendor_entries = [
                entry for entry in manifest["files"] if entry["localPath"].startswith("vendor/")
            ][:6]
            for entry in vendor_entries:
                data = b"#" + b"a" * 899_998 + b"\n"
                (root / entry["localPath"]).write_bytes(data)
                entry["byteSize"] = len(data)
                entry["sha256"] = hashlib.sha256(data).hexdigest()
            self.write_json(root, MANIFEST_NAME, manifest)
            self.assert_rejected(root, "snapshot exceeds 10 MiB limit")

    def test_39_pycache_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / "scripts/__pycache__").mkdir()
            (root / "scripts/__pycache__/cached.pyc").write_bytes(b"pyc")
            self.assert_rejected(root, "forbidden artifact path")

    def test_40_errors_do_not_expose_planted_fake_secret(self) -> None:
        with self.copied_snapshot() as root:
            fake_secret = "sk-" + "A" * 32
            (root / "leak.txt").write_text(fake_secret, encoding="utf-8")
            errors = verify_snapshot(root)
            self.assertTrue(errors)
            self.assertNotIn(fake_secret, "\n".join(errors))
            self.assertTrue(any("secret-like content is forbidden" in error for error in errors))

    def test_41_lock_schema_boolean_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            lock = self.read_json(root, "UPSTREAM.lock.json")
            lock["schemaVersion"] = True
            self.write_json(root, "UPSTREAM.lock.json", lock)
            self.assert_rejected(root, "schemaVersion must be exact integer 1")

    def test_42_manifest_schema_boolean_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            manifest = self.read_json(root, MANIFEST_NAME)
            manifest["schemaVersion"] = True
            self.write_json(root, MANIFEST_NAME, manifest)
            self.assert_rejected(root, "schemaVersion must be exact integer 1")

    def test_43_lock_value_with_extra_whitespace_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            lock = self.read_json(root, "UPSTREAM.lock.json")
            lock["repository"] = " " + lock["repository"]
            self.write_json(root, "UPSTREAM.lock.json", lock)
            self.assert_rejected(root, "repository does not match the pinned identity")

    def test_44_backslash_manifest_path_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            manifest = self.read_json(root, MANIFEST_NAME)
            manifest["files"][1]["localPath"] = "vendor\\autogeo\\config.py"
            self.write_json(root, MANIFEST_NAME, manifest)
            self.assert_rejected(root, "localPath must be a normalized relative POSIX path")

    def test_45_duplicate_slash_manifest_path_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            manifest = self.read_json(root, MANIFEST_NAME)
            manifest["files"][1]["localPath"] = "vendor//autogeo/config.py"
            self.write_json(root, MANIFEST_NAME, manifest)
            self.assert_rejected(root, "localPath must be a normalized relative POSIX path")

    def test_46_encoded_traversal_manifest_path_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            manifest = self.read_json(root, MANIFEST_NAME)
            manifest["files"][1]["upstreamPath"] = "autogeo/%2e%2e/config.py"
            self.write_json(root, MANIFEST_NAME, manifest)
            self.assert_rejected(root, "upstreamPath must be a normalized relative POSIX path")

    def test_47_fifo_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            os.mkfifo(root / "runtime.pipe")
            self.assert_rejected(root, "non-regular filesystem object is forbidden")

    def test_48_socket_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            socket_path = root / "runtime.sock"
            runtime_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                runtime_socket.bind(str(socket_path))
                self.assert_rejected(root, "non-regular filesystem object is forbidden")
            finally:
                runtime_socket.close()

    def test_49_empty_manifest_files_array_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            manifest = self.read_json(root, MANIFEST_NAME)
            manifest["files"] = []
            self.write_json(root, MANIFEST_NAME, manifest)
            self.assert_rejected(root, "files must be a non-empty array")

    def test_50_unexpected_empty_directory_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / "unexpected-empty-directory").mkdir()
            self.assert_rejected(root, "unexpected directory")

    def test_51_lock_license_unknown_field_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            lock = self.read_json(root, "UPSTREAM.lock.json")
            lock["license"]["unexpected"] = "value"
            self.write_json(root, "UPSTREAM.lock.json", lock)
            self.assert_rejected(root, "license has an unknown field")

    def test_52_lock_null_top_level_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            self.write_json(root, "UPSTREAM.lock.json", None)
            self.assert_rejected(root, "top level must be an object")

    def test_53_manifest_null_top_level_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            self.write_json(root, MANIFEST_NAME, None)
            self.assert_rejected(root, "top level must be an object")

    def test_54_duplicate_json_key_is_rejected(self) -> None:
        with self.copied_snapshot() as root:
            (root / "UPSTREAM.lock.json").write_text(
                '{"schemaVersion":1,"schemaVersion":1}\n', encoding="utf-8"
            )
            self.assert_rejected(root, "invalid strict JSON")


if __name__ == "__main__":
    unittest.main()
