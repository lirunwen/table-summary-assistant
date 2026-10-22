"""字段来源与合并：一个目标列可以从多张表取数，并按指定方式合并。

## 为什么要这一层

以前一个目标列只能绑「一张表 + 一列」，于是三类真实需求都表达不了：

1. 手机号在通讯录里有、在员工主表里也有，谁空不一定——需要「多源兜底」；
2. 一个员工在考勤明细里有 N 行——以前只取第一条，合计/次数/最新一条全都算不出来；
3. 金额一列，A 表是含税、B 表是不含税，要拼在一起。

现在映射带一条**来源链** + 一个**合并方式**：

```json
{
  "sources": [
    {"table_id": "s_a::s0", "column_index": 2, "transform": "direct"},
    {"table_id": "s_b::s0", "column_index": 5, "transform": "number"}
  ],
  "combine": "first",
  "fallback": ""
}
```

## 合并方式

| combine | 语义 | 典型场景 |
| --- | --- | --- |
| `first` | 按来源顺序取第一个非空值（默认） | 多源兜底：先用通讯录，没有再看主表 |
| `sum` | 数值求和，转不成数字的跳过；全都不行则视为空 | 一人多行考勤 → 当月加班合计 |
| `count` | 非空值个数 | 当月报销次数 |
| `max` / `min` | 取最大/最小值（数值按大小，日期按先后，其余按文本） | 最近一次出勤日期 |
| `latest` | 按 `order_by` 指定的列排序，取**最新那条记录里**的目标列值 | 最近一次体检的医院名 |
| `concat` | 去重后按出现顺序拼接，分隔符默认「、」 | 一人多岗位拼成一列 |

`latest` 与 `max` 的区别：`max` 返回的就是那一列的极值；`latest` 返回的是「按时间排序后第一条记录里的另一个字段」。

## 兼容

老配置的映射是扁平的 `{mode: "table", table_id, column_index, transform}`，
`sources_of()` 会把它当成只有一条来源的链，合并方式按 `first` 处理。
读老配置不需要迁移；写回时前端统一写成新结构。
"""
from __future__ import annotations

import datetime as dt
from typing import Any

from .utils import coerce_number, display_value

DEFAULT_COMBINE = "first"

#: 合并方式 → 界面标签。顺序即下拉框顺序。
COMBINES: dict[str, str] = {
    "first": "取第一个非空值",
    "sum": "求和",
    "count": "计数",
    "max": "最大值",
    "min": "最小值",
    "latest": "取最新一条",
    "concat": "拼接",
}

#: 需要跨行（同一个键的多条记录）才有意义的方式，用于给出「当前会丢数据」的提示。
CROSS_ROW = {"sum", "count", "max", "min", "latest", "concat"}

DEFAULT_SEPARATOR = "、"


def _as_index(value: Any) -> int | None:
    try:
        i = int(value)
        return i if i >= 0 else None
    except (TypeError, ValueError):
        return None


def combine_of(mapping: dict) -> str:
    """取合并方式，非法值回落为 first（不因为一个拼错的枚举就中断整次汇总）。"""
    raw = str((mapping or {}).get("combine") or DEFAULT_COMBINE).strip().lower()
    return raw if raw in COMBINES else DEFAULT_COMBINE


def separator_of(mapping: dict) -> str:
    sep = (mapping or {}).get("separator")
    return str(sep) if sep else DEFAULT_SEPARATOR


def order_by_of(mapping: dict) -> dict | None:
    """latest 用的排序列：{"table_id", "column_index"}；没配或非法返回 None。"""
    raw = (mapping or {}).get("order_by")
    if not isinstance(raw, dict):
        return None
    tid = raw.get("table_id")
    idx = _as_index(raw.get("column_index"))
    if not tid or idx is None:
        return None
    return {"table_id": tid, "column_index": idx}


def sources_of(mapping: dict) -> list[dict]:
    """归一化来源链：新结构 `sources[]` 优先，老结构视作单来源。"""
    mapping = mapping or {}
    out: list[dict] = []
    raw = mapping.get("sources")
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            tid = item.get("table_id")
            idx = _as_index(item.get("column_index"))
            if not tid or idx is None:
                continue
            out.append({
                "table_id": tid,
                "column_index": idx,
                "transform": item.get("transform") or mapping.get("transform") or "direct",
            })
    if not out and mapping.get("mode") == "table":
        tid = mapping.get("table_id")
        idx = _as_index(mapping.get("column_index"))
        if tid and idx is not None:
            out.append({
                "table_id": tid,
                "column_index": idx,
                "transform": mapping.get("transform") or "direct",
            })
    return out


def is_const(mapping: dict) -> bool:
    return (mapping or {}).get("mode") == "const"


def is_blank(mapping: dict) -> bool:
    """既不是固定值、也没有任何来源。"""
    mapping = mapping or {}
    if is_const(mapping):
        return False
    return not sources_of(mapping)


def normalize_mapping(mapping: dict) -> dict:
    """把任意历史形态的映射整理成统一结构（不改原字典）。"""
    mapping = mapping or {}
    out = dict(mapping)
    if is_const(mapping):
        out["kind"] = "const"
        out["sources"] = []
        return out
    sources = sources_of(mapping)
    out["sources"] = sources
    out["combine"] = combine_of(mapping)
    out["kind"] = "sources" if sources else "blank"
    if out["combine"] == "concat":
        out["separator"] = separator_of(mapping)
    if out["combine"] == "latest":
        order = order_by_of(mapping)
        if order:
            out["order_by"] = order
        else:
            out.pop("order_by", None)
    return out


def sort_key(value: Any) -> tuple[int, Any]:
    """跨行比较用的排序键：数值按大小、日期按时间、其余按文本。

    返回 (等级, 可比较值)。等级用来避免「数字和文本直接比大小」抛 TypeError。
    """
    if value is None or (isinstance(value, str) and not value.strip()):
        return (0, "")
    if isinstance(value, bool):
        return (3, "1" if value else "0")
    if isinstance(value, (int, float)):
        return (2, float(value))
    if isinstance(value, (dt.date, dt.datetime)):
        return (1, value.isoformat())
    num = coerce_number(value)
    if num is not None:
        return (2, num)
    text = display_value(value)
    return (3, text)


def aggregate(combine: str, items: list[tuple[Any, tuple]],
              separator: str = DEFAULT_SEPARATOR) -> Any:
    """按合并方式把 [(值, 排序键)] 合成一个结果。空输入返回 None。"""
    combine = combine if combine in COMBINES else DEFAULT_COMBINE
    if not items:
        return None
    if combine == "first":
        for value, _ in items:
            if not _is_empty(value):
                return value
        return None
    if combine == "count":
        return sum(1 for value, _ in items if not _is_empty(value))
    if combine == "concat":
        seen: list[str] = []
        for value, _ in items:
            if _is_empty(value):
                continue
            text = display_value(value)
            if text not in seen:
                seen.append(text)
        return separator.join(seen) if seen else None
    if combine == "sum":
        total = 0.0
        found = False
        for value, _ in items:
            if _is_empty(value):
                continue
            num = coerce_number(value)
            if num is None:
                continue
            total += num
            found = True
        return total if found else None
    if combine in ("max", "latest"):
        best = None
        best_key = None
        found = False
        for value, key in items:
            # 空值不参与比较：否则 min 会返回空字符串、latest 会取到一条空记录
            if _is_empty(value) or key is None:
                continue
            if not found or key > best_key:
                best, best_key, found = value, key, True
        return best if found else None
    if combine == "min":
        best = None
        best_key = None
        found = False
        for value, key in items:
            if _is_empty(value) or key is None:
                continue
            if not found or key < best_key:
                best, best_key, found = value, key, True
        return best if found else None
    return None


def _is_empty(value: Any) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "")


__all__ = [
    "COMBINES",
    "CROSS_ROW",
    "DEFAULT_COMBINE",
    "DEFAULT_SEPARATOR",
    "aggregate",
    "combine_of",
    "is_blank",
    "is_const",
    "normalize_mapping",
    "order_by_of",
    "separator_of",
    "sort_key",
    "sources_of",
]
