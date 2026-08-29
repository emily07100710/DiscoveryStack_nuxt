from discovery_stack.compiler import canonical_json, compile_spec


def test_compiler_is_deterministic():
    field = {"key": "title", "label": "Title", "type": "text", "required": True, "unique": False, "sensitive": False, "readOnly": False, "options": [], "linkEntity": None}
    spec = {"fingerprint": "a" * 64, "systemTemplate": "custom_bounded", "entities": [{"key": "record", "label": "Record", "kind": "custom", "erpNextDocType": None, "fields": [field]}], "statuses": [], "roles": [{"key": "system_viewer", "label": "System Viewer", "permissions": [{"entity": "record", "actions": ["read"]}]}], "workflows": [], "views": [{"key": "record_list", "entity": "record", "fields": ["title"], "kind": "list"}], "reports": [{"key": "record_count", "label": "Record count", "entity": "record", "measure": "count", "field": None, "timeWindowDays": None, "limitations": []}], "kpis": [{"key": "record_kpi", "label": "Record KPI", "reportKey": "record_count", "denominatorReportKey": None, "source": "operational", "limitations": []}], "notificationIntents": [], "integrationIntents": []}
    first = compile_spec(spec)
    assert first == compile_spec(spec)
    assert first["fingerprint"]
    assert {unit["kind"] for unit in first["units"]} == {"doctype", "role", "view", "report", "kpi", "workspace"}
    view = next(unit for unit in first["units"] if unit["kind"] == "view")
    assert view["definition"]["materialization"] == "desk_ready"
    assert canonical_json({"b": 1, "a": 2}) == '{"a":2,"b":1}'
