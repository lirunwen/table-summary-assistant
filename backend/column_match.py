"""列名匹配：先严格同名，再退回「括号里的备注名」。

## 为什么需要这一层

模板是别的部门定的，列名往往写成「员工编号（工号）」「月薪（税前）」这种
「正式名（说明或别名）」的形式；而数据源表格来自另一个部门，列名就叫「工号」「税前」。
两边都不能改，只能在中间做适配。

所以匹配分两级，**严格名永远优先**：

1. 严格匹配：目标列名与源表列名规范化后完全相同；
2. 括号别名匹配：从目标列名里取出括号内的文字，再拿它去比。

**只解析目标列（模板列）的括号，不解析源表列名的括号。** 源表的括号在别的部门
可能有别的含义（单位、口径、备注），替它猜是在制造错误，不是适配。

## 括号解析规则

- 支持的开括号：`（`（全角）、`(`（半角）、`【`、`〔`、`［`、`[`；
- 支持任意「开括号 + 任一闭括号」组合：`（备注)` 这种全半角混用也能识别，
  因为这是手打时最常见的失误；
- 只取**最外层**内容，不递归（`金额（含税【元】）` 的候选是「含税【元】」）；
  括号内容为空则忽略；
- 一个列名里有多组括号时，**按出现顺序**依次作为候选
  （`月薪（税前）（元）` → 先试「税前」，再试「元」）；
- 只有开括号没有闭括号的部分跳过，不影响同一列名里其它正常的括号；
- 同一个列名里重复出现的别名会去重。

**不做**的事：不做模糊匹配、不做包含匹配、不做拼音、不做大小写折叠。
列名对不上就留空让人工选——猜错比留空更难发现。

## 冲突与优先级

- **候选优先于表**：先拿严格名把主表、各关联表都试一遍；都没命中，才试第一个别名，
  再试第二个别名。所以「严格命中关联表」优先于「别名命中主表」。
- **表内取最左**：同一张表出现重复表头时，取最左边那一列。
- **表间按配置顺序**：主表在前，关联表按用户添加的顺序；纵向合并按 `append_tables` 顺序。
- **多个目标列命中同一个源列是允许的**（如「姓名」与「联系人（姓名）」都取姓名），
  互不排斥。
- **一旦命中即停止**，不再尝试后续别名，保证结果确定、可复现。
"""
from __future__ import annotations

import re
from dataclasses import dataclass

#: 能当括号用的字符。开闭不对称也接受（`（备注)`），这是手打时的常见形态。
OPEN_BRACKETS = "（(【〔［["
CLOSE_BRACKETS = "）)】〕］]"

_ZERO_WIDTH = dict.fromkeys(map(ord, "\u200b\u200c\u200d\u2060\ufeff"), None)
_SPACES = re.compile(r"\s+")

NAME = "name"
ALIAS = "alias"


def normalize_name(text: object) -> str:
    """列名比较用的规范化：去零宽字符、全角空格转半角、连续空白压一个、去首尾空白。

    刻意不做大小写折叠和 NFKC：中文列名用不上，而 NFKC 会把 ① 折成 1 这类
    本就不同的字符，凭空制造「匹配成功」。
    """
    s = str(text or "").translate(_ZERO_WIDTH)
    s = s.replace("\u3000", " ")
    return _SPACES.sub(" ", s).strip()


def bracket_aliases(name: object) -> list[str]:
    """取出列名里所有括号中的文字，按出现顺序、去重。

    用括号深度判断层级：`金额（含税【元】）` 的外层内容算「含税【元】」，
    内层那对不会单独成为一个候选；深度回不到 0 的就是没闭合，跳过重找。
    """
    text = str(name or "")
    out: list[str] = []
    seen: set[str] = set()
    n = len(text)
    i = 0
    while i < n:
        if text[i] in OPEN_BRACKETS:
            depth = 0
            j = i
            while j < n:
                char = text[j]
                if char in OPEN_BRACKETS:
                    depth += 1
                elif char in CLOSE_BRACKETS:
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            if j < n:
                content = normalize_name(text[i + 1:j])
                if content and content not in seen:
                    seen.add(content)
                    out.append(content)
                i = j + 1
                continue
            # 没有闭合括号：跳过这个开括号，继续看后面（可能还有成对的）
        i += 1
    return out


def candidate_names(name: object) -> list[tuple[str, str]]:
    """目标列的候选名列表：[(严格名, 'name'), (别名1, 'alias'), ...]。"""
    strict = normalize_name(name)
    out: list[tuple[str, str]] = []
    if strict:
        out.append((strict, NAME))
    for alias in bracket_aliases(name):
        if alias != strict:
            out.append((alias, ALIAS))
    return out


def header_index(headers: list[str]) -> dict[str, int]:
    """列名 → 列下标。重复表头取最左一列。"""
    index: dict[str, int] = {}
    for i, header in enumerate(headers):
        key = normalize_name(header)
        if key and key not in index:
            index[key] = i
    return index


@dataclass(frozen=True)
class Match:
    """一次命中的结果。`table_pos` 对应传入的表顺序（0 = 主表）。"""

    table_pos: int
    column_index: int
    via: str            # NAME / ALIAS
    alias: str = ""     # via=ALIAS 时，实际命中的那个括号名


def resolve(target_name: object, header_lists: list[list[str]]) -> Match | None:
    """在若干张表里给一个目标列找来源列，找不到返回 None。

    `header_lists` 的顺序就是优先级：主表在前，关联表按配置顺序。
    """
    candidates = candidate_names(target_name)
    if not candidates:
        return None
    indexes = [header_index(headers) for headers in header_lists]
    for key, kind in candidates:
        for pos, index in enumerate(indexes):
            hit = index.get(key)
            if hit is not None:
                return Match(pos, hit, kind, key if kind == ALIAS else "")
    return None


def match_columns(columns: list[dict], header_lists: list[list[str]]) -> list[dict]:
    """批量匹配：给前端「按列名匹配」用，前端不重复实现这套规则。

    `columns` 是 `[{"key": ..., "name": ...}]`，返回命中的那些（未命中的不出现）：
    `[{"key", "name", "table_pos", "column_index", "column_name", "via", "alias"}]`
    """
    out: list[dict] = []
    for col in columns or []:
        if not isinstance(col, dict):
            continue
        match = resolve(col.get("name"), header_lists)
        if match is None:
            continue
        headers = header_lists[match.table_pos] or []
        raw = headers[match.column_index] if match.column_index < len(headers) else ""
        out.append({
            "key": col.get("key"),
            "name": col.get("name"),
            "table_pos": match.table_pos,
            "column_index": match.column_index,
            "column_name": raw,
            "via": match.via,
            "alias": match.alias,
        })
    return out


class TableMatcher:
    """给同一张表的很多次查找用：表头索引只建一次，结果按列名缓存。

    纵向合并时每张表要跑几万行 × 十几列，不缓存的话每行都要重算别名。
    """

    __slots__ = ("headers", "_index", "_cache")

    def __init__(self, headers: list[str]) -> None:
        self.headers = list(headers or [])
        self._index = header_index(self.headers)
        self._cache: dict[str, tuple[int, str]] = {}

    def resolve(self, target_name: object) -> tuple[int, str]:
        """返回 (列下标, 'name'|'alias')，找不到给 (-1, '')。"""
        key = normalize_name(target_name)
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        found: tuple[int, str] = (-1, "")
        for candidate, kind in candidate_names(target_name):
            hit = self._index.get(candidate)
            if hit is not None:
                found = (hit, kind)
                break
        self._cache[key] = found
        return found


__all__ = [
    "ALIAS", "CLOSE_BRACKETS", "NAME", "OPEN_BRACKETS", "Match", "TableMatcher",
    "bracket_aliases", "candidate_names", "header_index", "normalize_name", "resolve",
]
