"""Statically enumerate non-relative imports in a pinned AutoGEO checkout.

This tool parses source with ``ast`` and never imports or executes upstream code.
It supports the research-only dependency audit documented in README.md.
"""

from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path


def collect_imports(root: Path) -> dict[str, list[str]]:
    """Return each top-level module and its source locations."""
    imports: dict[str, list[str]] = {}
    for path in sorted(root.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names = [node.module]
            else:
                continue
            for name in names:
                top_level = name.split(".", 1)[0]
                imports.setdefault(top_level, []).append(f"{path}:{node.lineno}")
    return {name: sorted(locations) for name, locations in sorted(imports.items())}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    source = args.upstream / "autogeo"
    if not source.is_dir():
        raise SystemExit(f"Missing AutoGEO source directory: {source}")
    payload = {"upstream": str(args.upstream.resolve()), "imports": collect_imports(source)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(payload, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
