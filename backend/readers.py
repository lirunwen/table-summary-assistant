"""Excel / CSV / 邮件正文表格的读取与表头分析。"""
from __future__ import annotations

import csv
import io
import os
from collections import OrderedDict
from pathlib import Path
from typing import Any

from .config import (
    LIMIT_EXCEL_MB,
    MAX_CELLS,
    MAX_COLS,
    MAX_ROWS,
    PREVIEW_ROWS,
)
from .utils import (
    UserError,
    dedupe_headers,
    detect_header_row,
    format_value,
)

csv.field_size_limit(10 * 1024 * 1024)


def decode_bytes(data: bytes) -> str:
    if not data:
        return ""
    for enc in ("utf-8-sig", "utf-8", "gb18030", "gbk", "big5", "utf-16", "latin-1"):
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", "replace")


def _sniff_delimiter(text: str) -> str:
    head = text[:8192]
    try:
        dialect = csv.Sniffer().sniff(head, delimiters=",;\t|")
        return dialect.delimiter
    except Exception:
        counts = {d: head.count(d) for d in (",", "\t", ";", "|")}
        best = max(counts, key=counts.get)
        return best if counts[best] > 0 else ","


def read_csv_grid(path: Path | str) -> list[list[Any]]:
    raw = Path(path).read_bytes()
    text = decode_bytes(raw)
    if not text.strip():
        return []
    delimiter = _sniff_delimiter(text)
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)
    grid: list[list[Any]] = []
    for i, row in enumerate(reader):
        if i > MAX_ROWS + 30:
            break
        grid.append([c.strip() if isinstance(c, str) else c for c in row[:MAX_COLS]])
    return grid


def _fill_merged(ws, grid: list[list[Any]]) -> None:
    try:
        ranges = list(ws.merged_cells.ranges)
    except Exception:
        return
    for rng in ranges[:5000]:
        try:
            r0, c0 = rng.min_row - 1, rng.min_col - 1
            if r0 >= len(grid) or c0 >= len(grid[r0]):
                continue
            value = grid[r0][c0]
            if value is None:
                continue
            for r in range(rng.min_row - 1, min(rng.max_row, len(grid))):
                for c in range(rng.min_col - 1, min(rng.max_col, len(grid[r]))):
                    grid[r][c] = value
        except Exception:
            continue


def read_excel_grids(path: Path | str, only_sheets: set[str] | None = None) -> list[dict]:
    """读取工作簿为二维数组。

    only_sheets 用于只解析真正被方案引用的工作表——以前一个 20 个 sheet 的
    台账文件，为了读 1 张表也要把 20 张全部解析一遍。
    """
    path = Path(path)
    if path.stat().st_size > LIMIT_EXCEL_MB * 1024 * 1024:
        raise UserError(f"这个 Excel 文件超过 {LIMIT_EXCEL_MB} MB，建议先在 Excel 中拆分后再上传。")
    try:
        from openpyxl import load_workbook

        wb = load_workbook(path, data_only=True, read_only=False, keep_links=False)
    except Exception as exc:
        raise UserError(f"无法读取 Excel 文件：{exc}") from exc
    results = []
    try:
        for ws in wb.worksheets:
            if only_sheets is not None and ws.title not in only_sheets:
                continue
            max_row = min(ws.max_row or 0, MAX_ROWS + 40)
            max_col = min(ws.max_column or 1, MAX_COLS)
            if max_row * max_col > MAX_CELLS:
                raise UserError(
                    f"工作表「{ws.title}」约 {max_row} 行 × {max_col} 列，"
                    f"超过 {MAX_CELLS:,} 个单元格的处理上限。"
                    "请先在 Excel 中删除空白行列、拆分工作表，或只上传需要的部分。"
                )
            grid: list[list[Any]] = []
            for row in ws.iter_rows(min_row=1, max_row=max_row, max_col=max_col):
                grid.append([cell.value for cell in row])
            _fill_merged(ws, grid)
            grid = [[format_value(v) for v in row] for row in grid]
            results.append({
                "name": ws.title,
                "grid": grid,
                "hidden": ws.sheet_state != "visible",
            })
    finally:
        try:
            wb.close()
        except Exception:
            pass
    return results


def read_xls_grids(path: Path | str) -> list[dict]:
    try:
        import xlrd
    except ImportError as exc:
        raise UserError("读取 .xls 需要 xlrd 组件，请检查安装是否完整。") from exc
    try:
        book = xlrd.open_workbook(str(path), on_demand=True)
    except Exception as exc:
        raise UserError(f"无法读取 .xls 文件：{exc}") from exc
    results = []
    try:
        for sheet in book.sheets():
            grid: list[list[Any]] = []
            for r in range(min(sheet.nrows, MAX_ROWS + 40)):
                row = []
                for c in range(min(sheet.ncols, MAX_COLS)):
                    cell = sheet.cell(r, c)
                    value = cell.value
                    if cell.ctype == xlrd.XL_CELL_DATE:
                        try:
                            value = xlrd.xldate.xldate_as_datetime(value, book.datemode)
                        except Exception:
                            pass
                    elif cell.ctype == xlrd.XL_CELL_EMPTY:
                        value = None
                    row.append(format_value(value))
                grid.append(row)
            results.append({"name": sheet.name, "grid": grid, "hidden": False})
    finally:
        try:
            book.release_resources()
        except Exception:
            pass
    return results


def _trim_grid(grid: list[list[Any]]) -> list[list[Any]]:
    """去掉尾部完全空白的行与列，避免生成一堆“列 80”。"""
    def row_empty(row):
        return all(v is None or str(v).strip() == "" for v in row)

    while grid and row_empty(grid[-1]):
        grid.pop()
    max_col = 0
    for row in grid:
        for i, v in enumerate(row):
            if v is not None and str(v).strip() != "":
                max_col = max(max_col, i + 1)
    if max_col == 0:
        return []
    max_col = min(max_col, MAX_COLS)
    return [(row + [None] * max_col)[:max_col] for row in grid]


def analyze_grid(grid: list[list[Any]], header_row: int | None = None,
                 trim: bool = True) -> dict:
    if trim:
        grid = _trim_grid(grid)
    if not grid:
        return {
            "header_row": 1, "headers": [], "row_count": 0, "sample": [],
            "col_count": 0, "truncated": False,
        }
    if header_row is None:
        hr = detect_header_row(grid)
    else:
        hr = max(1, min(int(header_row), len(grid)))
    header_values = grid[hr - 1] if hr - 1 < len(grid) else []
    headers = dedupe_headers(header_values)
    data = grid[hr:]
    # 跳过完全空行
    data = [r for r in data if any(v is not None and str(v).strip() != "" for v in r)]
    truncated = len(data) > MAX_ROWS
    data = data[:MAX_ROWS]
    sample = []
    for row in data[:PREVIEW_ROWS]:
        sample.append([row[i] if i < len(row) else None for i in range(len(headers))])
    return {
        "header_row": hr,
        "headers": headers,
        "row_count": len(data),
        "sample": sample,
        "col_count": len(headers),
        "truncated": truncated,
    }


def _table_meta(source_id: str, key: str, label: str, sheet: str | None,
                kind: str, info: dict, hidden: bool = False, path: str | None = None) -> dict:
    return {
        "key": key,
        "id": f"{source_id}::{key}",
        "label": label,
        "sheet": sheet,
        "kind": kind,
        "hidden": hidden,
        "path": path,
        "header_row": info["header_row"],
        "headers": info["headers"],
        "row_count": info["row_count"],
        "col_count": info["col_count"],
        "sample": info["sample"],
        "truncated": info["truncated"],
    }


def tables_for_excel(path: Path, source_id: str) -> list[dict]:
    suffix = path.suffix.lower()
    grids = read_xls_grids(path) if suffix == ".xls" else read_excel_grids(path)
    tables = []
    idx = 0
    for sheet in grids:
        if not any(any(v is not None and str(v).strip() != "" for v in row) for row in sheet["grid"]):
            continue
        info = analyze_grid(sheet["grid"])
        if not info["headers"]:
            continue
        key = f"s{idx}"
        tables.append(_table_meta(
            source_id, key, sheet["name"], sheet["name"],
            "excel" if suffix != ".xls" else "xls",
            info, hidden=sheet.get("hidden", False),
        ))
        idx += 1
    return tables


def table_for_csv(path: Path, source_id: str, label: str | None = None,
                  header_row: int | None = None, key: str = "c0",
                  kind: str = "csv", stored_path: str | None = None) -> dict:
    grid = read_csv_grid(path)
    info = analyze_grid(grid, header_row)
    if not info["headers"]:
        raise UserError("这个 CSV 文件里没有可识别的表头和数据。")
    return _table_meta(source_id, key, label or path.stem, None, kind, info,
                       path=stored_path)


def rebuild_table_meta(source: dict, table: dict, header_row: int | None = None) -> dict:
    """用户调整表头行后，重新计算 headers / sample / row_count。"""
    path = Path(table.get("path") or source["path"])
    kind = table.get("kind")
    hr = header_row or table.get("header_row") or 1
    if kind in ("excel", "xls"):
        grids = (read_xls_grids(path) if kind == "xls"
                 else read_excel_grids(path, only_sheets={table.get("sheet")}))
        target = next((g for g in grids if g["name"] == table.get("sheet")), None)
        if not target:
            raise UserError("找不到原来的工作表，文件可能已被移动。")
        info = analyze_grid(target["grid"], hr)
    elif kind in ("csv", "mail_table"):
        grid = read_csv_grid(path)
        info = analyze_grid(grid, hr)
    else:
        raise UserError("不支持的数据表类型")
    if not info["headers"]:
        raise UserError("这个表头行没有可用的列名。")
    updated = dict(table)
    updated.update(info)
    return updated


def read_table_data(source: dict, table: dict) -> tuple[list[str], list[list[Any]], bool]:
    """读取整张表，返回 (headers, rows, truncated)。headers 与列索引严格对齐。"""
    path = Path(table.get("path") or source["path"])
    kind = table.get("kind")
    hr = int(table.get("header_row") or 1)
    if kind in ("excel", "xls"):
        grids = (read_xls_grids(path) if kind == "xls"
                 else read_excel_grids(path, only_sheets={table.get("sheet")}))
        target = next((g for g in grids if g["name"] == table.get("sheet")), None)
        if not target:
            raise UserError(f"文件「{source['name']}」中找不到工作表「{table.get('sheet')}」。")
        grid = target["grid"]
    elif kind in ("csv", "mail_table"):
        grid = read_csv_grid(path)
    else:
        raise UserError("不支持的数据表类型")

    grid = _trim_grid(grid)
    if not grid:
        return [], [], False
    hr = max(1, min(hr, len(grid)))
    # 已经 trim 过了，别再让 analyze_grid 从头扫一遍整张网格
    info = analyze_grid(grid, hr, trim=False)
    data = grid[hr:]
    data = [r for r in data if any(v is not None and str(v).strip() != "" for v in r)]
    truncated = len(data) > MAX_ROWS
    data = data[:MAX_ROWS]
    width = len(info["headers"])
    rows = [[(row[i] if i < len(row) else None) for i in range(width)] for row in data]
    return info["headers"], rows, truncated


# ---------------------------------------------------------------------------
# 解析结果缓存
#
# 用户调字段映射时会反复点「预览」，以前每一次都是完整的一次 openpyxl 读盘
# （5 万行实测 8.1s）。这里按「文件 + mtime + 大小 + 表 + 表头行」做键缓存，
# 文件一改 mtime 就变，自动失效，不需要手动清理。
#
# 只缓存中小表：大表本身就很占内存，再缓存一份只会把 600 MB 变成 1.2 GB。
# ---------------------------------------------------------------------------
_TABLE_CACHE: "OrderedDict[tuple, tuple]" = OrderedDict()
_TABLE_CACHE_MAX = 3
# 单表超过这个单元格数就不缓存（默认 40 万，约等于 5 万行 × 8 列）。
# 大表本身已经吃掉几百 MB，再留一份缓存会把内存直接翻倍；内存宽裕的机器
# 可以用环境变量 HUIYI_TABLE_CACHE_CELLS 调大，设 0 表示关闭缓存。
try:
    _TABLE_CACHE_MAX_CELLS = max(0, int(os.environ.get("HUIYI_TABLE_CACHE_CELLS") or 400_000))
except ValueError:
    _TABLE_CACHE_MAX_CELLS = 400_000


def _table_cache_key(source: dict, table: dict):
    path = Path(table.get("path") or source.get("path") or "")
    try:
        stat = path.stat()
    except OSError:
        return None
    return (
        str(path), stat.st_mtime_ns, stat.st_size,
        table.get("kind"), table.get("sheet"), int(table.get("header_row") or 1),
    )


def clear_table_cache() -> None:
    _TABLE_CACHE.clear()


def read_table_data_cached(source: dict, table: dict) -> tuple[list[str], list[list[Any]], bool]:
    """read_table_data 的带缓存版本。返回的列表视为只读，调用方不要原地修改。"""
    key = _table_cache_key(source, table)
    if key is None:
        return read_table_data(source, table)
    hit = _TABLE_CACHE.get(key)
    if hit is not None:
        _TABLE_CACHE.move_to_end(key)
        return hit
    result = read_table_data(source, table)
    headers, rows = result[0], result[1]
    if len(rows) * max(len(headers), 1) <= _TABLE_CACHE_MAX_CELLS:
        _TABLE_CACHE[key] = result
        while len(_TABLE_CACHE) > _TABLE_CACHE_MAX:
            _TABLE_CACHE.popitem(last=False)
    return result
