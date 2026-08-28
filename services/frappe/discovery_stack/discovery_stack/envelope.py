import hashlib
import hmac
import json
import os
from datetime import datetime, timezone


def _header(request, name):
    value = request.headers.get(name)
    if not isinstance(value, str) or not value:
        raise PermissionError("Signed envelope is invalid.")
    return value


def verify_before_lookup_or_write(request, expected_sender, expected_receiver, expected_key_id, maximum_skew_seconds=300):
    raw = request.get_data(cache=True)
    timestamp = _header(request, "X-DS-Timestamp")
    nonce = _header(request, "X-DS-Nonce")
    sender = _header(request, "X-DS-Sender")
    receiver = _header(request, "X-DS-Receiver")
    key_id = _header(request, "X-DS-Key-Id")
    body_hash = _header(request, "X-DS-Body-Sha256")
    signature = _header(request, "X-DS-Signature")
    if sender != expected_sender or receiver != expected_receiver or key_id != expected_key_id:
        raise PermissionError("Signed envelope authority is invalid.")
    calculated_hash = hashlib.sha256(raw).hexdigest()
    if not hmac.compare_digest(calculated_hash, body_hash):
        raise PermissionError("Signed envelope body hash is invalid.")
    key = os.environ.get("DISCOVERYSTACK_FRAPPE_HMAC_KEY", "").encode("utf-8")
    if len(key) < 32:
        raise PermissionError("Signed envelope key is unavailable.")
    path = request.path
    material = "\n".join([request.method.upper(), path, timestamp, nonce, sender, receiver, key_id, body_hash]).encode("utf-8")
    expected = hmac.new(key, material, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise PermissionError("Signed envelope signature is invalid.")
    at = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    if abs((datetime.now(timezone.utc) - at).total_seconds()) > maximum_skew_seconds:
        raise PermissionError("Signed envelope timestamp is stale.")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise PermissionError("Signed envelope payload is invalid.")
    return payload, {"sender": sender, "receiver": receiver, "key_id": key_id, "nonce": nonce, "body_hash": body_hash}


def consume_nonce_after_verification(envelope):
    import frappe
    try:
        frappe.get_doc({"doctype": "DiscoveryStack Envelope Nonce", "nonce": envelope["nonce"], "sender": envelope["sender"], "receiver": envelope["receiver"], "key_id": envelope["key_id"], "body_hash": envelope["body_hash"]}).insert(ignore_permissions=True)
    except frappe.DuplicateEntryError as error:
        raise PermissionError("Signed envelope replay is rejected.") from error
    return True
