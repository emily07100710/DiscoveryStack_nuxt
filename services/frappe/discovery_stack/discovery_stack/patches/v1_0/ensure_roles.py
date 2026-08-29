def execute():
    import frappe
    for role_name in ("DiscoveryStack System Manager", "DiscoveryStack System User", "DiscoveryStack System Viewer"):
        if not frappe.db.exists("Role", role_name):
            frappe.get_doc({"doctype": "Role", "role_name": role_name, "desk_access": 1}).insert(ignore_permissions=True)
