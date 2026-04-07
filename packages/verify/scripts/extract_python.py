#!/usr/bin/env python3
"""Emit ExtractionResult JSON for Python files (stdlib ast only). Args: absolute file paths."""
from __future__ import annotations

import ast
import json
import sys
from typing import Any


def extract_file(path: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as f:
        src = f.read()
    tree = ast.parse(src, filename=path)
    imports: list[str] = []
    sig_lines: list[str] = []

    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            imports.append(ast.unparse(node))
        elif isinstance(node, ast.ClassDef) and not node.name.startswith("_"):
            methods: list[str] = []
            for m in node.body:
                if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef)) and not m.name.startswith(
                    "_"
                ):
                    methods.append(ast.unparse(m).split(":")[0] + ": ...")
            inner = "\n".join(f"    {x}" for x in methods) or "    ..."
            sig_lines.append(f"class {node.name}:\n{inner}")
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not node.name.startswith("_"):
            sig_lines.append(ast.unparse(node).split(":")[0] + ": ...")

    return {
        "filePath": path,
        "signatures": "\n\n".join(sig_lines),
        "types": "",
        "imports": "\n".join(imports),
    }


def main() -> None:
    paths = [p for p in sys.argv[1:] if p]
    sigs = [extract_file(p) for p in paths]
    print(json.dumps({"signatures": sigs, "types": []}))


if __name__ == "__main__":
    main()
