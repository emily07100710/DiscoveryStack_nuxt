import hashlib
import json


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def compile_spec(spec):
    """Golden parity helper. The authoritative allowlist validation occurs before this boundary."""
    units = []
    for entity in sorted(spec.get("entities", []), key=lambda item: item["key"]):
        units.append({
            "kind": "doctype",
            "key": entity["key"],
            "source": entity.get("erpNextDocType") or f"DiscoveryStack {entity['key']}",
            "fields": sorted(entity.get("fields", []), key=lambda item: item["key"]),
        })
    for role in sorted(spec.get("roles", []), key=lambda item: item["key"]):
        units.append({"kind": "role", "key": role["key"], "permissions": sorted(role.get("permissions", []), key=lambda item: (item["entity"], ",".join(item["actions"])))})
    plan = {"schemaVersion": "compiled-system-plan-v1", "specFingerprint": spec["fingerprint"], "units": units}
    plan["planFingerprint"] = sha256(canonical_json(plan))
    return plan
