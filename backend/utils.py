"""通用工具：ID、时间、单元格值规整、表头处理等。"""
from __future__ import annotations

import datetime as dt
import re
import unicodedata
import uuid
from decimal import Decimal
from typing import Any

from .config import MAX_COLS


class UserError(Exception):
    """可直接展示给用户的业务错误。"""


def uid(prefix: str = "") -> str:
    raw = uuid.uuid4().hex[:12]
    return f"{prefix}{raw}" if prefix else raw


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


def safe_filename(name: str, fallback: str = "file") -> str:
    name = (name or "").strip()
    name = name.replace("\\", "_").replace("/", "_")
    name = re.sub(r'[<>:"|?*\x00-\x1f]', "_", name)
    name = name.strip(" .")
    if not name:
        return fallback
    if len(name) > 120:
        stem = re.sub(r"\.[^.]+$", "", name)[:100]
        suffix = name[len(stem):][-20:]
        name = stem + suffix
    return name


def unique_path(directory, filename: str):
    from pathlib import Path

    directory = Path(directory)
    candidate = directory / filename
    if not candidate.exists():
        return candidate
    stem = candidate.stem
    suffix = candidate.suffix
    i = 2
    while True:
        c = directory / f"{stem} ({i}){suffix}"
        if not c.exists():
            return c
        i += 1


def format_value(value: Any) -> Any:
    """把 Excel 单元格值转换成可 JSON 序列化、便于比较的 Python 值。"""
    if value is None:
        return None
    if isinstance(value, dt.datetime):
        if value.tzinfo is not None:
            value = value.replace(tzinfo=None)
        if value.hour == 0 and value.minute == 0 and value.second == 0 and value.microsecond == 0:
            return value.date().isoformat()
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, dt.time):
        return value.isoformat(timespec="seconds")
    if isinstance(value, dt.timedelta):
        total = int(value.total_seconds())
        return f"{total // 3600:02d}:{total % 3600 // 60:02d}:{total % 60:02d}"
    if isinstance(value, Decimal):
        f = float(value)
        return int(f) if f.is_integer() else f
    if isinstance(value, float):
        if value != value:  # NaN
            return None
        if value.is_integer() and abs(value) < 1e15:
            return int(value)
        return value
    if isinstance(value, (int, bool)):
        return value
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", "ignore")
        except Exception:
            return ""
    text = str(value)
    # openpyxl 有时会把非法 XML 字符带进来
    return "".join(ch for ch in text if ch == "\n" or ch == "\t" or ord(ch) >= 32)


def stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def display_value(value: Any) -> str:
    """写回 Excel 前的基础规整，日期以字符串形式输出时保持稳定。"""
    if value is None:
        return ""
    if isinstance(value, dt.datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, bool):
        return "是" if value else "否"
    return str(value)


def norm_key(value: Any) -> str:
    """关联键归一化：忽略首尾空白、数字 1.0 与 1 的差异、日期格式差异。"""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    if isinstance(value, dt.datetime):
        if value.hour == 0 and value.minute == 0 and value.second == 0:
            value = value.date()
        else:
            value = value.replace(microsecond=0)
    if isinstance(value, (dt.date, dt.time)):
        return value.isoformat()
    text = unicodedata.normalize("NFKC", str(value)).strip()
    text = re.sub(r"\s+", " ", text)
    return text


def dedupe_headers(headers: list[Any]) -> list[str]:
    """表头转字符串、补空列名、重名加序号。列位置本身不受影响。"""
    out: list[str] = []
    seen: dict[str, int] = {}
    for i, h in enumerate(headers):
        if h is None or str(h).strip() == "":
            base = f"列{i + 1}"
        else:
            base = str(h).strip().replace("\n", " ")
            base = re.sub(r"\s+", " ", base)
        base = base[:120]
        count = seen.get(base, 0)
        seen[base] = count + 1
        out.append(base if count == 0 else f"{base} ({count + 1})")
    return out[:MAX_COLS]


def header_score(row: list[Any], data_rows: list[list[Any]]) -> float:
    """给一行打“像表头”的分，用于自动识别表头行。"""
    cells = [c for c in row if c is not None and str(c).strip() != ""]
    if len(cells) < 2:
        return -1.0
    strings = sum(1 for c in cells if isinstance(c, str) and not re.fullmatch(r"[\d.\-+/%]+", c.strip()))
    unique = len({norm_key(c) for c in cells})
    score = len(cells) * 1.2 + strings / max(len(cells), 1) * 3 + unique / max(len(cells), 1) * 2
    # 下一行如果和本行大量相同，说明可能是重复数据而非表头
    if data_rows:
        nxt = data_rows[0]
        overlap = len({norm_key(c) for c in cells} & {norm_key(c) for c in nxt if c is not None})
        score -= overlap * 0.35
    return score


def detect_header_row(grid: list[list[Any]], default: int = 1, scan: int = 10) -> int:
    """在前若干行中猜测表头行，返回 1-based 行号。"""
    if not grid:
        return max(1, default)
    best_row = max(1, default)
    best_score = -999.0
    limit = min(scan, len(grid))
    for i in range(limit):
        row = grid[i]
        nonempty = sum(1 for c in row if c is not None and str(c).strip() != "")
        if nonempty < 2:
            continue
        score = header_score(row, grid[i + 1:i + 3])
        # 轻微偏向靠前的行，避免把数据行当表头
        score -= i * 0.15
        if score > best_score:
            best_score, best_row = score, i + 1
    return best_row


AMBIGUOUS_DMY_RE = re.compile(r"^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$")


def ambiguous_date(value: Any) -> bool:
    """形如 03/04/2026（两段都 ≤12）的日期，日月顺序无法从单条数据判断。"""
    if not isinstance(value, str):
        return False
    m = AMBIGUOUS_DMY_RE.fullmatch(value.strip())
    if not m:
        return False
    return int(m.group(1)) <= 12 and int(m.group(2)) <= 12


def parse_date_value(value: Any) -> tuple[bool, Any]:
    """尽量识别日期，返回 (是否识别, date/datetime 或原值)。

    对 03/04/2026 这类无法区分日/月顺序的输入**不猜**：返回 False 让调用方
    保留原文并给出警告。猜错一次，整列日期就是错的，而且不会有人发现。
    """
    if isinstance(value, (dt.datetime, dt.date)):
        return True, value
    if value is None or value == "":
        return False, value
    text = str(value).strip()
    if not text:
        return False, value

    # 先处理「两位 + 两位 + 四位」，因为日月顺序要靠数值大小判断
    m = AMBIGUOUS_DMY_RE.fullmatch(text)
    if m:
        first, second, year = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            if first > 12 >= second:          # 只能是 日/月
                return True, dt.date(year, second, first)
            if second > 12 >= first:          # 只能是 月/日
                return True, dt.date(year, first, second)
        except ValueError:
            return False, value
        return False, value                    # 两段都 ≤12：歧义，保留原文

    patterns = [
        "%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y年%m月%d日",
        "%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M",
        "%Y/%m/%d %H:%M", "%Y%m%d",
    ]
    for fmt in patterns:
        try:
            parsed = dt.datetime.strptime(text, fmt)
            if "%H" not in fmt:
                return True, parsed.date()
            return True, parsed
        except ValueError:
            continue
    # Excel 序列号（1900 日期系统）
    if re.fullmatch(r"\d{5}(\.\d+)?", text):
        try:
            base = dt.datetime(1899, 12, 30)
            return True, (base + dt.timedelta(days=float(text))).date()
        except Exception:
            pass
    return False, value


def coerce_number(value: Any):
    """把单元格值转成数字。

    百分比按数学语义折算："50%" → 0.5（写入时配 0.00% 格式显示回 50%）。
    无法解析时返回 None，由调用方决定是否套缺省值。
    """
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    text = str(value).strip()
    is_percent = text.endswith("%")
    text = text.replace(",", "").replace("，", "")
    text = re.sub(r"[¥￥$元]\s*", "", text)
    text = text.replace("%", "").strip()
    try:
        f = float(text)
    except Exception:
        return None
    if is_percent:
        f = f / 100.0
        return f
    return int(f) if f.is_integer() else f


def human_datetime(iso_text: str | None) -> str:
    if not iso_text:
        return "—"
    try:
        d = dt.datetime.fromisoformat(iso_text)
        return d.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return iso_text
