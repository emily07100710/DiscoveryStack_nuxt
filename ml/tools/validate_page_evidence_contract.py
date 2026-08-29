#!/usr/bin/env python3
"""Validate page-evidence schema, lineage, bytes, privacy, and replay semantics."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import stat
import sys
from datetime import datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any, Mapping, NoReturn, Sequence

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
RAW_URL_RE = re.compile(r"(?:https?|wss?)://", re.I)
RAW_PROJECTION_KEYS = {
    "url",
    "rawUrl",
    "queryText",
    "bodyText",
    "title",
    "metaDescription",
    "headings",
    "detailsText",
    "screenshotPath",
    "fullTextPath",
}
ARTIFACT_LIMITS = {
    "raw_text": 2 * 1024 * 1024,
    "screenshot": 20 * 1024 * 1024,
    "private_query_sidecar": 256 * 1024,
    "lighthouse": 25 * 1024 * 1024,
}
POLICY_REASON_CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
SENSITIVE_SIDECAR_PATTERNS = (
    re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I),
    re.compile(r"(?<!\w)(?:\+?\d[\d .()\-]{7,}\d)(?!\w)"),
    re.compile(
        r"\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~+/-]{16,})\b",
        re.I,
    ),
    re.compile(
        r"\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|password)\b\s*[:=]\s*[^\s]{8,}",
        re.I,
    ),
)


class ValidationError(AssertionError):
    pass


def fail(message: str, path: str = "$") -> NoReturn:
    raise ValidationError(f"{path}: {message}")


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _resolve_ref(root_schema: Mapping[str, Any], reference: str) -> Mapping[str, Any]:
    if not reference.startswith("#/"):
        fail("only local schema refs are supported")
    value: Any = root_schema
    for component in reference[2:].split("/"):
        component = component.replace("~1", "/").replace("~0", "~")
        if not isinstance(value, Mapping) or component not in value:
            fail(f"unresolved schema ref {reference}")
        value = value[component]
    if not isinstance(value, Mapping):
        fail(f"schema ref does not resolve to object: {reference}")
    return value


def _matches_type(value: Any, expected: str) -> bool:
    if expected == "null":
        return value is None
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "string":
        return isinstance(value, str)
    if expected == "array":
        return isinstance(value, list)
    if expected == "object":
        return isinstance(value, dict)
    fail(f"unsupported schema type {expected}")


def validate_schema(
    value: Any,
    schema: Mapping[str, Any],
    root_schema: Mapping[str, Any] | None = None,
    path: str = "$",
) -> None:
    root = root_schema or schema
    if "$ref" in schema:
        validate_schema(value, _resolve_ref(root, schema["$ref"]), root, path)
        return
    if "anyOf" in schema:
        errors: list[str] = []
        for option in schema["anyOf"]:
            try:
                validate_schema(value, option, root, path)
                break
            except ValidationError as exc:
                errors.append(str(exc))
        else:
            fail("did not match anyOf", path)
    if "const" in schema and value != schema["const"]:
        fail(f"must equal {schema['const']!r}", path)
    if "enum" in schema and value not in schema["enum"]:
        fail(f"value {value!r} is outside enum", path)
    expected_type = schema.get("type")
    if expected_type is not None:
        expected_types = (
            [expected_type] if isinstance(expected_type, str) else expected_type
        )
        if not any(_matches_type(value, item) for item in expected_types):
            fail(f"wrong type; expected {expected_types}", path)
    if isinstance(value, dict):
        required = schema.get("required", [])
        missing = [key for key in required if key not in value]
        if missing:
            fail(f"missing required keys {missing}", path)
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            unknown = sorted(set(value) - set(properties))
            if unknown:
                fail(f"unknown keys {unknown}", path)
        for key, child in value.items():
            if key in properties:
                validate_schema(child, properties[key], root, f"{path}.{key}")
    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            fail("too few items", path)
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            fail("too many items", path)
        if schema.get("uniqueItems"):
            encoded = [canonical_json_bytes(item) for item in value]
            if len(encoded) != len(set(encoded)):
                fail("items must be unique", path)
        if "items" in schema:
            for index, child in enumerate(value):
                validate_schema(child, schema["items"], root, f"{path}[{index}]")
    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            fail("string is too short", path)
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            fail("string is too long", path)
        if "pattern" in schema and re.search(schema["pattern"], value) is None:
            fail("string does not match pattern", path)
        if schema.get("format") == "date-time":
            try:
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError as exc:
                raise ValidationError(f"{path}: invalid date-time") from exc
            if parsed.tzinfo is None:
                fail("date-time must include timezone", path)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            fail("number below minimum", path)
        if "maximum" in schema and value > schema["maximum"]:
            fail("number above maximum", path)


def validate_relative_path(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        fail("invalid artifact path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        fail("artifact path traversal")
    return path


def ensure_private_mode(path: Path, expected: int) -> None:
    actual = stat.S_IMODE(path.stat().st_mode)
    if actual & 0o077:
        fail(f"permissions are not private: {oct(actual)}", str(path))
    if actual != expected:
        fail(f"expected mode {oct(expected)}, got {oct(actual)}", str(path))


def assert_no_symlinks(root: Path, path: Path) -> None:
    current = path
    while True:
        if current.is_symlink():
            fail("symlink blocked", str(current))
        if current == root:
            return
        if current.parent == current:
            fail("path escaped run directory", str(path))
        current = current.parent


def resolve_artifact(run_dir: Path, relative: str) -> Path:
    rel = validate_relative_path(relative)
    path = run_dir.joinpath(*rel.parts)
    assert_no_symlinks(run_dir, path)
    try:
        path.resolve().relative_to(run_dir.resolve())
    except ValueError:
        fail("artifact escaped run directory", relative)
    if not path.is_file():
        fail("artifact is not a regular file", relative)
    ensure_private_mode(path, 0o600)
    return path


def load_jsonl(path: Path, *, max_line_bytes: int = 512 * 1024) -> list[dict[str, Any]]:
    if path.is_symlink() or not path.is_file():
        fail("JSONL input must be a regular non-symlink file", str(path))
    records: list[dict[str, Any]] = []
    with path.open("rb") as handle:
        for line_number, line in enumerate(handle, start=1):
            if len(line) > max_line_bytes:
                fail("JSONL line too large", f"{path}:{line_number}")
            if not line.strip():
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValidationError(f"{path}:{line_number}: invalid JSON") from exc
            if not isinstance(value, dict):
                fail("JSONL row must be object", f"{path}:{line_number}")
            records.append(value)
    return records


def _walk_projection(value: Any, path: str = "$") -> None:
    if isinstance(value, dict):
        forbidden = RAW_PROJECTION_KEYS & set(value)
        if forbidden:
            fail(
                f"raw evidence keys forbidden in model projection: {sorted(forbidden)}",
                path,
            )
        for key, child in value.items():
            _walk_projection(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _walk_projection(child, f"{path}[{index}]")
    elif isinstance(value, str) and RAW_URL_RE.search(value):
        fail("raw URL forbidden in model projection", path)


def _artifact_index(record: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    index: dict[str, Mapping[str, Any]] = {}
    for artifact in record["artifacts"]:
        path = artifact["path"]
        if path in index:
            fail("duplicate artifact path", f"$.artifacts.{path}")
        index[path] = artifact
    return index


def _validate_query_sidecar(
    record: Mapping[str, Any], run_dir: Path, artifacts: Mapping[str, Mapping[str, Any]]
) -> None:
    query_artifacts = [
        item for item in artifacts.values() if item["kind"] == "private_query_sidecar"
    ]
    if bool(record["queryContexts"]) != bool(query_artifacts):
        fail("query sidecar presence does not match queryContexts")
    if not query_artifacts:
        return
    if len(query_artifacts) != 1:
        fail("exactly one query sidecar is allowed per record")
    artifact = query_artifacts[0]
    path = resolve_artifact(run_dir, artifact["path"])
    try:
        sidecar = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValidationError("invalid private query sidecar") from exc
    if not isinstance(sidecar, list) or len(sidecar) != len(record["queryContexts"]):
        fail("query sidecar count mismatch")
    manifest_by_id = {item["queryId"]: item for item in record["queryContexts"]}
    if len(manifest_by_id) != len(record["queryContexts"]):
        fail("query IDs must be unique")
    sidecar_ids: set[str] = set()
    for query in sidecar:
        if not isinstance(query, dict) or set(query) != {
            "queryId",
            "queryText",
            "intent",
            "queryHash",
        }:
            fail("query sidecar schema mismatch")
        query_id = query["queryId"]
        if query_id in sidecar_ids or query_id not in manifest_by_id:
            fail("query sidecar ID mismatch")
        sidecar_ids.add(query_id)
        query_text = query["queryText"]
        intent = query["intent"]
        if not isinstance(query_text, str) or not query_text.strip():
            fail("query sidecar queryText must be a non-empty string")
        try:
            query_text_bytes = query_text.encode("utf-8")
            intent_bytes = intent.encode("utf-8") if isinstance(intent, str) else None
        except UnicodeError:
            fail("query sidecar contains invalid Unicode")
        if len(query_text_bytes) > 8192:
            fail("query sidecar queryText exceeds private limit")
        if intent is not None and (
            not isinstance(intent, str)
            or not intent.strip()
            or intent_bytes is None
            or len(intent_bytes) > 1024
        ):
            fail("query sidecar intent violates private limit")
        for value in (query_text, intent):
            if isinstance(value, str) and any(
                pattern.search(value) for pattern in SENSITIVE_SIDECAR_PATTERNS
            ):
                fail("sensitive query sidecar content is forbidden")
        expected = sha256_bytes(
            canonical_json_bytes(
                {"queryText": query["queryText"], "intent": query["intent"]}
            )
        )
        if (
            query["queryHash"] != expected
            or manifest_by_id[query_id]["queryHash"] != expected
        ):
            fail("query hash mismatch")


def validate_record_semantics(record: Mapping[str, Any], run_dir: Path) -> None:
    status = record["collectionStatus"]
    if record["page"]["status"] != status:
        fail("page status must match collectionStatus")
    desktop = record["responsive"]["desktop"]
    mobile = record["responsive"]["mobile"]
    if desktop["viewport"] != "desktop" or mobile["viewport"] != "mobile":
        fail("responsive viewport identity mismatch")
    if status == "complete" and (
        desktop["status"] != "complete" or mobile["status"] != "complete"
    ):
        fail("complete requires both viewports complete")
    if status == "partial" and "complete" not in {desktop["status"], mobile["status"]}:
        fail("partial requires one complete viewport")
    if status == "sandbox_required":
        if {desktop["status"], mobile["status"]} != {"sandbox_required"} or record[
            "requestAudit"
        ]["count"] != 0:
            fail("sandbox_required must not collect or request")
    if (
        status in {"sandbox_required", "blocked_missing_mapping"}
        and record["artifacts"]
    ):
        fail("blocked records cannot contain artifacts")
    for viewport in (desktop, mobile):
        if viewport["status"] in {"complete", "quarantined_sensitive"}:
            if (
                viewport["httpStatus"] is None
                or viewport["finalUrlHash"] is None
                or "observations" not in viewport
            ):
                fail("collected viewport is missing response or observation evidence")
    trace = record["interactionTrace"]
    if trace["dispatchedClicks"] != 0 or trace["formsSubmitted"] != 0:
        fail("V1 interaction mutation invariant violated")
    if trace["bookingStatus"] != "unknown" or trace["checkoutStatus"] != "unknown":
        fail("booking and checkout must remain unknown")
    audit = record["requestAudit"]
    if audit["count"] != len(audit["entries"]) or audit["count"] > audit["maxCount"]:
        fail("request audit count mismatch or budget exceeded")
    blocked = 0
    blocked_reasons: set[str] = set()
    for expected_sequence, entry in enumerate(audit["entries"], start=1):
        if entry["sequence"] != expected_sequence:
            fail("request audit sequence must be contiguous")
        if entry["decision"] == "allowed" and entry["method"] not in {"GET", "HEAD"}:
            fail("non-GET/HEAD request was allowed")
        if entry["decision"] == "blocked":
            blocked += 1
            if "reason" not in entry:
                fail("blocked request must have reason")
            blocked_reasons.add(entry["reason"])
    if blocked != audit["blockedCount"]:
        fail("blocked request count mismatch")
    policy_reasons = audit["policyReasonCodes"]
    if any(not POLICY_REASON_CODE_RE.fullmatch(reason) for reason in policy_reasons):
        fail("invalid policy reason code")
    if not blocked_reasons.issubset(set(policy_reasons)):
        fail("blocked request reason missing from policy reason codes")
    if status == "blocked_policy" and not policy_reasons:
        fail("blocked_policy requires a bounded policy reason code")
    if status != "blocked_policy" and policy_reasons:
        fail("non-policy status cannot carry policy reason codes")
    artifacts = _artifact_index(record)
    referenced_paths: list[str] = []
    for viewport in (desktop, mobile):
        referenced_paths.extend(item["path"] for item in viewport["artifacts"])
    for preset in ("desktop", "mobile"):
        lighthouse = record["lighthouse"][preset]
        artifact = lighthouse["artifact"]
        if lighthouse["status"] == "complete" and artifact is None:
            fail("complete Lighthouse requires an artifact")
        if lighthouse["status"] != "complete" and artifact is not None:
            fail("non-complete Lighthouse cannot carry an artifact")
        if artifact is not None:
            referenced_paths.append(artifact["path"])
    referenced_paths.extend(
        artifact["path"]
        for artifact in artifacts.values()
        if artifact["kind"] == "private_query_sidecar"
    )
    if set(referenced_paths) != set(artifacts):
        fail(
            "top-level artifacts must exactly match viewport, Lighthouse, and query references"
        )
    for relative_path in referenced_paths:
        if relative_path not in artifacts:
            fail(
                "referenced artifact missing from top-level artifact list",
                relative_path,
            )
    for relative, artifact in artifacts.items():
        artifact_path = resolve_artifact(run_dir, relative)
        size = artifact_path.stat().st_size
        if size != artifact["bytes"]:
            fail("artifact byte count mismatch", relative)
        if size > ARTIFACT_LIMITS[artifact["kind"]]:
            fail("artifact exceeds kind limit", relative)
        if sha256_file(artifact_path) != artifact["sha256"]:
            fail("artifact sha256 mismatch", relative)
        under_quarantine = relative.startswith(
            (
                "quarantined_sensitive_evidence/",
                "quarantined_policy_evidence/",
                "quarantined_visual_evidence/",
            )
        )
        if artifact["quarantined"] != under_quarantine:
            fail("artifact quarantine flag/path mismatch", relative)
        if artifact["kind"] == "screenshot" and (
            not artifact["quarantined"]
            or not relative.startswith(
                (
                    "quarantined_sensitive_evidence/",
                    "quarantined_policy_evidence/",
                    "quarantined_visual_evidence/",
                )
            )
        ):
            fail("screenshots must always remain private quarantine", relative)
    sensitive_reasons = record["page"]["sensitiveReasons"]
    governance = record["governance"]
    if status == "blocked_policy":
        if record["page"]["observationsIncluded"] is not False:
            fail("policy-blocked observations cannot enter general evidence")
        if governance["quarantineStatus"] not in {
            "quarantined_sensitive_evidence",
            "quarantined_policy_evidence",
        }:
            fail("policy-blocked evidence must be quarantined")
        if any(not artifact["quarantined"] for artifact in artifacts.values()):
            fail("all policy-blocked artifacts must be quarantined")
        if any(
            record["lighthouse"][preset]["status"] == "complete"
            for preset in ("desktop", "mobile")
        ):
            fail("policy-blocked evidence cannot include Lighthouse results")
        for viewport in (desktop, mobile):
            observations = viewport.get("observations")
            if observations and (
                observations["title"] is not None
                or observations["metaDescription"] is not None
                or observations["headings"]
                or observations["detailsText"]
            ):
                fail("policy-blocked raw observations leaked into manifest")
    if sensitive_reasons:
        if (
            status not in {"quarantined_sensitive", "blocked_policy"}
            or governance["quarantineStatus"] != "quarantined_sensitive_evidence"
        ):
            fail("sensitive evidence must be quarantined")
        if record["page"]["observationsIncluded"] is not False:
            fail("sensitive observations cannot enter general evidence")
        if any(not artifact["quarantined"] for artifact in artifacts.values()):
            fail("all sensitive-page artifacts must be quarantined")
        if status == "quarantined_sensitive" and "quarantined_sensitive" not in {
            desktop["status"],
            mobile["status"],
        }:
            fail("sensitive page requires a quarantined viewport")
        for viewport in (desktop, mobile):
            observations = viewport.get("observations")
            if observations and (
                observations["title"] is not None
                or observations["metaDescription"] is not None
                or observations["headings"]
                or observations["detailsText"]
            ):
                fail("sensitive raw observations leaked into evidence manifest")
    else:
        if governance["quarantineStatus"] == "quarantined_sensitive_evidence":
            fail("clear page cannot claim sensitive quarantine")
    if governance["containsPii"] and not set(sensitive_reasons) & {
        "email",
        "phone",
        "credit_card",
        "ssn_like",
    }:
        fail("containsPii lacks detection provenance")
    if governance["containsCredentials"] and not set(sensitive_reasons) & {
        "api_key_like",
        "credential_assignment",
        "credential_form",
    }:
        fail("containsCredentials lacks detection provenance")
    _validate_query_sidecar(record, run_dir, artifacts)
    replay = record["replay"]
    if replay["exactReplay"] != (replay["replayOf"] is not None):
        fail("replay exactness fields inconsistent")
    if replay["exactReplay"] != (replay["sourceRunMetadataHash"] is not None):
        fail("replay metadata hash fields inconsistent")


def validate_run(
    run_dir: Path, schema_path: Path, *, require_complete: bool = True
) -> dict[str, Any]:
    run_dir = Path(run_dir)
    if run_dir.is_symlink() or not run_dir.is_dir():
        fail("run directory must be a regular non-symlink directory", str(run_dir))
    ensure_private_mode(run_dir, 0o700)
    for item in run_dir.rglob("*"):
        if item.is_symlink():
            fail("symlink blocked", str(item))
        if item.is_dir():
            ensure_private_mode(item, 0o700)
        elif item.is_file():
            ensure_private_mode(item, 0o600)
        else:
            fail("non-regular filesystem entry blocked", str(item))
    schema = json.loads(Path(schema_path).read_text(encoding="utf-8"))
    manifest_path = run_dir / "evidence_manifest.jsonl"
    projection_path = run_dir / "model_projection.jsonl"
    metadata_path = run_dir / "run_metadata.json"
    for path in (manifest_path, projection_path, metadata_path):
        assert_no_symlinks(run_dir, path)
        ensure_private_mode(path, 0o600)
    records = load_jsonl(manifest_path)
    projections = load_jsonl(projection_path)
    if len(records) != len(projections):
        fail("evidence/projection row count mismatch")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    required_metadata = {
        "runId",
        "targetBundleDigest",
        "parentManifestHash",
        "parentDatasetDigest",
        "configDigest",
        "selectionFingerprint",
        "ownerAuthorityFingerprint",
        "collectorSourceHash",
        "collectorVersion",
        "state",
        "createdAt",
        "retentionDays",
        "deleteAfter",
        "retentionUntil",
        "replay",
    }
    if not isinstance(metadata, dict) or set(metadata) != required_metadata:
        fail("run metadata schema mismatch")
    for field in (
        "targetBundleDigest",
        "parentManifestHash",
        "parentDatasetDigest",
        "configDigest",
        "selectionFingerprint",
        "ownerAuthorityFingerprint",
        "collectorSourceHash",
    ):
        if not isinstance(metadata[field], str) or not SHA256_RE.fullmatch(
            metadata[field]
        ):
            fail(f"metadata {field} is not sha256")
    if metadata["state"] not in {"in_progress", "complete"}:
        fail("metadata state is invalid")
    if require_complete and metadata["state"] != "complete":
        fail("run is not complete and cannot be eligible")
    if (
        not isinstance(metadata["retentionDays"], int)
        or not 1 <= metadata["retentionDays"] <= 30
    ):
        fail("metadata retentionDays outside policy")
    try:
        created_at = datetime.fromisoformat(
            metadata["createdAt"].replace("Z", "+00:00")
        )
        delete_after = datetime.fromisoformat(
            metadata["deleteAfter"].replace("Z", "+00:00")
        )
        retention_until = datetime.fromisoformat(
            metadata["retentionUntil"].replace("Z", "+00:00")
        )
    except (AttributeError, ValueError) as exc:
        raise ValidationError("run metadata timestamps are invalid") from exc
    if created_at.tzinfo is None or delete_after.tzinfo is None:
        fail("run metadata timestamps require timezone")
    if delete_after != created_at + timedelta(days=metadata["retentionDays"]):
        fail("deleteAfter does not exactly implement retentionDays")
    if retention_until != delete_after:
        fail("retentionUntil must exactly equal deleteAfter")
    seen_rows: set[int] = set()
    seen_artifact_paths: set[str] = set()
    expected_lineage = {
        "parentManifestHash": metadata["parentManifestHash"],
        "parentDatasetDigest": metadata["parentDatasetDigest"],
    }
    for index, (record, projection) in enumerate(zip(records, projections)):
        validate_schema(record, schema, schema, f"records[{index}]")
        validate_schema(
            projection,
            schema["$defs"]["modelProjection"],
            schema,
            f"projections[{index}]",
        )
        validate_record_semantics(record, run_dir)
        for artifact in record["artifacts"]:
            if artifact["path"] in seen_artifact_paths:
                fail("artifact path reused across records")
            seen_artifact_paths.add(artifact["path"])
        if record["collectionRunId"] != metadata["runId"]:
            fail("record runId mismatch")
        if record["rowId"] in seen_rows:
            fail("record rowId must be unique")
        seen_rows.add(record["rowId"])
        for key, expected in expected_lineage.items():
            if record["parentLineage"][key] != expected:
                fail(f"record lineage mismatch: {key}")
        mapping = record["mapping"]
        if mapping["ownerAuthorityFingerprint"] != metadata[
            "ownerAuthorityFingerprint"
        ]:
            fail("record owner authority mismatch")
        expected_mapping_fingerprint = sha256_bytes(
            canonical_json_bytes(
                {
                    "rowId": record["rowId"],
                    "split": record["split"],
                    "urlHash": mapping["urlHash"],
                    "method": mapping["method"],
                    "mappedByHash": mapping["mappedByHash"],
                    "mappedAt": mapping["mappedAt"],
                    "evidenceRefHash": mapping["evidenceRefHash"],
                    "robotsDecision": mapping["robotsDecision"],
                    "ownerAuthorityFingerprint": mapping[
                        "ownerAuthorityFingerprint"
                    ],
                }
            )
        )
        if mapping["mappingFingerprint"] != expected_mapping_fingerprint:
            fail("record mapping fingerprint mismatch")
        if (
            projection["rowId"] != record["rowId"]
            or projection["split"] != record["split"]
        ):
            fail("projection row mapping mismatch")
        if projection["parentLineage"] != record["parentLineage"]:
            fail("projection lineage mismatch")
        if projection["evidenceStatus"] != record["collectionStatus"]:
            fail("projection evidence status mismatch")
        if projection["sourceEvidenceRecordHash"] != sha256_bytes(
            canonical_json_bytes(record)
        ):
            fail("projection evidence record hash mismatch")
        _walk_projection(projection, f"projections[{index}]")
    expected_files = {
        "evidence_manifest.jsonl",
        "model_projection.jsonl",
        "run_metadata.json",
        *seen_artifact_paths,
    }
    completion_path = run_dir / "run_complete.json"
    if metadata["state"] == "complete":
        if not completion_path.is_file() or completion_path.is_symlink():
            fail("complete run requires an atomic completion marker")
        ensure_private_mode(completion_path, 0o600)
        try:
            completion = json.loads(completion_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ValidationError("completion marker is not valid JSON") from exc
        required_completion = {
            "contractVersion",
            "runId",
            "completedAt",
            "metadataHash",
            "evidenceManifestHash",
            "modelProjectionHash",
            "selectionFingerprint",
            "ownerAuthorityFingerprint",
        }
        if not isinstance(completion, dict) or set(completion) != required_completion:
            fail("completion marker schema mismatch")
        if (
            completion["contractVersion"] != "page-evidence-completion-v1"
            or completion["runId"] != metadata["runId"]
            or completion["selectionFingerprint"] != metadata["selectionFingerprint"]
            or completion["ownerAuthorityFingerprint"]
            != metadata["ownerAuthorityFingerprint"]
        ):
            fail("completion marker authority mismatch")
        try:
            completed_at = datetime.fromisoformat(
                completion["completedAt"].replace("Z", "+00:00")
            )
        except (AttributeError, ValueError) as exc:
            raise ValidationError("completion timestamp is invalid") from exc
        if completed_at.tzinfo is None or completed_at < created_at:
            fail("completion timestamp must be timezone-aware and monotonic")
        for field in (
            "metadataHash",
            "evidenceManifestHash",
            "modelProjectionHash",
        ):
            if not isinstance(completion[field], str) or not SHA256_RE.fullmatch(
                completion[field]
            ):
                fail(f"completion {field} is not sha256")
        if completion["metadataHash"] != sha256_file(metadata_path):
            fail("completion metadata hash mismatch")
        if completion["evidenceManifestHash"] != sha256_file(manifest_path):
            fail("completion evidence manifest hash mismatch")
        if completion["modelProjectionHash"] != sha256_file(projection_path):
            fail("completion model projection hash mismatch")
        expected_files.add("run_complete.json")
    elif completion_path.exists():
        fail("in-progress run cannot carry completion marker")
    actual_files = {
        str(path.relative_to(run_dir).as_posix())
        for path in run_dir.rglob("*")
        if path.is_file()
    }
    if actual_files != expected_files:
        fail(
            f"unreferenced or missing run files: {sorted(actual_files ^ expected_files)}"
        )
    replay = metadata["replay"]
    if replay.get("exactReplay"):
        source_id = replay.get("replayOf")
        source_path = run_dir.parent / str(source_id) / "run_metadata.json"
        assert_no_symlinks(run_dir.parent, source_path)
        if not source_path.is_file():
            fail("replay source metadata missing")
        source = json.loads(source_path.read_text(encoding="utf-8"))
        if sha256_bytes(canonical_json_bytes(source)) != replay.get(
            "sourceRunMetadataHash"
        ):
            fail("replay source metadata hash mismatch")
        for key in (
            "targetBundleDigest",
            "parentManifestHash",
            "parentDatasetDigest",
            "configDigest",
            "collectorVersion",
            "selectionFingerprint",
            "ownerAuthorityFingerprint",
            "collectorSourceHash",
        ):
            if source.get(key) != metadata.get(key):
                fail(f"replay is not exact: {key}")
    return {
        "valid": True,
        "records": len(records),
        "projections": len(projections),
        "privatePermissionsChecked": True,
        "artifactBytesChecked": sum(len(record["artifacts"]) for record in records),
        "realUrlCollectionRun": False,
        "adjudicationRun": False,
        "trainingRun": False,
        "eligible": metadata["state"] == "complete",
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dir", type=Path)
    parser.add_argument(
        "--schema",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "schemas"
        / "page-evidence-v1.schema.json",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        result = validate_run(args.run_dir, args.schema)
    except (ValidationError, OSError, json.JSONDecodeError) as exc:
        print(
            json.dumps({"valid": False, "reason": str(exc)}, ensure_ascii=False),
            file=sys.stderr,
        )
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
