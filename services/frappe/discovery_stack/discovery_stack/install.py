def after_install():
    """Install only deterministic app-owned metadata; never mutate ERPNext core."""
    return {"installed": True, "schema_version": "system-spec-v1"}


def before_uninstall():
    """Fail closed until an operator completes the reviewed retention/export plan."""
    raise RuntimeError("DiscoveryStack uninstall requires a reviewed retention and export intent.")
