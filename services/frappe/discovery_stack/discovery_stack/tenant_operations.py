"""Bounded tenant-site operations. Bench and site lifecycle never enter this module."""

import hashlib
import json

import frappe

from discovery_stack.executor import _canonical, _fingerprint, _opaque_id, _target_name, health_snapshot, validate_compiled_plan


def _sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _tenant_identity(payload):
    tenant_id = _opaque_id(payload.get("systemTenantId"), "systemTenantId")
    identity = frappe.db.exists("DiscoveryStack Tenant Identity", tenant_id)
    if not identity:
        raise frappe.PermissionError("Tenant binding is unavailable.")
    record = frappe.get_doc("DiscoveryStack Tenant Identity", tenant_id)
    if record.owner_id_hash != _sha(_opaque_id(payload.get("ownerId"), "ownerId")) or record.client_id_hash != _sha(_opaque_id(payload.get("clientId"), "clientId")):
        raise frappe.PermissionError("Tenant binding authority is mismatched.")
    return tenant_id


def _stored_plan(tenant_id, expected_fingerprint):
    if not isinstance(expected_fingerprint, str) or len(expected_fingerprint) != 64:
        raise frappe.ValidationError("Compiled plan fingerprint is invalid.")
    name = frappe.db.get_value("DiscoveryStack Compiled System Spec", {"system_tenant_id": tenant_id, "plan_fingerprint": expected_fingerprint}, "name")
    if not name:
        raise frappe.ValidationError("Compiled plan is not installed for this tenant.")
    return validate_compiled_plan(json.loads(frappe.get_doc("DiscoveryStack Compiled System Spec", name).compiled_metadata))


def _materialized_role(tenant_id, plan, role_key):
    role_units = {unit["key"]: unit for unit in plan["materializationManifest"]["units"] if unit["kind"] == "role"}
    if role_key not in role_units:
        raise frappe.PermissionError("Invitation role is outside the compiled plan.")
    role_name = _target_name(tenant_id, "role", role_key)
    unit = frappe.db.get_value("DiscoveryStack Materialized Unit", {"system_tenant_id": tenant_id, "plan_fingerprint": plan["planFingerprint"], "unit_kind": "role", "unit_key": role_key}, ["target_name", "definition_fingerprint"], as_dict=True)
    if not unit or unit.target_name != role_name or unit.definition_fingerprint != role_units[role_key]["definitionFingerprint"] or not frappe.db.exists("Role", role_name):
        raise frappe.PermissionError("Invitation role has not been materialized exactly.")
    return role_name


def _operation_event(payload, operation, metadata):
    tenant_id = payload["systemTenantId"]
    request_fingerprint = _fingerprint({key: value for key, value in payload.items() if key != "password"} | ({"password": "[REDACTED]"} if "password" in payload else {}))
    event_fingerprint = _fingerprint({"operation": operation, "tenant": tenant_id, "idempotencyKey": payload["idempotencyKey"], "requestFingerprint": request_fingerprint})
    replayed = bool(frappe.db.exists("DiscoveryStack System Audit Event", event_fingerprint))
    if not replayed:
        frappe.get_doc({"doctype": "DiscoveryStack System Audit Event", "system_tenant_id": tenant_id, "event_type": operation, "actor_hash": _sha("server:system-factory"), "event_fingerprint": event_fingerprint, "event_metadata": _canonical(metadata)}).insert(ignore_permissions=True)
    receipt = _fingerprint({"eventFingerprint": event_fingerprint, "requestFingerprint": request_fingerprint, "runtimeAuthorityFingerprint": payload["runtimeAuthorityFingerprint"]})
    return request_fingerprint, receipt, replayed


def configure_roles(payload):
    tenant_id = _tenant_identity(payload)
    plan = _stored_plan(tenant_id, payload["compiledPlanFingerprint"])
    roles = sorted({unit["key"] for unit in plan["materializationManifest"]["units"] if unit["kind"] == "role"})
    role_names = [_materialized_role(tenant_id, plan, role) for role in roles]
    request_fingerprint, receipt, replayed = _operation_event(payload, "configure_roles", {"roleKeys": roles, "materializedRoles": role_names})
    frappe.db.commit()
    return _response(payload, "configure_roles", request_fingerprint, receipt, replayed)


def configure_modules(payload):
    tenant_id = _tenant_identity(payload)
    plan = _stored_plan(tenant_id, payload["compiledPlanFingerprint"])
    modules = sorted({unit["key"] for unit in plan["materializationManifest"]["units"] if unit["kind"] == "module"})
    if len(modules) > 16:
        raise frappe.ValidationError("Compiled module bound is exceeded.")
    materialized = frappe.get_all("DiscoveryStack Materialized Unit", filters={"system_tenant_id": tenant_id, "plan_fingerprint": plan["planFingerprint"], "unit_kind": "module"}, pluck="unit_key")
    if sorted(materialized) != modules:
        raise frappe.ValidationError("Compiled module binding is not fully materialized.")
    request_fingerprint, receipt, replayed = _operation_event(payload, "configure_modules", {"moduleKeys": modules, "configuration": "verified-existing-bindings"})
    frappe.db.commit()
    return _response(payload, "configure_modules", request_fingerprint, receipt, replayed)


def prepare_admin_invitation(payload):
    tenant_id = _tenant_identity(payload)
    plan = _stored_plan(tenant_id, payload["compiledPlanFingerprint"])
    snapshot = health_snapshot(tenant_id)
    if snapshot["healthy"] is not True:
        raise frappe.ValidationError("Tenant must be healthy before invitation preparation.")
    roles = sorted(unit["key"] for unit in plan["materializationManifest"]["units"] if unit["kind"] == "role")
    materialized_roles = [_materialized_role(tenant_id, plan, role) for role in roles]
    request_fingerprint, receipt, replayed = _operation_event(payload, "prepare_admin_invitation", {"prepared": True, "roleKeys": roles, "materializedRoles": materialized_roles, "planFingerprint": plan["planFingerprint"]})
    frappe.db.commit()
    return _response(payload, "prepare_admin_invitation", request_fingerprint, receipt, replayed)


def activate_admin_invitation(payload):
    tenant_id = _tenant_identity(payload)
    plan = _stored_plan(tenant_id, payload["compiledPlanFingerprint"])
    allowed = {"invitationId", "principalEmail", "principalEmailHash", "roleKey", "password"}
    if not allowed.issubset(payload):
        raise frappe.ValidationError("Invitation activation payload is incomplete.")
    invitation_id = _opaque_id(payload["invitationId"], "invitationId")
    role_key = _opaque_id(payload["roleKey"], "roleKey")
    role = _materialized_role(tenant_id, plan, role_key)
    email = payload["principalEmail"].strip().casefold() if isinstance(payload["principalEmail"], str) else ""
    principal_hash = _fingerprint({"email": email})
    if principal_hash != payload["principalEmailHash"]:
        raise frappe.PermissionError("Invitation principal identity is mismatched.")
    password = payload["password"] if isinstance(payload["password"], str) else ""
    if not 14 <= len(password) <= 256:
        raise frappe.ValidationError("Invitation password is invalid.")
    safe_request = {key: value for key, value in payload.items() if key != "password"} | {"password": "[REDACTED]"}
    request_fingerprint = _fingerprint(safe_request)
    event_fingerprint = _fingerprint({"operation": "activate_admin_invitation", "tenant": tenant_id, "invitationId": invitation_id, "idempotencyKey": payload["idempotencyKey"], "requestFingerprint": request_fingerprint})
    existing_event = frappe.db.exists("DiscoveryStack System Audit Event", event_fingerprint)
    if existing_event:
        metadata = json.loads(frappe.get_doc("DiscoveryStack System Audit Event", existing_event).event_metadata)
        if metadata.get("principalIdentityHash") != principal_hash or metadata.get("roleKey") != role_key:
            raise frappe.ValidationError("Invitation activation replay collided.")
        user_hash = metadata["userIdentityHash"]
        replayed = True
    else:
        if frappe.db.exists("User", email):
            raise frappe.ValidationError("Invitation principal already exists without matching activation authority.")
        user = frappe.get_doc({"doctype": "User", "email": email, "first_name": "DiscoveryStack User", "enabled": 1, "send_welcome_email": 0, "roles": [{"role": role}]})
        user.new_password = password
        user.insert(ignore_permissions=True)
        user_hash = _fingerprint({"tenant": tenant_id, "email": email})
        frappe.get_doc({"doctype": "DiscoveryStack System Audit Event", "system_tenant_id": tenant_id, "event_type": "activate_admin_invitation", "actor_hash": principal_hash, "event_fingerprint": event_fingerprint, "event_metadata": _canonical({"invitationId": invitation_id, "principalIdentityHash": principal_hash, "userIdentityHash": user_hash, "roleKey": role_key})}).insert(ignore_permissions=True)
        replayed = False
    receipt = _fingerprint({"eventFingerprint": event_fingerprint, "requestFingerprint": request_fingerprint, "runtimeAuthorityFingerprint": payload["runtimeAuthorityFingerprint"], "userIdentityHash": user_hash})
    frappe.db.commit()
    return {**_response(payload, "activate_admin_invitation", request_fingerprint, receipt, replayed), "invitationId": invitation_id, "principalIdentityHash": principal_hash, "userIdentityHash": user_hash, "roleKey": role_key}


def suspend_tenant(payload):
    tenant_id = _tenant_identity(payload)
    plan = _stored_plan(tenant_id, payload["compiledPlanFingerprint"])
    policy = frappe.get_doc("DiscoveryStack Tenant Policy", tenant_id)
    role_names = [_target_name(tenant_id, "role", unit["key"]) for unit in plan["materializationManifest"]["units"] if unit["kind"] == "role"]
    disabled_users = []
    for role_name in role_names:
        for user_name in frappe.get_all("Has Role", filters={"role": role_name, "parenttype": "User"}, pluck="parent"):
            if user_name not in {"Administrator", "Guest"} and frappe.db.exists("User", user_name):
                user = frappe.get_doc("User", user_name)
                if user.enabled:
                    user.enabled = 0
                    user.save(ignore_permissions=True)
                    disabled_users.append(_fingerprint({"tenant": tenant_id, "user": user_name}))
    policy.suspended = 1
    policy.policy_fingerprint = _fingerprint({"tenant": tenant_id, "active_plan_fingerprint": policy.active_plan_fingerprint, "manifest_fingerprint": policy.manifest_fingerprint, "suspended": 1})
    policy.save(ignore_permissions=True)
    request_fingerprint, receipt, replayed = _operation_event(payload, "suspend_tenant", {"suspended": True, "disabledUserHashes": sorted(set(disabled_users)), "roleCount": len(role_names)})
    frappe.db.commit()
    return _response(payload, "suspend_tenant", request_fingerprint, receipt, replayed)


def health(payload):
    tenant_id = _tenant_identity(payload)
    snapshot = health_snapshot(tenant_id)
    request_fingerprint = _fingerprint(payload)
    receipt = _fingerprint({"requestFingerprint": request_fingerprint, "runtimeAuthorityFingerprint": payload["runtimeAuthorityFingerprint"], "healthy": snapshot["healthy"], "unitCount": snapshot["unitCount"], "driftedUnits": snapshot["driftedUnits"]})
    return {**_response(payload, "health", request_fingerprint, receipt, False), "healthy": bool(snapshot["healthy"])}


def _response(payload, operation, request_fingerprint, receipt, replayed):
    return {"ok": True, "schemaVersion": "tenant-app-operation-response-v1", "operation": operation, "systemTenantId": payload["systemTenantId"], "runtimeAuthorityFingerprint": payload["runtimeAuthorityFingerprint"], "requestFingerprint": request_fingerprint, "receiptFingerprint": receipt, "replayed": replayed}
