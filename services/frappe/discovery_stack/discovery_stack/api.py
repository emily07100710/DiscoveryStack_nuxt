"""Authenticated internal methods. Raw envelope verification runs before tenant lookup."""

import hashlib
import json
import os

import frappe

from discovery_stack import __version__
from discovery_stack.envelope import consume_nonce_after_verification, verify_before_lookup_or_write
from discovery_stack.executor import apply_compiled_plan, health_snapshot


def _verified_payload():
    payload, envelope = verify_before_lookup_or_write(frappe.request, os.environ.get("DISCOVERYSTACK_INTERNAL_SENDER_ID", "discoverystack-nuxt"), os.environ.get("FRAPPE_INTERNAL_RECEIVER_ID", "discovery-stack-frappe"), os.environ.get("DISCOVERYSTACK_FRAPPE_HMAC_KEY_ID", "frappe-internal-v1"))
    consume_nonce_after_verification(envelope)
    return payload, envelope


@frappe.whitelist(allow_guest=False)
def health():
    payload, envelope = _verified_payload()
    tenant_id = payload.get("systemTenantId")
    if not isinstance(tenant_id, str):
        raise PermissionError("Tenant binding is invalid.")
    snapshot = health_snapshot(tenant_id)
    receipt = hashlib.sha256(json.dumps({"tenant": tenant_id, "body_hash": envelope["body_hash"], "version": __version__}, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return {**snapshot, "receiptFingerprint": receipt}


@frappe.whitelist(allow_guest=False)
def apply_compiled_spec():
    payload, _envelope = _verified_payload()
    plan = payload.get("compiledPlan")
    if os.environ.get("DISCOVERYSTACK_FRAPPE_APPLY_ENABLED") != "true":
        raise PermissionError("Compiled SystemSpec apply is disabled.")
    return apply_compiled_plan(plan)
