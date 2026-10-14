"""
Budget-Pal Backend — jeder schreibende Endpunkt muss committen

get_db() committet nicht automatisch (siehe app/core/database.py). Fehlt das
commit(), verwirft die Session die Aenderung beim Schliessen — der Endpunkt
antwortet 204, aber nichts ist passiert. So waren acht DELETE-Endpunkte
wirkungslos, darunter das Loeschen einzelner Transaktionen. Die API-Tests
merken das nicht, weil sie die Session mit dem Endpunkt teilen.

Diese Pruefung liest die Router: jeder POST/PUT/PATCH/DELETE mit DB-Session
muss commit() aufrufen (direkt oder ueber einen Helfer im selben Modul) oder
ausdruecklich als lesend eingetragen sein.
"""

import ast
from pathlib import Path

API_DIR = Path(__file__).resolve().parents[1] / "app" / "api"

# POST ohne Schreibzugriff — reine Berechnungen und Vorschauen
READ_ONLY = {
    "auth.py:login",
    "backup.py:export_backup_with_secrets",
    "imports.py:preview_import",
    "imports.py:preview_pdf_import",
    "projections.py:run_projection",
    "projections.py:income_plan",
    "projections.py:retirement_scenarios",
    "projections.py:compare_bvg",
}


def _routes_without_commit() -> list[str]:
    missing = []
    for path in sorted(API_DIR.glob("*.py")):
        tree = ast.parse(path.read_text())
        funcs = {
            n.name: n for n in ast.walk(tree)
            if isinstance(n, (ast.AsyncFunctionDef, ast.FunctionDef))
        }

        def commits(fn, seen=()):
            for node in ast.walk(fn):
                if isinstance(node, ast.Attribute) and node.attr == "commit":
                    return True
                if isinstance(node, ast.Call):
                    name = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
                    if name in funcs and name not in seen and funcs[name] is not fn:
                        if commits(funcs[name], seen + (name,)):
                            return True
            return False

        for fn in funcs.values():
            is_write = any(
                isinstance(d, ast.Call)
                and getattr(d.func, "attr", "") in ("post", "put", "patch", "delete")
                for d in fn.decorator_list
            )
            takes_db = "db" in [a.arg for a in fn.args.args + fn.args.kwonlyargs]
            key = f"{path.name}:{fn.name}"
            if is_write and takes_db and key not in READ_ONLY and not commits(fn):
                missing.append(key)
    return missing


def test_every_writing_route_commits():
    assert _routes_without_commit() == []
