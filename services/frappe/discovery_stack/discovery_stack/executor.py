"""Transactional materializer for an allowlisted, already-compiled SystemSpec."""

import hashlib
import json
import re
import unicodedata

import frappe

from discovery_stack import __version__


ALLOWED_UNIT_KINDS = {"module", "doctype", "status", "role", "workflow", "view", "report", "kpi", "notification_intent", "integration_intent"}
ALLOWED_FIELD_TYPES = {"Data", "Long Text", "Int", "Float", "Check", "Date", "Datetime", "Currency", "Select", "Link"}
ALLOWED_VIEW_KINDS = {"list", "form", "calendar", "kanban"}
ALLOWED_ACTIONS = {"create", "read", "write"}
LOGICAL_FIELD_TYPES = {"text": "Data", "long_text": "Long Text", "integer": "Int", "decimal": "Float", "boolean": "Check", "date": "Date", "datetime": "Datetime", "email": "Data", "phone": "Data", "currency": "Currency", "select": "Select", "link": "Link"}
RESERVED_NAMES = {"doctype", "docfield", "user", "role", "permission", "system settings", "site config", "scheduled job type", "server script", "client script", "custom script", "patch log", "installed application", "module def", "custom field", "property setter", "workflow action master", "custom docperm"}
MAX_UNITS = 192
MAX_FIELDS = 32


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _fingerprint(value):
    return _sha(_canonical(value))


def _exact_hash(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise ValueError(f"{label} is invalid.")
    return value


def _opaque_id(value, label):
    if not isinstance(value, str) or not 2 <= len(value) <= 128 or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9:_-]{1,127}", value):
        raise ValueError(f"{label} is invalid.")
    return value


def _key(value, label):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", value):
        raise ValueError(f"{label} is invalid.")
    return value


def _plain(value, label, maximum=300):
    if not isinstance(value, str):
        raise ValueError(f"{label} is invalid.")
    normalized = " ".join(unicodedata.normalize("NFKC", value).strip().split())
    if not 1 <= len(normalized) <= maximum or any(ord(character) < 32 for character in normalized):
        raise ValueError(f"{label} is invalid.")
    return normalized


def _normalized(value):
    return " ".join(unicodedata.normalize("NFKC", value).strip().split()).casefold()


def _tenant_token(tenant_id):
    return _sha(tenant_id)[:12]


def _target_name(tenant_id, kind, key):
    prefixes = {"doctype": "DS", "role": "DS Role", "workflow": "DS Workflow", "report": "DS Report"}
    return f"{prefixes[kind]} {_tenant_token(tenant_id)} {key.replace('_', ' ').title()}"[:140]


def _unit_identity(tenant_id, plan_fingerprint, unit):
    return f"{_tenant_token(tenant_id)}:{plan_fingerprint[:16]}:{unit['kind']}:{unit['key']}"[:140]


def _validate_field(field, entity_keys):
    required = {"key", "label", "type", "required", "unique", "sensitive", "readOnly", "options", "linkEntity", "targetField", "frappeFieldType"}
    if not isinstance(field, dict) or set(field) != required:
        raise ValueError("Materialization field shape is invalid.")
    _key(field["key"], "field key")
    _key(field["targetField"], "target field")
    _plain(field["label"], "field label", 120)
    if field.get("type") not in LOGICAL_FIELD_TYPES or field["frappeFieldType"] not in ALLOWED_FIELD_TYPES or LOGICAL_FIELD_TYPES[field["type"]] != field["frappeFieldType"] or not all(isinstance(field[item], bool) for item in ("required", "unique", "sensitive", "readOnly")):
        raise ValueError("Materialization field policy is invalid.")
    if not isinstance(field["options"], list) or len(field["options"]) > 32 or any(not isinstance(option, str) or len(option) > 120 for option in field["options"]):
        raise ValueError("Materialization field options are invalid.")
    if len({_normalized(option) for option in field["options"]}) != len(field["options"]):
        raise ValueError("Materialization field options collide.")
    if field["frappeFieldType"] == "Select" and not field["options"]:
        raise ValueError("Select materialization requires options.")
    if field["frappeFieldType"] == "Link" and (field["linkEntity"] not in entity_keys):
        raise ValueError("Link materialization target is outside the manifest.")
    if field["frappeFieldType"] != "Link" and field["linkEntity"] is not None:
        raise ValueError("Only Link fields may specify linkEntity.")


def validate_compiled_plan(plan):
    required = {"schemaVersion", "compilerVersion", "specId", "specVersion", "specFingerprint", "parentFingerprint", "tenantBinding", "materializationManifest", "canonicalSpecJson", "planFingerprint"}
    if not isinstance(plan, dict) or set(plan) != required or plan["schemaVersion"] != "compiled-system-plan-v2" or plan["compilerVersion"] != "system-spec-compiler-v2":
        raise ValueError("Compiled SystemSpec plan shape or version is invalid.")
    _opaque_id(plan["specId"], "specId")
    if not isinstance(plan["specVersion"], int) or not 1 <= plan["specVersion"] <= 1_000_000:
        raise ValueError("specVersion is invalid.")
    _exact_hash(plan["specFingerprint"], "specFingerprint")
    if plan["parentFingerprint"] is not None:
        _exact_hash(plan["parentFingerprint"], "parentFingerprint")
    binding = plan["tenantBinding"]
    if not isinstance(binding, dict) or not all(key in binding for key in ("ownerId", "clientId", "systemTenantId")):
        raise ValueError("Tenant binding is invalid.")
    _opaque_id(binding["ownerId"], "ownerId")
    _opaque_id(binding["clientId"], "clientId")
    if binding["systemTenantId"] is not None:
        _opaque_id(binding["systemTenantId"], "systemTenantId")
    manifest = plan["materializationManifest"]
    if not isinstance(manifest, dict) or set(manifest) != {"schemaVersion", "units", "fingerprint"} or manifest["schemaVersion"] != "system-materialization-manifest-v1" or not isinstance(manifest["units"], list) or len(manifest["units"]) > MAX_UNITS:
        raise ValueError("Materialization manifest is invalid or exceeds its bound.")
    manifest_draft = {"schemaVersion": manifest["schemaVersion"], "units": manifest["units"]}
    if _fingerprint(manifest_draft) != _exact_hash(manifest["fingerprint"], "manifest fingerprint"):
        raise ValueError("Materialization manifest fingerprint is invalid.")
    entity_keys = {unit.get("key") for unit in manifest["units"] if isinstance(unit, dict) and unit.get("kind") == "doctype"}
    role_keys = {unit.get("key") for unit in manifest["units"] if isinstance(unit, dict) and unit.get("kind") == "role"}
    report_keys = {unit.get("key") for unit in manifest["units"] if isinstance(unit, dict) and unit.get("kind") == "report"}
    entity_fields = {unit.get("key"): {field.get("key") for field in unit.get("fields", [])} for unit in manifest["units"] if isinstance(unit, dict) and unit.get("kind") == "doctype"}
    statuses = {unit.get("entity"): unit for unit in manifest["units"] if isinstance(unit, dict) and unit.get("kind") == "status"}
    seen = set()
    for unit in manifest["units"]:
        if not isinstance(unit, dict) or unit.get("kind") not in ALLOWED_UNIT_KINDS:
            raise ValueError("Materialization unit kind is not allowlisted.")
        key = _key(unit.get("key"), "materialization unit key")
        identity = (unit["kind"], key.casefold())
        if identity in seen:
            raise ValueError("Materialization unit identity is duplicated.")
        seen.add(identity)
        definition = {key: value for key, value in unit.items() if key != "definitionFingerprint"}
        if _fingerprint(definition) != _exact_hash(unit.get("definitionFingerprint"), "unit definition fingerprint"):
            raise ValueError("Materialization unit fingerprint is invalid.")
        if unit["kind"] == "doctype":
            if unit.get("mode") not in {"existing_binding", "custom_doctype"} or not isinstance(unit.get("fields"), list) or len(unit["fields"]) > MAX_FIELDS:
                raise ValueError("DocType materialization is invalid.")
            if _normalized(unit["source"]) in RESERVED_NAMES:
                raise ValueError("Reserved DocType authority cannot be materialized.")
            for field in unit["fields"]:
                _validate_field(field, entity_keys)
        if unit["kind"] == "role":
            if not isinstance(unit.get("permissions"), list) or len(unit["permissions"]) > 48 or any(permission.get("entity") not in entity_keys or not isinstance(permission.get("actions"), list) or any(action not in ALLOWED_ACTIONS for action in permission.get("actions", [])) for permission in unit.get("permissions", [])):
                raise ValueError("Role permission escalation is not allowlisted.")
        if unit["kind"] == "status":
            if unit.get("entity") not in entity_keys or not isinstance(unit.get("values"), list) or len(unit["values"]) > 24 or unit.get("initial") not in unit["values"] or any(value not in unit["values"] for value in unit.get("terminal", [])):
                raise ValueError("Status materialization is invalid.")
        if unit["kind"] == "workflow":
            status = statuses.get(unit.get("entity"))
            if not status or not isinstance(unit.get("transitions"), list) or len(unit["transitions"]) > 24 or any(item.get("from") not in status["values"] or item.get("to") not in status["values"] or not item.get("roles") or any(role not in role_keys for role in item.get("roles", [])) for item in unit["transitions"]):
                raise ValueError("Workflow materialization is invalid.")
        if unit["kind"] == "view":
            definition = unit.get("definition", {})
            if definition.get("kind") not in ALLOWED_VIEW_KINDS or definition.get("entity") not in entity_keys or any(field not in entity_fields[definition["entity"]] for field in definition.get("fields", [])):
                raise ValueError("View kind or field is not allowlisted.")
        if unit["kind"] == "report":
            definition = unit.get("definition", {})
            if definition.get("entity") not in entity_keys or definition.get("measure") not in {"count", "sum", "average"} or definition.get("field") is not None and definition.get("field") not in entity_fields[definition["entity"]]:
                raise ValueError("Report materialization is invalid.")
        if unit["kind"] == "kpi" and (unit.get("definition", {}).get("reportKey") not in report_keys or unit.get("definition", {}).get("denominatorReportKey") not in (None, *report_keys)):
            raise ValueError("KPI materialization is invalid.")
        if unit["kind"] == "notification_intent" and unit.get("definition", {}).get("recipientRole") not in role_keys:
            raise ValueError("Notification role authority is invalid.")
        if unit["kind"].endswith("intent") and unit.get("definition", {}).get("effectiveEnabled") is not False:
            raise ValueError("External intent must materialize disabled.")
    if not isinstance(plan["canonicalSpecJson"], str) or len(plan["canonicalSpecJson"].encode("utf-8")) > 512_000:
        raise ValueError("Canonical SystemSpec payload is invalid or too large.")
    supplied = _exact_hash(plan["planFingerprint"], "planFingerprint")
    if _fingerprint({key: value for key, value in plan.items() if key != "planFingerprint"}) != supplied:
        raise ValueError("Compiled SystemSpec fingerprint is invalid.")
    return plan


def _entity_targets(plan, tenant_id):
    targets = {}
    for unit in plan["materializationManifest"]["units"]:
        if unit["kind"] == "doctype":
            targets[unit["key"]] = unit["source"] if unit["mode"] == "existing_binding" else _target_name(tenant_id, "doctype", unit["key"])
    return targets


def _field_projection(field, targets):
    options = "\n".join(field["options"]) if field["frappeFieldType"] == "Select" else targets.get(field["linkEntity"]) if field["frappeFieldType"] == "Link" else "Email" if field["type"] == "email" else "Phone" if field["type"] == "phone" else None
    return {"fieldname": field["targetField"], "label": field["label"], "fieldtype": field["frappeFieldType"], "reqd": int(field["required"]), "unique": int(field["unique"]), "read_only": int(field["readOnly"]), "hidden": int(field["sensitive"]), "options": options}


def _inspect_doctype(unit, tenant_id, targets):
    target = targets[unit["key"]]
    if not frappe.db.exists("DocType", target):
        raise frappe.ValidationError("Required DocType is not materialized.")
    meta = frappe.get_meta(target, cached=False)
    fields = []
    for expected in unit["fields"]:
        actual = meta.get_field(expected["targetField"])
        if not actual:
            raise frappe.ValidationError("Required DocType field is missing.")
        fields.append({"fieldname": actual.fieldname, "label": actual.label, "fieldtype": actual.fieldtype, "reqd": int(actual.reqd or 0), "unique": int(actual.unique or 0), "read_only": int(actual.read_only or 0), "hidden": int(actual.hidden or 0), "options": actual.options or None})
    return {"doctype": target, "mode": unit["mode"], "fields": fields}


def _materialize_doctype(unit, tenant_id, targets):
    target = targets[unit["key"]]
    if unit["mode"] == "existing_binding":
        return target, _inspect_doctype(unit, tenant_id, targets)
    if frappe.db.exists("DocType", target):
        existing = frappe.get_doc("DocType", target)
        if not int(existing.custom or 0) or existing.module != "Discovery Stack":
            raise frappe.ValidationError("Custom DocType identity collided with non-app metadata.")
    else:
        frappe.get_doc({"doctype": "DocType", "name": target, "module": "Discovery Stack", "custom": 1, "istable": 0, "track_changes": 1, "autoname": "hash", "fields": [_field_projection(field, targets) for field in unit["fields"]]}).insert(ignore_permissions=True)
        frappe.clear_cache(doctype=target)
    projection = _inspect_doctype(unit, tenant_id, targets)
    expected = {"doctype": target, "mode": unit["mode"], "fields": [_field_projection(field, targets) for field in unit["fields"]]}
    if projection != expected:
        raise frappe.ValidationError("Custom DocType definition collision.")
    return target, projection


def _append_custom_doctype_fields(unit, tenant_id, targets):
    target = targets[unit["key"]]
    existing = frappe.get_doc("DocType", target)
    actual_names = {field.fieldname for field in existing.fields}
    additions = [field for field in unit["fields"] if field["targetField"] not in actual_names]
    for field in additions:
        existing.append("fields", _field_projection(field, targets))
    if additions:
        existing.save(ignore_permissions=True)
        frappe.clear_cache(doctype=target)
    projection = _inspect_doctype(unit, tenant_id, targets)
    expected = {"doctype": target, "mode": unit["mode"], "fields": [_field_projection(field, targets) for field in unit["fields"]]}
    if projection != expected:
        raise frappe.ValidationError("Custom DocType append-only update failed.")
    return target, projection


def _materialize_status(unit, tenant_id):
    names = []
    for value in unit["values"]:
        name = f"DS {_tenant_token(tenant_id)} {value.replace('_', ' ').title()}"[:140]
        if not frappe.db.exists("Workflow State", name):
            frappe.get_doc({"doctype": "Workflow State", "workflow_state_name": name, "style": "Primary"}).insert(ignore_permissions=True)
        names.append(name)
    return ",".join(names), {"states": names, "initial": unit["initial"], "terminal": unit["terminal"]}


def _role_permissions(role_name):
    rows = frappe.get_all("Custom DocPerm", filters={"role": role_name}, fields=["parent", "read", "write", "create", "delete"], order_by="parent asc")
    return [{"doctype": row.parent, "read": int(row.read or 0), "write": int(row.write or 0), "create": int(row.create or 0), "delete": int(row.delete or 0)} for row in rows]


def _materialize_role(unit, tenant_id, targets):
    role_name = _target_name(tenant_id, "role", unit["key"])
    if not frappe.db.exists("Role", role_name):
        frappe.get_doc({"doctype": "Role", "role_name": role_name, "desk_access": 1}).insert(ignore_permissions=True)
    expected = []
    for permission in unit["permissions"]:
        target = targets.get(permission["entity"])
        if not target:
            raise frappe.ValidationError("Role permission references an unknown entity.")
        values = {action: 1 for action in permission["actions"]}
        expected.append({"doctype": target, "read": int(values.get("read", 0)), "write": int(values.get("write", 0)), "create": int(values.get("create", 0)), "delete": 0})
    expected.sort(key=lambda item: item["doctype"])
    actual = _role_permissions(role_name)
    if actual and actual != expected:
        raise frappe.ValidationError("Role permission definition collision.")
    if not actual:
        for permission in expected:
            frappe.get_doc({"doctype": "Custom DocPerm", "parent": permission["doctype"], "role": role_name, "permlevel": 0, **{key: permission[key] for key in ("read", "write", "create", "delete")}}).insert(ignore_permissions=True)
        actual = _role_permissions(role_name)
    if actual != expected:
        raise frappe.ValidationError("Role permission materialization failed.")
    return role_name, {"role": role_name, "permissions": actual}


def _role_projection(unit, tenant_id, targets):
    role_name = _target_name(tenant_id, "role", unit["key"])
    expected = []
    for permission in unit["permissions"]:
        values = {action: 1 for action in permission["actions"]}
        expected.append({"doctype": targets[permission["entity"]], "read": int(values.get("read", 0)), "write": int(values.get("write", 0)), "create": int(values.get("create", 0)), "delete": 0})
    return role_name, sorted(expected, key=lambda item: item["doctype"])


def _update_role_permissions(unit, tenant_id, targets):
    role_name, expected = _role_projection(unit, tenant_id, targets)
    for name in frappe.get_all("Custom DocPerm", filters={"role": role_name}, pluck="name"):
        frappe.delete_doc("Custom DocPerm", name, ignore_permissions=True)
    for permission in expected:
        frappe.get_doc({"doctype": "Custom DocPerm", "parent": permission["doctype"], "role": role_name, "permlevel": 0, **{key: permission[key] for key in ("read", "write", "create", "delete")}}).insert(ignore_permissions=True)
    if _role_permissions(role_name) != expected:
        raise frappe.ValidationError("Role permission update failed.")
    return role_name, {"role": role_name, "permissions": expected}


def _workflow_projection(name):
    doc = frappe.get_doc("Workflow", name)
    states = sorted(({"state": row.state, "allow_edit": row.allow_edit} for row in doc.states), key=lambda item: item["state"])
    transitions = sorted(({"state": row.state, "action": row.action, "next_state": row.next_state, "allowed": row.allowed} for row in doc.transitions), key=lambda item: (item["state"], item["next_state"], item["action"], item["allowed"]))
    return {"workflow": name, "document_type": doc.document_type, "workflow_state_field": doc.workflow_state_field, "states": states, "transitions": transitions}


def _expected_workflow(unit, tenant_id, targets, units):
    target = targets.get(unit["entity"])
    status = next((candidate for candidate in units if candidate["kind"] == "status" and candidate["entity"] == unit["entity"]), None)
    if not target or not status:
        raise frappe.ValidationError("Workflow status authority is unavailable.")
    role_names = {candidate["key"]: _target_name(tenant_id, "role", candidate["key"]) for candidate in units if candidate["kind"] == "role"}
    state_names = {value: f"DS {_tenant_token(tenant_id)} {value.replace('_', ' ').title()}"[:140] for value in status["values"]}
    name = _target_name(tenant_id, "workflow", unit["key"])
    edit_role = sorted({role for transition in unit["transitions"] for role in transition["roles"]})[0]
    transitions = []
    for item in unit["transitions"]:
        for role in item["roles"]:
            transitions.append({"state": state_names[item["from"]], "action": f"DS {item['from']} to {item['to']}"[:140], "next_state": state_names[item["to"]], "allowed": role_names[role]})
    return {"workflow": name, "document_type": target, "workflow_state_field": "status", "states": sorted(({"state": state_names[value], "allow_edit": role_names[edit_role]} for value in status["values"]), key=lambda item: item["state"]), "transitions": sorted(transitions, key=lambda item: (item["state"], item["next_state"], item["action"], item["allowed"]))}


def _materialize_workflow(unit, tenant_id, targets, units, allow_update=False):
    expected = _expected_workflow(unit, tenant_id, targets, units)
    name = expected["workflow"]
    for transition in expected["transitions"]:
        if not frappe.db.exists("Workflow Action Master", transition["action"]):
            frappe.get_doc({"doctype": "Workflow Action Master", "workflow_action_name": transition["action"]}).insert(ignore_permissions=True)
    if not frappe.db.exists("Workflow", name):
        frappe.get_doc({"doctype": "Workflow", "workflow_name": name, "document_type": expected["document_type"], "is_active": 1, "workflow_state_field": "status", "send_email_alert": 0, "states": [{**item, "doc_status": "0"} for item in expected["states"]], "transitions": [dict(item) for item in expected["transitions"]]}).insert(ignore_permissions=True)
    actual = _workflow_projection(name)
    if actual != expected and allow_update:
        workflow = frappe.get_doc("Workflow", name)
        workflow.document_type = expected["document_type"]
        workflow.workflow_state_field = expected["workflow_state_field"]
        workflow.set("states", [{**item, "doc_status": "0"} for item in expected["states"]])
        workflow.set("transitions", [dict(item) for item in expected["transitions"]])
        workflow.save(ignore_permissions=True)
        actual = _workflow_projection(name)
    if actual != expected:
        for field in ("document_type", "workflow_state_field", "states", "transitions"):
            if actual[field] != expected[field]:
                diagnostic = _canonical({"actualFingerprint": _fingerprint(actual[field]), "expectedFingerprint": _fingerprint(expected[field])})
                raise frappe.ValidationError(f"Workflow {field} definition collision: {diagnostic}")
    return name, actual


def _app_record(doctype, identity_field, identity, values, projection_fields):
    if not frappe.db.exists(doctype, identity):
        frappe.get_doc({"doctype": doctype, identity_field: identity, **values}).insert(ignore_permissions=True)
    doc = frappe.get_doc(doctype, identity)
    actual = {field: doc.get(field) for field in projection_fields}
    expected = {field: values.get(field, identity if field == identity_field else None) for field in projection_fields}
    if actual != expected:
        raise frappe.ValidationError(f"{doctype} definition collision.")
    return actual


def _materialize_unit(unit, tenant_id, plan, targets, allow_update=False):
    units = plan["materializationManifest"]["units"]
    kind = unit["kind"]
    if kind == "module":
        if not frappe.db.exists("Module Def", unit["erpNextModule"]):
            raise frappe.ValidationError("Required ERPNext module is unavailable.")
        return unit["erpNextModule"], {"module": unit["erpNextModule"], "exists": True}
    if kind == "doctype":
        if allow_update and unit["mode"] == "custom_doctype" and frappe.db.exists("DocType", targets[unit["key"]]):
            return _append_custom_doctype_fields(unit, tenant_id, targets)
        return _materialize_doctype(unit, tenant_id, targets)
    if kind == "status":
        return _materialize_status(unit, tenant_id)
    if kind == "role":
        if allow_update and frappe.db.exists("Role", _target_name(tenant_id, "role", unit["key"])):
            return _update_role_permissions(unit, tenant_id, targets)
        return _materialize_role(unit, tenant_id, targets)
    if kind == "workflow":
        return _materialize_workflow(unit, tenant_id, targets, units, allow_update)
    if kind == "view":
        definition = unit["definition"]
        identity = _unit_identity(tenant_id, plan["planFingerprint"], unit)
        fields = [next(field["targetField"] for candidate in units if candidate["kind"] == "doctype" and candidate["key"] == definition["entity"] for field in candidate["fields"] if field["key"] == logical) for logical in definition["fields"]]
        values = {"system_tenant_id": tenant_id, "plan_fingerprint": plan["planFingerprint"], "view_key": unit["key"], "target_doctype": targets[definition["entity"]], "view_kind": definition["kind"], "view_fields": _canonical(fields), "definition_fingerprint": unit["definitionFingerprint"]}
        return identity, _app_record("DiscoveryStack View Definition", "view_identity", identity, values, ["view_identity", *values])
    if kind == "report":
        definition = unit["definition"]
        report_name = _target_name(tenant_id, "report", unit["key"])
        if not frappe.db.exists("Report", report_name):
            frappe.get_doc({"doctype": "Report", "report_name": report_name, "ref_doctype": targets[definition["entity"]], "report_type": "Report Builder", "is_standard": "No", "module": "Discovery Stack", "disabled": 0}).insert(ignore_permissions=True)
        report = frappe.get_doc("Report", report_name)
        if report.ref_doctype != targets[definition["entity"]] or report.report_type != "Report Builder":
            raise frappe.ValidationError("Report definition collision.")
        identity = _unit_identity(tenant_id, plan["planFingerprint"], unit)
        values = {"system_tenant_id": tenant_id, "plan_fingerprint": plan["planFingerprint"], "metric_key": unit["key"], "metric_kind": "report", "target_doctype": report.ref_doctype, "metric_definition": _canonical(definition), "definition_fingerprint": unit["definitionFingerprint"]}
        metric = _app_record("DiscoveryStack Metric Definition", "metric_identity", identity, values, ["metric_identity", *values])
        return report_name, {"report": report_name, "ref_doctype": report.ref_doctype, "report_type": report.report_type, "metric": metric}
    if kind == "kpi":
        identity = _unit_identity(tenant_id, plan["planFingerprint"], unit)
        values = {"system_tenant_id": tenant_id, "plan_fingerprint": plan["planFingerprint"], "metric_key": unit["key"], "metric_kind": "kpi", "target_doctype": None, "metric_definition": _canonical(unit["definition"]), "definition_fingerprint": unit["definitionFingerprint"]}
        return identity, _app_record("DiscoveryStack Metric Definition", "metric_identity", identity, values, ["metric_identity", *values])
    identity = _unit_identity(tenant_id, plan["planFingerprint"], unit)
    values = {"system_tenant_id": tenant_id, "plan_fingerprint": plan["planFingerprint"], "intent_key": unit["key"], "intent_kind": "notification" if kind == "notification_intent" else "integration", "effective_enabled": 0, "intent_definition": _canonical(unit["definition"]), "definition_fingerprint": unit["definitionFingerprint"]}
    return identity, _app_record("DiscoveryStack Disabled Intent", "intent_identity", identity, values, ["intent_identity", *values])


def _upgrade_guard(plan, tenant_id):
    rows = frappe.get_all("DiscoveryStack Compiled System Spec", filters={"system_tenant_id": tenant_id}, fields=["name", "spec_version", "spec_fingerprint", "compiled_metadata"], order_by="spec_version desc", limit=1)
    if not rows:
        return None
    prior = validate_compiled_plan(json.loads(rows[0].compiled_metadata))
    if prior["planFingerprint"] == plan["planFingerprint"]:
        return prior
    if plan["specVersion"] <= prior["specVersion"] or plan["parentFingerprint"] != prior["specFingerprint"]:
        raise frappe.ValidationError("Stale SystemSpec lineage is blocked.")
    old_units = {(unit["kind"], unit["key"]): unit for unit in prior["materializationManifest"]["units"]}
    new_units = {(unit["kind"], unit["key"]): unit for unit in plan["materializationManifest"]["units"]}
    for identity, old in old_units.items():
        new = new_units.get(identity)
        if not new and old["kind"] in {"doctype", "role", "workflow"}:
            raise frappe.ValidationError("Destructive materialization removal is blocked.")
        if old["kind"] == "doctype" and new:
            if old["mode"] != new["mode"] or old["source"] != new["source"]:
                raise frappe.ValidationError("DocType binding changes are blocked.")
            old_fields = {field["key"]: field for field in old["fields"]}; new_fields = {field["key"]: field for field in new["fields"]}
            if any(key not in new_fields or new_fields[key]["frappeFieldType"] != field["frappeFieldType"] or (not field["required"] and new_fields[key]["required"]) for key, field in old_fields.items()):
                raise frappe.ValidationError("Destructive field change is blocked.")
            if any(field["required"] for key, field in new_fields.items() if key not in old_fields):
                raise frappe.ValidationError("New required fields need a reviewed data migration.")
        if old["kind"] == "role" and new:
            old_permissions = {(item["entity"], action) for item in old["permissions"] for action in item["actions"]}; new_permissions = {(item["entity"], action) for item in new["permissions"] for action in item["actions"]}
            if not new_permissions.issubset(old_permissions):
                raise frappe.ValidationError("Permission escalation requires reviewed intent.")
        if old["kind"] == "status" and new and not set(old["values"]).issubset(set(new["values"])):
                raise frappe.ValidationError("Workflow state orphaning is blocked.")
        if old["kind"] == "workflow" and new:
            old_edges = {(item["from"], item["to"]): set(item["roles"]) for item in old["transitions"]}
            new_edges = {(item["from"], item["to"]): set(item["roles"]) for item in new["transitions"]}
            if any(edge not in new_edges for edge in old_edges):
                raise frappe.ValidationError("Workflow transition orphaning is blocked.")
            if any(not new_edges[edge].issubset(roles) for edge, roles in old_edges.items()):
                raise frappe.ValidationError("Workflow role escalation requires reviewed intent.")
    return prior


def _preflight_materialization(plan, tenant_id, targets, prior=None):
    """Detect every known collision before the first metadata write or DDL operation."""
    for unit in plan["materializationManifest"]["units"]:
        if unit["kind"] == "module" and not frappe.db.exists("Module Def", unit["erpNextModule"]):
            raise frappe.ValidationError("Required ERPNext module is unavailable.")
        if unit["kind"] == "doctype" and unit["mode"] == "existing_binding":
            _inspect_doctype(unit, tenant_id, targets)
        if unit["kind"] == "doctype" and unit["mode"] == "custom_doctype" and frappe.db.exists("DocType", targets[unit["key"]]):
            existing = frappe.get_doc("DocType", targets[unit["key"]])
            if not int(existing.custom or 0) or existing.module != "Discovery Stack":
                raise frappe.ValidationError("Custom DocType identity collided with non-app metadata.")
            prior_unit = next((candidate for candidate in (prior or {}).get("materializationManifest", {}).get("units", []) if candidate["kind"] == "doctype" and candidate["key"] == unit["key"]), None)
            comparison = prior_unit or unit
            expected = {"doctype": targets[unit["key"]], "mode": comparison["mode"], "fields": [_field_projection(field, targets) for field in comparison["fields"]]}
            if _inspect_doctype(comparison, tenant_id, targets) != expected or prior_unit is None and any(field["targetField"] not in {item.fieldname for item in existing.fields} for field in unit["fields"]):
                raise frappe.ValidationError("Custom DocType definition collision.")
        if unit["kind"] == "role":
            name = _target_name(tenant_id, "role", unit["key"])
            if frappe.db.exists("Role", name):
                prior_unit = next((candidate for candidate in (prior or {}).get("materializationManifest", {}).get("units", []) if candidate["kind"] == "role" and candidate["key"] == unit["key"]), None)
                _, expected = _role_projection(prior_unit or unit, tenant_id, targets)
                if _role_permissions(name) and _role_permissions(name) != expected:
                    raise frappe.ValidationError("Role permission definition collision.")
        if unit["kind"] == "workflow" and frappe.db.exists("Workflow", _target_name(tenant_id, "workflow", unit["key"])):
            prior_unit = next((candidate for candidate in (prior or {}).get("materializationManifest", {}).get("units", []) if candidate["kind"] == "workflow" and candidate["key"] == unit["key"]), None)
            comparison = prior_unit or unit
            comparison_units = (prior or plan)["materializationManifest"]["units"]
            if _workflow_projection(_target_name(tenant_id, "workflow", unit["key"])) != _expected_workflow(comparison, tenant_id, targets, comparison_units):
                raise frappe.ValidationError("Workflow definition collision.")
        if unit["kind"] == "report":
            name = _target_name(tenant_id, "report", unit["key"])
            if frappe.db.exists("Report", name):
                report = frappe.get_doc("Report", name)
                if report.ref_doctype != targets[unit["definition"]["entity"]] or report.report_type != "Report Builder":
                    raise frappe.ValidationError("Report definition collision.")


def apply_compiled_plan(plan, authority_binding=None):
    """Materialize an entire manifest atomically through Frappe metadata APIs."""
    plan = validate_compiled_plan(plan)
    binding = plan["tenantBinding"]
    authority_binding = authority_binding or binding
    tenant_id = _opaque_id(authority_binding.get("systemTenantId"), "systemTenantId")
    for key in ("ownerId", "clientId"):
        if _opaque_id(authority_binding.get(key), key) != binding[key]:
            raise frappe.PermissionError("Materialization tenant lineage is mismatched.")
    if binding.get("systemTenantId") not in (None, tenant_id):
        raise frappe.PermissionError("Materialization tenant identity is mismatched.")
    website_id = binding.get("managedSiteId") or binding.get("websiteId") or "unbound"
    identity = {"system_tenant_id": tenant_id, "owner_id_hash": _sha(binding["ownerId"]), "client_id_hash": _sha(binding["clientId"]), "website_id_hash": _sha(website_id)}
    identity["binding_fingerprint"] = _fingerprint(identity)
    savepoint = f"ds_{plan['planFingerprint'][:16]}"
    frappe.db.savepoint(savepoint)
    try:
        existing_identity = frappe.db.exists("DiscoveryStack Tenant Identity", tenant_id)
        if existing_identity:
            stored = frappe.get_doc("DiscoveryStack Tenant Identity", tenant_id)
            if any(stored.get(key) != value for key, value in identity.items()):
                raise frappe.ValidationError("Tenant identity lineage collision.")
        else:
            frappe.get_doc({"doctype": "DiscoveryStack Tenant Identity", **identity}).insert(ignore_permissions=True)
        prior = _upgrade_guard(plan, tenant_id)
        existing_plan = frappe.db.exists("DiscoveryStack Compiled System Spec", plan["planFingerprint"])
        if existing_plan:
            stored = frappe.get_doc("DiscoveryStack Compiled System Spec", existing_plan)
            if stored.spec_fingerprint != plan["specFingerprint"] or stored.system_tenant_id != tenant_id or stored.compiled_metadata != _canonical(plan):
                raise frappe.ValidationError("Compiled SystemSpec replay collision.")
            replayed = True
        else:
            replayed = False
        targets = _entity_targets(plan, tenant_id)
        _preflight_materialization(plan, tenant_id, targets, prior)
        allow_update = bool(prior and prior["planFingerprint"] != plan["planFingerprint"])
        applied = []
        for unit in plan["materializationManifest"]["units"]:
            target, projection = _materialize_unit(unit, tenant_id, plan, targets, allow_update)
            applied_fingerprint = _fingerprint(projection)
            unit_identity = _unit_identity(tenant_id, plan["planFingerprint"], unit)
            values = {"system_tenant_id": tenant_id, "owner_id_hash": identity["owner_id_hash"], "client_id_hash": identity["client_id_hash"], "plan_fingerprint": plan["planFingerprint"], "manifest_fingerprint": plan["materializationManifest"]["fingerprint"], "unit_kind": unit["kind"], "unit_key": unit["key"], "target_name": target, "definition_fingerprint": unit["definitionFingerprint"], "applied_fingerprint": applied_fingerprint, "unit_metadata": _canonical({"projection": projection})}
            if frappe.db.exists("DiscoveryStack Materialized Unit", unit_identity):
                record = frappe.get_doc("DiscoveryStack Materialized Unit", unit_identity)
                if any(record.get(key) != value for key, value in values.items()):
                    raise frappe.ValidationError("Materialized unit replay collision.")
            else:
                frappe.get_doc({"doctype": "DiscoveryStack Materialized Unit", "unit_identity": unit_identity, **values}).insert(ignore_permissions=True)
            applied.append({"kind": unit["kind"], "key": unit["key"], "target": target, "appliedFingerprint": applied_fingerprint})
        if frappe.db.exists("DiscoveryStack Tenant Policy", tenant_id):
            policy = frappe.get_doc("DiscoveryStack Tenant Policy", tenant_id)
            policy_values = {"active_plan_fingerprint": plan["planFingerprint"], "manifest_fingerprint": plan["materializationManifest"]["fingerprint"], "suspended": int(policy.suspended or 0)}
            policy_values["policy_fingerprint"] = _fingerprint({"tenant": tenant_id, **policy_values})
            if any(policy.get(key) != value for key, value in policy_values.items()):
                policy.update(policy_values); policy.save(ignore_permissions=True)
        else:
            policy_values = {"active_plan_fingerprint": plan["planFingerprint"], "manifest_fingerprint": plan["materializationManifest"]["fingerprint"], "suspended": 0}
            policy_values["policy_fingerprint"] = _fingerprint({"tenant": tenant_id, **policy_values})
            frappe.get_doc({"doctype": "DiscoveryStack Tenant Policy", "system_tenant_id": tenant_id, **policy_values}).insert(ignore_permissions=True)
        if not existing_plan:
            frappe.get_doc({"doctype": "DiscoveryStack Compiled System Spec", "system_tenant_id": tenant_id, "spec_version": plan["specVersion"], "spec_fingerprint": plan["specFingerprint"], "plan_fingerprint": plan["planFingerprint"], "compiler_version": plan["compilerVersion"], "compiled_metadata": _canonical(plan)}).insert(ignore_permissions=True)
        event_fingerprint = _fingerprint({"event": "materialization_applied", "tenant": tenant_id, "plan": plan["planFingerprint"], "manifest": plan["materializationManifest"]["fingerprint"]})
        if not frappe.db.exists("DiscoveryStack System Audit Event", event_fingerprint):
            frappe.get_doc({"doctype": "DiscoveryStack System Audit Event", "system_tenant_id": tenant_id, "event_type": "materialization_applied", "actor_hash": _sha("server:system-factory"), "event_fingerprint": event_fingerprint, "event_metadata": _canonical({"planFingerprint": plan["planFingerprint"], "manifestFingerprint": plan["materializationManifest"]["fingerprint"], "unitCount": len(applied)})}).insert(ignore_permissions=True)
        frappe.db.commit()
    except Exception:
        frappe.db.rollback(save_point=savepoint)
        raise
    receipt = _fingerprint({"site": frappe.local.site, "tenant": tenant_id, "plan": plan["planFingerprint"], "manifest": plan["materializationManifest"]["fingerprint"], "units": applied, "appVersion": __version__})
    return {"ok": True, "applied": True, "replayed": replayed, "systemTenantId": tenant_id, "planFingerprint": plan["planFingerprint"], "materializationFingerprint": plan["materializationManifest"]["fingerprint"], "unitCount": len(applied), "units": applied, "receiptFingerprint": receipt}


def health_snapshot(system_tenant_id=None):
    if system_tenant_id is None:
        return {"ok": True, "healthy": True, "app": "discovery_stack", "version": __version__, "schemaVersion": "system-spec-v1", "site": frappe.local.site, "unitCount": 0, "driftedUnits": []}
    tenant_id = _opaque_id(system_tenant_id, "systemTenantId")
    policy_name = frappe.db.exists("DiscoveryStack Tenant Policy", tenant_id)
    if not policy_name:
        return {"ok": True, "healthy": False, "app": "discovery_stack", "version": __version__, "schemaVersion": "system-spec-v1", "site": frappe.local.site, "unitCount": 0, "driftedUnits": ["tenant_policy"]}
    policy = frappe.get_doc("DiscoveryStack Tenant Policy", policy_name)
    plan_name = frappe.db.exists("DiscoveryStack Compiled System Spec", policy.active_plan_fingerprint)
    if not plan_name:
        return {"ok": True, "healthy": False, "app": "discovery_stack", "version": __version__, "schemaVersion": "system-spec-v1", "site": frappe.local.site, "unitCount": 0, "driftedUnits": ["compiled_plan"]}
    plan = validate_compiled_plan(json.loads(frappe.get_doc("DiscoveryStack Compiled System Spec", plan_name).compiled_metadata))
    targets = _entity_targets(plan, tenant_id); drifted = []
    records = frappe.get_all("DiscoveryStack Materialized Unit", filters={"system_tenant_id": tenant_id, "plan_fingerprint": plan["planFingerprint"]}, fields=["unit_kind", "unit_key", "definition_fingerprint", "applied_fingerprint"])
    by_key = {(record.unit_kind, record.unit_key): record for record in records}
    for unit in plan["materializationManifest"]["units"]:
        record = by_key.get((unit["kind"], unit["key"]))
        try:
            _, projection = _inspect_materialized_unit(unit, tenant_id, plan, targets)
            if not record or record.definition_fingerprint != unit["definitionFingerprint"] or record.applied_fingerprint != _fingerprint(projection):
                drifted.append(f"{unit['kind']}:{unit['key']}")
        except Exception:
            drifted.append(f"{unit['kind']}:{unit['key']}")
    if len(records) != len(plan["materializationManifest"]["units"]):
        drifted.append("unit_count")
    healthy = not int(policy.suspended or 0) and not drifted and policy.manifest_fingerprint == plan["materializationManifest"]["fingerprint"]
    return {"ok": True, "healthy": bool(healthy), "app": "discovery_stack", "version": __version__, "schemaVersion": "system-spec-v1", "site": frappe.local.site, "unitCount": len(records), "driftedUnits": sorted(set(drifted))}


def _inspect_materialized_unit(unit, tenant_id, plan, targets):
    kind = unit["kind"]
    if kind == "module":
        if not frappe.db.exists("Module Def", unit["erpNextModule"]): raise frappe.ValidationError("Module drift.")
        return unit["erpNextModule"], {"module": unit["erpNextModule"], "exists": True}
    if kind == "doctype": return targets[unit["key"]], _inspect_doctype(unit, tenant_id, targets)
    if kind == "status":
        names = [f"DS {_tenant_token(tenant_id)} {value.replace('_', ' ').title()}"[:140] for value in unit["values"]]
        if any(not frappe.db.exists("Workflow State", name) for name in names): raise frappe.ValidationError("Status drift.")
        return ",".join(names), {"states": names, "initial": unit["initial"], "terminal": unit["terminal"]}
    if kind == "role":
        name = _target_name(tenant_id, "role", unit["key"])
        if not frappe.db.exists("Role", name): raise frappe.ValidationError("Role drift.")
        return name, {"role": name, "permissions": _role_permissions(name)}
    if kind == "workflow":
        name = _target_name(tenant_id, "workflow", unit["key"])
        projection = _workflow_projection(name)
        if any(not frappe.db.exists("Workflow Action Master", transition["action"]) for transition in projection["transitions"]): raise frappe.ValidationError("Workflow action drift.")
        return name, projection
    identity = _unit_identity(tenant_id, plan["planFingerprint"], unit)
    if kind == "view":
        doc = frappe.get_doc("DiscoveryStack View Definition", identity); return identity, {field: doc.get(field) for field in ["view_identity", "system_tenant_id", "plan_fingerprint", "view_key", "target_doctype", "view_kind", "view_fields", "definition_fingerprint"]}
    if kind == "report":
        name = _target_name(tenant_id, "report", unit["key"]); report = frappe.get_doc("Report", name); metric = frappe.get_doc("DiscoveryStack Metric Definition", identity); return name, {"report": name, "ref_doctype": report.ref_doctype, "report_type": report.report_type, "metric": {field: metric.get(field) for field in ["metric_identity", "system_tenant_id", "plan_fingerprint", "metric_key", "metric_kind", "target_doctype", "metric_definition", "definition_fingerprint"]}}
    if kind == "kpi":
        doc = frappe.get_doc("DiscoveryStack Metric Definition", identity); return identity, {field: doc.get(field) for field in ["metric_identity", "system_tenant_id", "plan_fingerprint", "metric_key", "metric_kind", "target_doctype", "metric_definition", "definition_fingerprint"]}
    doc = frappe.get_doc("DiscoveryStack Disabled Intent", identity); return identity, {field: doc.get(field) for field in ["intent_identity", "system_tenant_id", "plan_fingerprint", "intent_key", "intent_kind", "effective_enabled", "intent_definition", "definition_fingerprint"]}
