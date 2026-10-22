"""汇总引擎：表解析、关联 / 纵向合并、字段映射与统计。"""
from __future__ import annotations

import datetime as dt
import time
from typing import Any

from . import column_match, db, fieldmap
from .formula import Formula, FormulaError, FormulaSyntaxError, compile_formula
from .readers import read_table_data_cached
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
            headers, rows, truncated = read_table_data_cached(source, table)
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


def _formula_on(mapping: dict) -> bool:
    """该列是否启用了公式。formula_on 为真才算，空公式交由 validate 报错。"""
    return mapping.get("formula_on") is True


def _formula_value(formula: Formula, fields: dict, col_name: str,
                   ctx: dict, row_no: int) -> Any:
    """求值单个公式；失败时返回 Excel 错误值并记账，绝不静默丢数。"""
    try:
        value = formula.evaluate(fields)
    except FormulaError as exc:
        book = ctx.setdefault("formula_errors", {})
        info = book.setdefault(col_name, {"count": 0, "codes": {}, "first": "", "first_row": row_no})
        info["count"] += 1
        info["codes"][exc.code] = info["codes"].get(exc.code, 0) + 1
        if not info["first"]:
            info["first"] = f"第 {row_no} 行 {exc.message}"
        return exc.code
    except RecursionError:
        book = ctx.setdefault("formula_errors", {})
        info = book.setdefault(col_name, {"count": 0, "codes": {}, "first": "", "first_row": row_no})
        info["count"] += 1
        info["codes"]["#NUM!"] = info["codes"].get("#NUM!", 0) + 1
        if not info["first"]:
            info["first"] = f"第 {row_no} 行 公式嵌套过深"
        return "#NUM!"
    # 日期结果转 ISO 文本：预览接口要 JSON 序列化；写入时列类型为日期
    # 会被 writer 重新解析成日期对象并套用格式，不影响 Excel 里的日期语义。
    if isinstance(value, (dt.date, dt.datetime)):
        return display_value(value)
    return value


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
    # 公式能引用的字段 = 所有参与表表头的并集。重名字段按「先出现者优先」
    # 解析（主表 → 关联表/合并表按选择顺序），与求值时的 fields 构造保持一致。
    field_owner: dict[str, list[str]] = {}
    for tid in active_tables:
        for header in registry.headers(tid):
            name = str(header).strip()
            if name:
                field_owner.setdefault(name, []).append(tid)

    unmapped = 0
    required_missing: list[str] = []
    for col in cols:
        mapping = mappings.get(col.get("key")) or {}
        col_name = col.get("name") or col.get("key")
        if _formula_on(mapping):
            text = str(mapping.get("formula") or "")
            if not text.strip():
                errors.append(f"列「{col_name}」启用了公式但内容为空，请填写公式或关闭公式。")
            else:
                try:
                    compiled = compile_formula(text)
                except FormulaSyntaxError as exc:
                    errors.append(
                        f"列「{col_name}」公式语法错误：{exc.message}（第 {exc.pos} 个字符附近）"
                    )
                else:
                    missing = [r for r in compiled.refs if r not in field_owner]
                    if missing:
                        sample = "、".join(f"[{m}]" for m in missing[:3])
                        usable = "、".join(list(field_owner)[:8]) or "（暂无可用字段）"
                        errors.append(
                            f"列「{col_name}」公式引用了不存在的字段 {sample}。"
                            f"可引用：{usable}"
                        )
                    elif mode == "append":
                        partial = [r for r in compiled.refs
                                   if len(field_owner[r]) < len(active_tables)]
                        if partial:
                            warnings.append(
                                f"列「{col_name}」公式引用的「{'、'.join(partial[:3])}」"
                                "只在部分数据表中存在，缺失的行会写入 #REF!。"
                            )
            continue
        if fieldmap.is_const(mapping):
            continue
        sources = fieldmap.sources_of(mapping)
        if not sources:
            unmapped += 1
            if col.get("required"):
                required_missing.append(str(col_name))
            continue
        raw_combine = str(mapping.get("combine") or "").strip().lower()
        if raw_combine and raw_combine not in fieldmap.COMBINES:
            warnings.append(
                f"列「{col_name}」的合并方式「{mapping.get('combine')}」不认识，"
                "已按「取第一个非空值」处理。"
            )
        for src in sources:
            tid = src["table_id"]
            if not registry.has(tid):
                errors.append(f"列「{col_name}」的来源表已失效。")
                continue
            headers = registry.headers(tid)
            if src["column_index"] >= len(headers):
                errors.append(f"列「{col_name}」的来源字段无效。")
            if tid not in active_tables:
                warnings.append(f"列「{col_name}」的来源表未参与本次汇总，将输出缺省值。")
        if fieldmap.combine_of(mapping) == "latest":
            order = fieldmap.order_by_of(mapping)
            if not order:
                warnings.append(
                    f"列「{col_name}」用了「取最新一条」但没指定排序列，"
                    "改为按这一列自身的值比较。"
                )
            elif not registry.has(order["table_id"]):
                warnings.append(f"列「{col_name}」的排序列所在表已失效，改为按这一列自身比较。")
            elif order["column_index"] >= len(registry.headers(order["table_id"])):
                warnings.append(f"列「{col_name}」的排序列无效，改为按这一列自身比较。")
    if unmapped:
        warnings.append(f"有 {unmapped} 个目标列尚未配置来源，将以空值或固定值输出。")
    if required_missing:
        warnings.append(
            "模板里标了必填、但还没有配置来源："
            + "、".join(required_missing[:6])
            + ("…" if len(required_missing) > 6 else "")
        )

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


def _compile_plan(mapping: dict) -> dict:
    """把一条映射预编译成取值计划。

    行循环里每列要跑几万次，不能每次都去解析 sources / combine 这些 JSON 结构。
    """
    if fieldmap.is_const(mapping):
        return {
            "kind": "const",
            "value": mapping.get("value"),
            "sources": [],
            "combine": "first",
            "separator": fieldmap.DEFAULT_SEPARATOR,
            "order_by": None,
        }
    sources = fieldmap.sources_of(mapping)
    combine = fieldmap.combine_of(mapping)
    return {
        "kind": "sources" if sources else "blank",
        "sources": sources,
        "combine": combine,
        "separator": fieldmap.separator_of(mapping),
        "order_by": fieldmap.order_by_of(mapping) if combine == "latest" else None,
    }


def _resolve(plan: dict, primary_tid: str, primary_row: list[Any],
             matched: dict, ctx: dict | None = None) -> Any:
    """按计划取值：主表用当前行，其他表用匹配到的**所有**行，再按合并方式合成。

    纵向合并时把 `primary_tid` 设成当前表、`matched` 传空字典即可——
    「只有当前表那一条来源生效」这件事自然由这里表达，不需要两套代码。
    """
    kind = plan.get("kind")
    if kind == "const":
        return plan.get("value")
    if kind != "sources":
        return None
    combine = plan.get("combine") or fieldmap.DEFAULT_COMBINE
    order_by = plan.get("order_by")
    # first / sum / count / concat 不看排序键；max / min / latest 需要
    needs_key = combine in ("max", "min", "latest")
    items: list[tuple[Any, Any]] = []
    for src in plan["sources"]:
        tid = src["table_id"]
        idx = src["column_index"]
        transform = src["transform"]
        if tid == primary_tid:
            rows_iter: Any = (primary_row,)
        else:
            rows_iter = matched.get(tid) or ()
        order_idx = None
        if combine == "latest":
            # 排序列必须和来源同表，否则退回用本列自身比较
            if order_by and order_by.get("table_id") == tid:
                order_idx = order_by["column_index"]
            else:
                order_idx = idx
        for row in rows_iter:
            raw = row[idx] if idx < len(row) else None
            value = _apply_transform(raw, transform, ctx)
            if needs_key:
                key_src = row[order_idx] if order_idx is not None and order_idx < len(row) else value
                items.append((value, fieldmap.sort_key(key_src)))
            else:
                items.append((value, None))
    return fieldmap.aggregate(combine, items,
                              plan.get("separator") or fieldmap.DEFAULT_SEPARATOR)


def _finish_value(value: Any, mapping: dict, trim_text: bool) -> Any:
    """收尾：空值走缺省值，再去首尾空格（与以前 `_mapping_value` 的行为一致）。"""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        fallback = mapping.get("fallback")
        value = "" if fallback is None else fallback
    if trim_text and isinstance(value, str):
        return value.strip()
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

    # 公式在进入行循环前编译一次，几万行里只做求值不再解析
    formulas: dict[str, Formula] = {}
    for col in cols:
        mapping = mappings.get(col.get("key")) or {}
        if not _formula_on(mapping):
            continue
        text = str(mapping.get("formula") or "")
        if not text.strip():
            raise UserError(f"列「{col['name']}」启用了公式但内容为空，请填写公式或关闭公式。")
        try:
            formulas[col["key"]] = compile_formula(text)
        except FormulaSyntaxError as exc:
            raise UserError(
                f"列「{col['name']}」公式语法错误：{exc.message}（第 {exc.pos} 个字符附近）"
            ) from exc
    need_formula = bool(formulas)
    # 每列取值计划同样预编译一次：来源链与合并方式在行循环里不再解析
    plans: dict[str, dict] = {}
    for col in cols:
        if col["key"] in formulas:
            continue
        plans[col["key"]] = _compile_plan(mappings.get(col.get("key")) or {})
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
            # 一个键可能对应多行：以前只留第一条（等于静默丢数据），
            # 现在全部留下，由每列的合并方式决定怎么用（取首条 / 求和 / 计数 / 最新…）。
            index: dict[tuple, list[list[Any]]] = {}
            dup_rows = 0
            for row in rows:
                key = _join_key(row, lkeys)
                if not all(key):
                    continue
                bucket = index.get(key)
                if bucket is None:
                    index[key] = [row]
                else:
                    bucket.append(row)
                    dup_rows += 1
            multi_keys = sum(1 for bucket in index.values() if len(bucket) > 1)
            max_rows = max((len(b) for b in index.values()), default=1)
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
            if dup_rows:
                warnings.append(
                    f"关联表「{registry.label(tid)}」有 {multi_keys} 个键对应多行"
                    f"（最多 {max_rows} 行）。目标列按各自的合并方式处理，"
                    "默认「取第一个非空值」只会拿到其中一条。"
                )
            lookup_stats.append({
                "table_id": tid,
                "label": registry.label(tid),
                "rows": len(rows),
                "matched": matched,
                "missing": missing,
                "duplicates": dup_rows,
                "multi_keys": multi_keys,
                "max_rows_per_key": max_rows,
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
    # 列级填充统计：模板驱动下最常被问的是「哪个字段还有大片空白」
    col_filled = [0] * len(cols)
    col_empty = [0] * len(cols)
    ctx: dict = {"ambiguous_dates": 0}

    def _count(ci: int, value: Any) -> None:
        nonlocal filled, empty
        if value is None or (isinstance(value, str) and value == ""):
            empty += 1
            col_empty[ci] += 1
        else:
            filled += 1
            col_filled[ci] += 1

    if mode == "join":
        # 每行动态计算 lookup 行，避免构建巨大笛卡尔结构
        pkeys = [int(k) for k in (config.get("primary_keys") or [])]
        pheaders = primary_data["headers"]
        primary_tid = primary_data["table_id"]
        for row in primary_data["rows"]:
            key = _join_key(row, pkeys)
            matched_rows: dict[str, list[list[Any]]] = {}
            if all(key):
                for ld in lookup_data:
                    bucket = ld["index"].get(key)
                    if bucket:
                        matched_rows[ld["table_id"]] = bucket
            fields = None
            if need_formula:
                # 主表字段先占位，关联表用 setdefault 补；
                # 没匹配到关联行时也要把字段名放进去（值为 None），
                # 否则公式引用它会报 #REF!，而 Excel 里缺失单元格是空值。
                # 一对多时公式只看第一行——要合计请用字段的合并方式，别写公式。
                fields = {}
                for i, h in enumerate(pheaders):
                    fields.setdefault(h, row[i] if i < len(row) else None)
                for ld in lookup_data:
                    bucket = matched_rows.get(ld["table_id"]) or []
                    lk_row = bucket[0] if bucket else None
                    for i, h in enumerate(ld["headers"]):
                        fields.setdefault(
                            h, lk_row[i] if lk_row is not None and i < len(lk_row) else None
                        )
            row_no = len(output_rows) + 1
            out = []
            for ci, col in enumerate(cols):
                col_key = col["key"]
                compiled = formulas.get(col_key)
                if compiled is not None:
                    value = _formula_value(compiled, fields, col["name"], ctx, row_no)
                    if trim_text and isinstance(value, str):
                        value = value.strip()
                else:
                    mapping = mappings.get(col_key) or {}
                    plan = plans.get(col_key) or {"kind": "blank"}
                    value = _finish_value(
                        _resolve(plan, primary_tid, row, matched_rows, ctx), mapping, trim_text
                    )
                out.append(value)
                _count(ci, value)
            output_rows.append(out)
        totals["input"] = len(primary_data["rows"])
    else:
        auto_by_name = bool(config.get("auto_by_name", True))
        # 纵向合并时各表列名可能不同，先把并集准备好，
        # 让公式引用另一张表独有的字段时得到空值而不是 #REF!
        all_fields: list[str] = []
        if need_formula:
            seen_fields: set[str] = set()
            for ld in lookup_data:
                for h in ld["headers"]:
                    if h not in seen_fields:
                        seen_fields.add(h)
                        all_fields.append(h)
        for ld in lookup_data:
            headers = ld["headers"]
            tid = ld["table_id"]
            # 预先建好「列名 → 列下标」索引：以前是 rows × cols 次 headers.index()，
            # 每次线性扫一遍表头；5 万行 × 20 列就是上百万次查找。
            # 索引同时支持「严格同名 → 括号别名」两级匹配（见 column_match）。
            name_pos = column_match.TableMatcher(headers)
            # 当前表是否为该列指定了来源；没指定才启用「同名列兜底」，
            # 免得把用户明确配好的来源链冲掉。
            local: dict[str, tuple[dict, bool, str]] = {}
            for col in cols:
                plan = plans.get(col["key"])
                if plan is None:
                    continue
                sources = plan.get("sources") or []
                has = any(src["table_id"] == tid for src in sources)
                transform = next((src["transform"] for src in sources if src["table_id"] == tid),
                                 sources[0]["transform"] if sources else "direct")
                local[col["key"]] = (plan, has, transform)
            for row in ld["rows"]:
                fields = None
                if need_formula:
                    fields = {h: (row[i] if i < len(row) else None) for i, h in enumerate(headers)}
                    for h in all_fields:
                        fields.setdefault(h, None)
                row_no = len(output_rows) + 1
                out = []
                for ci, col in enumerate(cols):
                    col_key = col["key"]
                    compiled = formulas.get(col_key)
                    if compiled is not None:
                        value = _formula_value(compiled, fields, col["name"], ctx, row_no)
                        if trim_text and isinstance(value, str):
                            value = value.strip()
                    else:
                        plan, has, transform = local.get(col_key, ({"kind": "blank"}, False, "direct"))
                        mapping = mappings.get(col_key) or {}
                        value = _resolve(plan, tid, row, {}, ctx) if has else None
                        if value is None and not has and auto_by_name:
                            # 纵向合并时，其他表按同名列自动填充；同名列缺失时
                            # 退回模板列名括号里的备注名（「月薪（税前）」→ 税前）
                            idx, _via = name_pos.resolve(col.get("name"))
                            if idx >= 0:
                                value = _apply_transform(row[idx] if idx < len(row) else None,
                                                         transform, ctx)
                        value = _finish_value(value, mapping, trim_text)
                    out.append(value)
                    _count(ci, value)
                output_rows.append(out)
            totals["input"] += len(ld["rows"])

    if ctx["ambiguous_dates"]:
        warnings.append(
            f"{ctx['ambiguous_dates']} 个日期形如 03/04/2026，无法判断日/月顺序，已按原文保留。"
            "如需统一，请先在源表中改成 2026-03-04 这种格式。"
        )

    for col_name, info in (ctx.get("formula_errors") or {}).items():
        codes = "、".join(f"{code}×{count}" for code, count in info["codes"].items())
        warnings.append(
            f"列「{col_name}」有 {info['count']} 个单元格公式计算失败（{codes}），"
            f"首个：{info['first']}。结果里已写入 Excel 错误值，可用 IFERROR 兜底。"
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
        "column_stats": [
            {
                "key": col["key"],
                "name": headers[i],
                "filled": col_filled[i],
                "empty": col_empty[i],
                "empty_rate": round(col_empty[i] / len(output_rows), 4) if output_rows else 0,
                "required": bool(col.get("required")),
            }
            for i, col in enumerate(cols)
        ],
        "sources": [
            {"table_id": tid, "label": registry.label(tid), "rows": len(registry.data(tid)[1])}
            for tid in active
        ],
        "mode": mode,
        "active_tables": active,
    }
