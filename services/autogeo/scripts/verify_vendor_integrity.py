#!/usr/bin/env python3
"""Fail-closed, offline integrity checks for the AutoGEO source snapshot."""

from __future__ import annotations

import ast
import hashlib
import json
import os
import re
import stat
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any


MAX_FILE_BYTES = 1 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024
EXPECTED_VENDOR_PYTHON_COUNT = 35

LOCK_NAME = "UPSTREAM.lock.json"
MANIFEST_NAME = "UPSTREAM_MANIFEST.json"

EXPECTED_REPOSITORY = "https://github.com/cxcscmu/AutoGEO.git"
EXPECTED_PINNED_COMMIT = "49456df236774ea24087c44f45e9e52005b8e6a4"
EXPECTED_TREE_SHA = "4eb429f3ee33150c122a8e37856977b13c089924"
EXPECTED_LICENSE_SPDX = "MIT"
EXPECTED_LICENSE_UPSTREAM_PATH = "LICENSE"
EXPECTED_LICENSE_SHA256 = "7db440f0a16ee1bb2b77726e9c693a6171667069c6ac1679efbb2c2fe41cf0b3"
EXPECTED_SELECTION_POLICY = "autogeo-runtime-source-v1"

LOCK_KEYS = {
    "schemaVersion",
    "repository",
    "pinnedCommit",
    "treeSha",
    "license",
    "importedAt",
    "selectionPolicyVersion",
}
LOCK_LICENSE_KEYS = {"spdx", "upstreamPath", "sha256"}
MANIFEST_KEYS = {"schemaVersion", "files"}
MANIFEST_ENTRY_KEYS = {"upstreamPath", "localPath", "byteSize", "sha256"}

SERVICE_OWNED_FILES = {
    ".gitattributes",
    "ADAPTATION_BOUNDARY.md",
    "LICENSE.autogeo",
    "README.md",
    "SECURITY_AUDIT.md",
    LOCK_NAME,
    MANIFEST_NAME,
    "scripts/verify_vendor_integrity.py",
    "tests/test_vendor_integrity.py",
}

FORBIDDEN_COMPONENTS = {
    ".git",
    ".github",
    "__pycache__",
    "build",
    "cache",
    "caches",
    "checkpoint",
    "checkpoints",
    "conda",
    "data",
    "dataset",
    "datasets",
    "dist",
    "model",
    "models",
    "node_modules",
    "output",
    "outputs",
    "venv",
    "weight",
    "weights",
}

ARCHIVE_SUFFIXES = {
    ".7z",
    ".bz2",
    ".dmg",
    ".gz",
    ".iso",
    ".jar",
    ".pdf",
    ".rar",
    ".tar",
    ".tbz2",
    ".tgz",
    ".txz",
    ".whl",
    ".xz",
    ".zip",
}

MODEL_BINARY_SUFFIXES = {
    ".arrow",
    ".bin",
    ".ckpt",
    ".dll",
    ".dylib",
    ".exe",
    ".joblib",
    ".npy",
    ".npz",
    ".onnx",
    ".parquet",
    ".pickle",
    ".pkl",
    ".pt",
    ".pth",
    ".safetensors",
    ".so",
    ".wasm",
}

MAGIC_PREFIXES = (
    (b"version https://git-lfs.github.com/spec/v1", "Git LFS pointer is forbidden"),
    (b"PK\x03\x04", "archive magic is forbidden"),
    (b"PK\x05\x06", "archive magic is forbidden"),
    (b"PK\x07\x08", "archive magic is forbidden"),
    (b"\x1f\x8b", "archive magic is forbidden"),
    (b"7z\xbc\xaf\x27\x1c", "archive magic is forbidden"),
    (b"Rar!\x1a\x07", "archive magic is forbidden"),
    (b"\x7fELF", "executable binary magic is forbidden"),
    (b"MZ", "executable binary magic is forbidden"),
    (b"\xfe\xed\xfa\xce", "Mach-O magic is forbidden"),
    (b"\xce\xfa\xed\xfe", "Mach-O magic is forbidden"),
    (b"\xfe\xed\xfa\xcf", "Mach-O magic is forbidden"),
    (b"\xcf\xfa\xed\xfe", "Mach-O magic is forbidden"),
    (b"\xca\xfe\xba\xbe", "Mach-O magic is forbidden"),
    (b"\xbe\xba\xfe\xca", "Mach-O magic is forbidden"),
    (b"\xca\xfe\xba\xbf", "Mach-O magic is forbidden"),
    (b"\xbf\xba\xfe\xca", "Mach-O magic is forbidden"),
    (b"%PDF-", "PDF magic is forbidden"),
    (b"SQLite format 3\x00", "SQLite magic is forbidden"),
)

SECRET_PATTERNS = (
    re.compile(rb"(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}"),
    re.compile(rb"(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}"),
    re.compile(rb"AIza[0-9A-Za-z_-]{35}"),
    re.compile(rb"gh[pousr]_[A-Za-z0-9]{30,}"),
    re.compile(rb"(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])"),
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
)

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
UTC_TIMESTAMP_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")
INVALID_JSON = object()


class DuplicateJsonKeyError(ValueError):
    """Raised when JSON repeats an object key."""


def _error(errors: list[str], path: str, reason: str) -> None:
    errors.append(f"{path}: {reason}")


def _absolute_without_resolving(path: Path) -> Path:
    return path if path.is_absolute() else Path.cwd() / path


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateJsonKeyError
        result[key] = value
    return result


def _reject_json_constant(_value: str) -> None:
    raise ValueError


def _is_exact_integer(value: Any) -> bool:
    return type(value) is int


def _is_normalized_relative_posix_path(value: Any) -> bool:
    if type(value) is not str or value == "":
        return False
    if "\\" in value or "//" in value or "%" in value:
        return False
    candidate = PurePosixPath(value)
    if candidate.is_absolute() or candidate.parts == ():
        return False
    if any(part in {"", ".", ".."} for part in candidate.parts):
        return False
    return candidate.as_posix() == value


def _walk_without_following_symlinks(
    root: Path, errors: list[str]
) -> tuple[dict[str, os.stat_result], set[str]]:
    files: dict[str, os.stat_result] = {}
    directories: set[str] = set()
    try:
        root_stat = os.lstat(root)
    except OSError:
        _error(errors, "services/autogeo", "snapshot root is unavailable")
        return files, directories
    if stat.S_ISLNK(root_stat.st_mode):
        _error(errors, "services/autogeo", "symlink is forbidden")
        return files, directories
    if not stat.S_ISDIR(root_stat.st_mode):
        _error(errors, "services/autogeo", "snapshot root is not a directory")
        return files, directories

    stack: list[tuple[Path, tuple[str, ...]]] = [(root, ())]
    while stack:
        directory, parent_parts = stack.pop()
        try:
            entries = sorted(os.scandir(directory), key=lambda item: item.name)
        except OSError:
            display = "/".join(parent_parts) or "services/autogeo"
            _error(errors, display, "directory cannot be inspected")
            continue
        for entry in entries:
            parts = parent_parts + (entry.name,)
            relative = PurePosixPath(*parts).as_posix()
            try:
                entry_stat = entry.stat(follow_symlinks=False)
            except OSError:
                _error(errors, relative, "filesystem object cannot be inspected")
                continue
            mode = entry_stat.st_mode
            if stat.S_ISLNK(mode):
                _error(errors, relative, "symlink is forbidden")
            elif stat.S_ISDIR(mode):
                directories.add(relative)
                lowered = {part.lower() for part in parts}
                if lowered & FORBIDDEN_COMPONENTS:
                    _error(errors, relative, "forbidden artifact path")
                else:
                    stack.append((Path(entry.path), parts))
            elif stat.S_ISREG(mode):
                files[relative] = entry_stat
            else:
                _error(errors, relative, "non-regular filesystem object is forbidden")
    return files, directories


def _path_policy_reasons(relative: str) -> tuple[list[str], bool]:
    path = PurePosixPath(relative)
    lowered_parts = {part.lower() for part in path.parts}
    name = path.name.lower()
    suffix = path.suffix.lower()
    reasons: list[str] = []
    sensitive = False
    if lowered_parts & FORBIDDEN_COMPONENTS:
        reasons.append("forbidden artifact path")
        sensitive = True
    if name == ".ds_store":
        reasons.append("system metadata file is forbidden")
    if name == "keys.env" or name.startswith(".env"):
        reasons.append("environment file is forbidden")
        sensitive = True
    if suffix in ARCHIVE_SUFFIXES:
        reasons.append("archive file is forbidden")
        sensitive = True
    if suffix in MODEL_BINARY_SUFFIXES:
        reasons.append("model or executable artifact is forbidden")
        sensitive = True
    return reasons, sensitive


def _read_regular_files(
    root: Path, files: dict[str, os.stat_result], errors: list[str]
) -> dict[str, bytes]:
    contents: dict[str, bytes] = {}
    total_size = 0
    for relative in sorted(files):
        file_stat = files[relative]
        total_size += file_stat.st_size
        if file_stat.st_size > MAX_FILE_BYTES:
            _error(errors, relative, "file exceeds 1 MiB limit")
        policy_reasons, sensitive = _path_policy_reasons(relative)
        for reason in policy_reasons:
            _error(errors, relative, reason)
        if sensitive:
            continue
        try:
            data = (root / relative).read_bytes()
        except OSError:
            _error(errors, relative, "regular file cannot be read")
            continue
        contents[relative] = data
        if b"\x00" in data:
            _error(errors, relative, "NUL binary content is forbidden")
        for prefix, reason in MAGIC_PREFIXES:
            if data.startswith(prefix):
                _error(errors, relative, reason)
        if any(pattern.search(data) for pattern in SECRET_PATTERNS):
            _error(errors, relative, "secret-like content is forbidden")
    if total_size > MAX_SNAPSHOT_BYTES:
        _error(errors, "services/autogeo", "snapshot exceeds 10 MiB limit")
    return contents


def _load_strict_json(
    name: str, contents: dict[str, bytes], errors: list[str]
) -> Any:
    data = contents.get(name)
    if data is None:
        _error(errors, name, "required regular JSON file is unavailable")
        return INVALID_JSON
    try:
        text = data.decode("utf-8", errors="strict")
        return json.loads(
            text,
            object_pairs_hook=_strict_object,
            parse_constant=_reject_json_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, DuplicateJsonKeyError, ValueError):
        _error(errors, name, "invalid strict JSON")
        return INVALID_JSON


def _validate_fixed_string(
    data: dict[str, Any], key: str, expected: str, path: str, errors: list[str]
) -> bool:
    value = data.get(key)
    if type(value) is not str:
        _error(errors, path, f"{key} must be a string")
        return False
    if value != expected:
        _error(errors, path, f"{key} does not match the pinned identity")
        return False
    return True


def _validate_lock(data: Any, errors: list[str]) -> dict[str, Any] | None:
    if type(data) is not dict:
        _error(errors, LOCK_NAME, "top level must be an object")
        return None
    keys = set(data)
    if keys - LOCK_KEYS:
        _error(errors, LOCK_NAME, "unknown top-level field")
    if LOCK_KEYS - keys:
        _error(errors, LOCK_NAME, "missing required top-level field")

    schema = data.get("schemaVersion")
    if not _is_exact_integer(schema) or schema != 1:
        _error(errors, LOCK_NAME, "schemaVersion must be exact integer 1")

    _validate_fixed_string(data, "repository", EXPECTED_REPOSITORY, LOCK_NAME, errors)

    pinned = data.get("pinnedCommit")
    if type(pinned) is not str or SHA_RE.fullmatch(pinned) is None:
        _error(errors, LOCK_NAME, "pinnedCommit must be 40 lowercase hexadecimal characters")
    elif pinned != EXPECTED_PINNED_COMMIT:
        _error(errors, LOCK_NAME, "pinnedCommit does not match the pinned identity")

    tree = data.get("treeSha")
    if type(tree) is not str or SHA_RE.fullmatch(tree) is None:
        _error(errors, LOCK_NAME, "treeSha must be 40 lowercase hexadecimal characters")
    elif tree != EXPECTED_TREE_SHA:
        _error(errors, LOCK_NAME, "treeSha does not match the pinned identity")

    _validate_fixed_string(
        data,
        "selectionPolicyVersion",
        EXPECTED_SELECTION_POLICY,
        LOCK_NAME,
        errors,
    )

    imported_at = data.get("importedAt")
    imported_at_valid = type(imported_at) is str and UTC_TIMESTAMP_RE.fullmatch(imported_at) is not None
    if imported_at_valid:
        try:
            parsed = datetime.strptime(imported_at, "%Y-%m-%dT%H:%M:%SZ")
            imported_at_valid = parsed.strftime("%Y-%m-%dT%H:%M:%SZ") == imported_at
        except ValueError:
            imported_at_valid = False
    if not imported_at_valid:
        _error(errors, LOCK_NAME, "importedAt must be canonical UTC ISO-8601 ending in Z")

    license_data = data.get("license")
    if type(license_data) is not dict:
        _error(errors, LOCK_NAME, "license must be a strict object")
    else:
        license_keys = set(license_data)
        if license_keys - LOCK_LICENSE_KEYS:
            _error(errors, LOCK_NAME, "license has an unknown field")
        if LOCK_LICENSE_KEYS - license_keys:
            _error(errors, LOCK_NAME, "license is missing a required field")
        _validate_fixed_string(
            license_data, "spdx", EXPECTED_LICENSE_SPDX, LOCK_NAME, errors
        )
        _validate_fixed_string(
            license_data,
            "upstreamPath",
            EXPECTED_LICENSE_UPSTREAM_PATH,
            LOCK_NAME,
            errors,
        )
        license_hash = license_data.get("sha256")
        if type(license_hash) is not str or SHA256_RE.fullmatch(license_hash) is None:
            _error(errors, LOCK_NAME, "license sha256 must be 64 lowercase hexadecimal characters")
        elif license_hash != EXPECTED_LICENSE_SHA256:
            _error(errors, LOCK_NAME, "license sha256 does not match the pinned identity")
    return data


def _validate_manifest(data: Any, errors: list[str]) -> list[dict[str, Any]] | None:
    if type(data) is not dict:
        _error(errors, MANIFEST_NAME, "top level must be an object")
        return None
    keys = set(data)
    if keys - MANIFEST_KEYS:
        _error(errors, MANIFEST_NAME, "unknown top-level field")
    if MANIFEST_KEYS - keys:
        _error(errors, MANIFEST_NAME, "missing required top-level field")

    schema = data.get("schemaVersion")
    if not _is_exact_integer(schema) or schema != 1:
        _error(errors, MANIFEST_NAME, "schemaVersion must be exact integer 1")

    files = data.get("files")
    if type(files) is not list or len(files) == 0:
        _error(errors, MANIFEST_NAME, "files must be a non-empty array")
        return None

    entries: list[dict[str, Any]] = []
    structurally_valid = True
    for index, entry in enumerate(files):
        entry_path = f"{MANIFEST_NAME}#files[{index}]"
        if type(entry) is not dict:
            _error(errors, entry_path, "entry must be an object")
            structurally_valid = False
            continue
        entry_keys = set(entry)
        if entry_keys - MANIFEST_ENTRY_KEYS:
            _error(errors, entry_path, "entry has an unknown field")
            structurally_valid = False
        if MANIFEST_ENTRY_KEYS - entry_keys:
            _error(errors, entry_path, "entry is missing a required field")
            structurally_valid = False

        upstream = entry.get("upstreamPath")
        local = entry.get("localPath")
        if not _is_normalized_relative_posix_path(upstream):
            _error(errors, entry_path, "upstreamPath must be a normalized relative POSIX path")
            structurally_valid = False
        if not _is_normalized_relative_posix_path(local):
            _error(errors, entry_path, "localPath must be a normalized relative POSIX path")
            structurally_valid = False

        byte_size = entry.get("byteSize")
        if not _is_exact_integer(byte_size) or byte_size < 0:
            _error(errors, entry_path, "byteSize must be a non-negative integer")
            structurally_valid = False
        file_hash = entry.get("sha256")
        if type(file_hash) is not str or SHA256_RE.fullmatch(file_hash) is None:
            _error(errors, entry_path, "sha256 must be 64 lowercase hexadecimal characters")
            structurally_valid = False
        entries.append(entry)

    if not structurally_valid:
        return None

    upstream_paths = [entry["upstreamPath"] for entry in entries]
    local_paths = [entry["localPath"] for entry in entries]
    if len(set(upstream_paths)) != len(upstream_paths):
        _error(errors, MANIFEST_NAME, "duplicate upstreamPath")
    if len(set(local_paths)) != len(local_paths):
        _error(errors, MANIFEST_NAME, "duplicate localPath")
    ordering = [(entry["upstreamPath"], entry["localPath"]) for entry in entries]
    if ordering != sorted(ordering):
        _error(errors, MANIFEST_NAME, "entries are not in deterministic code-point order")

    license_entries = [entry for entry in entries if entry["upstreamPath"] == "LICENSE"]
    if len(license_entries) != 1:
        _error(errors, MANIFEST_NAME, "exactly one LICENSE entry is required")

    vendor_count = 0
    for index, entry in enumerate(entries):
        entry_path = f"{MANIFEST_NAME}#files[{index}]"
        upstream = entry["upstreamPath"]
        local = entry["localPath"]
        if upstream == "LICENSE":
            if local != "LICENSE.autogeo":
                _error(errors, entry_path, "LICENSE mapping must be exact")
            continue
        if not upstream.startswith("autogeo/") or not upstream.endswith(".py"):
            _error(errors, entry_path, "upstream Python mapping is outside autogeo")
            continue
        relative = upstream[len("autogeo/") :]
        expected_local = f"vendor/autogeo/{relative}"
        if local != expected_local:
            _error(errors, entry_path, "upstream and local Python paths must map exactly")
        vendor_count += 1
    if vendor_count != EXPECTED_VENDOR_PYTHON_COUNT:
        _error(errors, MANIFEST_NAME, "manifest must contain exactly 35 vendored Python files")
    return entries


def _expected_directories(expected_files: set[str]) -> set[str]:
    expected: set[str] = set()
    for relative in expected_files:
        parent = PurePosixPath(relative).parent
        while parent.as_posix() != ".":
            expected.add(parent.as_posix())
            parent = parent.parent
    return expected


def _validate_exact_inventory(
    files: dict[str, os.stat_result],
    directories: set[str],
    entries: list[dict[str, Any]],
    errors: list[str],
) -> None:
    expected_files = SERVICE_OWNED_FILES | {entry["localPath"] for entry in entries}
    actual_files = set(files)
    for relative in sorted(expected_files - actual_files):
        _error(errors, relative, "required regular file is missing")
    for relative in sorted(actual_files - expected_files):
        _error(errors, relative, "unexpected regular file")
    expected_directories = _expected_directories(expected_files)
    for relative in sorted(directories - expected_directories):
        _error(errors, relative, "unexpected directory")
    for relative in sorted(expected_directories - directories):
        _error(errors, relative, "required directory is missing")


def _validate_entries_and_python(
    files: dict[str, os.stat_result],
    contents: dict[str, bytes],
    entries: list[dict[str, Any]],
    lock_data: dict[str, Any] | None,
    errors: list[str],
) -> None:
    license_entry: dict[str, Any] | None = None
    for entry in entries:
        local = entry["localPath"]
        if entry["upstreamPath"] == "LICENSE":
            license_entry = entry
        if local not in files:
            continue
        data = contents.get(local)
        if data is None:
            _error(errors, local, "manifest file bytes are unavailable")
            continue
        if files[local].st_size != entry["byteSize"]:
            _error(errors, local, "manifest byteSize mismatch")
        actual_hash = hashlib.sha256(data).hexdigest()
        if actual_hash != entry["sha256"]:
            _error(errors, local, "manifest sha256 mismatch")

        if local.startswith("vendor/autogeo/") and local.endswith(".py"):
            try:
                source = data.decode("utf-8", errors="strict")
            except UnicodeDecodeError:
                _error(errors, local, "vendored Python is not strict UTF-8")
                continue
            try:
                ast.parse(source, filename=local, mode="exec")
                compile(
                    source,
                    local,
                    "exec",
                    flags=ast.PyCF_ONLY_AST,
                    dont_inherit=True,
                )
            except (SyntaxError, ValueError, TypeError, OverflowError):
                _error(errors, local, "vendored Python syntax is invalid")

    license_data = contents.get("LICENSE.autogeo")
    if license_entry is None:
        return
    if license_data is None:
        _error(errors, "LICENSE.autogeo", "license bytes are unavailable")
        return
    actual_license_hash = hashlib.sha256(license_data).hexdigest()
    if actual_license_hash != license_entry["sha256"]:
        _error(errors, "LICENSE.autogeo", "license and manifest hashes do not match")
    lock_license_hash: Any = None
    if type(lock_data) is dict and type(lock_data.get("license")) is dict:
        lock_license_hash = lock_data["license"].get("sha256")
    if type(lock_license_hash) is not str:
        _error(errors, "LICENSE.autogeo", "lock license hash is unavailable")
        return
    if license_entry["sha256"] != lock_license_hash:
        _error(errors, "LICENSE.autogeo", "lock and manifest license hashes do not match")
    if actual_license_hash != lock_license_hash:
        _error(errors, "LICENSE.autogeo", "actual and lock license hashes do not match")


def verify_snapshot(service_root: Path | None = None) -> list[str]:
    """Return stable, content-safe validation errors; an empty list means PASS."""

    default_root = Path(__file__).absolute().parents[1]
    selected_root = Path(service_root) if service_root is not None else default_root
    root = _absolute_without_resolving(selected_root)
    errors: list[str] = []
    files, directories = _walk_without_following_symlinks(root, errors)
    contents = _read_regular_files(root, files, errors)

    lock_json = _load_strict_json(LOCK_NAME, contents, errors)
    manifest_json = _load_strict_json(MANIFEST_NAME, contents, errors)
    lock_data = _validate_lock(lock_json, errors) if lock_json is not INVALID_JSON else None
    entries = _validate_manifest(manifest_json, errors) if manifest_json is not INVALID_JSON else None
    if entries is not None:
        _validate_exact_inventory(files, directories, entries, errors)
        _validate_entries_and_python(files, contents, entries, lock_data, errors)
    return sorted(set(errors))


def main() -> int:
    errors = verify_snapshot()
    if errors:
        print("FAIL: AutoGEO vendor integrity verification")
        for error in errors:
            print(f"- {error}")
        return 1
    print("PASS: AutoGEO vendor integrity verification")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
