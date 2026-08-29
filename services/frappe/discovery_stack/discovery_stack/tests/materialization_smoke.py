"""Disposable-site assertions against actual Frappe metadata records."""

import copy

import frappe

from discovery_stack import tenant_operations
from discovery_stack.compiler import compile_spec
from discovery_stack.executor import _canonical, _fingerprint, _kpi_runtime_names, _target_name, apply_compiled_plan, health_snapshot, validate_compiled_plan


def _field(key, label, logical_type, *, options=None, link=None, required=False):
    return {"key": key, "label": label, "type": logical_type, "required": required, "unique": False, "sensitive": False, "readOnly": False, "options": options or [], "linkEntity": link}


def _spec(template, tenant_id, entities, roles, statuses, workflows, views, reports):
    draft = {"systemTemplate": template, "entities": entities, "roles": roles, "statuses": statuses, "workflows": workflows, "views": views, "reports": reports, "kpis": [{"key": f"{reports[0]['key']}_kpi", "label": reports[0]["label"], "reportKey": reports[0]["key"], "denominatorReportKey": None, "source": "operational", "limitations": ["Operational count only."]}], "notificationIntents": [{"key": "owner_notice", "event": "record_updated", "channel": "in_app", "recipientRole": roles[0]["key"]}], "integrationIntents": [{"key": "content_projection", "type": "publication_projection", "enabled": False, "credentialReference": None, "writeEnabled": False}]}
    draft["fingerprint"] = _fingerprint(draft)
    return draft


def _plan(spec, tenant_id, spec_id):
    manifest = compile_spec(spec)
    draft = {"schemaVersion": "compiled-system-plan-v2", "compilerVersion": "system-spec-compiler-v2", "specId": spec_id, "specVersion": 1, "specFingerprint": spec["fingerprint"], "parentFingerprint": None, "tenantBinding": {"ownerId": "owner:smoke", "clientId": "client:smoke", "websiteId": f"website:{tenant_id}", "managedSiteId": None, "systemTenantId": tenant_id, "locale": "en", "timezone": "UTC", "currency": "USD"}, "materializationManifest": manifest, "canonicalSpecJson": _canonical(spec)}
    return {**draft, "planFingerprint": _fingerprint(draft)}


def _rehash(plan):
    for unit in plan["materializationManifest"]["units"]:
        definition = {key: value for key, value in unit.items() if key != "definitionFingerprint"}
        unit["definitionFingerprint"] = _fingerprint(definition)
    manifest_draft = {"schemaVersion": plan["materializationManifest"]["schemaVersion"], "units": plan["materializationManifest"]["units"]}
    plan["materializationManifest"]["fingerprint"] = _fingerprint(manifest_draft)
    plan["planFingerprint"] = _fingerprint({key: value for key, value in plan.items() if key != "planFingerprint"})
    return plan


def _plans():
    crm_entities = [{"key": "lead", "label": "Lead", "kind": "erpnext", "erpNextDocType": "Lead", "fields": [_field("lead_name", "Lead name", "text", required=True), _field("email", "Email", "email"), _field("status", "Status", "select", options=["active", "cancelled", "draft"])]}, {"key": "opportunity", "label": "Opportunity", "kind": "erpnext", "erpNextDocType": "Opportunity", "fields": [_field("title", "Opportunity", "text"), _field("amount", "Expected amount", "currency"), _field("status", "Status", "select", options=["active", "cancelled", "draft"])]}]
    crm_roles = [{"key": "crm_manager", "label": "CRM Manager", "permissions": [{"entity": "lead", "actions": ["create", "read", "update"]}, {"entity": "opportunity", "actions": ["create", "read", "update"]}]}, {"key": "crm_viewer", "label": "CRM Viewer", "permissions": [{"entity": "lead", "actions": ["read"]}, {"entity": "opportunity", "actions": ["read"]}]}]
    crm_status = [{"entity": "lead", "values": ["active", "cancelled", "draft"], "initial": "draft", "terminal": ["cancelled"]}]
    crm_workflow = [{"key": "lead_lifecycle", "entity": "lead", "transitions": [{"from": "draft", "to": "active", "roles": ["crm_manager"]}, {"from": "active", "to": "cancelled", "roles": ["crm_manager"]}]}]
    crm_reports = [{"key": "lead_count", "label": "Lead count", "entity": "lead", "measure": "count", "field": None, "timeWindowDays": 30, "limitations": ["Operational count only."]}]
    crm = _plan(_spec("light_crm", "tenant:crm-smoke", crm_entities, crm_roles, crm_status, crm_workflow, [{"key": "lead_list", "entity": "lead", "fields": ["lead_name", "email", "status"], "kind": "list"}], crm_reports), "tenant:crm-smoke", "spec:crm-smoke")

    booking_entities = [{"key": "customer", "label": "Customer", "kind": "erpnext", "erpNextDocType": "Customer", "fields": [_field("customer_name", "Customer name", "text", required=True)]}, {"key": "appointment", "label": "Appointment", "kind": "custom", "erpNextDocType": None, "fields": [_field("starts_at", "Starts at", "datetime", required=True), _field("ends_at", "Ends at", "datetime"), _field("customer", "Customer", "link", link="customer"), _field("status", "Status", "select", options=["active", "cancelled", "draft"])]}]
    booking_roles = [{"key": "booking_manager", "label": "Booking Manager", "permissions": [{"entity": "customer", "actions": ["read"]}, {"entity": "appointment", "actions": ["create", "read", "update"]}]}, {"key": "booking_viewer", "label": "Booking Viewer", "permissions": [{"entity": "appointment", "actions": ["read"]}]}]
    booking_status = [{"entity": "appointment", "values": ["active", "cancelled", "draft"], "initial": "draft", "terminal": ["cancelled"]}]
    booking_workflow = [{"key": "appointment_lifecycle", "entity": "appointment", "transitions": [{"from": "draft", "to": "active", "roles": ["booking_manager"]}, {"from": "active", "to": "cancelled", "roles": ["booking_manager"]}]}]
    booking_reports = [{"key": "appointment_count", "label": "Appointment count", "entity": "appointment", "measure": "count", "field": None, "timeWindowDays": 30, "limitations": ["Operational count only."]}]
    booking = _plan(_spec("appointment_booking", "tenant:booking-smoke", booking_entities, booking_roles, booking_status, booking_workflow, [{"key": "appointment_calendar", "entity": "appointment", "fields": ["starts_at", "ends_at", "status"], "kind": "calendar"}], booking_reports), "tenant:booking-smoke", "spec:booking-smoke")

    custom_entities = [{"key": "asset", "label": "Asset", "kind": "custom", "erpNextDocType": None, "fields": [_field("title", "Title", "text", required=True), _field("quantity", "Quantity", "integer"), _field("active", "Active", "boolean"), _field("category", "Category", "select", options=["primary", "secondary"])]}, {"key": "asset_note", "label": "Asset Note", "kind": "custom", "erpNextDocType": None, "fields": [_field("asset", "Asset", "link", link="asset", required=True), _field("body", "Body", "long_text")]}]
    custom_roles = [{"key": "system_manager", "label": "System Manager", "permissions": [{"entity": "asset", "actions": ["create", "read", "update"]}, {"entity": "asset_note", "actions": ["create", "read", "update"]}]}]
    custom_status = [{"entity": "asset", "values": ["active", "draft"], "initial": "draft", "terminal": []}]
    custom_workflow = [{"key": "asset_lifecycle", "entity": "asset", "transitions": [{"from": "draft", "to": "active", "roles": ["system_manager"]}]}]
    custom_reports = [{"key": "asset_count", "label": "Asset count", "entity": "asset", "measure": "count", "field": None, "timeWindowDays": None, "limitations": ["Operational count only."]}]
    custom = _plan(_spec("custom_bounded", "tenant:custom-smoke", custom_entities, custom_roles, custom_status, custom_workflow, [{"key": "asset_kanban", "entity": "asset", "fields": ["title", "category", "active"], "kind": "kanban"}], custom_reports), "tenant:custom-smoke", "spec:custom-smoke")
    return crm, booking, custom


def _assert_materialized(plan, expected):
    tenant = plan["tenantBinding"]["systemTenantId"]
    first = apply_compiled_plan(plan); before = frappe.db.count("DiscoveryStack Materialized Unit", {"system_tenant_id": tenant, "plan_fingerprint": plan["planFingerprint"]}); second = apply_compiled_plan(plan); after = frappe.db.count("DiscoveryStack Materialized Unit", {"system_tenant_id": tenant, "plan_fingerprint": plan["planFingerprint"]})
    assert first["unitCount"] == before == after and second["replayed"] is True
    assert health_snapshot(tenant)["healthy"] is True
    units = plan["materializationManifest"]["units"]
    for entity, fields in expected["doctypes"].items():
        unit = next(item for item in units if item["kind"] == "doctype" and item["key"] == entity); target = unit["source"] if unit["mode"] == "existing_binding" else next(item["target"] for item in first["units"] if item["kind"] == "doctype" and item["key"] == entity); meta = frappe.get_meta(target, cached=False); assert all(meta.get_field(field) for field in fields)
    role = _target_name(tenant, "role", expected["role"]); assert frappe.db.exists("Role", role); assert frappe.db.count("Custom DocPerm", {"role": role}) >= 1
    workflow = _target_name(tenant, "workflow", expected["workflow"]); assert frappe.db.exists("Workflow", workflow); assert len(frappe.get_doc("Workflow", workflow).transitions) >= 1
    report = _target_name(tenant, "report", expected["report"]); assert frappe.db.exists("Report", report); assert frappe.get_doc("Report", report).report_type == "Report Builder"
    view = next(item for item in units if item["kind"] == "view"); view_name = frappe.db.get_value("DiscoveryStack View Definition", {"system_tenant_id": tenant, "view_key": view["key"], "view_kind": expected["view"]}, "name"); assert view_name; view_doc = frappe.get_doc("DiscoveryStack View Definition", view_name); assert view_doc.materialization_status == ("desk_ready" if expected["view"] in {"list", "form"} else "registry_only")
    kpi = next(item for item in units if item["kind"] == "kpi"); card, chart = _kpi_runtime_names(tenant, kpi["key"], plan); assert frappe.db.exists("Number Card", card); assert frappe.db.exists("Dashboard Chart", chart)
    workspace = next(item["target"] for item in first["units"] if item["kind"] == "workspace"); workspace_doc = frappe.get_doc("Workspace", workspace); assert not workspace_doc.public and not workspace_doc.is_hidden; assert role in [row.role for row in workspace_doc.roles]; assert report in [row.link_to for row in workspace_doc.shortcuts]; assert card in [row.number_card_name for row in workspace_doc.number_cards]; assert chart in [row.chart_name for row in workspace_doc.charts]
    if expected["view"] in {"calendar", "kanban"}: assert targets_absent(workspace_doc.shortcuts, next(item["target"] for item in first["units"] if item["kind"] == "doctype" and item["key"] == view["definition"]["entity"]))
    return first


def targets_absent(shortcuts, target):
    return target not in [row.link_to for row in shortcuts if row.type == "DocType"]


def _assert_custom_crud_and_isolation(booking, custom):
    booking_tenant = booking["tenantBinding"]["systemTenantId"]; custom_tenant = custom["tenantBinding"]["systemTenantId"]
    booking_target = _target_name(booking_tenant, "doctype", "appointment"); custom_target = _target_name(custom_tenant, "doctype", "asset")
    booking_role = _target_name(booking_tenant, "role", "booking_manager"); custom_role = _target_name(custom_tenant, "role", "system_manager")
    users = []
    for email, role in (("booking-runtime-user@example.invalid", booking_role), ("custom-runtime-user@example.invalid", custom_role)):
        if frappe.db.exists("User", email): frappe.delete_doc("User", email, ignore_permissions=True)
        frappe.get_doc({"doctype": "User", "email": email, "first_name": "Disposable Runtime", "enabled": 1, "send_welcome_email": 0, "roles": [{"role": role}]}).insert(ignore_permissions=True); users.append(email)
    try:
        assert frappe.has_permission(booking_target, "create", user=users[0]); assert frappe.has_permission(booking_target, "read", user=users[0]); assert frappe.has_permission(booking_target, "write", user=users[0])
        assert not frappe.has_permission(custom_target, "read", user=users[0]); assert not frappe.has_permission(booking_target, "read", user=users[1])
        frappe.set_user(users[0]); record = frappe.get_doc({"doctype": booking_target, "starts_at": frappe.utils.now_datetime(), "ends_at": frappe.utils.add_to_date(frappe.utils.now_datetime(), hours=1)}); record.insert(); record.ends_at = frappe.utils.add_to_date(record.starts_at, hours=2); record.save(); assert frappe.get_doc(booking_target, record.name).name == record.name
        frappe.set_user(users[1]); denied = False
        try: frappe.get_doc(booking_target, record.name).check_permission("read")
        except frappe.PermissionError: denied = True
        assert denied
        frappe.set_user("Administrator"); frappe.delete_doc(booking_target, record.name, ignore_permissions=True)
        workspace = _target_name(booking_tenant, "workspace", f"system_{booking['planFingerprint'][:8]}"); assert frappe.has_permission("Workspace", "read", doc=frappe.get_doc("Workspace", workspace), user=users[0])
    finally:
        frappe.set_user("Administrator")
        for email in users:
            if frappe.db.exists("User", email): frappe.delete_doc("User", email, ignore_permissions=True)
        frappe.db.commit()


def _expect_rejected(plan, fragment):
    try:
        validate_compiled_plan(_rehash(plan))
    except Exception as error:
        assert fragment.casefold() in str(error).casefold()
        return
    raise AssertionError("Adversarial manifest was accepted.")


def run():
    crm, booking, custom = _plans()
    crm_result = _assert_materialized(crm, {"doctypes": {"lead": ["lead_name", "email_id", "status"], "opportunity": ["title", "opportunity_amount", "status"]}, "role": "crm_manager", "workflow": "lead_lifecycle", "report": "lead_count", "view": "list"})
    booking_result = _assert_materialized(booking, {"doctypes": {"customer": ["customer_name"], "appointment": ["starts_at", "ends_at", "customer", "status"]}, "role": "booking_manager", "workflow": "appointment_lifecycle", "report": "appointment_count", "view": "calendar"})
    custom_result = _assert_materialized(custom, {"doctypes": {"asset": ["title", "quantity", "active", "category"], "asset_note": ["asset", "body"]}, "role": "system_manager", "workflow": "asset_lifecycle", "report": "asset_count", "view": "kanban"})
    _assert_custom_crud_and_isolation(booking, custom)

    upgraded = copy.deepcopy(booking); upgraded["specVersion"] = 2; upgraded["parentFingerprint"] = booking["specFingerprint"]; upgraded["specFingerprint"] = _fingerprint({"booking": "v2"}); upgraded["canonicalSpecJson"] = '{"booking":"v2"}'
    appointment = next(unit for unit in upgraded["materializationManifest"]["units"] if unit["kind"] == "doctype" and unit["key"] == "appointment"); appointment["fields"].append({"key": "notes", "label": "Notes", "type": "long_text", "required": False, "unique": False, "sensitive": False, "readOnly": False, "options": [], "linkEntity": None, "targetField": "notes", "frappeFieldType": "Long Text"})
    status = next(unit for unit in upgraded["materializationManifest"]["units"] if unit["kind"] == "status" and unit["key"] == "appointment_statuses"); status["values"].append("completed"); status["terminal"].append("completed")
    workflow = next(unit for unit in upgraded["materializationManifest"]["units"] if unit["kind"] == "workflow" and unit["key"] == "appointment_lifecycle"); workflow["transitions"].append({"from": "active", "to": "completed", "roles": ["booking_manager"]})
    manager = next(unit for unit in upgraded["materializationManifest"]["units"] if unit["kind"] == "role" and unit["key"] == "booking_manager"); next(permission for permission in manager["permissions"] if permission["entity"] == "appointment")["actions"].remove("create")
    _rehash(upgraded); upgraded_result = apply_compiled_plan(upgraded); appointment_target = next(item["target"] for item in upgraded_result["units"] if item["kind"] == "doctype" and item["key"] == "appointment"); assert frappe.get_meta(appointment_target, cached=False).get_field("notes"); assert len(frappe.get_doc("Workflow", _target_name("tenant:booking-smoke", "workflow", "appointment_lifecycle")).transitions) == 3; assert frappe.db.count("DiscoveryStack Compiled System Spec", {"system_tenant_id": "tenant:booking-smoke"}) == 2; assert health_snapshot("tenant:booking-smoke")["healthy"] is True
    manager_role = _target_name("tenant:booking-smoke", "role", "booking_manager"); assert not frappe.db.get_value("Custom DocPerm", {"role": manager_role, "parent": appointment_target}, "create")

    upgrade_escalation = copy.deepcopy(upgraded); upgrade_escalation["specVersion"] = 3; upgrade_escalation["parentFingerprint"] = upgraded["specFingerprint"]; upgrade_escalation["specFingerprint"] = _fingerprint({"booking": "v3-escalation"}); upgrade_escalation["canonicalSpecJson"] = '{"booking":"v3-escalation"}'; viewer = next(unit for unit in upgrade_escalation["materializationManifest"]["units"] if unit["kind"] == "role" and unit["key"] == "booking_viewer"); viewer["permissions"][0]["actions"].append("write"); _rehash(upgrade_escalation)
    try: apply_compiled_plan(upgrade_escalation)
    except Exception as error: assert "escalation" in str(error).casefold()
    else: raise AssertionError("Upgrade permission escalation was accepted.")
    destructive = copy.deepcopy(upgraded); destructive["specVersion"] = 3; destructive["parentFingerprint"] = upgraded["specFingerprint"]; destructive["specFingerprint"] = _fingerprint({"booking": "v3-removal"}); destructive["canonicalSpecJson"] = '{"booking":"v3-removal"}'; next(unit for unit in destructive["materializationManifest"]["units"] if unit["kind"] == "doctype" and unit["key"] == "appointment")["fields"].pop(); _rehash(destructive)
    try: apply_compiled_plan(destructive)
    except Exception as error: assert "destructive" in str(error).casefold()
    else: raise AssertionError("Destructive field removal was accepted.")
    orphan = copy.deepcopy(upgraded); orphan["specVersion"] = 3; orphan["parentFingerprint"] = upgraded["specFingerprint"]; orphan["specFingerprint"] = _fingerprint({"booking": "v3-orphan"}); orphan["canonicalSpecJson"] = '{"booking":"v3-orphan"}'; next(unit for unit in orphan["materializationManifest"]["units"] if unit["kind"] == "workflow" and unit["key"] == "appointment_lifecycle")["transitions"].pop(); _rehash(orphan)
    try: apply_compiled_plan(orphan)
    except Exception as error: assert "orphan" in str(error).casefold()
    else: raise AssertionError("Workflow transition orphan was accepted.")
    booking = upgraded

    unknown = copy.deepcopy(custom); next(unit for unit in unknown["materializationManifest"]["units"] if unit["kind"] == "doctype")["fields"][0]["type"] = "blob"; _expect_rejected(unknown, "field policy")
    reserved = copy.deepcopy(custom); target = next(unit for unit in reserved["materializationManifest"]["units"] if unit["kind"] == "doctype"); target["source"] = "User"; _expect_rejected(reserved, "reserved")
    cross_link = copy.deepcopy(custom); link = next(field for unit in cross_link["materializationManifest"]["units"] if unit["kind"] == "doctype" for field in unit["fields"] if field["frappeFieldType"] == "Link"); link["linkEntity"] = "missing_entity"; _expect_rejected(cross_link, "link")
    escalation = copy.deepcopy(custom); next(unit for unit in escalation["materializationManifest"]["units"] if unit["kind"] == "role")["permissions"][0]["actions"].append("delete"); _expect_rejected(escalation, "escalation")

    stale = copy.deepcopy(booking); stale["specFingerprint"] = "f" * 64; stale["canonicalSpecJson"] = "{\"changed\":true}"; _rehash(stale)
    try: apply_compiled_plan(stale)
    except Exception as error: assert "stale" in str(error).casefold()
    else: raise AssertionError("Stale plan was accepted.")

    resumable = copy.deepcopy(custom); resumable["tenantBinding"]["systemTenantId"] = "tenant:resume-smoke"; resumable["tenantBinding"]["websiteId"] = "website:resume-smoke"; resumable["specId"] = "spec:resume-smoke"; _rehash(resumable)
    frappe.flags.discovery_stack_materialization_crash_point = "after_ddl_before_ledger"
    try: apply_compiled_plan(resumable)
    except RuntimeError as error: assert "INJECTED" in str(error)
    else: raise AssertionError("Injected after-DDL interruption did not stop the run.")
    finally: frappe.flags.discovery_stack_materialization_crash_point = None
    assert health_snapshot("tenant:resume-smoke")["healthy"] is False; resumed = apply_compiled_plan(resumable); assert resumed["applied"] is True and health_snapshot("tenant:resume-smoke")["healthy"] is True

    activation_resume = copy.deepcopy(custom); activation_resume["tenantBinding"]["systemTenantId"] = "tenant:activation-resume"; activation_resume["tenantBinding"]["websiteId"] = "website:activation-resume"; activation_resume["specId"] = "spec:activation-resume"; _rehash(activation_resume)
    frappe.flags.discovery_stack_materialization_crash_point = "after_ledger_before_active"
    try: apply_compiled_plan(activation_resume)
    except RuntimeError as error: assert "INJECTED" in str(error)
    else: raise AssertionError("Injected pre-activation interruption did not stop the run.")
    finally: frappe.flags.discovery_stack_materialization_crash_point = None
    assert health_snapshot("tenant:activation-resume")["healthy"] is False; apply_compiled_plan(activation_resume); assert health_snapshot("tenant:activation-resume")["healthy"] is True

    permission_interrupt = copy.deepcopy(booking); permission_interrupt["specVersion"] = 3; permission_interrupt["parentFingerprint"] = booking["specFingerprint"]; permission_interrupt["specFingerprint"] = _fingerprint({"booking": "v3-permission-interrupt"}); permission_interrupt["canonicalSpecJson"] = '{"booking":"v3-permission-interrupt"}'; manager = next(unit for unit in permission_interrupt["materializationManifest"]["units"] if unit["kind"] == "role" and unit["key"] == "booking_manager"); next(item for item in manager["permissions"] if item["entity"] == "appointment")["actions"].remove("write"); _rehash(permission_interrupt); before_permissions = copy.deepcopy(frappe.get_all("Custom DocPerm", filters={"role": manager_role}, fields=["parent", "read", "write", "create", "delete"], order_by="parent asc"))
    frappe.flags.discovery_stack_materialization_crash_point = "permission_replacement"
    try: apply_compiled_plan(permission_interrupt)
    except RuntimeError as error: assert "INJECTED" in str(error)
    else: raise AssertionError("Injected permission replacement interruption did not stop the run.")
    finally: frappe.flags.discovery_stack_materialization_crash_point = None
    after_permissions = frappe.get_all("Custom DocPerm", filters={"role": manager_role}, fields=["parent", "read", "write", "create", "delete"], order_by="parent asc"); assert before_permissions == after_permissions; assert health_snapshot("tenant:booking-smoke")["healthy"] is True

    view_name = frappe.db.get_value("DiscoveryStack View Definition", {"system_tenant_id": "tenant:booking-smoke", "view_key": "appointment_calendar"}, "name"); view = frappe.get_doc("DiscoveryStack View Definition", view_name); original_fields = view.view_fields; view.view_fields = "[]"; view.save(ignore_permissions=True); frappe.db.commit(); assert health_snapshot("tenant:booking-smoke")["healthy"] is False; view.view_fields = original_fields; view.save(ignore_permissions=True); frappe.db.commit(); assert health_snapshot("tenant:booking-smoke")["healthy"] is True

    role_name = _target_name("tenant:booking-smoke", "role", "booking_viewer"); user = frappe.get_doc({"doctype": "User", "email": "materialization-smoke-user@example.invalid", "first_name": "Materialization Smoke", "enabled": 1, "send_welcome_email": 0, "roles": [{"role": role_name}]}); user.insert(ignore_permissions=True)
    tenant_operations.suspend_tenant({"ownerId": "owner:smoke", "clientId": "client:smoke", "systemTenantId": "tenant:booking-smoke", "compiledPlanFingerprint": booking["planFingerprint"], "specFingerprint": booking["specFingerprint"], "runtimeAuthorityFingerprint": "b" * 64, "idempotencyKey": "suspend-smoke-0001"}); assert not frappe.get_doc("User", user.name).enabled; assert health_snapshot("tenant:booking-smoke")["healthy"] is False

    partial = copy.deepcopy(custom); partial["tenantBinding"]["systemTenantId"] = "tenant:partial-smoke"; partial["tenantBinding"]["websiteId"] = "website:partial-smoke"; _rehash(partial); conflict_name = _target_name("tenant:partial-smoke", "report", "asset_count"); frappe.get_doc({"doctype": "Report", "report_name": conflict_name, "ref_doctype": "User", "report_type": "Report Builder", "is_standard": "No", "module": "Discovery Stack"}).insert(ignore_permissions=True); frappe.db.commit()
    try: apply_compiled_plan(partial)
    except Exception as error: assert "collision" in str(error).casefold()
    else: raise AssertionError("Preflight report collision was accepted.")
    assert not frappe.db.exists("DocType", _target_name("tenant:partial-smoke", "doctype", "asset")); assert not frappe.db.exists("DiscoveryStack Tenant Identity", "tenant:partial-smoke"); frappe.delete_doc("Report", conflict_name, ignore_permissions=True); frappe.db.commit()

    return {"ok": True, "templates": {"light_crm": crm_result["unitCount"], "appointment_booking": booking_result["unitCount"], "custom_bounded": custom_result["unitCount"]}, "actualRecords": {"DocType": frappe.db.count("DiscoveryStack Materialized Unit", {"unit_kind": "doctype"}), "Custom DocPerm": frappe.db.count("Custom DocPerm", {"role": ["like", "DS Role %"]}), "Workflow": frappe.db.count("Workflow", {"workflow_name": ["like", "DS Workflow %"]}), "Report": frappe.db.count("Report", {"report_name": ["like", "DS Report %"]}), "Workspace": frappe.db.count("Workspace", {"label": ["like", "DS Workspace %"]}), "Number Card": frappe.db.count("Number Card", {"label": ["like", "DS KPI %"]}), "Dashboard Chart": frappe.db.count("Dashboard Chart", {"chart_name": ["like", "DS Chart %"]}), "View": frappe.db.count("DiscoveryStack View Definition"), "Metric": frappe.db.count("DiscoveryStack Metric Definition"), "Materialization Run": frappe.db.count("DiscoveryStack Materialization Run"), "Materialization Journal": frappe.db.count("DiscoveryStack Materialization Journal"), "Intent": frappe.db.count("DiscoveryStack Disabled Intent")}}
