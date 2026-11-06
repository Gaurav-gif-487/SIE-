#!/usr/bin/env python3
"""
Fact extractor for the Python acquisition layer.

Uses only the standard-library `ast` module (no tree-sitter, no third-party
parser) to stay honest about what this actually does: a syntax-only,
name-based extraction, not type-aware resolution. Emits one JSON object on
stdout describing, per file: module name, imports, function/class/method
declarations, and call sites with their enclosing function (if any).

Deliberately conservative about what it claims:
  - No attempt to resolve `sys.path`, installed packages, or namespace
    packages. Import resolution (which import points at which in-repo
    module) is left entirely to the TypeScript caller.
  - Call callee names are syntactic (`Name` or `Attribute.attr`); no
    attempt to guess the receiver's type. Ambiguity is the caller's problem
    to represent, not this script's to hide.
  - A file that fails to parse is reported in `errors`, not silently
    skipped and not crashing the whole batch.

Usage: python3 extract.py <repo_root> <file1> [file2 ...]
Output: one JSON object on stdout: {"files": [...], "errors": [...]}
"""

import ast
import json
import os
import sys


def _qualify(stack, name):
    return ".".join([n for _, n in stack] + [name])


class _Visitor(ast.NodeVisitor):
    def __init__(self):
        self.stack = []  # list of (kind, name), kind in {"class", "function"}
        self.func_qname_stack = []  # qualified names of enclosing functions only
        self.imports = []
        self.functions = []
        self.classes = []
        self.calls = []

    def visit_Import(self, node):
        for alias in node.names:
            self.imports.append(
                {
                    "kind": "import",
                    "module": alias.name,
                    "name": None,
                    "asname": alias.asname,
                    "level": 0,
                    "line": node.lineno,
                    "col": node.col_offset,
                }
            )
        self.generic_visit(node)

    def visit_ImportFrom(self, node):
        for alias in node.names:
            self.imports.append(
                {
                    "kind": "from",
                    "module": node.module,
                    "name": alias.name,
                    "asname": alias.asname,
                    "level": node.level or 0,
                    "line": node.lineno,
                    "col": node.col_offset,
                }
            )
        self.generic_visit(node)

    def visit_ClassDef(self, node):
        qname = _qualify(self.stack, node.name)
        bases = []
        for b in node.bases:
            if isinstance(b, ast.Name):
                bases.append(b.id)
            elif isinstance(b, ast.Attribute):
                bases.append(b.attr)
        self.classes.append(
            {
                "name": node.name,
                "qualifiedName": qname,
                "line": node.lineno,
                "col": node.col_offset,
                "endLine": getattr(node, "end_lineno", node.lineno),
                "bases": bases,
                "enclosingClass": self.stack[-1][1] if self.stack and self.stack[-1][0] == "class" else None,
            }
        )
        self.stack.append(("class", node.name))
        self.generic_visit(node)
        self.stack.pop()

    def _function(self, node, is_async):
        qname = _qualify(self.stack, node.name)
        immediate_parent = self.stack[-1] if self.stack else None
        is_method = immediate_parent is not None and immediate_parent[0] == "class"
        decorators = []
        for d in node.decorator_list:
            if isinstance(d, ast.Name):
                decorators.append(d.id)
            elif isinstance(d, ast.Attribute):
                decorators.append(d.attr)
        self.functions.append(
            {
                "name": node.name,
                "qualifiedName": qname,
                "line": node.lineno,
                "col": node.col_offset,
                "endLine": getattr(node, "end_lineno", node.lineno),
                "isAsync": is_async,
                "isMethod": is_method,
                "enclosingClass": immediate_parent[1] if is_method else None,
                "params": [a.arg for a in node.args.args],
                "decorators": decorators,
            }
        )
        self.stack.append(("function", node.name))
        self.func_qname_stack.append(qname)
        self.generic_visit(node)
        self.func_qname_stack.pop()
        self.stack.pop()

    def visit_FunctionDef(self, node):
        self._function(node, is_async=False)

    def visit_AsyncFunctionDef(self, node):
        self._function(node, is_async=True)

    def visit_Call(self, node):
        callee = None
        is_attribute = False
        receiver = None
        if isinstance(node.func, ast.Name):
            callee = node.func.id
        elif isinstance(node.func, ast.Attribute):
            callee = node.func.attr
            is_attribute = True
            if isinstance(node.func.value, ast.Name):
                receiver = node.func.value.id
        # enclosing function/method, if any (innermost function on the stack)
        caller_qname = self.func_qname_stack[-1] if self.func_qname_stack else None
        self.calls.append(
            {
                "callee": callee,
                "isAttribute": is_attribute,
                "receiver": receiver,
                "caller": caller_qname,
                "line": node.lineno,
                "col": node.col_offset,
            }
        )
        self.generic_visit(node)


def _extract_one(path, root):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        src = f.read()
    tree = ast.parse(src, filename=path)
    rel = os.path.relpath(path, root)
    module = rel[:-3] if rel.endswith(".py") else rel
    module = module.replace(os.sep, ".")
    if module.endswith(".__init__"):
        module = module[: -len(".__init__")]
    v = _Visitor()
    v.visit(tree)
    return {
        "file": rel.replace(os.sep, "/"),
        "module": module,
        "lines": len(src.splitlines()),
        "imports": v.imports,
        "functions": v.functions,
        "classes": v.classes,
        "calls": v.calls,
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"files": [], "errors": [{"file": None, "error": "usage: extract.py <root> <file...>"}]}))
        return 1
    root = sys.argv[1]
    files = sys.argv[2:]
    out_files = []
    errors = []
    for path in files:
        try:
            out_files.append(_extract_one(path, root))
        except SyntaxError as e:
            errors.append({"file": os.path.relpath(path, root).replace(os.sep, "/"), "error": f"SyntaxError: {e}"})
        except (UnicodeDecodeError, OSError) as e:
            errors.append({"file": os.path.relpath(path, root).replace(os.sep, "/"), "error": str(e)})
    print(json.dumps({"files": out_files, "errors": errors}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
