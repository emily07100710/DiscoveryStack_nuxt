"""Deterministic, app-owned metadata executor for an already compiled SystemSpec."""

import hashlib
import json

import frappe

from discovery_stack import __version__


ALLOWED_UNIT_KINDS = {"module", "doctype", "role", "workflow", "report", "integration_intent"}
MAX_UNITS = 128


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _fingerprint(value):
    return _sha(_canonical(value))


def _exact_hash(value, label):
    if not isinstance(value, str) or len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
        raise ValueError(f"{label} is invalid.")
    return value


def _opaque_id(value, label):
    if not isinstance(value, str) or not 2 <= len(value) <= 128 or not value[0].isalnum() or any(not (character.isalnum() or character in ":_-") for character in value):
        raise ValueError(f"{label} is invalid.")
    return value


def validate_compiled_plan(plan):
    if not isinstance(plan, dict) or set(plan) != {"schemaVersion", "compilerVersion", "specId", "specVersion", "specFingerprint", "parentFingerprint", "tenantBinding", "units", "canonicalSpecJson", "planFingerprint"}:
        raise ValueError("Compiled SystemSpec plan shape is invalid.")
    if plan["schemaVersion"] != "compiled-system-plan-v1" or plan["compilerVersion"] != "system-spec-compiler-v1":
        raise ValueError("Compiled SystemSpec version is unsupported.")
    _opaque_id(plan["specId"], "specId")
    if not isinstance(plan["specVersion"], int) or not 1 <= plan["specVersion"] <= 1_000_000:
        raise ValueError("specVersion is invalid.")
    _exact_hash(plan["specFingerprint"], "specFingerprint")
    if plan["parentFingerprint"] is not None:
        _exact_hash(plan["parentFingerprint"], "parentFingerprint")
    binding = plan["tenantBinding"]
    if not isinstance(binding, dict) or not all(key in binding for key in ("ownerId", "clientId", "systemTenantId")):
        raise ValueError("Tenant binding is invalid.")
    for key in ("ownerId", "clientId", "systemTenantId"):
        _opaque_id(binding[key], key)
    if not isinstance(plan["units"], list) or len(plan["units"]) > MAX_UNITS:
        raise ValueError("Compiled unit bound is exceeded.")
    seen = set()
    for unit in plan["units"]:
        if not isinstance(unit, dict) or unit.get("kind") not in ALLOWED_UNIT_KINDS:
            raise ValueError("Compiled unit kind is not allowlisted.")
        key = _opaque_id(unit.get("key"), "compiled unit key")
        identity = (unit["kind"], key.casefold())
        if identity in seen:
            raise ValueError("Compiled unit identity is duplicated.")
        seen.add(identity)
    if not isinstance(plan["canonicalSpecJson"], str) or len(plan["canonicalSpecJson"].encode("utf-8")) > 512_000:
        raise ValueError("Canonical SystemSpec payload is invalid or too large.")
    supplied = _exact_hash(plan["planFingerprint"], "planFingerprint")
    draft = {key: value for key, value in plan.items() if key != "planFingerprint"}
    if _fingerprint(draft) != supplied:
        raise ValueError("Compiled SystemSpec fingerprint is invalid.")
    return plan


def apply_compiled_plan(plan):
    """Persist exact tenant/spec lineage. No Python, SQL, JS, shell, or ERPNext core mutation is generated."""
    plan = validate_compiled_plan(plan)
    binding = plan["tenantBinding"]
    tenant_id = binding["systemTenantId"]
    website_id = binding.get("managedSiteId") or binding.get("websiteId") or "unbound"
    identity = {
        "system_tenant_id": tenant_id,
        "owner_id_hash": _sha(binding["ownerId"]),
        "client_id_hash": _sha(binding["clientId"]),
        "website_id_hash": _sha(website_id),
    }
    identity["binding_fingerprint"] = _fingerprint(identity)
    existing_identity = frappe.db.exists("DiscoveryStack Tenant Identity", tenant_id)
    if existing_identity:
        stored = frappe.get_doc("DiscoveryStack Tenant Identity", tenant_id)
        if any(stored.get(key) != value for key, value in identity.items()):
            raise frappe.ValidationError("Tenant identity lineage collision.")
    else:
        frappe.get_doc({"doctype": "DiscoveryStack Tenant Identity", **identity}).insert(ignore_permissions=True)

    existing_plan = frappe.db.exists("DiscoveryStack Compiled System Spec", plan["planFingerprint"])
    if existing_plan:
        stored = frappe.get_doc("DiscoveryStack Compiled System Spec", plan["planFingerprint"])
        if stored.spec_fingerprint != plan["specFingerprint"] or stored.system_tenant_id != tenant_id:
            raise frappe.ValidationError("Compiled SystemSpec replay collision.")
        replayed = True
    else:
        frappe.get_doc({
            "doctype": "DiscoveryStack Compiled System Spec",
            "system_tenant_id": tenant_id,
            "spec_version": plan["specVersion"],
            "spec_fingerprint": plan["specFingerprint"],
            "plan_fingerprint": plan["planFingerprint"],
            "compiler_version": plan["compilerVersion"],
            "compiled_metadata": _canonical(plan),
        }).insert(ignore_permissions=True)
        replayed = False

    event_fingerprint = _fingerprint({"event": "compiled_spec_applied", "tenant": tenant_id, "plan": plan["planFingerprint"]})
    if not frappe.db.exists("DiscoveryStack System Audit Event", event_fingerprint):
        frappe.get_doc({
            "doctype": "DiscoveryStack System Audit Event",
            "system_tenant_id": tenant_id,
            "event_type": "compiled_spec_applied",
            "actor_hash": _sha("server:system-factory"),
            "event_fingerprint": event_fingerprint,
            "event_metadata": _canonical({"planFingerprint": plan["planFingerprint"], "replayed": replayed}),
        }).insert(ignore_permissions=True)
    frappe.db.commit()
    receipt = _fingerprint({"site": frappe.local.site, "tenant": tenant_id, "plan": plan["planFingerprint"], "appVersion": __version__})
    return {"ok": True, "applied": True, "replayed": replayed, "systemTenantId": tenant_id, "planFingerprint": plan["planFingerprint"], "receiptFingerprint": receipt}


def health_snapshot(system_tenant_id=None):
    if system_tenant_id is not None:
        _opaque_id(system_tenant_id, "systemTenantId")
        healthy = bool(frappe.db.exists("DiscoveryStack Tenant Identity", system_tenant_id))
    else:
        healthy = True
    return {"ok": True, "healthy": healthy, "app": "discovery_stack", "version": __version__, "schemaVersion": "system-spec-v1", "site": frappe.local.site}
