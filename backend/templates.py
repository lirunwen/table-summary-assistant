"""目标 Excel 模板的登记与表头解析。"""
from __future__ import annotations

import shutil
from pathlib import Path

from . import db
from .config import TEMPLATE_DIR
from .readers import analyze_grid, read_excel_grids
from .utils import UserError, now_iso, safe_filename, uid


def ingest_template(file_storage) -> dict:
    filename = safe_filename(file_storage.filename or "模板.xlsx")
    suffix = Path(filename).suffix.lower()
    if suffix not in (".xlsx", ".xlsm", ".xltx", ".xltm"):
        raise UserError("目标模板请使用 .xlsx 或 .xlsm 文件。.xls 旧格式请先在 Excel 中另存为新格式。")
    template_id = uid("t_")
    directory = TEMPLATE_DIR / template_id
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / filename
    file_storage.save(target)
    if target.stat().st_size == 0:
        shutil.rmtree(directory, ignore_errors=True)
        raise UserError("模板文件是空的。")
    try:
        grids = read_excel_grids(target)
        sheets = []
        for sheet in grids:
            info = analyze_grid(sheet["grid"])
            if not info["headers"]:
                continue
            sheets.append({
                "name": sheet["name"],
                "header_row": info["header_row"],
                "headers": info["headers"],
                "row_count": info["row_count"],
                "col_count": info["col_count"],
                "hidden": sheet.get("hidden", False),
            })
        if not sheets:
            raise UserError("模板中没有找到可用的表头行。")
        meta = {"sheets": sheets, "warnings": []}
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    record = {
        "id": template_id,
        "name": filename,
        "path": str(target),
        "size": target.stat().st_size,
        "created_at": now_iso(),
        "meta": meta,
    }
    db.execute(
        "INSERT INTO templates(id, name, path, size, created_at, meta) VALUES(?, ?, ?, ?, ?, ?)",
        (template_id, filename, str(target), record["size"], record["created_at"],
         db.dumps(meta)),
    )
    return record


def template_by_id(template_id: str) -> dict | None:
    row = db.query_one("SELECT * FROM templates WHERE id=?", (template_id,))
    if row:
        row["meta"] = db.loads(row.get("meta"), {}) or {}
    return row


def delete_template(template_id: str) -> None:
    row = template_by_id(template_id)
    if not row:
        raise UserError("模板不存在或已删除。")
    directory = Path(row["path"]).parent
    shutil.rmtree(directory, ignore_errors=True)
    db.execute("DELETE FROM templates WHERE id=?", (template_id,))


def inspect_sheet(template_id: str, sheet_name: str, header_row: int | None = None) -> dict:
    row = template_by_id(template_id)
    if not row:
        raise UserError("模板不存在或已删除。")
    grids = read_excel_grids(Path(row["path"]))
    target = next((g for g in grids if g["name"] == sheet_name), None)
    if not target:
        raise UserError("模板中找不到该工作表。")
    info = analyze_grid(target["grid"], header_row)
    return {"name": sheet_name, **info}
