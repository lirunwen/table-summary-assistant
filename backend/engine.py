"""汇总引擎：表解析、关联 / 纵向合并、字段映射与统计。"""
from __future__ import annotations

import time
from typing import Any

from . import db
from .readers import read_table_data
from .templates import template_by_id
from .utils import (
    UserError,
    ambiguous_date,
    coerce_number,
    display_value,
    norm_key,
    parse_date_value,
    stringify,
)

TRANSFORMS = {
    "direct": "保持原值",
    "trim": "去除首尾空格",
    "text": "转为文本",
    "number": "转为数值",
    "date": "统一为日期",
    "upper": "转为大写",
    "lower": "转为小写",
}


class Registry:
    def __init__(self):
        self.sources = {r["id"]: r for r in db.source_rows()}
        self.tables: dict[str, tuple[dict, dict]] = {}
        for source in self.sources.values():
            for table in (source.get("meta") or {}).get("tables") or []:
                if table.get("id"):
                    self.tables[table["id"]] = (source, table)
        self._data: dict[str, tuple[list[str], list[list[Any]], bool]] = {}

    def has(self, table_id: str | None) -> bool:
        return bool(table_id and table_id in self.tables)

    def get(self, table_id: str | None) -> tuple[dict, dict] | None:
        if not table_id:
            return None
        return self.tables.get(table_id)

    def headers(self, table_id: str) -> list[str]:
        item = self.get(table_id)
        if not item:
            return []
        return list(item[1].get("headers") or [])

    def label(self, table_id: str | None) -> str:
        item = self.get(table_id)
        if not item:
            return "（已失效的数据表）"
        source, table = item
        if source.get("kind") == "email" and table.get("kind") == "mail_table":
            subject = (source.get("meta") or {}).get("email", {}).get("subject") or source["name"]
            return f"{subject} · {table.get('label')}"
        if table.get("label") and table.get("label") != source.get("name"):
            return f"{source['name']} · {table['label']}"
        return source.get("name") or table.get("label") or table_id

    def data(self, table_id: str):
        if table_id in self._data:
            return self._data[table_id]
        item = self.get(table_id)
        if not item:
            raise UserError("引用的数据表已被删除，请重新选择数据来源。")
        source, table = item
        try:
            headers, rows, truncated = read_table_data(source, table)
        except UserError:
            raise
        except Exception as exc:
            raise UserError(f"读取「{source['name']}」失败：{exc}") from exc
        if not headers:
            raise UserError(f"「{source['name']}」没有可用的表头。")
        self._data[table_id] = (headers, rows, truncated)
        return self._data[table_id]


def _included_columns(config: dict) -> list[dict]:
    target = config.get("target") or {}
    cols = []
    for c in target.get("columns") or []:
        if not isinstance(c, dict):
            continue
        if not c.get("included", True):
            continue
        name = str(c.get("name") or "").strip()
        if not name:
            continue
        cols.append(c)
    return cols


def _as_index(value: Any) -> int | None:
    try:
        i = int(value)
        return i if i >= 0 else None
    except (TypeError, ValueError):
        return None


def validate_config(config: dict, registry: Registry | None = None) -> dict:
    registry = registry or Registry()
    errors: list[str] = []
    warnings: list[str] = []
    mode = config.get("mode") or "join"
    if mode not in ("join", "append"):
        errors.append("汇总方式无效。")

    target = config.get("target") or {}
    cols = _included_columns(config)
    if not cols:
        errors.append("至少需要勾选一个目标列。")
    names = [str(c.get("name") or "").strip() for c in cols]
    if len(names) != len(set(names)):
        errors.append("目标列名称有重复，请改成不同的列名。")
    if target.get("kind") == "template":
        template = template_by_id(target.get("template_id") or "")
        if not template:
            errors.append("目标模板已被删除，请重新选择模板。")
        elif target.get("sheet") not in {s["name"] for s in (template.get("meta") or {}).get("sheets", [])}:
            errors.append("目标模板中找不到所选工作表。")

    primary = config.get("primary_table")
    lookups = config.get("lookups") or []
    active_tables: list[str] = []

    if mode == "join":
        if not registry.has(primary):
            errors.append("请选择主表（行数据的基准表）。")
        else:
            active_tables.append(primary)
            keys = config.get("primary_keys") or []
            if not keys:
                errors.append("请至少选择一个主键字段，用于关联其他表格。")
            pheaders = registry.headers(primary)
            for k in keys:
                i = _as_index(k)
                if i is None or i >= len(pheaders):
                    errors.append("主键字段无效，请重新选择。")
                    break
        seen = set()
        for lk in lookups:
            tid = lk.get("table_id")
            if not registry.has(tid):
                errors.append("有关联表已被删除，请重新选择。")
                continue
            if tid in seen or tid == primary:
                errors.append(f"关联表「{registry.label(tid)}」重复。")
                continue
            seen.add(tid)
            active_tables.append(tid)
            keys = config.get("primary_keys") or []
            lk_keys = lk.get("keys") or []
            if len(lk_keys) != len(keys):
                errors.append(f"关联表「{registry.label(tid)}」的关联字段数量与主键不一致。")
            else:
                lheaders = registry.headers(tid)
                for k in lk_keys:
                    i = _as_index(k)
                    if i is None or i >= len(lheaders):
                        errors.append(f"关联表「{registry.label(tid)}」的关联字段无效。")
                        break
    else:
        append_tables = config.get("append_tables") or []
        if not append_tables:
            errors.append("请至少选择一张要合并的数据表。")
        for tid in append_tables:
            if not registry.has(tid):
                errors.append("有数据表已被删除，请重新选择。")
            elif tid in active_tables:
                errors.append(f"数据表「{registry.label(tid)}」重复。")
            else:
                active_tables.append(tid)

    mappings = config.get("mappings") or {}
    unmapped = 0
    for col in cols:
        mapping = mappings.get(col.get("key")) or {}
        m_mode = mapping.get("mode") or "blank"
        if m_mode == "table":
            tid = mapping.get("table_id")
            if not registry.has(tid):
                errors.append(f"列「{col['name']}」的来源表已失效。")
                continue
            idx = _as_index(mapping.get("column_index"))
            headers = registry.headers(tid)
            if idx is None or idx >= len(headers):
                errors.append(f"列「{col['name']}」的来源字段无效。")
            if tid not in active_tables:
                warnings.append(f"列「{col['name']}」的来源表未参与本次汇总，将输出缺省值。")
        elif m_mode == "const":
            pass
        else:
            unmapped += 1
    if unmapped:
        warnings.append(f"有 {unmapped} 个目标列尚未配置来源，将以空值或固定值输出。")

    dkeys = [c.get("key") for c in cols]
    if len(dkeys) != len(set(dkeys)):
        errors.append("目标列存在重复的内部标识，请重新导入目标列。")

    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "active_tables": active_tables,
        "column_count": len(cols),
        "unmapped": unmapped,
    }


def _apply_transform(value: Any, transform: str | None, ctx: dict | None = None) -> Any:
    if value is None:
        return None
    transform = transform or "direct"
    if transform == "trim":
        return str(value).strip() if not isinstance(value, (int, float, bool)) else value
    if transform == "text":
        return stringify(value).strip()
    if transform == "number":
        return coerce_number(value)
    if transform == "date":
        ok, parsed = parse_date_value(value)
        if ok:
            return display_value(parsed)
        if ctx is not None and ambiguous_date(value):
            ctx["ambiguous_dates"] = ctx.get("ambiguous_dates", 0) + 1
        return value
    if transform == "upper":
        return str(value).upper()
    if transform == "lower":
        return str(value).lower()
    return value


def _mapping_value(mapping: dict, row: list[Any] | None, fallback: Any = None,
                   ctx: dict | None = None):
    if mapping.get("mode") == "const":
        value = mapping.get("value")
    elif mapping.get("mode") == "table" and row is not None:
        idx = _as_index(mapping.get("column_index"))
        value = row[idx] if idx is not None and idx < len(row) else None
    else:
        value = None
    value = _apply_transform(value, mapping.get("transform"), ctx)
    if value is None or (isinstance(value, str) and value.strip() == ""):
        fb = mapping.get("fallback", fallback)
        if fb is None:
            return ""
        return fb
    return value


def _join_key(row: list[Any], indices: list[int]) -> tuple[str, ...]:
    return tuple(norm_key(row[i] if i < len(row) else None) for i in indices)


def build(config: dict, preview_limit: int | None = None, include_rows: bool = True) -> dict:
    started = time.perf_counter()
    registry = Registry()
    check = validate_config(config, registry)
    if not check["ok"]:
        raise UserError("；".join(check["errors"][:5]))
    mode = config.get("mode") or "join"
    cols = _included_columns(config)
    mappings = config.get("mappings") or {}
    options = config.get("options") or {}
    trim_text = bool(db.get_settings().get("trim_text", True))
    warnings: list[str] = list(check["warnings"])
    unmapped_count = check.get("unmapped", 0)

    active: list[str] = []
    primary_data = None
    lookup_data = []
    totals = {"input": 0, "matched": 0, "missing": 0, "duplicates": 0, "skipped": 0}
    lookup_stats = []

    if mode == "join":
        primary = config.get("primary_table")
        active.append(primary)
        pheaders, prows, ptrunc = registry.data(primary)
        if ptrunc:
            warnings.append(f"主表「{registry.label(primary)}」超过行数上限，只读取了前 20 万行。")
        pkeys = [int(k) for k in (config.get("primary_keys") or [])]
        for k in pkeys:
            if k >= len(pheaders):
                raise UserError("主键字段超出了主表列范围。")
        primary_data = {"table_id": primary, "headers": pheaders, "rows": prows}

        seen = set()
        dedupe = bool(options.get("dedupe", True))
        skip_empty = bool(options.get("skip_empty_key", False))
        deduped_rows = []
        for row in prows:
            key = _join_key(row, pkeys)
            if skip_empty and not all(key):
                totals["skipped"] += 1
                continue
            if dedupe and all(key):
                if key in seen:
                    totals["duplicates"] += 1
                    continue
                seen.add(key)
            deduped_rows.append(row)
        if dedupe and totals["duplicates"]:
            warnings.append(f"主表中有 {totals['duplicates']} 行主键重复，已保留首次出现的行。")
        if totals["skipped"]:
            warnings.append(f"主表中有 {totals['skipped']} 行主键为空，已按设置跳过。")
        primary_data["rows"] = deduped_rows

        for i, lk in enumerate(config.get("lookups") or []):
            tid = lk["table_id"]
            lkeys = [int(k) for k in lk.get("keys") or []]
            headers, rows, truncated = registry.data(tid)
            if truncated:
                warnings.append(f"关联表「{registry.label(tid)}」超过行数上限，只读取了前 20 万行。")
            active.append(tid)
            index: dict[tuple, list[Any]] = {}
            dup = 0
            for row in rows:
                key = _join_key(row, lkeys)
                if all(key):
                    if key in index:
                        dup += 1
                        continue
                    index[key] = row
            matched = 0
            missing = 0
            for row in deduped_rows:
                key = _join_key(row, pkeys)
                if all(key) and key in index:
                    matched += 1
                else:
                    missing += 1
            totals["matched"] += matched
            totals["missing"] += missing
            if dup:
                warnings.append(f"关联表「{registry.label(tid)}」有 {dup} 个重复键，已取第一条。")
            lookup_stats.append({
                "table_id": tid,
                "label": registry.label(tid),
                "rows": len(rows),
                "matched": matched,
                "missing": missing,
                "duplicates": dup,
            })
            lookup_data.append({"table_id": tid, "headers": headers, "index": index})
    else:
        append_tables = config.get("append_tables") or []
        for tid in append_tables:
            headers, rows, truncated = registry.data(tid)
            if truncated:
                warnings.append(f"数据表「{registry.label(tid)}」超过行数上限，只读取了前 20 万行。")
            active.append(tid)
            lookup_stats.append({
                "table_id": tid,
                "label": registry.label(tid),
                "rows": len(rows),
                "matched": 0,
                "missing": 0,
                "duplicates": 0,
            })
            lookup_data.append({"table_id": tid, "headers": headers, "rows": rows,
                                "index": None})

    output_rows: list[list[Any]] = []
    filled = 0
    empty = 0
    ctx: dict = {"ambiguous_dates": 0}

    def resolve_for_join(mapping, primary_row, lookup_rows):
        tid = mapping.get("table_id")
        if mapping.get("mode") == "const":
            return _mapping_value(mapping, None, ctx=ctx)
        if mapping.get("mode") != "table":
            return ""
        if tid == primary_data["table_id"]:
            return _mapping_value(mapping, primary_row, ctx=ctx)
        row = lookup_rows.get(tid)
        if row is None:
            # 主键为空或未匹配时使用缺省值
            return _mapping_value({**mapping, "mode": "const", "value": None}, None, ctx=ctx)
        return _mapping_value(mapping, row, ctx=ctx)

    if mode == "join":
        # 每行动态计算 lookup 行，避免构建巨大笛卡尔结构
        pkeys = [int(k) for k in (config.get("primary_keys") or [])]
        for row in primary_data["rows"]:
            key = _join_key(row, pkeys)
            matched_rows = {}
            if all(key):
                for ld in lookup_data:
                    matched_rows[ld["table_id"]] = ld["index"].get(key)
            out = []
            for col in cols:
                mapping = mappings.get(col.get("key")) or {"mode": "blank"}
                value = resolve_for_join(mapping, row, matched_rows)
                if trim_text and isinstance(value, str):
                    value = value.strip()
                out.append(value)
                if value is None or (isinstance(value, str) and value == ""):
                    empty += 1
                else:
                    filled += 1
            output_rows.append(out)
        totals["input"] = len(primary_data["rows"])
    else:
        auto_by_name = bool(config.get("auto_by_name", True))
        for ld in lookup_data:
            headers = ld["headers"]
            for row in ld["rows"]:
                out = []
                for col in cols:
                    mapping = mappings.get(col.get("key")) or {"mode": "blank"}
                    value = None
                    if mapping.get("mode") == "const":
                        value = _mapping_value(mapping, None, ctx=ctx)
                    elif mapping.get("mode") == "table":
                        if mapping.get("table_id") == ld["table_id"]:
                            value = _mapping_value(mapping, row, ctx=ctx)
                        elif auto_by_name:
                            # 纵向合并时，其他表按同名列自动填充
                            try:
                                idx = headers.index(col.get("name"))
                            except ValueError:
                                idx = -1
                            if idx >= 0:
                                value = _apply_transform(row[idx], mapping.get("transform"), ctx)
                            else:
                                value = _mapping_value(
                                    {**mapping, "mode": "const", "value": None}, None, ctx=ctx)
                        else:
                            value = _mapping_value(
                                {**mapping, "mode": "const", "value": None}, None, ctx=ctx)
                    if value is None:
                        value = ""
                    if trim_text and isinstance(value, str):
                        value = value.strip()
                    out.append(value)
                    if value == "":
                        empty += 1
                    else:
                        filled += 1
                output_rows.append(out)
            totals["input"] += len(ld["rows"])

    if ctx["ambiguous_dates"]:
        warnings.append(
            f"{ctx['ambiguous_dates']} 个日期形如 03/04/2026，无法判断日/月顺序，已按原文保留。"
            "如需统一，请先在源表中改成 2026-03-04 这种格式。"
        )

    headers = [str(c["name"]).strip() for c in cols]
    if preview_limit is not None and preview_limit > 0:
        preview_rows = output_rows[:preview_limit]
    else:
        preview_rows = output_rows
    duration = int((time.perf_counter() - started) * 1000)
    return {
        "headers": headers,
        "rows": output_rows if include_rows else [],
        "preview_rows": preview_rows,
        "stats": {
            "rows": len(output_rows),
            "columns": len(headers),
            "input_rows": totals["input"],
            "matched": totals["matched"],
            "missing": totals["missing"],
            "duplicates": totals["duplicates"],
            "filled_cells": filled,
            "empty_cells": empty,
            "unmapped_columns": unmapped_count,
            "duration_ms": duration,
        },
        "lookups": lookup_stats,
        "warnings": warnings,
        "sources": [
            {"table_id": tid, "label": registry.label(tid), "rows": len(registry.data(tid)[1])}
            for tid in active
        ],
        "mode": mode,
        "active_tables": active,
    }
