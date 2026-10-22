"""列名匹配：**括号备注名优先**，不含括号的列才按列名匹配。

## 规则一句话

**目标列名里带括号备注的，先把括号里的备注名取出来，用它去数据源里找；
不带括号的，才直接用列名去找。**

模板列写成「名称（备注）」，意思就是"这一列在数据源里叫『备注』"——
括号里的是**权威名**，外面那个「名称」只是给人看的说明。

| 目标列 | 数据源里有 | 匹配到 |
| --- | --- | --- |
| 月薪（税前） | 税前 | 税前（备注名） |
| 姓名（联系人） | 姓名、联系人 | **联系人**（备注名，不是「姓名」） |
| 姓名 | 姓名、联系人 | 姓名（列名） |

反着做（先按整串列名撞、撞不上再试备注名）会出乱子：上面第二行会先撞上「姓名」，
括号里的备注就白写了。所以**有括号的列不再拿整串列名去撞**。

## 三层匹配，优先级从高到低

1. **括号备注名**（仅当目标列带括号）：按括号出现顺序依次试
   （`月薪（税前）（元）` → 先试「税前」再试「元」），每个备注名都跨表扫一遍。
2. **列名**：目标列不带括号时，直接用列名（规范化后）跨表扫。
3. **相似度兜底**：前两层都没命中时按相似度比（`difflib` 序列比 + 包含关系加权），
   分数够高才自动采用，并带上分数让界面标出「相似 90%」；分数接近并列时
   **不自动采用**（宁可留给人工选），只作为候选列出来。

相似度比的是**有效匹配名**（带括号时就是括号里的备注名），不是目标列的整串文字。

## 为什么还要"写法差异"这一层

即使按上面的规则走，两边写法不一致也会对不上，所以比较时用**比较键**：
规范化（去零宽字符、全角转半角、压空白）→ 忽略大小写 → 去掉分隔符
（空格 / 下划线 / 连字符 / 中点 / 斜杠 / 冒号 / 逗号 / 句点）。

| 目标列 | 源列 | 结果 |
| --- | --- | --- |
| 员工工号 | 员工_工号 | 同名 |
| EmployeeID | employeeid | 同名 |
| 应发工资 | 应发 工资 | 同名 |
| 手机号 | 手机号码 | 相似 93% |
| 所属部门 | 部门 | 相似 90% |

**只解析目标列（模板列）的括号，不解析源表列名的括号。** 源表的括号在别的部门
可能有别的含义（单位、口径、备注），替它猜是在制造错误，不是适配。
但源表列名里的括号内容会参与**相似度**比较（`工号` 对 `工号（员工）` 仍是高分），
所以不会因为这条克制就把常见情况判死。

## 括号解析规则

- 支持的开括号：`（`（全角）、`(`（半角）、`【`、`〔`、`［`、`[`；
- 支持任意「开括号 + 任一闭括号」组合：`（备注)` 这种全半角混用也能识别，
  因为这是手打时最常见的失误；
- 只取**最外层**内容，不递归（`金额（含税【元】）` 的候选是「含税【元】」）；
- 括号内容为空则忽略；
- 一个列名里有多组括号时，**按出现顺序**依次作为候选
  （`月薪（税前）（元）` → 先试「税前」，再试「元」）；
- 只有开括号没有闭括号的部分跳过，不影响同一列名里其它正常的括号；
- 同一个列名里重复出现的别名会去重。

## 冲突与优先级

- **候选优先于表**：先拿第一个候选名把主表、各关联表都试一遍；都没命中，
  才试第二个候选，再试相似度。所以「备注名命中关联表」优先于「备注名命中主表」。
- **表内取最左**：同一张表出现重复表头时，取最左边那一列。
- **表间按配置顺序**：主表在前，关联表按用户添加的顺序；纵向合并按 `append_tables` 顺序。
- **多个目标列命中同一个源列是允许的**（如「姓名」与「联系人（姓名）」都取姓名），
  互不排斥。
- **一旦命中即停止**，不再尝试后续层级，保证结果确定、可复现。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

#: 能当括号用的字符。开闭不对称也接受（`（备注)`），这是手打时的常见形态。
OPEN_BRACKETS = "（(【〔［["
CLOSE_BRACKETS = "）)】〕］]"

#: 相似度达到这个分数才自动采用。
SIMILARITY_MIN = 0.85

#: 未命中时最多给几个候选。
CANDIDATE_LIMIT = 6

_ZERO_WIDTH = dict.fromkeys(map(ord, "\u200b\u200c\u200d\u2060\ufeff"), None)
_SPACES = re.compile(r"\s+")

#: 比较键里要去掉的字符：空白、下划线、连字符、中点、斜杠、冒号、逗号、句点。
_SEPARATORS = re.compile(r"[\s_\-·．/\\:：,，.。]+")

#: 匹配层级。
EXACT = "exact"
ALIAS = "alias"
SIMILAR = "similar"

#: 旧字段名，保留以兼容既有调用方（界面按层级文案展示）。
NAME = EXACT

VIA_LABELS = {
    EXACT: "同名",
    ALIAS: "备注名",
    SIMILAR: "相似",
}


def normalize_name(text: object) -> str:
    """列名展示用的规范化：去零宽字符、全角转半角、连续空白压一个、去首尾空白。"""
    s = str(text or "").translate(_ZERO_WIDTH)
    s = s.replace("　", " ")
    return _SPACES.sub(" ", s).strip()


def match_key(text: object) -> str:
    """比较用的键：规范化 + 忽略大小写 + 去掉分隔符。

    这一层是「大小写 / 空格 / 下划线 / 驼峰」能对上的关键：
    `员工_工号`、`员工 工号`、`员工工号` 的键都是 `员工工号`；
    `EmployeeID` 与 `employeeid` 的键都是 `employeeid`。
    """
    return _SEPARATORS.sub("", normalize_name(text).casefold())


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


def target_match_names(name: object) -> list[str]:
    """目标列真正用来去数据源里找的列名。

    **含括号备注的列只认括号里的名字。** 模板列写成「名称（备注）」，
    意思就是"这一列在数据源里叫『备注』"——括号里的是权威名，
    外面那个「名称」只是给人看的说明。所以：

    - 有括号 → 只用括号里的备注名去匹配（多个括号按出现顺序依次试）；
    - 没有括号 → 直接用列名本身。

    反过来做（先按整体列名撞、撞不上再试备注名）会出乱子：数据源里同时有
    「名称」和「备注」两列时，「名称（备注）」会先撞上「名称」，
    而用户要的是「备注」——括号备注就白写了。
    """
    aliases = bracket_aliases(name)
    if aliases:
        return aliases
    text = normalize_name(name)
    return [text] if text else []


def candidate_names(name: object) -> list[tuple[str, str, str]]:
    """目标列的候选匹配名：[(比较键, 层级, 原文)]，顺序即优先级。

    层级：含括号走的是备注名（`alias`），无括号走的是列名本身（`exact`）。
    原文保留下来，命中后界面要显示"是靠括号里的『税前』对上的"。
    """
    aliases = bracket_aliases(name)
    kind = ALIAS if aliases else EXACT
    out: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    for text in (aliases if aliases else [normalize_name(name)]):
        key = match_key(text)
        if key and key not in seen:
            seen.add(key)
            out.append((key, kind, text))
    return out


def header_index(headers: list[str]) -> dict[str, int]:
    """比较键 → 列下标。重复表头取最左一列。"""
    index: dict[str, int] = {}
    for i, header in enumerate(headers or []):
        key = match_key(header)
        if key and key not in index:
            index[key] = i
    return index


def similarity(left: str, right: str) -> float:
    """两个比较键的相似度（0~1）。

    基础分是 `difflib` 的序列比；一个键是另一个的子串时额外加权——
    「手机号」与「手机号码」、「所属部门」与「部门」这种"多一个字/少两个字"
    在序列比上分数不高，但对列名来说几乎是同一个字段。
    """
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    score = SequenceMatcher(None, left, right).ratio()
    short, long = (left, right) if len(left) <= len(right) else (right, left)
    if len(short) >= 2 and short in long:
        score = max(score, 0.82 + 0.15 * (len(short) / len(long)))
    return round(score, 4)


@dataclass(frozen=True)
class Match:
    """一次命中的结果。`table_pos` 对应传入的表顺序（0 = 主表）。"""

    table_pos: int
    column_index: int
    via: str            # EXACT / ALIAS / SIMILAR
    alias: str = ""     # via=ALIAS 时，实际命中的那个括号名
    score: float = 1.0  # via=SIMILAR 时的相似度


def _best_similar(target_keys: list[str], header_lists: list[list[str]]) -> Match | None:
    """相似度兜底：全局最高分、且没有并列时才自动采用。

    相似度比的是**有效匹配名**（有括号时是括号里的备注名），不是目标列的整串文字。
    """
    keys = [k for k in target_keys if k]
    if not keys:
        return None
    scored: list[tuple[float, int, int]] = []
    for pos, headers in enumerate(header_lists or []):
        for index, header in enumerate(headers or []):
            hkey = match_key(header)
            score = max((similarity(k, hkey) for k in keys), default=0.0)
            if score >= SIMILARITY_MIN:
                scored.append((score, pos, index))
    if not scored:
        return None
    scored.sort(key=lambda item: (-item[0], item[1], item[2]))
    best_score, best_pos, best_index = scored[0]
    # 最高分与次高分并列：分不清是哪一个，不自动采用，交给人工选
    if len(scored) > 1 and scored[1][0] >= best_score - 1e-9:
        return None
    return Match(best_pos, best_index, SIMILAR, "", best_score)


def resolve(target_name: object, header_lists: list[list[str]],
            allow_similar: bool = True) -> Match | None:
    """在若干张表里给一个目标列找来源列，找不到返回 None。

    规则见 `target_match_names()`：含括号的列只按括号里的备注名匹配，
    不含括号的列才直接按列名匹配。

    `header_lists` 的顺序就是优先级：主表在前，关联表按配置顺序。
    """
    candidates = candidate_names(target_name)
    if not candidates:
        return None
    indexes = [header_index(headers) for headers in header_lists or []]
    for key, kind, text in candidates:
        for pos, index in enumerate(indexes):
            hit = index.get(key)
            if hit is not None:
                return Match(pos, hit, kind, text if kind == ALIAS else "")
    if not allow_similar:
        return None
    return _best_similar([key for key, _kind, _text in candidates], header_lists or [])


def similar_candidates(target_name: object, header_lists: list[list[str]],
                       limit: int = CANDIDATE_LIMIT) -> list[dict]:
    """没命中时给出最接近的几个来源列，供界面让人挑。

    返回 `[{"table_pos", "column_index", "column_name", "score"}]`，按分数降序。
    同样按有效匹配名（有括号时用括号里的备注名）来比。
    """
    keys = [key for key, _kind, _text in candidate_names(target_name)]
    if not keys:
        return []
    scored: list[dict] = []
    for pos, headers in enumerate(header_lists or []):
        for index, header in enumerate(headers or []):
            hkey = match_key(header)
            score = max((similarity(k, hkey) for k in keys), default=0.0)
            if score <= 0:
                continue
            scored.append({
                "table_pos": pos,
                "column_index": index,
                "column_name": header,
                "score": score,
            })
    scored.sort(key=lambda item: (-item["score"], item["table_pos"], item["column_index"]))
    return scored[:limit]


def match_columns(columns: list[dict], header_lists: list[list[str]]) -> dict:
    """批量匹配：给界面「按列名匹配 / 自动预匹配」用，界面不重复实现这套规则。

    `columns` 是 `[{"key": ..., "name": ...}]`，返回
    `{"matches": [...], "candidates": {key: [...]}, "names": {key: {...}}}`：
    - `matches` 里是命中的那些（未命中的不出现），每项含 `via`（exact/alias/similar）、
      `score`、`alias`（备注名命中时命中的那个括号名原文）；
    - `candidates` 是没命中的目标列的候选来源列；
    - `names` 告诉界面这一列**实际拿去匹配的名字**（含括号时就是括号里的备注名），
      界面上要能说清"为什么没匹配上"。
    """
    matches: list[dict] = []
    candidates: dict[str, list[dict]] = {}
    names: dict[str, dict] = {}
    for col in columns or []:
        if not isinstance(col, dict):
            continue
        key = str(col.get("key"))
        effective = target_match_names(col.get("name"))
        names[key] = {
            "match": effective,
            "bracketed": bool(bracket_aliases(col.get("name"))),
        }
        match = resolve(col.get("name"), header_lists)
        if match is None:
            near = similar_candidates(col.get("name"), header_lists)
            if near:
                candidates[key] = near
            continue
        headers = header_lists[match.table_pos] or []
        raw = headers[match.column_index] if match.column_index < len(headers) else ""
        matches.append({
            "key": col.get("key"),
            "name": col.get("name"),
            "table_pos": match.table_pos,
            "column_index": match.column_index,
            "column_name": raw,
            "via": match.via,
            "alias": match.alias,
            "score": match.score,
        })
    return {"matches": matches, "candidates": candidates, "names": names}


class TableMatcher:
    """给同一张表的很多次查找用：表头索引只建一次，结果按列名缓存。

    纵向合并时每张表要跑几万行 × 十几列，不缓存的话每行都要重算别名。

    这里只做**精确 + 备注名**两层，不做相似度：纵向合并是"同构表按列名对齐"，
    相似度兜底反而容易把两列不同的表对齐错；需要模糊对齐时由界面显式逐列选。
    """

    __slots__ = ("headers", "_index", "_cache")

    def __init__(self, headers: list[str]) -> None:
        self.headers = list(headers or [])
        self._index = header_index(self.headers)
        self._cache: dict[str, tuple[int, str]] = {}

    def resolve(self, target_name: object) -> tuple[int, str]:
        """返回 (列下标, 'exact'|'alias')，找不到给 (-1, '')。"""
        key = match_key(target_name)
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        found: tuple[int, str] = (-1, "")
        for candidate, kind, _text in candidate_names(target_name):
            hit = self._index.get(candidate)
            if hit is not None:
                found = (hit, kind)
                break
        self._cache[key] = found
        return found


__all__ = [
    "ALIAS", "CANDIDATE_LIMIT", "CLOSE_BRACKETS", "EXACT", "NAME", "OPEN_BRACKETS",
    "SIMILAR", "SIMILARITY_MIN", "VIA_LABELS", "Match", "TableMatcher",
    "bracket_aliases", "candidate_names", "header_index", "match_columns", "match_key",
    "normalize_name", "resolve", "similar_candidates", "similarity", "target_match_names",
]
