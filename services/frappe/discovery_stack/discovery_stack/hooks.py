app_name = "discovery_stack"
app_title = "DiscoveryStack"
app_publisher = "DiscoveryStack"
app_description = "Governed tenant identity and compiled SystemSpec boundary"
app_email = "security@example.invalid"
app_license = "MIT"
required_apps = ["erpnext"]
fixtures = [{"dt": "Role", "filters": [["name", "in", ["DiscoveryStack System Manager", "DiscoveryStack System User", "DiscoveryStack System Viewer"]]]}]

after_install = "discovery_stack.install.after_install"
before_uninstall = "discovery_stack.install.before_uninstall"
