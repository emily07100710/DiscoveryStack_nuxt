#!/usr/bin/env python3
"""Private, development-only page evidence collection.

This module deliberately has no import-time Playwright dependency so its policy,
mapping, filesystem, and validator boundaries can be tested without a browser or
network.  Live collection requires an owner-authorized target bundle and an
externally enforced no-private-network egress sandbox.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import ipaddress
import json
import os
import re
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path, PurePosixPath
from typing import Any, Awaitable, Callable, Iterable, Mapping, Sequence
from urllib.parse import SplitResult, urlsplit, urlunsplit

CONTRACT_VERSION = "page-evidence-v1"
TARGET_CONTRACT_VERSION = "page-evidence-targets-v1"
PROJECTION_VERSION = "page-evidence-model-projection-v1"
COLLECTOR_VERSION = "1.0.0"
LIGHTHOUSE_VERSION = "12.8.2"

RUN_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
QUERY_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
SCOPE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
ALLOWED_SPLITS = {"train", "validation", "test"}
ALLOWED_MAPPING_METHOD = "owner_supplied_exact_url"
FORBIDDEN_MAPPING_KEYS = {
    "canonicalDomainHash",
    "domainHash",
    "semanticMatch",
    "semanticSearch",
    "artifactText",
    "candidateLabel",
    "candidateUrl",
}
SPECIAL_USE_SUFFIXES = (
    ".localhost",
    ".local",
    ".localdomain",
    ".internal",
    ".home",
    ".lan",
    ".test",
    ".invalid",
    ".example",
    ".onion",
    ".arpa",
)
SENSITIVE_TEXT_PATTERNS = {
    "email": re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I),
    "phone": re.compile(r"(?<!\d)(?:\+?\d[\d .()\-]{7,}\d)(?!\d)"),
    "credit_card": re.compile(r"(?<!\d)(?:\d[ -]*?){13,19}(?!\d)"),
    "ssn_like": re.compile(r"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)"),
    "api_key_like": re.compile(
        r"\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{16,})\b",
        re.I,
    ),
    "credential_assignment": re.compile(
        r"\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|password)\b\s*[:=]\s*[^\s]{8,}",
        re.I,
    ),
}
PASSWORD_FIELD_RE = re.compile(r"(?:password|current-password|new-password)", re.I)
WAF_CHALLENGE_RE = re.compile(
    r"(?:captcha|verify you are human|checking your browser|attention required|access denied|security challenge)",
    re.I,
)
RAW_URL_RE = re.compile(r"(?:https?|wss?)://", re.I)
MAX_TARGET_BUNDLE_BYTES = 5 * 1024 * 1024
MAX_PARENT_DATASET_BYTES = 128 * 1024 * 1024
MAX_TEXT_BYTES = 2 * 1024 * 1024
MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024
MAX_LIGHTHOUSE_BYTES = 25 * 1024 * 1024
MAX_QUERY_SIDECAR_BYTES = 256 * 1024
MAX_MANIFEST_LINE_BYTES = 512 * 1024
DEFAULT_MAX_REQUESTS = 180
DEFAULT_RETENTION_DAYS_MAX = 30
DNS_RESOLUTION_TIMEOUT_SECONDS = 1.5
MAX_POLICY_REASON_CODES = 16
POLICY_REASON_CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
MAX_QUERY_TEXT_BYTES = 8192
MAX_QUERY_INTENT_BYTES = 1024
MAX_PAGE_PURPOSE_BYTES = 4096


class PolicyError(ValueError):
    """A caller-controlled value violated a fail-closed policy."""


class MappingError(ValueError):
    """Target-to-parent lineage is absent, ambiguous, or invalid."""


class FilesystemPolicyError(ValueError):
    """Private output cannot be stored with the required guarantees."""


class RuntimeUnavailable(RuntimeError):
    """An injected, verified runtime dependency is unavailable."""


class EgressBlocked(RuntimeError):
    """A browser request was denied by the per-request egress guard."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_text(value: str) -> str:
    return sha256_bytes(value.encode("utf-8"))


def sha256_file(path: Path, *, max_bytes: int | None = None) -> str:
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise FilesystemPolicyError(f"not a regular non-symlink file: {path}")
    size = path.stat().st_size
    if max_bytes is not None and size > max_bytes:
        raise FilesystemPolicyError(f"file exceeds {max_bytes} bytes: {path}")
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def read_bounded_bytes(path: Path, max_bytes: int) -> bytes:
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise FilesystemPolicyError(f"input must be a regular non-symlink file: {path}")
    size = path.stat().st_size
    if size > max_bytes:
        raise FilesystemPolicyError(f"input exceeds {max_bytes} bytes: {path}")
    with path.open("rb") as handle:
        data = handle.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise FilesystemPolicyError(f"input exceeds {max_bytes} bytes: {path}")
    return data


def load_json_file(path: Path, max_bytes: int) -> Any:
    try:
        return json.loads(read_bounded_bytes(path, max_bytes).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MappingError(f"invalid JSON: {path}") from exc


def load_jsonl_file(path: Path, max_bytes: int) -> list[dict[str, Any]]:
    raw = read_bounded_bytes(path, max_bytes)
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(raw.decode("utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise MappingError(f"invalid JSONL at line {line_number}") from exc
        if not isinstance(value, dict):
            raise MappingError(f"parent row {line_number} must be an object")
        rows.append(value)
    return rows


def canonical_hostname(raw_host: str) -> str:
    if not isinstance(raw_host, str) or not raw_host.strip():
        raise PolicyError("missing_host")
    host = unicodedata.normalize("NFC", raw_host.strip()).rstrip(".")
    if not host or "\x00" in host:
        raise PolicyError("invalid_host")
    try:
        ip = ipaddress.ip_address(host)
        return ip.compressed.lower()
    except ValueError:
        pass
    try:
        ascii_host = host.encode("idna").decode("ascii").lower()
    except UnicodeError as exc:
        raise PolicyError("invalid_idna_host") from exc
    if len(ascii_host) > 253:
        raise PolicyError("host_too_long")
    labels = ascii_host.split(".")
    if len(labels) < 2 or any(not label or len(label) > 63 for label in labels):
        raise PolicyError("special_use_or_single_label_host")
    if any(
        label.startswith("-")
        or label.endswith("-")
        or re.fullmatch(r"[a-z0-9-]+", label) is None
        for label in labels
    ):
        raise PolicyError("invalid_idna_host")
    return ascii_host


def is_special_use_hostname(host: str) -> bool:
    lowered = host.lower().rstrip(".")
    return lowered == "localhost" or any(
        lowered.endswith(suffix) or lowered == suffix[1:]
        for suffix in SPECIAL_USE_SUFFIXES
    )


def public_ip_or_error(raw: str) -> str:
    try:
        address = ipaddress.ip_address(raw.split("%", 1)[0])
    except ValueError as exc:
        raise PolicyError("dns_returned_invalid_address") from exc
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        raise PolicyError("ipv4_mapped_ipv6_blocked")
    if (
        not address.is_global
        or address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
        or address.is_multicast
        or address.is_unspecified
    ):
        raise PolicyError("non_public_address_blocked")
    return address.compressed.lower()


Resolver = Callable[[str, int], Sequence[str]]
AsyncResolver = Callable[[str, int], Awaitable[Sequence[str]]]


def system_resolver(host: str, port: int) -> Sequence[str]:
    try:
        answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise PolicyError("dns_resolution_failed") from exc
    return sorted({str(answer[4][0]) for answer in answers})


async def async_system_resolver(host: str, port: int) -> Sequence[str]:
    return await asyncio.to_thread(system_resolver, host, port)


@dataclass(frozen=True)
class ValidatedURL:
    canonical_url: str
    hostname: str
    port: int
    addresses: tuple[str, ...]

    @property
    def url_hash(self) -> str:
        return sha256_text(self.canonical_url)


@dataclass
class PublicURLPolicy:
    resolver: Resolver | None = None
    async_resolver: AsyncResolver | None = None
    dns_timeout_seconds: float = DNS_RESOLUTION_TIMEOUT_SECONDS
    allow_http: bool = False
    allowed_https_ports: frozenset[int] = frozenset({443})
    allowed_http_ports: frozenset[int] = frozenset({80})

    def _prepare(self, raw: Any) -> tuple[str, str, int, SplitResult, Any]:
        if not isinstance(raw, str) or not raw.strip():
            raise PolicyError("missing_url")
        value = raw.strip()
        if "://" not in value:
            value = f"https://{value}"
        try:
            parsed = urlsplit(value)
        except ValueError as exc:
            raise PolicyError("malformed_url") from exc
        scheme = parsed.scheme.lower()
        if scheme != "https" and not (scheme == "http" and self.allow_http):
            raise PolicyError("https_required")
        if parsed.username is not None or parsed.password is not None:
            raise PolicyError("userinfo_blocked")
        if not parsed.hostname:
            raise PolicyError("missing_host")
        try:
            port = parsed.port or (443 if scheme == "https" else 80)
        except ValueError as exc:
            raise PolicyError("invalid_port") from exc
        allowed_ports = (
            self.allowed_https_ports if scheme == "https" else self.allowed_http_ports
        )
        if port not in allowed_ports:
            raise PolicyError("port_blocked")
        host = canonical_hostname(parsed.hostname)
        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            literal = None
        if literal is None and is_special_use_hostname(host):
            raise PolicyError("special_use_host_blocked")
        return scheme, host, port, parsed, literal

    def _finish(
        self,
        *,
        scheme: str,
        host: str,
        port: int,
        parsed: SplitResult,
        raw_addresses: Sequence[str],
    ) -> ValidatedURL:
        if not raw_addresses:
            raise PolicyError("dns_no_answers")
        addresses = tuple(
            sorted({public_ip_or_error(value) for value in raw_addresses})
        )
        if len(addresses) != len(set(raw_addresses)) and not addresses:
            raise PolicyError("dns_no_public_answers")
        display_host = f"[{host}]" if ":" in host else host
        default_port = 443 if scheme == "https" else 80
        netloc = display_host if port == default_port else f"{display_host}:{port}"
        path = parsed.path or "/"
        canonical = urlunsplit(SplitResult(scheme, netloc, path, parsed.query, ""))
        return ValidatedURL(canonical, host, port, addresses)

    def validate(self, raw: Any) -> ValidatedURL:
        scheme, host, port, parsed, literal = self._prepare(raw)
        if literal is not None:
            raw_addresses = [host]
        elif self.resolver is None:
            raise PolicyError("sync_resolver_not_injected")
        else:
            try:
                raw_addresses = list(self.resolver(host, port))
            except PolicyError:
                raise
            except Exception as exc:
                raise PolicyError("dns_resolution_failed") from exc
        return self._finish(
            scheme=scheme,
            host=host,
            port=port,
            parsed=parsed,
            raw_addresses=raw_addresses,
        )

    async def validate_async(self, raw: Any) -> ValidatedURL:
        scheme, host, port, parsed, literal = self._prepare(raw)
        if literal is not None:
            raw_addresses = [host]
        else:
            try:
                if self.async_resolver is not None:
                    pending = self.async_resolver(host, port)
                elif self.resolver is not None:
                    pending = asyncio.to_thread(self.resolver, host, port)
                else:
                    raise PolicyError("async_resolver_not_injected")
                raw_addresses = list(
                    await asyncio.wait_for(
                        pending,
                        timeout=self.dns_timeout_seconds,
                    )
                )
            except TimeoutError as exc:
                raise PolicyError("dns_resolution_timeout") from exc
            except PolicyError:
                raise
            except Exception as exc:
                raise PolicyError("dns_resolution_failed") from exc
        return self._finish(
            scheme=scheme,
            host=host,
            port=port,
            parsed=parsed,
            raw_addresses=raw_addresses,
        )


def validate_run_id(run_id: str) -> str:
    if not isinstance(run_id, str) or not RUN_ID_RE.fullmatch(run_id):
        raise FilesystemPolicyError("invalid run-id")
    if ".." in run_id:
        raise FilesystemPolicyError("invalid run-id")
    return run_id


def validate_relative_path(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise FilesystemPolicyError("invalid relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise FilesystemPolicyError("path traversal blocked")
    return path


def path_is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def assert_no_symlink_chain(path: Path, *, stop_at: Path | None = None) -> None:
    current = path
    boundary = stop_at.resolve() if stop_at is not None else None
    while True:
        if current.exists() and current.is_symlink():
            raise FilesystemPolicyError(f"symlink blocked: {current}")
        if boundary is not None and current.resolve() == boundary:
            return
        if current.parent == current:
            return
        current = current.parent


def inside_git_worktree(path: Path) -> bool:
    current = path.resolve()
    while current.parent != current:
        if (current / ".git").exists():
            return True
        current = current.parent
    return False


@dataclass
class PrivateRunStore:
    output_root: Path
    run_id: str
    max_total_bytes: int = 256 * 1024 * 1024
    run_dir: Path = field(init=False)
    bytes_written: int = field(default=0, init=False)

    def __post_init__(self) -> None:
        self.run_id = validate_run_id(self.run_id)
        root = Path(self.output_root).expanduser()
        if not root.is_absolute():
            raise FilesystemPolicyError("output root must be absolute")
        if root.is_symlink():
            raise FilesystemPolicyError(f"symlink blocked: {root}")
        root = root.resolve()
        assert_no_symlink_chain(root)
        if inside_git_worktree(root):
            raise FilesystemPolicyError(
                "private outputs must be outside every Git worktree"
            )
        if root.exists() and not root.is_dir():
            raise FilesystemPolicyError("output root is not a directory")
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(root, 0o700)
        self.output_root = root.resolve()
        self.run_dir = self.output_root / self.run_id
        if self.run_dir.exists() or self.run_dir.is_symlink():
            raise FilesystemPolicyError("existing run collision")
        self.run_dir.mkdir(mode=0o700)
        os.chmod(self.run_dir, 0o700)
        self.mkdir("evidence")
        self.mkdir("quarantined_sensitive_evidence")
        self.mkdir("quarantined_policy_evidence")
        self.mkdir("quarantined_visual_evidence")

    def resolve(self, relative: str) -> Path:
        rel = validate_relative_path(relative)
        candidate = self.run_dir.joinpath(*rel.parts)
        resolved_parent = candidate.parent.resolve()
        if not path_is_within(self.run_dir, resolved_parent):
            raise FilesystemPolicyError("path escaped run directory")
        assert_no_symlink_chain(candidate.parent, stop_at=self.run_dir)
        if candidate.exists() and candidate.is_symlink():
            raise FilesystemPolicyError("symlink target blocked")
        return candidate

    def mkdir(self, relative: str) -> Path:
        path = self.resolve(relative)
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        assert_no_symlink_chain(path, stop_at=self.run_dir)
        os.chmod(path, 0o700)
        return path

    def write_bytes(
        self, relative: str, data: bytes, *, max_bytes: int
    ) -> dict[str, Any]:
        if len(data) > max_bytes:
            raise FilesystemPolicyError(f"artifact exceeds {max_bytes} bytes")
        if self.bytes_written + len(data) > self.max_total_bytes:
            raise FilesystemPolicyError("run byte budget exceeded")
        destination = self.resolve(relative)
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(destination.parent, 0o700)
        if destination.exists() or destination.is_symlink():
            raise FilesystemPolicyError("refusing to overwrite existing artifact")
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".atomic-", dir=destination.parent
        )
        temporary = Path(temporary_name)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb", closefd=True) as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, destination)
            os.chmod(destination, 0o600)
        except Exception:
            try:
                temporary.unlink(missing_ok=True)
            finally:
                raise
        self.bytes_written += len(data)
        return {"path": relative, "sha256": sha256_bytes(data), "bytes": len(data)}

    def write_json(
        self, relative: str, value: Any, *, max_bytes: int
    ) -> dict[str, Any]:
        return self.write_bytes(
            relative, canonical_json_bytes(value) + b"\n", max_bytes=max_bytes
        )

    def append_jsonl(self, relative: str, value: Mapping[str, Any]) -> None:
        line = canonical_json_bytes(value) + b"\n"
        if len(line) > MAX_MANIFEST_LINE_BYTES:
            raise FilesystemPolicyError("manifest line too large")
        if self.bytes_written + len(line) > self.max_total_bytes:
            raise FilesystemPolicyError("run byte budget exceeded")
        destination = self.resolve(relative)
        if destination.exists() and destination.is_symlink():
            raise FilesystemPolicyError("manifest symlink blocked")
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(destination, flags, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
            os.write(descriptor, line)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        self.bytes_written += len(line)

    def quarantine_artifact(
        self,
        artifact: dict[str, Any],
        *,
        destination_root: str = "quarantined_sensitive_evidence",
    ) -> None:
        if destination_root not in {
            "quarantined_sensitive_evidence",
            "quarantined_policy_evidence",
        }:
            raise FilesystemPolicyError("invalid quarantine destination")
        source_relative = str(artifact.get("path") or "")
        source_path = validate_relative_path(source_relative)
        if source_path.parts and source_path.parts[0] == destination_root:
            artifact["quarantined"] = True
            return
        if not source_path.parts or source_path.parts[0] not in {
            "evidence",
            "quarantined_sensitive_evidence",
            "quarantined_policy_evidence",
            "quarantined_visual_evidence",
        }:
            raise FilesystemPolicyError("only evidence artifacts can be quarantined")
        destination_relative = str(
            PurePosixPath(destination_root, *source_path.parts[1:])
        )
        source = self.resolve(source_relative)
        destination = self.resolve(destination_relative)
        if (
            not source.is_file()
            or source.is_symlink()
            or destination.exists()
            or destination.is_symlink()
        ):
            raise FilesystemPolicyError("artifact quarantine move blocked")
        destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(destination.parent, 0o700)
        os.replace(source, destination)
        os.chmod(destination, 0o600)
        artifact["path"] = destination_relative
        artifact["quarantined"] = True


def detect_sensitive_content(
    text: str, form_metadata: Sequence[Mapping[str, Any]]
) -> list[str]:
    reasons = [
        name
        for name, pattern in SENSITIVE_TEXT_PATTERNS.items()
        if pattern.search(text)
    ]
    for form in form_metadata:
        input_types = " ".join(str(value) for value in form.get("inputTypes", []))
        autocomplete = " ".join(str(value) for value in form.get("autocomplete", []))
        if PASSWORD_FIELD_RE.search(input_types) or PASSWORD_FIELD_RE.search(
            autocomplete
        ):
            reasons.append("credential_form")
            break
    return sorted(set(reasons))


def validate_private_sidecar_text(
    value: Any,
    *,
    max_bytes: int,
    allow_none: bool,
) -> str | None:
    if value is None and allow_none:
        return None
    if not isinstance(value, str):
        raise MappingError("sidecar_invalid_type")
    normalized = value.strip()
    if not normalized:
        raise MappingError("sidecar_empty_value")
    try:
        encoded = normalized.encode("utf-8")
    except UnicodeError as exc:
        raise MappingError("sidecar_invalid_encoding") from exc
    if len(encoded) > max_bytes:
        raise MappingError("sidecar_value_too_large")
    if detect_sensitive_content(normalized, []):
        raise MappingError("sensitive_sidecar_blocked")
    return normalized


def bounded_policy_reason_codes(reasons: Iterable[str]) -> list[str]:
    bounded: list[str] = []
    for reason in reasons:
        code = reason if POLICY_REASON_CODE_RE.fullmatch(reason) else "policy_violation"
        if code in bounded:
            continue
        if len(bounded) < MAX_POLICY_REASON_CODES - 1:
            bounded.append(code)
        elif "policy_violation" not in bounded:
            bounded.append("policy_violation")
    return bounded


def parse_retry_after(
    value: str | None, *, now: datetime | None = None, cap_seconds: int = 300
) -> float:
    if not value:
        return 0.0
    stripped = value.strip()
    if stripped.isdigit():
        return float(min(int(stripped), cap_seconds))
    try:
        parsed = parsedate_to_datetime(stripped)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        current = now or datetime.now(timezone.utc)
        return float(max(0, min(int((parsed - current).total_seconds()), cap_seconds)))
    except (TypeError, ValueError, OverflowError):
        return 0.0


@dataclass
class HostRateLimiter:
    delay_seconds: float
    sleeper: Callable[[float], Awaitable[None]] = asyncio.sleep
    clock: Callable[[], float] = time.monotonic
    _ready_at: dict[str, float] = field(default_factory=dict)
    _locks: dict[str, asyncio.Lock] = field(default_factory=dict)

    async def wait(self, host: str) -> None:
        lock = self._locks.setdefault(host, asyncio.Lock())
        async with lock:
            remaining = self._ready_at.get(host, 0.0) - self.clock()
            if remaining > 0:
                await self.sleeper(remaining)
            self._ready_at[host] = self.clock() + self.delay_seconds

    def register_retry_after(self, host: str, value: str | None) -> None:
        delay = parse_retry_after(value)
        if delay:
            self._ready_at[host] = max(
                self._ready_at.get(host, 0.0), self.clock() + delay
            )

    def register_retry_seconds(self, host: str, delay: float) -> None:
        if delay > 0:
            self._ready_at[host] = max(
                self._ready_at.get(host, 0.0), self.clock() + min(delay, 300.0)
            )


@dataclass
class EgressGuard:
    policy: PublicURLPolicy
    max_requests: int = DEFAULT_MAX_REQUESTS
    request_count: int = 0
    blocked_count: int = 0
    websocket_seen: bool = False
    retry_after_seconds: float = 0.0
    audit: list[dict[str, Any]] = field(default_factory=list)
    policy_reason_codes: list[str] = field(default_factory=list)

    def _record_violation(self, reason: str) -> str:
        code = reason if POLICY_REASON_CODE_RE.fullmatch(reason) else "policy_violation"
        if code in self.policy_reason_codes:
            return code
        if len(self.policy_reason_codes) < MAX_POLICY_REASON_CODES - 1:
            self.policy_reason_codes.append(code)
            return code
        if "policy_violation" not in self.policy_reason_codes:
            self.policy_reason_codes.append("policy_violation")
        return "policy_violation"

    def raise_if_violated(self) -> None:
        if self.policy_reason_codes:
            raise PolicyError(self.policy_reason_codes[0])

    async def route(self, route: Any, request: Any) -> None:
        if self.request_count >= self.max_requests + 1:
            self._record_violation("request_budget_exceeded")
            await route.abort("blockedbyclient")
            return
        self.request_count += 1
        method = str(request.method).upper()
        url = str(request.url)
        reason: str | None = None
        if self.request_count > self.max_requests:
            reason = "request_budget_exceeded"
        elif method not in {"GET", "HEAD"}:
            reason = "method_blocked"
        else:
            try:
                validated = await self.policy.validate_async(url)
            except PolicyError as exc:
                reason = str(exc)
            else:
                self.audit.append(
                    {
                        "sequence": self.request_count,
                        "method": method,
                        "urlHash": validated.url_hash,
                        "host": validated.hostname,
                        "addressHashes": [
                            sha256_text(address) for address in validated.addresses
                        ],
                        "decision": "allowed",
                    }
                )
        if reason is not None:
            self.blocked_count += 1
            reason = self._record_violation(reason)
            self.audit.append(
                {
                    "sequence": self.request_count,
                    "method": method,
                    "urlHash": sha256_text(url),
                    "host": None,
                    "addressHashes": [],
                    "decision": "blocked",
                    "reason": reason,
                }
            )
            await route.abort("blockedbyclient")
            return
        await route.continue_()

    def on_websocket(self, _websocket: Any) -> None:
        self.websocket_seen = True
        self._record_violation("websocket_observed_sandbox_hard_blocker")

    def on_response(self, response: Any) -> None:
        if getattr(response, "status", None) not in {429, 503}:
            return
        headers = getattr(response, "headers", {}) or {}
        self.retry_after_seconds = max(
            self.retry_after_seconds,
            parse_retry_after(headers.get("retry-after")),
        )


@dataclass(frozen=True)
class LighthouseRuntime:
    binary: Path
    version: str


def verify_lighthouse_binary(
    binary: str | None, expected_version: str = LIGHTHOUSE_VERSION
) -> LighthouseRuntime:
    if not binary:
        raise RuntimeUnavailable("lighthouse_binary_missing")
    path = Path(binary).expanduser()
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise RuntimeUnavailable("lighthouse_binary_must_be_absolute_regular_file")
    mode = path.stat().st_mode
    if not mode & stat.S_IXUSR:
        raise RuntimeUnavailable("lighthouse_binary_not_executable")
    try:
        completed = subprocess.run(
            [str(path), "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
            env={"PATH": os.environ.get("PATH", "")},
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeUnavailable("lighthouse_version_check_failed") from exc
    version = (completed.stdout or completed.stderr).strip().lstrip("v")
    if completed.returncode != 0 or version != expected_version:
        raise RuntimeUnavailable("lighthouse_version_mismatch")
    return LighthouseRuntime(path.resolve(), version)


def run_lighthouse(
    runtime: LighthouseRuntime,
    *,
    url: str,
    chrome_path: Path,
    preset: str,
    timeout_seconds: int = 180,
) -> tuple[dict[str, Any], bytes | None]:
    if (
        not chrome_path.is_absolute()
        or chrome_path.is_symlink()
        or not chrome_path.is_file()
    ):
        return (
            {
                "status": "runtime_unavailable",
                "reason": "chromium_unavailable",
                "version": runtime.version,
            },
            None,
        )
    with tempfile.TemporaryDirectory(prefix="page-evidence-lighthouse-") as directory:
        report_path = Path(directory) / "report.json"
        command = [
            str(runtime.binary),
            url,
            "--output=json",
            f"--output-path={report_path}",
            f"--chrome-path={chrome_path}",
            "--chrome-flags=--headless --disable-dev-shm-usage",
            "--only-categories=performance",
            "--quiet",
        ]
        if preset == "desktop":
            command.append("--preset=desktop")
        try:
            lighthouse_env = {
                "PATH": os.environ.get("PATH", ""),
                "HOME": directory,
                "TMPDIR": directory,
            }
            for proxy_name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
                if os.environ.get(proxy_name):
                    lighthouse_env[proxy_name] = os.environ[proxy_name]
            completed = subprocess.run(
                command,
                capture_output=True,
                timeout=timeout_seconds,
                check=False,
                env=lighthouse_env,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            return (
                {
                    "status": "failed",
                    "reason": type(exc).__name__,
                    "version": runtime.version,
                },
                None,
            )
        if (
            completed.returncode != 0
            or not report_path.is_file()
            or report_path.is_symlink()
        ):
            return (
                {
                    "status": "failed",
                    "reason": f"process_exit_{completed.returncode}",
                    "version": runtime.version,
                },
                None,
            )
        report_bytes = read_bounded_bytes(report_path, MAX_LIGHTHOUSE_BYTES)
        try:
            report = json.loads(report_bytes)
        except json.JSONDecodeError:
            return (
                {
                    "status": "failed",
                    "reason": "invalid_report_json",
                    "version": runtime.version,
                },
                None,
            )
        score = report.get("categories", {}).get("performance", {}).get("score")
        return (
            {
                "status": "complete",
                "reason": None,
                "version": runtime.version,
                "performanceScore": (
                    score * 100 if isinstance(score, (int, float)) else None
                ),
            },
            report_bytes,
        )


def _validate_sha(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
        raise MappingError(f"{field_name} must be lowercase sha256")
    return value


def _parse_timestamp(value: Any, field_name: str) -> datetime:
    if not isinstance(value, str):
        raise MappingError(f"{field_name} must be an ISO timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise MappingError(f"{field_name} must be an ISO timestamp") from exc
    if parsed.tzinfo is None:
        raise MappingError(f"{field_name} must include timezone")
    return parsed


def parent_index(rows: Sequence[Mapping[str, Any]]) -> dict[int, str]:
    index: dict[int, str] = {}
    for row in rows:
        row_id = row.get("rowId")
        split = row.get("split")
        if isinstance(row_id, bool) or not isinstance(row_id, int):
            raise MappingError("every parent row must have an integer rowId")
        if not isinstance(split, str) or split not in ALLOWED_SPLITS:
            raise MappingError("every parent row must have an allowed split")
        if row_id in index:
            raise MappingError("parent rowId values must be unique")
        index[row_id] = split
    return index


async def validate_target_bundle(
    bundle: Any,
    *,
    parent_rows: Sequence[Mapping[str, Any]],
    actual_parent_manifest_hash: str,
    actual_parent_dataset_digest: str,
    policy: PublicURLPolicy,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    if (
        not isinstance(bundle, dict)
        or bundle.get("contractVersion") != TARGET_CONTRACT_VERSION
    ):
        raise MappingError("wrong target contractVersion")
    allowed_top = {"contractVersion", "parentLineage", "authorization", "targets"}
    if set(bundle) != allowed_top:
        raise MappingError("target bundle has missing or unknown top-level fields")
    lineage = bundle.get("parentLineage")
    if not isinstance(lineage, dict) or set(lineage) != {
        "parentManifestHash",
        "parentDatasetDigest",
        "parentRowCount",
    }:
        raise MappingError("invalid parentLineage")
    if (
        _validate_sha(lineage.get("parentManifestHash"), "parentManifestHash")
        != actual_parent_manifest_hash
    ):
        raise MappingError("parentManifestHash mismatch")
    if (
        _validate_sha(lineage.get("parentDatasetDigest"), "parentDatasetDigest")
        != actual_parent_dataset_digest
    ):
        raise MappingError("parentDatasetDigest mismatch")
    if lineage.get("parentRowCount") != len(parent_rows):
        raise MappingError("parentRowCount mismatch")
    authorization = bundle.get("authorization")
    required_auth = {
        "scopeId",
        "ownerId",
        "approvedAt",
        "expiresAt",
        "allowedHosts",
        "rightsBasis",
        "robotsPolicy",
        "retentionDays",
        "allowAuthenticatedAccess",
    }
    if not isinstance(authorization, dict) or set(authorization) != required_auth:
        raise MappingError("invalid authorization scope")
    scope_id = authorization.get("scopeId")
    if not isinstance(scope_id, str) or not SCOPE_ID_RE.fullmatch(scope_id):
        raise MappingError("invalid authorization scopeId")
    if (
        not isinstance(authorization.get("ownerId"), str)
        or not authorization["ownerId"].strip()
    ):
        raise MappingError("ownerId required")
    _parse_timestamp(authorization.get("approvedAt"), "approvedAt")
    expires_at = _parse_timestamp(authorization.get("expiresAt"), "expiresAt")
    if expires_at <= (now or datetime.now(timezone.utc)):
        raise MappingError("authorization expired")
    if authorization.get("robotsPolicy") != "respect":
        raise MappingError("robots policy must be respect")
    if authorization.get("allowAuthenticatedAccess") is not False:
        raise MappingError("authenticated collection is forbidden")
    retention_days = authorization.get("retentionDays")
    if (
        isinstance(retention_days, bool)
        or not isinstance(retention_days, int)
        or not 1 <= retention_days <= DEFAULT_RETENTION_DAYS_MAX
    ):
        raise MappingError("retentionDays outside policy")
    if (
        not isinstance(authorization.get("rightsBasis"), str)
        or not authorization["rightsBasis"].strip()
    ):
        raise MappingError("rightsBasis required")
    raw_allowed_hosts = authorization.get("allowedHosts")
    if not isinstance(raw_allowed_hosts, list) or not raw_allowed_hosts:
        raise MappingError("allowedHosts required")
    allowed_hosts = {canonical_hostname(value) for value in raw_allowed_hosts}
    if len(allowed_hosts) != len(raw_allowed_hosts):
        raise MappingError("allowedHosts must be unique")
    targets = bundle.get("targets")
    if not isinstance(targets, list) or not targets:
        raise MappingError("targets must be a non-empty list")
    parent = parent_index(parent_rows)
    seen_rows: set[int] = set()
    validated: list[dict[str, Any]] = []
    for target in targets:
        required_target = {
            "rowId",
            "split",
            "url",
            "mappingProvenance",
            "queryContexts",
        }
        allowed_target = required_target | {"pagePurpose"}
        if (
            not isinstance(target, dict)
            or not required_target.issubset(target)
            or not set(target).issubset(allowed_target)
        ):
            raise MappingError("target has missing or unknown fields")
        if FORBIDDEN_MAPPING_KEYS & set(target):
            raise MappingError("guess-derived mapping fields are forbidden")
        row_id = target.get("rowId")
        split = target.get("split")
        if (
            isinstance(row_id, bool)
            or not isinstance(row_id, int)
            or row_id in seen_rows
        ):
            raise MappingError("target rowId must be an exact unique integer")
        if parent.get(row_id) != split:
            raise MappingError("target rowId/split does not exactly match parent")
        seen_rows.add(row_id)
        provenance = target.get("mappingProvenance")
        required_provenance = {
            "method",
            "mappedBy",
            "mappedAt",
            "evidenceRef",
            "robotsDecision",
        }
        if not isinstance(provenance, dict) or set(provenance) != required_provenance:
            raise MappingError("invalid mapping provenance")
        if provenance.get("method") != ALLOWED_MAPPING_METHOD:
            raise MappingError("only owner_supplied_exact_url mapping is accepted")
        if not all(
            isinstance(provenance.get(key), str) and provenance[key].strip()
            for key in ("mappedBy", "evidenceRef")
        ):
            raise MappingError("mapping provenance is incomplete")
        _parse_timestamp(provenance.get("mappedAt"), "mappedAt")
        if provenance.get("robotsDecision") != "allowed":
            raise MappingError("robots-disallowed or unreviewed target blocked")
        page_purpose = validate_private_sidecar_text(
            target.get("pagePurpose"),
            max_bytes=MAX_PAGE_PURPOSE_BYTES,
            allow_none=True,
        )
        query_contexts = target.get("queryContexts")
        if not isinstance(query_contexts, list):
            raise MappingError("queryContexts must be a list")
        seen_query_ids: set[str] = set()
        normalized_queries: list[dict[str, Any]] = []
        for query in query_contexts:
            if not isinstance(query, dict) or set(query) != {
                "queryId",
                "queryText",
                "intent",
            }:
                raise MappingError("invalid query context")
            query_id = query.get("queryId")
            query_text = query.get("queryText")
            intent = query.get("intent")
            if (
                not isinstance(query_id, str)
                or not QUERY_ID_RE.fullmatch(query_id)
                or query_id in seen_query_ids
            ):
                raise MappingError("queryId must be valid and unique within target")
            normalized_query_text = validate_private_sidecar_text(
                query_text,
                max_bytes=MAX_QUERY_TEXT_BYTES,
                allow_none=False,
            )
            normalized_intent = validate_private_sidecar_text(
                intent,
                max_bytes=MAX_QUERY_INTENT_BYTES,
                allow_none=True,
            )
            seen_query_ids.add(query_id)
            normalized_queries.append(
                {
                    "queryId": query_id,
                    "queryText": normalized_query_text,
                    "intent": normalized_intent,
                }
            )
        validated_url = await policy.validate_async(target.get("url"))
        if validated_url.hostname not in allowed_hosts:
            raise MappingError("target host outside owner authorization scope")
        validated.append(
            {
                "rowId": row_id,
                "split": split,
                "validatedUrl": validated_url,
                "mappingProvenance": provenance,
                "queryContexts": normalized_queries,
                "pagePurpose": page_purpose,
                "authorizationScopeId": scope_id,
            }
        )
    return validated


def query_manifest_and_sidecar(
    queries: Sequence[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], bytes | None]:
    manifest: list[dict[str, Any]] = []
    sidecar: list[dict[str, Any]] = []
    for query in queries:
        payload = {"queryText": query["queryText"], "intent": query.get("intent")}
        digest = sha256_bytes(canonical_json_bytes(payload))
        manifest.append(
            {"queryId": query["queryId"], "queryHash": digest, "status": "provided"}
        )
        sidecar.append({"queryId": query["queryId"], **payload, "queryHash": digest})
    return manifest, (canonical_json_bytes(sidecar) + b"\n" if sidecar else None)


def empty_viewport(viewport: str, status: str, reason: str) -> dict[str, Any]:
    return {
        "viewport": viewport,
        "status": status,
        "reason": reason,
        "httpStatus": None,
        "finalUrlHash": None,
        "viewportWidth": 1440 if viewport == "desktop" else 390,
        "bodyScrollWidth": None,
        "horizontalOverflow": None,
        "visibleInteractiveCount": 0,
        "artifacts": [],
    }


def derive_collection_status(
    viewports: Sequence[Mapping[str, Any]],
    *,
    sensitive_reasons: Sequence[str],
    policy_reason_codes: Sequence[str],
) -> str:
    if policy_reason_codes:
        return "blocked_policy"
    if sensitive_reasons:
        return "quarantined_sensitive"
    statuses = {str(viewport.get("status")) for viewport in viewports}
    if statuses == {"complete"}:
        return "complete"
    if "complete" in statuses:
        return "partial"
    return "failed"


def unknown_projection(record: Mapping[str, Any], record_hash: str) -> dict[str, Any]:
    return {
        "contractVersion": PROJECTION_VERSION,
        "rowId": record["rowId"],
        "split": record["split"],
        "parentLineage": record["parentLineage"],
        "evidenceStatus": record["collectionStatus"],
        "frictionReasonSignals": {
            "search_intent_mismatch": "unknown",
            "page_speed_gap": "unknown",
            "mobile_experience_gap": "unknown",
            "booking_friction": "unknown",
            "checkout_friction": "unknown",
        },
        "sourceEvidenceRecordHash": record_hash,
        "rawEvidenceIncluded": False,
    }


DOM_INSPECTION_SCRIPT = r"""() => {
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return Boolean(rect.width || rect.height) && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const interactive = Array.from(document.querySelectorAll('a,button,[role="button"],input,select,textarea,summary'));
  const forms = Array.from(document.forms).slice(0, 50).map((form) => ({
    fieldCount: form.querySelectorAll('input,select,textarea').length,
    inputTypes: Array.from(form.querySelectorAll('input')).map((el) => el.type || 'text').slice(0, 100),
    autocomplete: Array.from(form.querySelectorAll('[autocomplete]')).map((el) => el.getAttribute('autocomplete')).filter(Boolean).slice(0, 100)
  }));
  return {
    title: clean(document.title).slice(0, 500) || null,
    metaDescription: clean(document.querySelector('meta[name="description"]')?.content).slice(0, 1000) || null,
    headings: Array.from(document.querySelectorAll('h1,h2,h3')).filter(visible).slice(0, 120).map((el) => ({
      level: Number(el.tagName.slice(1)), text: clean(el.innerText).slice(0, 500)
    })),
    bodyText: (document.body?.innerText || '').slice(0, 2000000),
    detailsText: Array.from(document.querySelectorAll('details')).slice(0, 50).map((el) => clean(el.textContent).slice(0, 4000)),
    forms,
    bodyScrollWidth: document.documentElement.scrollWidth,
    visibleInteractiveCount: interactive.filter(visible).length
  };
}"""

DISABLE_UNROUTABLE_CHANNELS_SCRIPT = r"""(() => {
  const blocked = () => { throw new DOMException('Blocked by private evidence policy', 'SecurityError'); };
  Object.defineProperty(globalThis, 'WebSocket', { configurable: false, writable: false, value: class { constructor() { blocked(); } } });
  Object.defineProperty(globalThis, 'EventSource', { configurable: false, writable: false, value: class { constructor() { blocked(); } } });
  if (navigator.sendBeacon) Object.defineProperty(navigator, 'sendBeacon', { configurable: false, writable: false, value: () => false });
})()"""


async def collect_viewport(
    browser: Any,
    *,
    validated_url: ValidatedURL,
    viewport: str,
    width: int,
    height: int,
    store: PrivateRunStore,
    row_prefix: str,
    max_requests: int,
    policy: PublicURLPolicy,
) -> tuple[dict[str, Any], list[str], EgressGuard]:
    context = await browser.new_context(
        viewport={"width": width, "height": height},
        java_script_enabled=True,
        service_workers="block",
        accept_downloads=False,
        locale="en-US",
        permissions=[],
    )
    guard = EgressGuard(policy, max_requests=max_requests)
    await context.add_init_script(DISABLE_UNROUTABLE_CHANNELS_SCRIPT)
    await context.route("**/*", guard.route)
    context.on("response", guard.on_response)
    page = await context.new_page()
    page.on("websocket", guard.on_websocket)
    sensitive_reasons: list[str] = []
    context_closed = False
    try:
        response = await page.goto(
            validated_url.canonical_url, wait_until="domcontentloaded", timeout=60_000
        )
        status_code = response.status if response is not None else None
        if status_code in {401, 403, 407, 429, 503}:
            raise PolicyError("authentication_or_waf_challenge_blocked")
        await page.wait_for_timeout(100)
        guard.raise_if_violated()
        snapshot = await page.evaluate(DOM_INSPECTION_SCRIPT)
        guard.raise_if_violated()
        text = str(snapshot.get("bodyText") or "")
        if WAF_CHALLENGE_RE.search(text[:20_000]):
            raise PolicyError("waf_or_human_challenge_blocked")
        forms = snapshot.get("forms") if isinstance(snapshot.get("forms"), list) else []
        sensitive_reasons = detect_sensitive_content(text, forms)
        await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        guard.raise_if_violated()
        screenshot = await page.screenshot(full_page=True, type="png")
        guard.raise_if_violated()
        final_validated = await policy.validate_async(page.url)
        guard.raise_if_violated()
        await context.close()
        context_closed = True
        guard.raise_if_violated()
        quarantine = bool(sensitive_reasons)
        storage_prefix = (
            f"quarantined_sensitive_evidence/{row_prefix}"
            if quarantine
            else f"evidence/{row_prefix}"
        )
        screenshot_prefix = (
            storage_prefix
            if quarantine
            else f"quarantined_visual_evidence/{row_prefix}"
        )
        store.mkdir(storage_prefix)
        store.mkdir(screenshot_prefix)
        text_artifact = store.write_bytes(
            f"{storage_prefix}/page-text-{viewport}.txt",
            text.encode("utf-8"),
            max_bytes=MAX_TEXT_BYTES,
        )
        screenshot_artifact = store.write_bytes(
            f"{screenshot_prefix}/screenshot-{viewport}.png",
            screenshot,
            max_bytes=MAX_SCREENSHOT_BYTES,
        )
        result = {
            "viewport": viewport,
            "status": "quarantined_sensitive" if quarantine else "complete",
            "reason": "sensitive_content_detected" if quarantine else None,
            "httpStatus": status_code,
            "finalUrlHash": final_validated.url_hash,
            "viewportWidth": width,
            "bodyScrollWidth": (
                snapshot.get("bodyScrollWidth")
                if isinstance(snapshot.get("bodyScrollWidth"), int)
                else None
            ),
            "horizontalOverflow": (
                snapshot.get("bodyScrollWidth", 0) > width + 2
                if isinstance(snapshot.get("bodyScrollWidth"), int)
                else None
            ),
            "visibleInteractiveCount": int(
                snapshot.get("visibleInteractiveCount") or 0
            ),
            "artifacts": [
                {"kind": "raw_text", **text_artifact, "quarantined": quarantine},
                {
                    "kind": "screenshot",
                    **screenshot_artifact,
                    "quarantined": True,
                },
            ],
            "observations": {
                "title": None if quarantine else snapshot.get("title"),
                "metaDescription": (
                    None if quarantine else snapshot.get("metaDescription")
                ),
                "headings": [] if quarantine else snapshot.get("headings", []),
                "detailsText": [] if quarantine else snapshot.get("detailsText", []),
                "formsObservedWithoutInput": len(forms),
            },
        }
        return result, sensitive_reasons, guard
    except PolicyError as exc:
        reason = guard._record_violation(str(exc))
        return (
            empty_viewport(viewport, "blocked_policy", reason),
            sensitive_reasons,
            guard,
        )
    except Exception:
        if guard.policy_reason_codes:
            return (
                empty_viewport(
                    viewport,
                    "blocked_policy",
                    guard.policy_reason_codes[0],
                ),
                sensitive_reasons,
                guard,
            )
        return (
            empty_viewport(viewport, "failed", "browser_runtime_failed"),
            sensitive_reasons,
            guard,
        )
    finally:
        if not context_closed:
            await context.close()


def make_blocked_record(
    *,
    run_id: str,
    row_id: int,
    split: str,
    lineage: Mapping[str, Any],
    mapping: Mapping[str, Any],
    queries: list[dict[str, Any]],
    status: str,
    reason: str,
    replay: Mapping[str, Any],
    max_requests: int,
) -> dict[str, Any]:
    return {
        "contractVersion": CONTRACT_VERSION,
        "collectionRunId": run_id,
        "collectedAt": utc_now(),
        "rowId": row_id,
        "split": split,
        "parentLineage": dict(lineage),
        "mapping": dict(mapping),
        "collectionStatus": status,
        "page": {
            "status": status,
            "sensitiveReasons": [],
            "observationsIncluded": False,
        },
        "responsive": {
            "desktop": empty_viewport("desktop", status, reason),
            "mobile": empty_viewport("mobile", status, reason),
        },
        "lighthouse": {
            "desktop": {
                "status": "not_run",
                "reason": reason,
                "version": LIGHTHOUSE_VERSION,
                "artifact": None,
            },
            "mobile": {
                "status": "not_run",
                "reason": reason,
                "version": LIGHTHOUSE_VERSION,
                "artifact": None,
            },
        },
        "interactionTrace": {
            "allowedActions": [
                "dom_inspect",
                "scroll",
                "screenshot",
                "native_details_text_read",
            ],
            "dispatchedClicks": 0,
            "formsSubmitted": 0,
            "bookingStatus": "unknown",
            "checkoutStatus": "unknown",
        },
        "queryContexts": queries,
        "governance": {
            "privateOnly": True,
            "developmentOnly": True,
            "containsPii": None,
            "containsCredentials": None,
            "quarantineStatus": "not_applicable",
            "modelArtifactRawEvidenceExcluded": True,
        },
        "requestAudit": {
            "count": 0,
            "maxCount": max_requests,
            "blockedCount": 0,
            "policyReasonCodes": (
                [reason]
                if status == "blocked_policy"
                and POLICY_REASON_CODE_RE.fullmatch(reason)
                else ["policy_violation"] if status == "blocked_policy" else []
            ),
            "allRequestsGuarded": True,
            "serviceWorkersBlocked": True,
            "websocketPolicy": "sandbox_hard_blocker",
            "entries": [],
        },
        "artifacts": [],
        "replay": dict(replay),
    }


def validate_replay(
    replay_metadata: Any,
    *,
    replay_of: str | None,
    target_bundle_digest: str,
    parent_manifest_hash: str,
    parent_dataset_digest: str,
    config_digest: str,
) -> dict[str, Any]:
    if replay_of is None:
        return {"replayOf": None, "exactReplay": False, "sourceRunMetadataHash": None}
    validate_run_id(replay_of)
    if not isinstance(replay_metadata, dict):
        raise MappingError("replay metadata missing")
    expected = {
        "runId": replay_of,
        "targetBundleDigest": target_bundle_digest,
        "parentManifestHash": parent_manifest_hash,
        "parentDatasetDigest": parent_dataset_digest,
        "configDigest": config_digest,
        "collectorVersion": COLLECTOR_VERSION,
    }
    for key, value in expected.items():
        if replay_metadata.get(key) != value:
            raise MappingError(f"exact replay mismatch: {key}")
    return {
        "replayOf": replay_of,
        "exactReplay": True,
        "sourceRunMetadataHash": sha256_bytes(canonical_json_bytes(replay_metadata)),
    }


async def run_collection(args: argparse.Namespace) -> None:
    previous_umask = os.umask(0o077)
    try:
        if (
            os.environ.get("DISCOVERYSTACK_PRIVATE_EVIDENCE_DEV") != "1"
            or not args.development_only
        ):
            raise PolicyError(
                "development-only execution requires env and CLI acknowledgement"
            )
        if inside_git_worktree(Path(args.targets)):
            raise FilesystemPolicyError(
                "private target bundles containing URLs must be outside Git"
            )
        bundle_bytes = read_bounded_bytes(Path(args.targets), MAX_TARGET_BUNDLE_BYTES)
        bundle = json.loads(bundle_bytes)
        parent_dataset_path = Path(args.parent_dataset)
        parent_manifest_path = Path(args.parent_manifest)
        parent_rows = load_jsonl_file(parent_dataset_path, MAX_PARENT_DATASET_BYTES)
        parent_manifest_hash = sha256_file(
            parent_manifest_path, max_bytes=MAX_TARGET_BUNDLE_BYTES
        )
        parent_dataset_digest = sha256_file(
            parent_dataset_path, max_bytes=MAX_PARENT_DATASET_BYTES
        )
        policy = PublicURLPolicy(
            async_resolver=async_system_resolver,
            dns_timeout_seconds=DNS_RESOLUTION_TIMEOUT_SECONDS,
            allow_http=args.allow_http,
        )
        targets = await validate_target_bundle(
            bundle,
            parent_rows=parent_rows,
            actual_parent_manifest_hash=parent_manifest_hash,
            actual_parent_dataset_digest=parent_dataset_digest,
            policy=policy,
        )
        if args.limit is not None:
            if args.limit < 1:
                raise PolicyError("limit must be positive")
            targets = targets[: args.limit]
        config = {
            "allowHttp": args.allow_http,
            "hostDelaySeconds": args.host_delay,
            "maxRequestsPerViewport": args.max_requests,
            "networkSandboxAttested": args.network_sandbox_attested,
            "runLighthouse": args.run_lighthouse,
            "lighthouseVersion": LIGHTHOUSE_VERSION,
        }
        config_digest = sha256_bytes(canonical_json_bytes(config))
        target_bundle_digest = sha256_bytes(bundle_bytes)
        replay_metadata = None
        if args.replay_of:
            replay_path = Path(args.output_dir) / args.replay_of / "run_metadata.json"
            replay_metadata = load_json_file(replay_path, MAX_TARGET_BUNDLE_BYTES)
        replay = validate_replay(
            replay_metadata,
            replay_of=args.replay_of,
            target_bundle_digest=target_bundle_digest,
            parent_manifest_hash=parent_manifest_hash,
            parent_dataset_digest=parent_dataset_digest,
            config_digest=config_digest,
        )
        store = PrivateRunStore(
            Path(args.output_dir), args.run_id, max_total_bytes=args.max_run_bytes
        )
        metadata_created_at = datetime.now(timezone.utc)
        metadata = {
            "runId": args.run_id,
            "targetBundleDigest": target_bundle_digest,
            "parentManifestHash": parent_manifest_hash,
            "parentDatasetDigest": parent_dataset_digest,
            "configDigest": config_digest,
            "collectorVersion": COLLECTOR_VERSION,
            "createdAt": metadata_created_at.isoformat(),
            "retentionDays": bundle["authorization"]["retentionDays"],
            "deleteAfter": (
                metadata_created_at
                + timedelta(days=bundle["authorization"]["retentionDays"])
            ).isoformat(),
            "replay": replay,
        }
        store.write_json(
            "run_metadata.json", metadata, max_bytes=MAX_TARGET_BUNDLE_BYTES
        )
        lineage = {
            "parentManifestHash": parent_manifest_hash,
            "parentDatasetDigest": parent_dataset_digest,
            "parentRowCount": len(parent_rows),
        }
        limiter = HostRateLimiter(args.host_delay)
        lighthouse_runtime: LighthouseRuntime | None = None
        lighthouse_unavailable_reason: str | None = None
        if args.run_lighthouse:
            if not args.network_sandbox_attested:
                lighthouse_unavailable_reason = "network_sandbox_required"
            else:
                try:
                    lighthouse_runtime = verify_lighthouse_binary(
                        args.lighthouse_binary
                    )
                except RuntimeUnavailable as exc:
                    lighthouse_unavailable_reason = str(exc)
        browser = None
        playwright_manager = None
        if args.network_sandbox_attested:
            chromium_path = Path(args.chromium_binary).expanduser()
            if (
                not chromium_path.is_absolute()
                or chromium_path.is_symlink()
                or not chromium_path.is_file()
            ):
                raise RuntimeUnavailable(
                    "chromium_binary_must_be_absolute_regular_file"
                )
            try:
                from playwright.async_api import async_playwright
            except ImportError as exc:
                raise RuntimeUnavailable("playwright_runtime_unavailable") from exc
            playwright_manager = await async_playwright().start()
            browser = await playwright_manager.chromium.launch(
                headless=True, executable_path=args.chromium_binary
            )
        try:
            for target in targets:
                validated_url: ValidatedURL = target["validatedUrl"]
                await limiter.wait(validated_url.hostname)
                queries, query_sidecar = query_manifest_and_sidecar(
                    target["queryContexts"]
                )
                mapping = {
                    "urlHash": validated_url.url_hash,
                    "method": target["mappingProvenance"]["method"],
                    "evidenceRefHash": sha256_text(
                        target["mappingProvenance"]["evidenceRef"]
                    ),
                    "mappedByHash": sha256_text(
                        target["mappingProvenance"]["mappedBy"]
                    ),
                    "mappedAt": target["mappingProvenance"]["mappedAt"],
                    "authorizationScopeId": target["authorizationScopeId"],
                    "pagePurposeHash": (
                        sha256_text(target["pagePurpose"])
                        if target["pagePurpose"] is not None
                        else None
                    ),
                }
                row_prefix = f"row-{target['rowId']}"
                if not args.network_sandbox_attested:
                    record = make_blocked_record(
                        run_id=args.run_id,
                        row_id=target["rowId"],
                        split=target["split"],
                        lineage=lineage,
                        mapping=mapping,
                        queries=queries,
                        status="sandbox_required",
                        reason="no_private_network_egress_sandbox_not_attested",
                        replay=replay,
                        max_requests=args.max_requests,
                    )
                else:
                    desktop, desktop_sensitive, desktop_guard = await collect_viewport(
                        browser,
                        validated_url=validated_url,
                        viewport="desktop",
                        width=1440,
                        height=900,
                        store=store,
                        row_prefix=row_prefix,
                        max_requests=args.max_requests,
                        policy=policy,
                    )
                    limiter.register_retry_seconds(
                        validated_url.hostname, desktop_guard.retry_after_seconds
                    )
                    await limiter.wait(validated_url.hostname)
                    mobile, mobile_sensitive, mobile_guard = await collect_viewport(
                        browser,
                        validated_url=validated_url,
                        viewport="mobile",
                        width=390,
                        height=844,
                        store=store,
                        row_prefix=row_prefix,
                        max_requests=args.max_requests,
                        policy=policy,
                    )
                    limiter.register_retry_seconds(
                        validated_url.hostname, mobile_guard.retry_after_seconds
                    )
                    sensitive_reasons = sorted(
                        set(desktop_sensitive + mobile_sensitive)
                    )
                    policy_reason_codes = bounded_policy_reason_codes(
                        desktop_guard.policy_reason_codes
                        + mobile_guard.policy_reason_codes
                    )
                    policy_blocked = bool(policy_reason_codes)
                    if sensitive_reasons or policy_blocked:
                        destination_root = (
                            "quarantined_sensitive_evidence"
                            if sensitive_reasons
                            else "quarantined_policy_evidence"
                        )
                        for viewport_result in (desktop, mobile):
                            for artifact in viewport_result.get("artifacts", []):
                                store.quarantine_artifact(
                                    artifact,
                                    destination_root=destination_root,
                                )
                            observations = viewport_result.get("observations")
                            if observations:
                                observations["title"] = None
                                observations["metaDescription"] = None
                                observations["headings"] = []
                                observations["detailsText"] = []
                    collection_status = derive_collection_status(
                        (desktop, mobile),
                        sensitive_reasons=sensitive_reasons,
                        policy_reason_codes=policy_reason_codes,
                    )
                    artifacts = list(desktop.get("artifacts", [])) + list(
                        mobile.get("artifacts", [])
                    )
                    if query_sidecar is not None:
                        quarantine = bool(sensitive_reasons or policy_blocked)
                        if sensitive_reasons:
                            query_prefix = "quarantined_sensitive_evidence"
                        elif policy_blocked:
                            query_prefix = "quarantined_policy_evidence"
                        else:
                            query_prefix = "evidence"
                        query_artifact = store.write_bytes(
                            f"{query_prefix}/{row_prefix}/private-query-contexts.json",
                            query_sidecar,
                            max_bytes=MAX_QUERY_SIDECAR_BYTES,
                        )
                        artifacts.append(
                            {
                                "kind": "private_query_sidecar",
                                **query_artifact,
                                "quarantined": quarantine,
                            }
                        )
                    lighthouse: dict[str, Any] = {}
                    for preset in ("desktop", "mobile"):
                        if policy_blocked or sensitive_reasons:
                            lighthouse[preset] = {
                                "status": "not_run",
                                "reason": (
                                    "policy_blocked"
                                    if policy_blocked
                                    else "sensitive_evidence_quarantined"
                                ),
                                "version": LIGHTHOUSE_VERSION,
                                "artifact": None,
                            }
                            continue
                        if lighthouse_runtime is None:
                            status = (
                                "runtime_unavailable"
                                if args.run_lighthouse
                                else "not_run"
                            )
                            lighthouse[preset] = {
                                "status": status,
                                "reason": lighthouse_unavailable_reason
                                or "not_requested",
                                "version": LIGHTHOUSE_VERSION,
                                "artifact": None,
                            }
                            continue
                        await limiter.wait(validated_url.hostname)
                        summary, report_bytes = run_lighthouse(
                            lighthouse_runtime,
                            url=validated_url.canonical_url,
                            chrome_path=Path(args.chromium_binary),
                            preset=preset,
                        )
                        artifact = None
                        if report_bytes is not None:
                            lighthouse_prefix = (
                                "quarantined_sensitive_evidence"
                                if sensitive_reasons
                                else "evidence"
                            )
                            artifact_data = store.write_bytes(
                                f"{lighthouse_prefix}/{row_prefix}/lighthouse-{preset}.json",
                                report_bytes,
                                max_bytes=MAX_LIGHTHOUSE_BYTES,
                            )
                            artifact = {
                                "kind": "lighthouse",
                                **artifact_data,
                                "quarantined": bool(sensitive_reasons),
                            }
                            artifacts.append(artifact)
                        lighthouse[preset] = {**summary, "artifact": artifact}
                    request_entries = desktop_guard.audit + mobile_guard.audit
                    for sequence, entry in enumerate(request_entries, start=1):
                        entry["sequence"] = sequence
                        if (
                            entry.get("decision") == "blocked"
                            and entry.get("reason") not in policy_reason_codes
                        ):
                            entry["reason"] = "policy_violation"
                    record = {
                        "contractVersion": CONTRACT_VERSION,
                        "collectionRunId": args.run_id,
                        "collectedAt": utc_now(),
                        "rowId": target["rowId"],
                        "split": target["split"],
                        "parentLineage": lineage,
                        "mapping": mapping,
                        "collectionStatus": collection_status,
                        "page": {
                            "status": collection_status,
                            "sensitiveReasons": sensitive_reasons,
                            "observationsIncluded": not bool(
                                sensitive_reasons or policy_blocked
                            ),
                        },
                        "responsive": {"desktop": desktop, "mobile": mobile},
                        "lighthouse": lighthouse,
                        "interactionTrace": {
                            "allowedActions": [
                                "dom_inspect",
                                "scroll",
                                "screenshot",
                                "native_details_text_read",
                            ],
                            "dispatchedClicks": 0,
                            "formsSubmitted": 0,
                            "bookingStatus": "unknown",
                            "checkoutStatus": "unknown",
                        },
                        "queryContexts": queries,
                        "governance": {
                            "privateOnly": True,
                            "developmentOnly": True,
                            "containsPii": any(
                                reason in {"email", "phone", "credit_card", "ssn_like"}
                                for reason in sensitive_reasons
                            ),
                            "containsCredentials": any(
                                reason
                                in {
                                    "api_key_like",
                                    "credential_assignment",
                                    "credential_form",
                                }
                                for reason in sensitive_reasons
                            ),
                            "quarantineStatus": (
                                "quarantined_sensitive_evidence"
                                if sensitive_reasons
                                else (
                                    "quarantined_policy_evidence"
                                    if policy_blocked
                                    else "clear"
                                )
                            ),
                            "modelArtifactRawEvidenceExcluded": True,
                        },
                        "requestAudit": {
                            "count": desktop_guard.request_count
                            + mobile_guard.request_count,
                            "maxCount": (args.max_requests + 1) * 2,
                            "blockedCount": desktop_guard.blocked_count
                            + mobile_guard.blocked_count,
                            "policyReasonCodes": policy_reason_codes,
                            "allRequestsGuarded": True,
                            "serviceWorkersBlocked": True,
                            "websocketPolicy": "sandbox_hard_blocker",
                            "entries": request_entries,
                        },
                        "artifacts": artifacts,
                        "replay": replay,
                    }
                record_hash = sha256_bytes(canonical_json_bytes(record))
                store.append_jsonl("evidence_manifest.jsonl", record)
                store.append_jsonl(
                    "model_projection.jsonl", unknown_projection(record, record_hash)
                )
        finally:
            if browser is not None:
                await browser.close()
            if playwright_manager is not None:
                await playwright_manager.stop()
    finally:
        os.umask(previous_umask)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--targets", required=True)
    parser.add_argument("--parent-dataset", required=True)
    parser.add_argument("--parent-manifest", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--development-only", action="store_true")
    parser.add_argument("--network-sandbox-attested", action="store_true")
    parser.add_argument("--allow-http", action="store_true")
    parser.add_argument("--run-lighthouse", action="store_true")
    parser.add_argument("--lighthouse-binary")
    parser.add_argument("--chromium-binary")
    parser.add_argument("--replay-of")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--host-delay", type=float, default=2.0)
    parser.add_argument("--max-requests", type=int, default=DEFAULT_MAX_REQUESTS)
    parser.add_argument("--max-run-bytes", type=int, default=256 * 1024 * 1024)
    args = parser.parse_args(argv)
    if args.host_delay < 1.0:
        parser.error("--host-delay must be at least 1 second")
    if not 1 <= args.max_requests <= DEFAULT_MAX_REQUESTS:
        parser.error(f"--max-requests must be between 1 and {DEFAULT_MAX_REQUESTS}")
    if args.max_run_bytes < 1024 * 1024:
        parser.error("--max-run-bytes must be at least 1 MiB")
    if args.network_sandbox_attested and not args.chromium_binary:
        parser.error("--chromium-binary is required for browser collection")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    try:
        asyncio.run(run_collection(parse_args(argv)))
    except (
        PolicyError,
        MappingError,
        FilesystemPolicyError,
        RuntimeUnavailable,
    ) as exc:
        print(json.dumps({"status": "blocked", "reason": str(exc)}), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
