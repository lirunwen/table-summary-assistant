"""目标 Excel 模板的文件层：上传登记、表头解析、字段派生。

这一层只关心「文件」：把上传的 .xlsx 存到 data/templates/<id>/ 下，
读出每个工作表的表头，并按表头派生出一份可编辑的字段定义（meta.fields）。

字段定义之上的增删改、版本、校验、导入导出，都在 backend/tmplib.py。
拆开是为了避免循环依赖：tmplib 需要这里的解析结果，engine 只需要 template_by_id。
"""
from __future__ import annotations

import shutil
from pathlib import Path

from . import db
from .config import TEMPLATE_DIR
from .readers import analyze_grid, read_excel_grids
from .utils import UserError, now_iso, safe_filename, uid

# 模板列上限：Excel 本身是 16384 列，但人工维护的表头超过 200 列基本是误传。
MAX_TEMPLATE_FIELDS = 200
MAX_FIELD_NAME = 60


def fields_from_sheet(sheet: dict, existing: list[dict] | None = None) -> list[dict]:
    """按工作表表头派生字段定义。

    已有的同名字段保留其类型、必填、规则等设置——调整表头行时不该把用户
    填了半天的校验规则清掉。
    """
    old_by_name = {f.get("name"): f for f in (existing or []) if isinstance(f, dict)}
    fields: list[dict] = []
    for index, raw_name in enumerate(sheet.get("headers") or []):
        name = str(raw_name or "").strip()
        if not name:
            continue
        old = old_by_name.get(name) or {}
        fields.append({
            "key": old.get("key") or uid("f_"),
            "name": name[:MAX_FIELD_NAME],
            "type": old.get("type") or "auto",
            "required": bool(old.get("required")),
            "default": old.get("default") or "",
            "width": old.get("width") or 14,
            "date_format": old.get("date_format") or "",
            "note": old.get("note") or "",
            "sample": old.get("sample") or "",
            "rules": old.get("rules") or [],
            "template_col": index,
        })
    return fields


def ingest_template(file_storage, extra: dict | None = None) -> dict:
    """保存上传的模板文件，解析所有工作表，并派生第一张表的字段定义。"""
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
        first = sheets[0]
        meta = {
            "sheets": sheets,
            "fields": fields_from_sheet(first),
            "sheet": first["name"],
            "header_row": first["header_row"],
            "warnings": [],
        }
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise

    extra = dict(extra or {})
    ts = now_iso()
    display_name = str(extra.get("name") or "").strip() or Path(filename).stem
    tags = extra.get("tags") or []
    db.execute(
        "INSERT INTO templates(id, name, path, size, created_at, updated_at, description, "
        "category, tags, status, origin, version, meta) "
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'upload', 1, ?)",
        (
            template_id,
            display_name[:80],
            str(target),
            target.stat().st_size,
            ts,
            ts,
            str(extra.get("description") or "")[:300],
            str(extra.get("category") or "")[:40],
            db.dumps(tags),
            str(extra.get("status") or "active"),
            db.dumps(meta),
        ),
    )
    return template_by_id(template_id) or {}


def template_by_id(template_id: str) -> dict | None:
    row = db.query_one("SELECT * FROM templates WHERE id=?", (template_id,))
    if row:
        row["meta"] = db.loads(row.get("meta"), {}) or {}
        row["tags"] = db.loads(row.get("tags"), []) or []
    return row


def delete_template_dir(row: dict) -> None:
    """删掉模板文件目录（只动 data/templates/<id>/，不碰别的）。"""
    try:
        path = Path(row.get("path") or "")
        if path and path.exists():
            directory = path.parent
            if directory.parent.name == "templates":
                shutil.rmtree(directory, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)
    except Exception:
        pass


def inspect_sheet(template_id: str, sheet_name: str, header_row: int | None = None,
                  existing_fields: list[dict] | None = None) -> dict:
    row = template_by_id(template_id)
    if not row:
        raise UserError("模板不存在或已删除。")
    grids = read_excel_grids(Path(row["path"]), only_sheets={sheet_name})
    target = next((g for g in grids if g["name"] == sheet_name), None)
    if not target:
        raise UserError("模板中找不到该工作表。")
    info = analyze_grid(target["grid"], header_row)
    sheet = {"name": sheet_name, **info}
    sheet["fields"] = fields_from_sheet(sheet, existing_fields)
    return sheet
