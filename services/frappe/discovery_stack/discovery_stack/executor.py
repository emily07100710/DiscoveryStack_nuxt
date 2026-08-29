"""Transactional materializer for an allowlisted, already-compiled SystemSpec."""

import hashlib
import json
import re
import unicodedata

import frappe

from discovery_stack import __version__


ALLOWED_UNIT_KINDS = {"module", "doctype", "status", "role", "workflow", "view", "report", "kpi", "workspace", "notification_intent", "integration_intent"}
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
    prefixes = {"doctype": "DS", "role": "DS Role", "workflow": "DS Workflow", "report": "DS Report", "workspace": "DS Workspace", "number_card": "DS KPI", "chart": "DS Chart"}
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
    view_keys = {unit.get("key") for unit in manifest["units"] if isinstance(unit, dict) and unit.get("kind") == "view"}
    kpi_keys = {unit.get("key") for unit in manifest["units"] if isinstance(unit, dict) and unit.get("kind") == "kpi"}
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
            expected_materialization = "desk_ready" if definition.get("kind") in {"list", "form"} else "registry_only"
            if definition.get("kind") not in ALLOWED_VIEW_KINDS or definition.get("materialization") != expected_materialization or definition.get("entity") not in entity_keys or any(field not in entity_fields[definition["entity"]] for field in definition.get("fields", [])):
                raise ValueError("View kind or field is not allowlisted.")
        if unit["kind"] == "report":
            definition = unit.get("definition", {})
            if definition.get("entity") not in entity_keys or definition.get("measure") not in {"count", "sum", "average"} or definition.get("field") is not None and definition.get("field") not in entity_fields[definition["entity"]]:
                raise ValueError("Report materialization is invalid.")
        if unit["kind"] == "kpi" and (unit.get("definition", {}).get("reportKey") not in report_keys or unit.get("definition", {}).get("denominatorReportKey") not in (None, *report_keys)):
            raise ValueError("KPI materialization is invalid.")
        if unit["kind"] == "workspace":
            definition = unit.get("definition", {})
            if set(definition) != {"viewKeys", "reportKeys", "kpiKeys", "roleKeys"} or set(definition["viewKeys"]) != view_keys or set(definition["reportKeys"]) != report_keys or set(definition["kpiKeys"]) != kpi_keys or set(definition["roleKeys"]) != role_keys:
                raise ValueError("Workspace authority is incomplete or mismatched.")
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
        for permission_index, permission in enumerate(expected):
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
    prior = _role_permissions(role_name)
    try:
        for permission in expected:
            existing_name = frappe.db.get_value("Custom DocPerm", {"role": role_name, "parent": permission["doctype"], "permlevel": 0}, "name")
            if existing_name:
                doc = frappe.get_doc("Custom DocPerm", existing_name); doc.update({key: permission[key] for key in ("read", "write", "create", "delete")}); doc.save(ignore_permissions=True)
            else:
                frappe.get_doc({"doctype": "Custom DocPerm", "parent": permission["doctype"], "role": role_name, "permlevel": 0, **{key: permission[key] for key in ("read", "write", "create", "delete")}}).insert(ignore_permissions=True)
            if permission_index == 0: _inject_crash("permission_replacement")
        expected_doctypes = {item["doctype"] for item in expected}
        for row in frappe.get_all("Custom DocPerm", filters={"role": role_name}, fields=["name", "parent"]):
            if row.parent not in expected_doctypes:
                frappe.delete_doc("Custom DocPerm", row.name, ignore_permissions=True)
        if _role_permissions(role_name) != expected:
            raise frappe.ValidationError("Role permission update failed.")
    except Exception:
        for name in frappe.get_all("Custom DocPerm", filters={"role": role_name}, pluck="name"):
            frappe.delete_doc("Custom DocPerm", name, ignore_permissions=True)
        for permission in prior:
            frappe.get_doc({"doctype": "Custom DocPerm", "parent": permission["doctype"], "role": role_name, "permlevel": 0, **{key: permission[key] for key in ("read", "write", "create", "delete")}}).insert(ignore_permissions=True)
        raise
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
            transitions.append({"state": state_names[item["from"]], "action": f"DS {_tenant_token(tenant_id)} {item['from']} to {item['to']}"[:140], "next_state": state_names[item["to"]], "allowed": role_names[role]})
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


def _kpi_runtime_names(tenant_id, key, plan=None):
    suffix = f"_{plan['planFingerprint'][:8]}" if plan else ""
    return _target_name(tenant_id, "number_card", f"{key}{suffix}"), _target_name(tenant_id, "chart", f"{key}{suffix}")


def _kpi_projection(unit, tenant_id, plan, targets):
    report_key = unit["definition"]["reportKey"]
    report_unit = next(candidate for candidate in plan["materializationManifest"]["units"] if candidate["kind"] == "report" and candidate["key"] == report_key)
    target = targets[report_unit["definition"]["entity"]]
    card_name, chart_name = _kpi_runtime_names(tenant_id, unit["key"], plan)
    card = frappe.get_doc("Number Card", card_name)
    chart = frappe.get_doc("Dashboard Chart", chart_name)
    return {
        "number_card": {"name": card.name, "type": card.type, "document_type": card.document_type, "function": card.function, "filters_json": card.filters_json or "[]", "is_public": int(card.is_public or 0)},
        "dashboard_chart": {"name": chart.name, "chart_type": chart.chart_type, "document_type": chart.document_type, "based_on": chart.based_on, "type": chart.type, "filters_json": chart.filters_json or "[]", "is_public": int(chart.is_public or 0)},
        "target_doctype": target,
    }


def _materialize_kpi(unit, tenant_id, plan, targets):
    report_key = unit["definition"]["reportKey"]
    report_unit = next(candidate for candidate in plan["materializationManifest"]["units"] if candidate["kind"] == "report" and candidate["key"] == report_key)
    target = targets[report_unit["definition"]["entity"]]
    card_name, chart_name = _kpi_runtime_names(tenant_id, unit["key"], plan)
    if not frappe.db.exists("Number Card", card_name):
        frappe.get_doc({"doctype": "Number Card", "label": card_name, "type": "Document Type", "document_type": target, "function": "Count", "filters_json": "[]", "is_public": 0, "is_standard": 0, "module": "Discovery Stack"}).insert(ignore_permissions=True)
    if not frappe.db.exists("Dashboard Chart", chart_name):
        frappe.get_doc({"doctype": "Dashboard Chart", "chart_name": chart_name, "chart_type": "Count", "document_type": target, "based_on": "creation", "type": "Bar", "filters_json": "[]", "is_public": 0, "is_standard": 0, "module": "Discovery Stack", "timespan": "Last Year", "time_interval": "Monthly"}).insert(ignore_permissions=True)
    runtime = _kpi_projection(unit, tenant_id, plan, targets)
    expected = {"number_card": {"name": card_name, "type": "Document Type", "document_type": target, "function": "Count", "filters_json": "[]", "is_public": 0}, "dashboard_chart": {"name": chart_name, "chart_type": "Count", "document_type": target, "based_on": "creation", "type": "Bar", "filters_json": "[]", "is_public": 0}, "target_doctype": target}
    if runtime != expected:
        raise frappe.ValidationError("KPI runtime metadata definition collision.")
    identity = _unit_identity(tenant_id, plan["planFingerprint"], unit)
    values = {"system_tenant_id": tenant_id, "plan_fingerprint": plan["planFingerprint"], "metric_key": unit["key"], "metric_kind": "kpi", "target_doctype": target, "metric_definition": _canonical(unit["definition"]), "definition_fingerprint": unit["definitionFingerprint"]}
    metric = _app_record("DiscoveryStack Metric Definition", "metric_identity", identity, values, ["metric_identity", *values])
    return card_name, {"metric": metric, **runtime}


def _workspace_projection(tenant_id, plan):
    name = _target_name(tenant_id, "workspace", f"system_{plan['planFingerprint'][:8]}")
    doc = frappe.get_doc("Workspace", name)
    return {
        "workspace": doc.name,
        "label": doc.label,
        "public": int(doc.public or 0),
        "module": doc.module,
        "roles": sorted(row.role for row in doc.roles),
        "shortcuts": sorted(({"label": row.label, "type": row.type, "link_to": row.link_to} for row in doc.shortcuts), key=lambda item: (item["type"], item["link_to"])),
        "number_cards": sorted(row.number_card_name for row in doc.number_cards),
        "charts": sorted(row.chart_name for row in doc.charts),
    }


def _materialize_workspace(unit, tenant_id, plan, targets):
    units = plan["materializationManifest"]["units"]
    name = _target_name(tenant_id, "workspace", f"system_{plan['planFingerprint'][:8]}")
    roles = sorted(_target_name(tenant_id, "role", key) for key in unit["definition"]["roleKeys"])
    shortcuts = []
    for view_key in unit["definition"]["viewKeys"]:
        view = next(candidate for candidate in units if candidate["kind"] == "view" and candidate["key"] == view_key)
        if view["definition"]["materialization"] == "desk_ready":
            shortcuts.append({"label": view_key.replace("_", " ").title(), "type": "DocType", "link_to": targets[view["definition"]["entity"]]})
    for report_key in unit["definition"]["reportKeys"]:
        shortcuts.append({"label": report_key.replace("_", " ").title(), "type": "Report", "link_to": _target_name(tenant_id, "report", report_key)})
    shortcuts.sort(key=lambda item: (item["type"], item["link_to"]))
    cards = sorted(_kpi_runtime_names(tenant_id, key, plan)[0] for key in unit["definition"]["kpiKeys"])
    charts = sorted(_kpi_runtime_names(tenant_id, key, plan)[1] for key in unit["definition"]["kpiKeys"])
    expected = {"workspace": name, "label": name, "public": 0, "module": "Discovery Stack", "roles": roles, "shortcuts": shortcuts, "number_cards": cards, "charts": charts}
    if not frappe.db.exists("Workspace", name):
        frappe.get_doc({"doctype": "Workspace", "label": name, "title": name, "module": "Discovery Stack", "public": 0, "is_hidden": 1, "content": "[]", "roles": [{"role": role} for role in roles], "shortcuts": shortcuts, "number_cards": [{"number_card_name": card} for card in cards], "charts": [{"chart_name": chart} for chart in charts]}).insert(ignore_permissions=True)
    actual = _workspace_projection(tenant_id, plan)
    if actual != expected:
        raise frappe.ValidationError("Tenant Workspace definition collision.")
    return name, actual


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
        values = {"system_tenant_id": tenant_id, "plan_fingerprint": plan["planFingerprint"], "view_key": unit["key"], "target_doctype": targets[definition["entity"]], "view_kind": definition["kind"], "materialization_status": definition["materialization"], "view_fields": _canonical(fields), "definition_fingerprint": unit["definitionFingerprint"]}
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
        return _materialize_kpi(unit, tenant_id, plan, targets)
    if kind == "workspace":
        return _materialize_workspace(unit, tenant_id, plan, targets)
    identity = _unit_identity(tenant_id, plan["planFingerprint"], unit)
    values = {"system_tenant_id": tenant_id, "plan_fingerprint": plan["planFingerprint"], "intent_key": unit["key"], "intent_kind": "notification" if kind == "notification_intent" else "integration", "effective_enabled": 0, "intent_definition": _canonical(unit["definition"]), "definition_fingerprint": unit["definitionFingerprint"]}
    return identity, _app_record("DiscoveryStack Disabled Intent", "intent_identity", identity, values, ["intent_identity", *values])


def _upgrade_guard(plan, tenant_id):
    policy_name = frappe.db.exists("DiscoveryStack Tenant Policy", tenant_id)
    active_fingerprint = frappe.db.get_value("DiscoveryStack Tenant Policy", policy_name, "active_plan_fingerprint") if policy_name else None
    if not active_fingerprint:
        return None
    row = frappe.db.get_value("DiscoveryStack Compiled System Spec", {"system_tenant_id": tenant_id, "plan_fingerprint": active_fingerprint}, ["compiled_metadata"], as_dict=True)
    if not row:
        raise frappe.ValidationError("Active SystemSpec authority is missing.")
    prior = validate_compiled_plan(json.loads(row.compiled_metadata))
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
        if unit["kind"] == "kpi":
            card_name, chart_name = _kpi_runtime_names(tenant_id, unit["key"], plan)
            if frappe.db.exists("Number Card", card_name) or frappe.db.exists("Dashboard Chart", chart_name):
                try:
                    _kpi_projection(unit, tenant_id, plan, targets)
                except Exception as error:
                    raise frappe.ValidationError("KPI runtime metadata definition collision.") from error
        if unit["kind"] == "workspace" and frappe.db.exists("Workspace", _target_name(tenant_id, "workspace", f"system_{plan['planFingerprint'][:8]}")):
            prior_workspace = next((candidate for candidate in (prior or {}).get("materializationManifest", {}).get("units", []) if candidate["kind"] == "workspace"), None)
            if prior_workspace is None:
                raise frappe.ValidationError("Tenant Workspace identity collision.")


def _runtime_exists(unit, tenant_id, plan, targets):
    kind = unit["kind"]
    if kind == "module": return True
    if kind == "doctype": return bool(frappe.db.exists("DocType", targets[unit["key"]]))
    if kind == "status": return all(frappe.db.exists("Workflow State", f"DS {_tenant_token(tenant_id)} {value.replace('_', ' ').title()}"[:140]) for value in unit["values"])
    if kind == "role": return bool(frappe.db.exists("Role", _target_name(tenant_id, "role", unit["key"])))
    if kind == "workflow": return bool(frappe.db.exists("Workflow", _target_name(tenant_id, "workflow", unit["key"])))
    if kind == "report": return bool(frappe.db.exists("Report", _target_name(tenant_id, "report", unit["key"])))
    if kind == "kpi":
        card, chart = _kpi_runtime_names(tenant_id, unit["key"], plan); return bool(frappe.db.exists("Number Card", card) and frappe.db.exists("Dashboard Chart", chart))
    if kind == "workspace": return bool(frappe.db.exists("Workspace", _target_name(tenant_id, "workspace", f"system_{plan['planFingerprint'][:8]}")))
    identity = _unit_identity(tenant_id, plan["planFingerprint"], unit)
    doctype = "DiscoveryStack View Definition" if kind == "view" else "DiscoveryStack Disabled Intent"
    return bool(frappe.db.exists(doctype, identity))


def _journal_identity(run_identity, unit):
    return f"{run_identity[:64]}:{unit['kind']}:{unit['key']}"[:140]


def _error_code(error):
    name = re.sub(r"[^A-Z0-9_]+", "_", error.__class__.__name__.upper())[:48]
    return f"MATERIALIZATION_{name or 'FAILED'}"


def _inject_crash(point):
    if getattr(frappe.flags, "discovery_stack_materialization_crash_point", None) == point:
        raise RuntimeError(f"DISCOVERY_STACK_INJECTED_{point.upper()}")


def _compensate_initial_run(run_identity, tenant_id, plan, targets):
    units = {(unit["kind"], unit["key"]): unit for unit in plan["materializationManifest"]["units"]}
    journals = frappe.get_all("DiscoveryStack Materialization Journal", filters={"run_identity": run_identity, "created_by_run": 1}, fields=["name", "unit_kind", "unit_key"], order_by="ordinal desc")
    for row in journals:
        unit = units.get((row.unit_kind, row.unit_key))
        if not unit: continue
        try:
            kind = unit["kind"]
            identity = _unit_identity(tenant_id, plan["planFingerprint"], unit)
            if frappe.db.exists("DiscoveryStack Materialized Unit", identity): frappe.delete_doc("DiscoveryStack Materialized Unit", identity, ignore_permissions=True)
            if kind == "workspace":
                name = _target_name(tenant_id, "workspace", f"system_{plan['planFingerprint'][:8]}");
                if frappe.db.exists("Workspace", name): frappe.delete_doc("Workspace", name, ignore_permissions=True)
            elif kind == "kpi":
                card, chart = _kpi_runtime_names(tenant_id, unit["key"], plan)
                for doctype, name in (("Dashboard Chart", chart), ("Number Card", card), ("DiscoveryStack Metric Definition", identity)):
                    if frappe.db.exists(doctype, name): frappe.delete_doc(doctype, name, ignore_permissions=True)
            elif kind == "report":
                name = _target_name(tenant_id, "report", unit["key"])
                if frappe.db.exists("Report", name): frappe.delete_doc("Report", name, ignore_permissions=True)
                if frappe.db.exists("DiscoveryStack Metric Definition", identity): frappe.delete_doc("DiscoveryStack Metric Definition", identity, ignore_permissions=True)
            elif kind == "view" and frappe.db.exists("DiscoveryStack View Definition", identity): frappe.delete_doc("DiscoveryStack View Definition", identity, ignore_permissions=True)
            elif kind.endswith("intent") and frappe.db.exists("DiscoveryStack Disabled Intent", identity): frappe.delete_doc("DiscoveryStack Disabled Intent", identity, ignore_permissions=True)
            elif kind == "workflow":
                name = _target_name(tenant_id, "workflow", unit["key"])
                if frappe.db.exists("Workflow", name): frappe.delete_doc("Workflow", name, ignore_permissions=True)
            elif kind == "role":
                name = _target_name(tenant_id, "role", unit["key"])
                for permission in frappe.get_all("Custom DocPerm", filters={"role": name}, pluck="name"): frappe.delete_doc("Custom DocPerm", permission, ignore_permissions=True)
                if frappe.db.exists("Role", name): frappe.delete_doc("Role", name, ignore_permissions=True)
            elif kind == "status":
                for value in unit["values"]:
                    name = f"DS {_tenant_token(tenant_id)} {value.replace('_', ' ').title()}"[:140]
                    if frappe.db.exists("Workflow State", name): frappe.delete_doc("Workflow State", name, ignore_permissions=True)
            elif kind == "doctype" and unit["mode"] == "custom_doctype" and frappe.db.exists("DocType", targets[unit["key"]]): frappe.delete_doc("DocType", targets[unit["key"]], ignore_permissions=True)
            journal = frappe.get_doc("DiscoveryStack Materialization Journal", row.name); journal.status = "compensated"; journal.save(ignore_permissions=True)
            frappe.db.commit()
        except Exception:
            frappe.db.rollback()


def apply_compiled_plan(plan, authority_binding=None):
    """Preflight, journal, stage, verify and activate a compiled manifest without assuming DDL rollback."""
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
    run_identity = f"ds-run-{_fingerprint({'tenant': tenant_id, 'plan': plan['planFingerprint']})[:32]}"
    request_fingerprint = _fingerprint({"tenant": tenant_id, "plan": plan["planFingerprint"], "manifest": plan["materializationManifest"]["fingerprint"]})
    applied = []
    prior = None
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
        if frappe.db.exists("DiscoveryStack Materialization Run", run_identity):
            run = frappe.get_doc("DiscoveryStack Materialization Run", run_identity)
            if run.request_fingerprint != request_fingerprint or run.plan_fingerprint != plan["planFingerprint"] or run.system_tenant_id != tenant_id:
                raise frappe.ValidationError("Materialization run identity collision.")
            if run.status == "active":
                snapshot = health_snapshot(tenant_id)
                if not snapshot["healthy"]: raise frappe.ValidationError("Active materialization replay is drifted.")
                records = frappe.get_all("DiscoveryStack Materialized Unit", filters={"system_tenant_id": tenant_id, "plan_fingerprint": plan["planFingerprint"]}, fields=["unit_kind", "unit_key", "target_name", "applied_fingerprint"], order_by="unit_kind asc, unit_key asc")
                applied = [{"kind": row.unit_kind, "key": row.unit_key, "target": row.target_name, "appliedFingerprint": row.applied_fingerprint} for row in records]
                receipt = _fingerprint({"site": frappe.local.site, "tenant": tenant_id, "plan": plan["planFingerprint"], "manifest": plan["materializationManifest"]["fingerprint"], "units": applied, "appVersion": __version__})
                return {"ok": True, "applied": True, "replayed": True, "systemTenantId": tenant_id, "planFingerprint": plan["planFingerprint"], "materializationFingerprint": plan["materializationManifest"]["fingerprint"], "unitCount": len(applied), "units": applied, "receiptFingerprint": receipt}
            run.status = "applying"; run.error_code = None; run.save(ignore_permissions=True)
        else:
            run_values = {"run_identity": run_identity, "system_tenant_id": tenant_id, "plan_fingerprint": plan["planFingerprint"], "manifest_fingerprint": plan["materializationManifest"]["fingerprint"], "prior_active_plan_fingerprint": prior["planFingerprint"] if prior else None, "request_fingerprint": request_fingerprint, "status": "applying", "unit_count": len(plan["materializationManifest"]["units"]), "verified_unit_count": 0}
            run_values["run_fingerprint"] = _fingerprint(run_values)
            frappe.get_doc({"doctype": "DiscoveryStack Materialization Run", **run_values}).insert(ignore_permissions=True)
        if frappe.db.exists("DiscoveryStack Tenant Policy", tenant_id):
            policy = frappe.get_doc("DiscoveryStack Tenant Policy", tenant_id); policy.staged_plan_fingerprint = plan["planFingerprint"]; policy.materialization_state = "active" if policy.active_plan_fingerprint else "incomplete"
        else:
            policy = frappe.get_doc({"doctype": "DiscoveryStack Tenant Policy", "system_tenant_id": tenant_id, "active_plan_fingerprint": None, "manifest_fingerprint": None, "active_run_identity": None, "staged_plan_fingerprint": plan["planFingerprint"], "materialization_state": "incomplete", "suspended": 0, "policy_fingerprint": _fingerprint({"tenant": tenant_id, "state": "incomplete", "staged": plan["planFingerprint"]})})
        policy.policy_fingerprint = _fingerprint({"tenant": tenant_id, "active": policy.active_plan_fingerprint, "manifest": policy.manifest_fingerprint, "run": policy.active_run_identity, "staged": plan["planFingerprint"], "state": policy.materialization_state, "suspended": int(policy.suspended or 0)})
        if policy.is_new(): policy.insert(ignore_permissions=True)
        else: policy.save(ignore_permissions=True)
        frappe.db.commit()
        for ordinal, unit in enumerate(plan["materializationManifest"]["units"], start=1):
            journal_identity = _journal_identity(run_identity, unit)
            if frappe.db.exists("DiscoveryStack Materialization Journal", journal_identity):
                journal = frappe.get_doc("DiscoveryStack Materialization Journal", journal_identity)
                if journal.definition_fingerprint != unit["definitionFingerprint"] or journal.plan_fingerprint != plan["planFingerprint"]: raise frappe.ValidationError("Materialization journal collision.")
                if journal.status == "verified":
                    target, projection = _inspect_materialized_unit(unit, tenant_id, plan, targets); applied_fingerprint = _fingerprint(projection)
                    if journal.applied_fingerprint != applied_fingerprint: raise frappe.ValidationError("Materialization journal replay drift.")
                    applied.append({"kind": unit["kind"], "key": unit["key"], "target": target, "appliedFingerprint": applied_fingerprint}); continue
            else:
                existed = _runtime_exists(unit, tenant_id, plan, targets)
                journal_values = {"journal_identity": journal_identity, "run_identity": run_identity, "system_tenant_id": tenant_id, "plan_fingerprint": plan["planFingerprint"], "unit_kind": unit["kind"], "unit_key": unit["key"], "ordinal": ordinal, "status": "pending", "before_fingerprint": _fingerprint({"exists": existed, "kind": unit["kind"], "key": unit["key"]}), "created_by_run": int(not existed), "target_name": None, "definition_fingerprint": unit["definitionFingerprint"], "applied_fingerprint": None, "error_code": None}
                journal_values["journal_fingerprint"] = _fingerprint({key: value for key, value in journal_values.items() if key not in {"status", "target_name", "applied_fingerprint", "error_code"}})
                journal = frappe.get_doc({"doctype": "DiscoveryStack Materialization Journal", **journal_values}); journal.insert(ignore_permissions=True)
            journal.status = "applying"; journal.save(ignore_permissions=True); frappe.db.commit()
            target, projection = _materialize_unit(unit, tenant_id, plan, targets, allow_update)
            _inject_crash("after_ddl_before_ledger")
            applied_fingerprint = _fingerprint(projection)
            unit_identity = _unit_identity(tenant_id, plan["planFingerprint"], unit)
            values = {"system_tenant_id": tenant_id, "owner_id_hash": identity["owner_id_hash"], "client_id_hash": identity["client_id_hash"], "plan_fingerprint": plan["planFingerprint"], "manifest_fingerprint": plan["materializationManifest"]["fingerprint"], "unit_kind": unit["kind"], "unit_key": unit["key"], "target_name": target, "definition_fingerprint": unit["definitionFingerprint"], "applied_fingerprint": applied_fingerprint, "unit_metadata": _canonical({"projection": projection})}
            if frappe.db.exists("DiscoveryStack Materialized Unit", unit_identity):
                record = frappe.get_doc("DiscoveryStack Materialized Unit", unit_identity)
                if any(record.get(key) != value for key, value in values.items()):
                    raise frappe.ValidationError("Materialized unit replay collision.")
            else:
                frappe.get_doc({"doctype": "DiscoveryStack Materialized Unit", "unit_identity": unit_identity, **values}).insert(ignore_permissions=True)
            journal.target_name = target; journal.applied_fingerprint = applied_fingerprint; journal.status = "verified"; journal.error_code = None; journal.save(ignore_permissions=True)
            run = frappe.get_doc("DiscoveryStack Materialization Run", run_identity); run.verified_unit_count = ordinal; run.save(ignore_permissions=True); frappe.db.commit()
            applied.append({"kind": unit["kind"], "key": unit["key"], "target": target, "appliedFingerprint": applied_fingerprint})
        if not existing_plan:
            frappe.get_doc({"doctype": "DiscoveryStack Compiled System Spec", "system_tenant_id": tenant_id, "spec_version": plan["specVersion"], "spec_fingerprint": plan["specFingerprint"], "plan_fingerprint": plan["planFingerprint"], "compiler_version": plan["compilerVersion"], "compiled_metadata": _canonical(plan)}).insert(ignore_permissions=True)
        run = frappe.get_doc("DiscoveryStack Materialization Run", run_identity); run.status = "verified"; run.verified_unit_count = len(applied); run.save(ignore_permissions=True); frappe.db.commit()
        _inject_crash("after_ledger_before_active")
        workspace_name = _target_name(tenant_id, "workspace", f"system_{plan['planFingerprint'][:8]}"); workspace = frappe.get_doc("Workspace", workspace_name); workspace.is_hidden = 0; workspace.save(ignore_permissions=True)
        if prior and prior["planFingerprint"] != plan["planFingerprint"]:
            prior_workspace_name = _target_name(tenant_id, "workspace", f"system_{prior['planFingerprint'][:8]}")
            if frappe.db.exists("Workspace", prior_workspace_name): prior_workspace = frappe.get_doc("Workspace", prior_workspace_name); prior_workspace.is_hidden = 1; prior_workspace.save(ignore_permissions=True)
        policy = frappe.get_doc("DiscoveryStack Tenant Policy", tenant_id); policy.active_plan_fingerprint = plan["planFingerprint"]; policy.manifest_fingerprint = plan["materializationManifest"]["fingerprint"]; policy.active_run_identity = run_identity; policy.staged_plan_fingerprint = None; policy.materialization_state = "active"; policy.policy_fingerprint = _fingerprint({"tenant": tenant_id, "active": plan["planFingerprint"], "manifest": plan["materializationManifest"]["fingerprint"], "run": run_identity, "staged": None, "state": "active", "suspended": int(policy.suspended or 0)}); policy.save(ignore_permissions=True)
        run.status = "active"; run.save(ignore_permissions=True)
        event_fingerprint = _fingerprint({"event": "materialization_applied", "tenant": tenant_id, "plan": plan["planFingerprint"], "manifest": plan["materializationManifest"]["fingerprint"]})
        if not frappe.db.exists("DiscoveryStack System Audit Event", event_fingerprint):
            frappe.get_doc({"doctype": "DiscoveryStack System Audit Event", "system_tenant_id": tenant_id, "event_type": "materialization_applied", "actor_hash": _sha("server:system-factory"), "event_fingerprint": event_fingerprint, "event_metadata": _canonical({"planFingerprint": plan["planFingerprint"], "manifestFingerprint": plan["materializationManifest"]["fingerprint"], "unitCount": len(applied)})}).insert(ignore_permissions=True)
        frappe.db.commit()
    except Exception as error:
        frappe.db.rollback()
        if frappe.db.exists("DiscoveryStack Materialization Run", run_identity):
            run = frappe.get_doc("DiscoveryStack Materialization Run", run_identity); run.status = "failed"; run.error_code = _error_code(error); run.save(ignore_permissions=True)
            if frappe.db.exists("DiscoveryStack Tenant Policy", tenant_id):
                policy = frappe.get_doc("DiscoveryStack Tenant Policy", tenant_id); policy.staged_plan_fingerprint = plan["planFingerprint"]; policy.materialization_state = "active" if prior else "incomplete"; policy.policy_fingerprint = _fingerprint({"tenant": tenant_id, "active": policy.active_plan_fingerprint, "manifest": policy.manifest_fingerprint, "run": policy.active_run_identity, "staged": plan["planFingerprint"], "state": policy.materialization_state, "suspended": int(policy.suspended or 0)}); policy.save(ignore_permissions=True)
            frappe.db.commit()
        injected = "DISCOVERY_STACK_INJECTED_" in str(error)
        if not prior and not injected:
            _compensate_initial_run(run_identity, tenant_id, plan, _entity_targets(plan, tenant_id))
            run = frappe.get_doc("DiscoveryStack Materialization Run", run_identity); run.status = "compensated"; run.save(ignore_permissions=True)
            if frappe.db.exists("DiscoveryStack Tenant Policy", tenant_id): policy = frappe.get_doc("DiscoveryStack Tenant Policy", tenant_id); policy.materialization_state = "compensated"; policy.save(ignore_permissions=True)
            frappe.db.commit()
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
        staged = frappe.get_all("DiscoveryStack Materialization Run", filters={"system_tenant_id": tenant_id}, fields=["run_identity", "plan_fingerprint", "status", "verified_unit_count", "unit_count"], order_by="creation desc", limit=20)
        return {"ok": True, "healthy": False, "app": "discovery_stack", "version": __version__, "schemaVersion": "system-spec-v1", "site": frappe.local.site, "unitCount": 0, "driftedUnits": ["compiled_plan", f"materialization_state:{policy.materialization_state or 'unknown'}"], "materializationState": policy.materialization_state, "stagedPlanFingerprint": policy.staged_plan_fingerprint, "stagedRuns": [dict(row) for row in staged]}
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
    run = frappe.get_doc("DiscoveryStack Materialization Run", policy.active_run_identity) if policy.active_run_identity and frappe.db.exists("DiscoveryStack Materialization Run", policy.active_run_identity) else None
    if not run or run.status != "active" or int(run.verified_unit_count or 0) != len(plan["materializationManifest"]["units"]): drifted.append("materialization_run")
    if policy.materialization_state != "active": drifted.append(f"materialization_state:{policy.materialization_state or 'unknown'}")
    healthy = not int(policy.suspended or 0) and not drifted and policy.manifest_fingerprint == plan["materializationManifest"]["fingerprint"]
    staged = frappe.get_all("DiscoveryStack Materialization Run", filters={"system_tenant_id": tenant_id, "status": ["in", ["pending", "applying", "verified", "failed", "compensated"]]}, fields=["run_identity", "plan_fingerprint", "status", "verified_unit_count", "unit_count"], order_by="creation desc", limit=20)
    return {"ok": True, "healthy": bool(healthy), "app": "discovery_stack", "version": __version__, "schemaVersion": "system-spec-v1", "site": frappe.local.site, "unitCount": len(records), "driftedUnits": sorted(set(drifted)), "materializationState": policy.materialization_state, "stagedPlanFingerprint": policy.staged_plan_fingerprint, "stagedRuns": [dict(row) for row in staged]}


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
        doc = frappe.get_doc("DiscoveryStack View Definition", identity); return identity, {field: doc.get(field) for field in ["view_identity", "system_tenant_id", "plan_fingerprint", "view_key", "target_doctype", "view_kind", "materialization_status", "view_fields", "definition_fingerprint"]}
    if kind == "report":
        name = _target_name(tenant_id, "report", unit["key"]); report = frappe.get_doc("Report", name); metric = frappe.get_doc("DiscoveryStack Metric Definition", identity); return name, {"report": name, "ref_doctype": report.ref_doctype, "report_type": report.report_type, "metric": {field: metric.get(field) for field in ["metric_identity", "system_tenant_id", "plan_fingerprint", "metric_key", "metric_kind", "target_doctype", "metric_definition", "definition_fingerprint"]}}
    if kind == "kpi":
        doc = frappe.get_doc("DiscoveryStack Metric Definition", identity); return _kpi_runtime_names(tenant_id, unit["key"], plan)[0], {"metric": {field: doc.get(field) for field in ["metric_identity", "system_tenant_id", "plan_fingerprint", "metric_key", "metric_kind", "target_doctype", "metric_definition", "definition_fingerprint"]}, **_kpi_projection(unit, tenant_id, plan, targets)}
    if kind == "workspace":
        return _target_name(tenant_id, "workspace", f"system_{plan['planFingerprint'][:8]}"), _workspace_projection(tenant_id, plan)
    doc = frappe.get_doc("DiscoveryStack Disabled Intent", identity); return identity, {field: doc.get(field) for field in ["intent_identity", "system_tenant_id", "plan_fingerprint", "intent_key", "intent_kind", "effective_enabled", "intent_definition", "definition_fingerprint"]}
