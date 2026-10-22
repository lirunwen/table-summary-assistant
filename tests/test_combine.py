"""字段来源链与合并方式：多源兜底、一对多聚合、旧配置兼容。"""
from __future__ import annotations

import pytest
from openpyxl import Workbook

from backend import fieldmap as fm


# ---------- 合并方式本身 ----------

def test_combine_catalog_covers_expected_modes():
    assert set(fm.COMBINES) == {"first", "sum", "count", "max", "min", "latest", "concat"}
    assert fm.combine_of({"combine": "SUM"}) == "sum"
    assert fm.combine_of({"combine": "不认识"}) == "first"
    assert fm.combine_of({}) == "first"


def test_first_takes_first_non_empty():
    items = [("", fm.sort_key("")), (None, fm.sort_key(None)), ("B", fm.sort_key("B"))]
    assert fm.aggregate("first", items) == "B"


def test_sum_skips_non_numeric_and_empty():
    items = [("2", fm.sort_key("2")), ("abc", fm.sort_key("abc")), (None, fm.sort_key(None)), (3, fm.sort_key(3))]
    assert fm.aggregate("sum", items) == 5.0
    assert fm.aggregate("sum", [("abc", None)]) is None


def test_count_counts_non_empty():
    items = [("x", None), ("", None), (None, None), (0, None)]
    assert fm.aggregate("count", items) == 2


def test_max_min_ignore_blanks():
    items = [("", fm.sort_key("")), ("2025-01-01", fm.sort_key("2025-01-01")),
             ("2026-05-01", fm.sort_key("2026-05-01"))]
    assert fm.aggregate("max", items) == "2026-05-01"
    assert fm.aggregate("min", items) == "2025-01-01"


def test_latest_uses_order_key_not_value():
    items = [("旧医院", fm.sort_key("2025-01-01")), ("新医院", fm.sort_key("2026-05-01"))]
    assert fm.aggregate("latest", items) == "新医院"


def test_concat_dedupes_and_uses_separator():
    items = [("开发", None), ("测试", None), ("开发", None)]
    assert fm.aggregate("concat", items) == "开发、测试"
    assert fm.aggregate("concat", items, "／") == "开发／测试"
    assert fm.aggregate("concat", [("", None)]) is None


def test_sources_of_reads_new_and_old_shapes():
    old = {"mode": "table", "table_id": "t1", "column_index": 2, "transform": "trim"}
    assert fm.sources_of(old) == [{"table_id": "t1", "column_index": 2, "transform": "trim"}]
    new = {"sources": [{"table_id": "t1", "column_index": 2},
                       {"table_id": "t2", "column_index": 5, "transform": "number"}]}
    assert [s["table_id"] for s in fm.sources_of(new)] == ["t1", "t2"]
    assert fm.sources_of({"mode": "const", "value": "x"}) == []
    assert fm.normalize_mapping(old)["kind"] == "sources"


# ---------- 端到端：真表格、真配置 ----------

def _xlsx(path, headers, rows):
    wb = Workbook()
    ws = wb.active
    ws.title = "数据"
    ws.append(headers)
    for row in rows:
        ws.append(row)
    wb.save(path)
    return path


def _upload(client, paths):
    resp = client.post("/api/sources/upload", data={
        "files": [(open(p, "rb"), p.name) for p in paths],
    }, content_type="multipart/form-data").get_json()
    return {s["name"]: s["meta"]["tables"][0] for s in resp["created"]}


def _config(mode, tables, columns, mappings, *, primary=None, keys=None, lookups=None, append=None):
    return {
        "mode": mode,
        "primary_table": primary,
        "primary_keys": keys or [],
        "lookups": lookups or [],
        "append_tables": append or [],
        "auto_by_name": True,
        "target": {"kind": "blank", "sheet": "汇总", "header_row": 1, "columns": columns},
        "mappings": mappings,
        "options": {"dedupe": True, "skip_empty_key": False},
    }


def _col(key, name, **extra):
    base = {"key": key, "name": name, "type": "auto", "included": True}
    base.update(extra)
    return base


def _src(table, headers, name, transform="direct"):
    return {"table_id": table["id"], "column_index": headers.index(name), "transform": transform}


def _join(emp, det, columns, mappings, *, lookups=None):
    """横向合并的配置：第一列（工号）固定取主表同名列，让用例只关心被测列。

    注：join 模式不做「同名列兜底」，列必须有显式来源（前端建方案时会自动填），
    所以这里把主键列补上，避免所有用例都因为 id 列为空而挂掉。
    """
    mappings = dict(mappings)
    key_col = columns[0]
    if key_col["key"] not in mappings:
        mappings[key_col["key"]] = {
            "sources": [_src(emp, ["工号", "姓名", "手机号"], "工号")],
            "combine": "first",
        }
    return _config(
        "join", None, columns, mappings,
        primary=emp["id"], keys=[0],
        lookups=lookups if lookups is not None else [{"table_id": det["id"], "keys": [0]}],
    )


@pytest.fixture()
def pair(client, workdir):
    """主表（一人一行）+ 明细表（一人多行），覆盖绝大多数一对多场景。"""
    emp = _xlsx(workdir / "员工.xlsx", ["工号", "姓名", "手机号"],
                [["A", "张三", ""], ["B", "李四", "13800000000"]])
    det = _xlsx(workdir / "明细.xlsx", ["工号", "加班小时", "岗位", "日期", "医院"],
                [["A", 2, "开发", "2025-01-01", "市一"],
                 ["A", 3, "测试", "2026-05-01", "市二"],
                 ["A", 1.5, "开发", "2024-12-01", "市三"],
                 ["B", 4, "运营", "2026-03-01", "市四"]])
    tables = _upload(client, [emp, det])
    return tables["员工.xlsx"], tables["明细.xlsx"]


def test_multi_source_first_falls_back(client, pair):
    emp, det = pair
    emp_headers = ["工号", "姓名", "手机号"]
    det_headers = ["工号", "加班小时", "岗位", "日期", "医院"]
    config = _join(
        emp, det,
        [_col("c0", "工号"), _col("c1", "手机号")],
        {
            # 先用主表手机号，空的时候再看明细表（真实场景是“通讯录优先，主表兜底”）
            "c1": {"sources": [_src(emp, emp_headers, "手机号"),
                               _src(det, det_headers, "医院")], "combine": "first"},
        },
    )
    # 用 医院 冒充第二来源只为验证“第一个非空胜出”，值本身不重要
    data = client.post("/api/preview", json={"config": config}).get_json()
    assert data["ok"] is True
    rows = {r[0]: r[1] for r in data["rows"]}
    assert rows["A"] == "市一"          # 主表空 → 退到明细表第一条
    assert rows["B"] == "13800000000"   # 主表有值 → 不再看明细表


def test_sum_and_count_over_many_rows(client, pair):
    emp, det = pair
    emp_headers = ["工号", "姓名", "手机号"]
    det_headers = ["工号", "加班小时", "岗位", "日期", "医院"]
    config = _join(
        emp, det,
        [_col("c0", "工号"), _col("c1", "加班合计", type="number"), _col("c2", "次数", type="number")],
        {
            "c1": {"sources": [_src(det, det_headers, "加班小时", "number")], "combine": "sum"},
            "c2": {"sources": [_src(det, det_headers, "加班小时")], "combine": "count"},
        },
    )
    data = client.post("/api/preview", json={"config": config}).get_json()
    rows = {r[0]: r for r in data["rows"]}
    assert rows["A"][1] == 6.5     # 2 + 3 + 1.5，三行都算进来了
    assert rows["A"][2] == 3
    assert rows["B"][1] == 4


def test_max_min_and_latest(client, pair):
    emp, det = pair
    emp_headers = ["工号", "姓名", "手机号"]
    det_headers = ["工号", "加班小时", "岗位", "日期", "医院"]
    config = _join(
        emp, det,
        [_col("c0", "工号"), _col("c1", "最早"), _col("c2", "最新"), _col("c3", "最近医院")],
        {
            "c1": {"sources": [_src(det, det_headers, "日期")], "combine": "min"},
            "c2": {"sources": [_src(det, det_headers, "日期")], "combine": "max"},
            "c3": {
                "sources": [_src(det, det_headers, "医院")],
                "combine": "latest",
                "order_by": {"table_id": det["id"], "column_index": det_headers.index("日期")},
            },
        },
    )
    data = client.post("/api/preview", json={"config": config}).get_json()
    rows = {r[0]: r for r in data["rows"]}
    assert rows["A"][1] == "2024-12-01"
    assert rows["A"][2] == "2026-05-01"
    assert rows["A"][3] == "市二"      # 2026-05-01 那条记录里的医院


def test_concat_dedupes_positions(client, pair):
    emp, det = pair
    det_headers = ["工号", "加班小时", "岗位", "日期", "医院"]
    config = _join(
        emp, det,
        [_col("c0", "工号"), _col("c1", "岗位")],
        {"c1": {"sources": [_src(det, det_headers, "岗位")], "combine": "concat"}},
    )
    data = client.post("/api/preview", json={"config": config}).get_json()
    rows = {r[0]: r for r in data["rows"]}
    assert rows["A"][1] == "开发、测试"   # 三行里「开发」出现两次，只留一个


def test_legacy_mapping_still_takes_first_row(client, pair):
    """老配置（mode=table + table_id + column_index）行为不变。"""
    emp, det = pair
    det_headers = ["工号", "加班小时", "岗位", "日期", "医院"]
    config = _join(
        emp, det,
        [_col("c0", "工号"), _col("c1", "加班小时", type="number")],
        {"c1": {"mode": "table", "table_id": det["id"],
                "column_index": det_headers.index("加班小时"),
                "column_name": "加班小时", "transform": "direct", "fallback": ""}},
    )
    data = client.post("/api/preview", json={"config": config}).get_json()
    rows = {r[0]: r for r in data["rows"]}
    assert rows["A"][1] == 2        # 老语义：取第一条


def test_append_mode_uses_matching_source_per_table(client, workdir):
    """纵向合并：每张表各用自己那条来源，而不是全表按列名猜。"""
    t1 = _xlsx(workdir / "一月.xlsx", ["工号", "金额"], [["A", 10]])
    t2 = _xlsx(workdir / "二月.xlsx", ["编号", "金额"], [["A", 20]])
    tables = _upload(client, [t1, t2])
    jan, feb = tables["一月.xlsx"], tables["二月.xlsx"]
    config = _config(
        "append", None,
        [_col("c0", "工号"), _col("c1", "金额", type="number")],
        {
            "c0": {"sources": [{"table_id": jan["id"], "column_index": 0, "transform": "direct"},
                               {"table_id": feb["id"], "column_index": 0, "transform": "direct"}],
                   "combine": "first"},
            "c1": {"sources": [{"table_id": jan["id"], "column_index": 1, "transform": "number"},
                               {"table_id": feb["id"], "column_index": 1, "transform": "number"}],
                   "combine": "first"},
        },
        append=[jan["id"], feb["id"]],
    )
    data = client.post("/api/preview", json={"config": config}).get_json()
    assert data["rows"] == [["A", 10], ["A", 20]]


def test_unknown_combine_warns_and_falls_back(client, pair):
    emp, det = pair
    det_headers = ["工号", "加班小时", "岗位", "日期", "医院"]
    config = _config(
        "join", None,
        [_col("c0", "工号"), _col("c1", "加班小时")],
        {"c1": {"sources": [_src(det, det_headers, "加班小时")], "combine": "平均"}},
        primary=emp["id"], keys=[0], lookups=[{"table_id": det["id"], "keys": [0]}],
    )
    data = client.post("/api/preview", json={"config": config}).get_json()
    assert any("合并方式" in w for w in data["warnings"])


def test_column_stats_report_per_column_fill(client, pair):
    emp, det = pair
    emp_headers = ["工号", "姓名", "手机号"]
    config = _join(
        emp, det,
        [_col("c0", "工号"), _col("c1", "手机号", required=True)],
        {"c1": {"sources": [_src(emp, emp_headers, "手机号")], "combine": "first"}},
        lookups=[],
    )
    data = client.post("/api/preview", json={"config": config}).get_json()
    stats = {c["name"]: c for c in data["column_stats"]}
    assert stats["工号"]["empty"] == 0
    assert stats["手机号"]["empty"] == 1 and stats["手机号"]["filled"] == 1
    assert stats["手机号"]["empty_rate"] == 0.5
    assert stats["手机号"]["required"] is True


def test_required_without_source_is_warned(client, pair):
    emp, _det = pair
    config = _config(
        "join", None,
        [_col("c0", "工号"), _col("c1", "部门", required=True)],
        {"c0": {"sources": [_src(emp, ["工号", "姓名", "手机号"], "工号")], "combine": "first"}},
        primary=emp["id"], keys=[0], lookups=[],
    )
    data = client.post("/api/preview", json={"config": config}).get_json()
    assert any("必填" in w and "部门" in w for w in data["warnings"])


def test_many_rows_warning_mentions_combine(client, pair):
    emp, det = pair
    config = _config(
        "join", None,
        [_col("c0", "工号"), _col("c1", "加班小时")],
        {"c1": {"sources": [_src(det, ["工号", "加班小时", "岗位", "日期", "医院"], "加班小时")],
                "combine": "first"}},
        primary=emp["id"], keys=[0], lookups=[{"table_id": det["id"], "keys": [0]}],
    )
    data = client.post("/api/preview", json={"config": config}).get_json()
    assert any("多行" in w and "合并方式" in w for w in data["warnings"])
    lookup = data["lookups"][0]
    assert lookup["multi_keys"] >= 1
    assert lookup["max_rows_per_key"] >= 2
