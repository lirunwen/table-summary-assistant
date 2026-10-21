"""字段映射的两项增强：Excel 公式、列级日期格式。

覆盖三层：
1. formula 引擎本身（优先级、函数、错误码、语法错误）；
2. engine 的映射与校验（公式列输出、引用缺失、空公式、失败降级）；
3. writer 的日期格式是否真的写进了单元格 number_format。
"""
from __future__ import annotations

import datetime as dt
import io

import pytest
from openpyxl import Workbook, load_workbook

from backend import writer
from backend.engine import build, validate_config
from backend.formula import (
    FormulaError,
    FormulaSyntaxError,
    compile_formula,
)

# --------------------------------------------------------------------------
# 1. 公式引擎
# --------------------------------------------------------------------------

FIELDS = {
    "单价": 12.5,
    "数量": 4,
    "空": None,
    "姓名": "张三",
    "金额文本": "1,234.5",
    "入职日期": dt.date(2020, 3, 5),
    "离职日期": dt.date(2026, 10, 21),
    "部门": "研发部",
    "备注": "",
}


@pytest.mark.parametrize("expr,expected", [
    ("=1+2*3", 7),
    ("=(1+2)*3", 9),
    ("=2^3^2", 512),                  # 幂右结合
    ("=10/4", 2.5),
    ("=[单价]*[数量]", 50),
    ("=[空]*2", 0),                   # 空值在算术里当 0
    ("=[空]+5", 5),
    ("=[单价]*2", 25),                # 省略等号也认
    ('=[姓名]&"（"&[部门]&"）"', "张三（研发部）"),
    ('=CONCAT([姓名], "-", [部门])', "张三-研发部"),
    ("=ROUND(2.5, 0)", 3),            # Excel 是四舍五入，不是银行家舍入
    ("=ROUND(-2.5, 0)", -3),
    ("=ROUNDUP(3.1, 0)", 4),
    ("=ROUNDDOWN(3.9, 0)", 3),
    ("=SUM(1, 2, 3)", 6),
    ("=MAX(1, 9, 3)", 9),
    ("=ABS(-7)", 7),
    ("=MOD(10, 3)", 1),
    ("=LEN([姓名])", 2),
    ("=LEFT([姓名], 1)", "张"),
    ("=MID([姓名], 2, 1)", "三"),
    ("=VALUE([金额文本])", 1234.5),
    ("=YEAR([入职日期])", 2020),
    ("=MONTH([入职日期])", 3),
    ("=DAYS([离职日期], [入职日期])", 2421),
    ("=EDATE([入职日期], 12)", dt.date(2021, 3, 5)),
    ("=EOMONTH([入职日期], 0)", dt.date(2020, 3, 31)),
    ('=TEXT(1234.5, "#,##0.00")', "1,234.50"),
    ('=TEXT(0.256, "0.0%")', "25.6%"),
    ('=TEXT([入职日期], "YYYY年M月D日")', "2020年3月5日"),
    ('=TEXT([入职日期], "YYYY-MM-DD")', "2020-03-05"),
    ("=[离职日期]-[入职日期]", 2421),  # 日期相减得天数
    ('=IF([数量]>3, "多", "少")', "多"),
    ('=IF([数量]>10, "多", "少")', "少"),
    ('=IFERROR(1/0, "算不了")', "算不了"),
    ('=IFERROR([单价]/[数量], 0)', 3.125),
    ('=IF([数量]>1，"是"，"否")', "是"),   # 中文逗号
    ("=ISBLANK([空])", "TRUE"),
    ("=ISBLANK([姓名])", "FALSE"),
    ("=AND(1, 0)", "FALSE"),
    ("=OR(1, 0)", "TRUE"),
])
def test_formula_evaluates(expr, expected):
    got = compile_formula(expr).evaluate(FIELDS)
    if isinstance(expected, float):
        assert abs(got - expected) < 1e-9
    else:
        assert got == expected


@pytest.mark.parametrize("expr,code", [
    ("=1/0", "#DIV/0!"),
    ("=[不存在的字段]", "#REF!"),
    ('=LEFT("a", -1)', "#VALUE!"),
    ("=SQRT(-1)", "#NUM!"),
])
def test_formula_runtime_errors_use_excel_codes(expr, code):
    with pytest.raises(FormulaError) as err:
        compile_formula(expr).evaluate(FIELDS)
    assert err.value.code == code


@pytest.mark.parametrize("expr", [
    "=1+", "=(1+2", "=[姓名", '="未闭合', "=姓名", "=NOSUCHFN(1)", "=",
])
def test_formula_syntax_errors(expr):
    with pytest.raises(FormulaSyntaxError):
        compile_formula(expr)


def test_formula_reports_referenced_fields():
    assert compile_formula("=[单价]*[数量]").refs == ["单价", "数量"]


# --------------------------------------------------------------------------
# 2. engine：映射与校验
# --------------------------------------------------------------------------

HEADER = ["工号", "单价", "数量", "日期", "备注"]
DATA = [
    ["A001", 10, 3, "2026-03-05", ""],
    ["A002", 0, 5, "2026-10-21", ""],
    ["A003", 8, 0, "2025-01-09", ""],
]


def _upload(client, rows=None, name="t.xlsx"):
    wb = Workbook()
    ws = wb.active
    for row in (rows or [HEADER] + DATA):
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    up = client.post("/api/sources/upload", data={"files": [(buf, name)]},
                     content_type="multipart/form-data").get_json()
    return up["created"][0]["meta"]["tables"][0]


def _config(table, cols, mappings):
    return {
        "mode": "join",
        "primary_table": table["id"],
        "primary_keys": [0],
        "lookups": [],
        "append_tables": [],
        "auto_by_name": True,
        "target": {"kind": "blank", "sheet": "汇总", "header_row": 1, "columns": cols},
        "mappings": mappings,
        "options": {"dedupe": True, "skip_empty_key": False},
    }


def _cols(*specs):
    return [{"key": k, "name": n, "type": t, "included": True} for k, n, t in specs]


def test_build_formula_columns(client):
    table = _upload(client)
    tid = table["id"]
    cols = _cols(("k0", "工号", "text"), ("k1", "总额", "number"),
                 ("k2", "判断", "text"), ("k3", "均摊", "text"))
    mappings = {
        "k0": {"mode": "table", "table_id": tid, "column_index": 0, "transform": "direct"},
        "k1": {"mode": "table", "table_id": tid, "column_index": 1,
               "formula_on": True, "formula": "=[单价]*[数量]"},
        "k2": {"mode": "table", "table_id": tid, "column_index": 2,
               "formula_on": True, "formula": '=IF([数量]>=3, "多", "少")'},
        "k3": {"mode": "table", "table_id": tid, "column_index": 1,
               "formula_on": True, "formula": '=IFERROR([单价]/[数量], "除零")'},
    }
    config = _config(table, cols, mappings)
    assert validate_config(config)["ok"] is True

    result = build(config)
    assert result["headers"] == ["工号", "总额", "判断", "均摊"]
    assert result["rows"] == [
        ["A001", 30, "多", pytest.approx(10 / 3)],
        ["A002", 0, "多", 0],
        ["A003", 0, "少", "除零"],
    ]
    assert result["stats"]["rows"] == 3


def test_build_formula_failure_writes_error_and_warns(client):
    table = _upload(client)
    tid = table["id"]
    cols = _cols(("k0", "工号", "text"), ("k1", "单价除数量", "text"))
    mappings = {
        "k0": {"mode": "table", "table_id": tid, "column_index": 0, "transform": "direct"},
        # 第三行数量为 0 → 除零
        "k1": {"mode": "table", "table_id": tid, "column_index": 1,
               "formula_on": True, "formula": "=[单价]/[数量]"},
    }
    result = build(_config(table, cols, mappings))
    assert result["rows"][2][1] == "#DIV/0!"
    assert any("公式计算失败" in w and "#DIV/0!" in w for w in result["warnings"])


def test_validate_rejects_empty_formula(client):
    table = _upload(client)
    tid = table["id"]
    cols = _cols(("k0", "工号", "text"))
    mappings = {"k0": {"mode": "table", "table_id": tid, "column_index": 0,
                       "formula_on": True, "formula": "   "}}
    check = validate_config(_config(table, cols, mappings))
    assert check["ok"] is False
    assert any("公式但内容为空" in e for e in check["errors"])


def test_validate_rejects_bad_syntax(client):
    table = _upload(client)
    tid = table["id"]
    cols = _cols(("k0", "工号", "text"))
    mappings = {"k0": {"mode": "table", "table_id": tid, "column_index": 0,
                       "formula_on": True, "formula": "=[单价]*"}}
    check = validate_config(_config(table, cols, mappings))
    assert check["ok"] is False
    assert any("公式语法错误" in e for e in check["errors"])


def test_validate_rejects_unknown_field(client):
    table = _upload(client)
    tid = table["id"]
    cols = _cols(("k0", "工号", "text"))
    mappings = {"k0": {"mode": "table", "table_id": tid, "column_index": 0,
                       "formula_on": True, "formula": "=[不存在的列]*2"}}
    check = validate_config(_config(table, cols, mappings))
    assert check["ok"] is False
    assert any("不存在的字段" in e and "不存在的列" in e for e in check["errors"])


def test_formula_disabled_falls_back_to_plain_mapping(client):
    table = _upload(client)
    tid = table["id"]
    cols = _cols(("k0", "工号", "text"), ("k1", "单价", "number"))
    mappings = {
        "k0": {"mode": "table", "table_id": tid, "column_index": 0, "transform": "direct"},
        # formula_on 为 false：公式只是留着备忘，不生效
        "k1": {"mode": "table", "table_id": tid, "column_index": 1,
               "transform": "direct", "formula_on": False, "formula": "=[单价]*999"},
    }
    result = build(_config(table, cols, mappings))
    assert [r[1] for r in result["rows"]] == [10, 0, 8]


# --------------------------------------------------------------------------
# 3. API：速查 / 校验 / 试算
# --------------------------------------------------------------------------

def test_formula_help_lists_functions_and_date_formats(client):
    body = client.get("/api/formula/help").get_json()
    assert body["ok"] is True
    names = {item["name"] for group in body["functions"] for item in group["items"]}
    assert {"SUM", "IF", "CONCAT", "TEXT", "YEAR", "EDATE"} <= names
    assert "YYYY-MM-DD" in body["date_formats"]
    assert "YYYY年M月D日" in body["date_formats"]


def test_formula_check_api(client):
    table = _upload(client)
    tid = table["id"]

    good = client.post("/api/formula/check",
                       json={"formula": "=[单价]*[数量]", "table_ids": [tid]}).get_json()
    assert good["valid"] is True and good["refs"] == ["单价", "数量"]

    empty = client.post("/api/formula/check",
                        json={"formula": "  ", "table_ids": [tid]}).get_json()
    assert empty["valid"] is False and "不能为空" in empty["error"]

    bad = client.post("/api/formula/check",
                      json={"formula": "=[单价]*", "table_ids": [tid]}).get_json()
    assert bad["valid"] is False and "语法错误" in bad["error"]

    missing = client.post("/api/formula/check",
                          json={"formula": "=[没有这列]", "table_ids": [tid]}).get_json()
    assert missing["valid"] is False and "找不到字段" in missing["error"]


def test_formula_try_api(client):
    table = _upload(client)
    body = client.post("/api/formula/try",
                       json={"formula": "=[单价]*[数量]", "table_id": table["id"],
                             "limit": 3}).get_json()
    assert body["ok"] is True
    assert [s["result"] for s in body["samples"]] == [30, 0, 0]
    assert body["total_rows"] == 3


# --------------------------------------------------------------------------
# 4. writer：列级日期格式
# --------------------------------------------------------------------------

@pytest.mark.parametrize("fmt_key,expected", [
    ("YYYY-MM-DD", "yyyy-mm-dd"),
    ("YYYY/M/D", "yyyy/m/d"),
    ("YYYY年M月D日", 'yyyy"年"m"月"d"日"'),
    ("YYYYMMDD", "yyyymmdd"),
    ("M月D日", 'm"月"d"日"'),
])
def test_column_date_format_is_written(workdir, fmt_key, expected):
    cols = [{"key": "k0", "name": "日期", "type": "date", "included": True}]
    config = {
        "mode": "append", "append_tables": ["t::c0"], "auto_by_name": True,
        "target": {"kind": "blank", "sheet": "汇总", "header_row": 1, "columns": cols},
        "mappings": {"k0": {"mode": "table", "table_id": "t::c0", "column_index": 0,
                            "transform": "date", "date_format": fmt_key}},
    }
    result = {"headers": ["日期"], "rows": [["2026-03-05"]],
              "stats": {"rows": 1, "columns": 1, "empty_cells": 0, "duration_ms": 1},
              "sources": [], "warnings": []}
    out = workdir / "d.xlsx"
    writer._blank_workbook(out, ["日期"], [["2026-03-05"]], config, result, "日期格式")

    cell = load_workbook(out)["汇总"]["A2"]
    assert cell.value == dt.datetime(2026, 3, 5, 0, 0) or cell.value == dt.date(2026, 3, 5)
    assert cell.number_format == expected


def test_date_format_ignored_when_column_not_date(workdir):
    """日期格式只对「类型=日期」的列生效，普通文本列不受影响。"""
    cols = [{"key": "k0", "name": "工号", "type": "text", "included": True}]
    config = {
        "mode": "append", "append_tables": ["t::c0"], "auto_by_name": True,
        "target": {"kind": "blank", "sheet": "汇总", "header_row": 1, "columns": cols},
        "mappings": {"k0": {"mode": "table", "table_id": "t::c0", "column_index": 0,
                            "transform": "direct", "date_format": "YYYY年M月D日"}},
    }
    result = {"headers": ["工号"], "rows": [["10001"]],
              "stats": {"rows": 1, "columns": 1, "empty_cells": 0, "duration_ms": 1},
              "sources": [], "warnings": []}
    out = workdir / "t.xlsx"
    writer._blank_workbook(out, ["工号"], [["10001"]], config, result, "文本")
    cell = load_workbook(out)["汇总"]["A2"]
    assert cell.value == "10001"
    assert cell.number_format != 'yyyy"年"m"月"d"日"'
