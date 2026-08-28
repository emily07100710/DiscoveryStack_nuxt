"""Authenticated tenant-app methods. Bench/site lifecycle operations do not exist here."""

import hashlib
import json
import os

import frappe

from discovery_stack.envelope import consume_nonce_after_verification, verify_before_lookup_or_write
from discovery_stack.executor import _fingerprint, apply_compiled_plan
from discovery_stack import tenant_operations


COMMON_KEYS = {"schemaVersion", "operation", "ownerId", "clientId", "websiteId", "managedSiteId", "systemTenantId", "siteName", "idempotencyKey", "compiledPlanFingerprint", "specFingerprint", "runtimeAuthorityFingerprint"}


def _verified_payload(operation, extra_keys=()):
    payload, envelope = verify_before_lookup_or_write(frappe.request, os.environ.get("DISCOVERYSTACK_INTERNAL_SENDER_ID", "discoverystack-nuxt"), os.environ.get("FRAPPE_INTERNAL_RECEIVER_ID", "discovery-stack-frappe"), os.environ.get("DISCOVERYSTACK_FRAPPE_HMAC_KEY_ID", "frappe-internal-v1"))
    expected = COMMON_KEYS | set(extra_keys)
    if set(payload) != expected or payload.get("schemaVersion") != "tenant-app-operation-v1" or payload.get("operation") != operation:
        raise PermissionError("Tenant app operation payload is invalid.")
    expected_authority = os.environ.get("DISCOVERYSTACK_RUNTIME_AUTHORITY_FINGERPRINT", "")
    if len(expected_authority) != 64 or payload.get("runtimeAuthorityFingerprint") != expected_authority:
        raise PermissionError("Tenant app runtime authority is invalid.")
    if operation == "activate_admin_invitation":
        redacted = {key: value for key, value in payload.items() if key != "password"} | {"password": "[REDACTED]"}
        persisted_hash = hashlib.sha256(json.dumps(redacted, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
        consume_nonce_after_verification(envelope, persisted_hash)
    else:
        consume_nonce_after_verification(envelope)
    return payload


def _apply_response(payload, result):
    request_fingerprint = _fingerprint(payload)
    receipt = _fingerprint({"requestFingerprint": request_fingerprint, "runtimeAuthorityFingerprint": payload["runtimeAuthorityFingerprint"], "executorReceiptFingerprint": result["receiptFingerprint"]})
    return {"ok": True, "schemaVersion": "tenant-app-operation-response-v1", "operation": "apply_compiled_spec", "systemTenantId": payload["systemTenantId"], "runtimeAuthorityFingerprint": payload["runtimeAuthorityFingerprint"], "requestFingerprint": request_fingerprint, "receiptFingerprint": receipt, "replayed": bool(result["replayed"])}


@frappe.whitelist(allow_guest=False)
def apply_compiled_spec():
    payload = _verified_payload("apply_compiled_spec", {"compiledPlan"})
    if os.environ.get("DISCOVERYSTACK_FRAPPE_APPLY_ENABLED") != "true":
        raise PermissionError("Compiled SystemSpec apply is disabled.")
    if payload["compiledPlan"].get("planFingerprint") != payload["compiledPlanFingerprint"] or payload["compiledPlan"].get("specFingerprint") != payload["specFingerprint"]:
        raise PermissionError("Compiled SystemSpec envelope lineage is invalid.")
    return _apply_response(payload, apply_compiled_plan(payload["compiledPlan"], {"ownerId": payload["ownerId"], "clientId": payload["clientId"], "systemTenantId": payload["systemTenantId"]}))


@frappe.whitelist(allow_guest=False)
def configure_roles():
    return tenant_operations.configure_roles(_verified_payload("configure_roles"))


@frappe.whitelist(allow_guest=False)
def configure_modules():
    return tenant_operations.configure_modules(_verified_payload("configure_modules"))


@frappe.whitelist(allow_guest=False)
def health():
    return tenant_operations.health(_verified_payload("health"))


@frappe.whitelist(allow_guest=False)
def prepare_admin_invitation():
    return tenant_operations.prepare_admin_invitation(_verified_payload("prepare_admin_invitation"))


@frappe.whitelist(allow_guest=False)
def activate_admin_invitation():
    return tenant_operations.activate_admin_invitation(_verified_payload("activate_admin_invitation", {"invitationId", "principalEmail", "principalEmailHash", "roleKey", "password"}))


@frappe.whitelist(allow_guest=False)
def suspend_tenant():
    return tenant_operations.suspend_tenant(_verified_payload("suspend_tenant"))
