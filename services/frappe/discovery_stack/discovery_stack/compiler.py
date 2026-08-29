"""Pure-Python golden compiler for the complete materialization manifest."""

import hashlib
import json


FIELD_TYPES = {"text": "Data", "long_text": "Long Text", "integer": "Int", "decimal": "Float", "boolean": "Check", "date": "Date", "datetime": "Datetime", "email": "Data", "phone": "Data", "currency": "Currency", "select": "Select", "link": "Link"}
ERP_FIELDS = {
    "Lead": {"lead_name": "lead_name", "email": "email_id", "status": "status"}, "Customer": {"customer_name": "customer_name", "email": "email_id", "phone": "mobile_no"}, "Opportunity": {"title": "title", "amount": "opportunity_amount", "status": "status"}, "Project": {"project_name": "project_name", "status": "status"}, "Task": {"subject": "subject", "status": "status"}, "Timesheet": {"hours": "total_hours"}, "Issue": {"subject": "subject", "status": "status"}, "Item": {"item_name": "item_name", "sku": "item_code"}, "Warehouse": {"warehouse_name": "warehouse_name"}, "Sales Order": {"order_reference": "po_no", "total": "grand_total", "status": "status"}, "Purchase Order": {"order_reference": "supplier_order_reference", "total": "grand_total"}, "Stock Entry": {"quantity": "total_outgoing_value"}, "Supplier": {"supplier_name": "supplier_name"}, "Course": {"course_name": "course_name"}, "Student": {"member_name": "student_name", "email": "student_email_id"}, "Program Enrollment": {"status": "docstatus"},
}


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _unit(value):
    return {**value, "definitionFingerprint": sha256(canonical_json(value))}


def compile_spec(spec):
    """Compile every governed SystemSpec field into deterministic materialization units."""
    units = []
    modules = {"light_crm": ["CRM", "Selling"], "appointment_booking": ["CRM"], "membership_course": ["CRM", "Education"], "service_project": ["CRM", "Projects"], "inventory_sales": ["Buying", "Selling", "Stock"], "retail_light": ["Selling", "Stock"], "custom_bounded": []}[spec["systemTemplate"]]
    for module in sorted(modules):
        units.append(_unit({"kind": "module", "key": module.lower().replace(" ", "_"), "erpNextModule": module, "mode": "existing_binding"}))
    for entity in sorted(spec.get("entities", []), key=lambda item: item["key"]):
        source = entity.get("erpNextDocType") or f"DiscoveryStack {entity['label']}"
        bindings = ERP_FIELDS.get(source) if entity["kind"] == "erpnext" else None
        fields = []
        for field in sorted(entity.get("fields", []), key=lambda item: item["key"]):
            target = bindings.get(field["key"]) if bindings else field["key"]
            if not target:
                raise ValueError("ERPNext field mapping is not allowlisted for this entity.")
            fields.append({**field, "targetField": target, "frappeFieldType": FIELD_TYPES[field["type"]]})
        units.append(_unit({"kind": "doctype", "key": entity["key"], "source": source, "mode": "custom_doctype" if entity["kind"] == "custom" else "existing_binding", "fields": fields}))
    for status in sorted(spec.get("statuses", []), key=lambda item: item["entity"]):
        units.append(_unit({"kind": "status", "key": f"{status['entity']}_statuses", **status}))
    for role in sorted(spec.get("roles", []), key=lambda item: item["key"]):
        permissions = []
        for permission in sorted(role.get("permissions", []), key=lambda item: item["entity"]):
            actions = sorted({"write" if action == "update" else action for action in permission["actions"] if action in {"create", "read", "update"}})
            permissions.append({"entity": permission["entity"], "actions": actions})
        units.append(_unit({"kind": "role", "key": role["key"], "label": role["label"], "permissions": permissions}))
    for workflow in sorted(spec.get("workflows", []), key=lambda item: item["key"]):
        units.append(_unit({"kind": "workflow", **workflow}))
    for view in sorted(spec.get("views", []), key=lambda item: item["key"]):
        units.append(_unit({"kind": "view", "key": view["key"], "definition": {**view, "materialization": "desk_ready" if view["kind"] in {"list", "form"} else "registry_only"}}))
    for report in sorted(spec.get("reports", []), key=lambda item: item["key"]):
        units.append(_unit({"kind": "report", "key": report["key"], "definition": report}))
    for kpi in sorted(spec.get("kpis", []), key=lambda item: item["key"]):
        units.append(_unit({"kind": "kpi", "key": kpi["key"], "definition": kpi}))
    units.append(_unit({"kind": "workspace", "key": "tenant_workspace", "definition": {"viewKeys": sorted(item["key"] for item in spec.get("views", [])), "reportKeys": sorted(item["key"] for item in spec.get("reports", [])), "kpiKeys": sorted(item["key"] for item in spec.get("kpis", [])), "roleKeys": sorted(item["key"] for item in spec.get("roles", []))}}))
    for notification in sorted(spec.get("notificationIntents", []), key=lambda item: item["key"]):
        units.append(_unit({"kind": "notification_intent", "key": notification["key"], "definition": {**notification, "effectiveEnabled": False}}))
    for integration in sorted(spec.get("integrationIntents", []), key=lambda item: item["key"]):
        units.append(_unit({"kind": "integration_intent", "key": integration["key"], "definition": {**integration, "effectiveEnabled": False}}))
    order = {"module": 1, "doctype": 2, "status": 3, "role": 4, "workflow": 5, "view": 6, "report": 7, "kpi": 8, "workspace": 9, "notification_intent": 10, "integration_intent": 11}
    units.sort(key=lambda item: (order[item["kind"]], item["key"]))
    manifest_draft = {"schemaVersion": "system-materialization-manifest-v1", "units": units}
    return {**manifest_draft, "fingerprint": sha256(canonical_json(manifest_draft))}
