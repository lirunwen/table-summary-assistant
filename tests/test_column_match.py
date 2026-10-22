"""列名匹配规则：严格同名优先，未命中时退回模板列名括号里的备注名。"""
from __future__ import annotations

import pytest

from backend import column_match as cm


# ---------- 规范化 ----------

def test_normalize_strips_zero_width_and_full_width_space():
    assert cm.normalize_name("\u200b员工编号\u3000 ") == "员工编号"
    assert cm.normalize_name("员工   编号") == "员工 编号"
    assert cm.normalize_name(None) == ""


def test_normalize_keeps_case_and_symbols():
    """刻意不做大小写折叠和 NFKC：列名对不上就留空，不猜。"""
    assert cm.normalize_name("Amount") == "Amount"
    assert cm.normalize_name("①号") == "①号"


# ---------- 括号解析 ----------

def test_alias_full_width_and_half_width():
    assert cm.bracket_aliases("员工编号（工号）") == ["工号"]
    assert cm.bracket_aliases("员工编号(工号)") == ["工号"]


def test_alias_allows_mixed_brackets():
    """全角开 + 半角闭这类手打失误也要认。"""
    assert cm.bracket_aliases("月薪（税前)") == ["税前"]
    assert cm.bracket_aliases("月薪(税前）") == ["税前"]


def test_alias_supports_square_corner_and_bracket_forms():
    assert cm.bracket_aliases("备注【说明】") == ["说明"]
    assert cm.bracket_aliases("备注〔说明〕") == ["说明"]
    assert cm.bracket_aliases("备注[说明]") == ["说明"]
    assert cm.bracket_aliases("备注［说明］") == ["说明"]


def test_alias_multiple_groups_in_order():
    assert cm.bracket_aliases("月薪（税前)(元)") == ["税前", "元"]


def test_alias_ignores_empty_and_unclosed():
    assert cm.bracket_aliases("员工编号（）") == []
    assert cm.bracket_aliases("未闭合（说明") == []
    # 没闭合的那截跳过，不影响后面成对的括号
    assert cm.bracket_aliases("说明（未闭合 【别名】") == ["别名"]


def test_alias_nested_takes_outer_only():
    assert cm.bracket_aliases("字段（外层（内层））") == ["外层（内层）"]
    assert cm.bracket_aliases("金额（含税【元】）") == ["含税【元】"]


def test_alias_dedupes():
    assert cm.bracket_aliases("工号（工号）（工号）") == ["工号"]


def test_candidates_strict_first_then_aliases():
    assert cm.candidate_names("月薪（税前）") == [("月薪（税前）", cm.NAME), ("税前", cm.ALIAS)]
    # 严格名带着括号整体参与比较，别名是括号里的内容，两者都要留着
    assert cm.candidate_names("工号（工号）") == [("工号（工号）", cm.NAME), ("工号", cm.ALIAS)]
    assert cm.candidate_names("") == []


# ---------- 匹配优先级 ----------

def test_strict_name_wins_over_alias():
    # 只有别名能命中时才走别名
    match = cm.resolve("月薪（税前）", [["税前", "姓名"]])
    assert (match.table_pos, match.column_index, match.via, match.alias) == (0, 0, cm.ALIAS, "税前")
    # 同名列存在时严格名优先，不会被别名抢走
    match = cm.resolve("月薪（税前）", [["税前", "月薪（税前）"]])
    assert (match.column_index, match.via) == (1, cm.NAME)


def test_strict_name_in_later_table_beats_alias_in_first():
    """候选优先于表：严格名跑遍所有表，才轮到别名。"""
    tables = [["税前"], ["月薪（税前）"]]
    match = cm.resolve("月薪（税前）", tables)
    assert (match.table_pos, match.via) == (1, cm.NAME)


def test_alias_falls_back_to_first_table_with_match():
    tables = [["别的"], ["税前"]]
    match = cm.resolve("月薪（税前）", tables)
    assert (match.table_pos, match.column_index, match.via) == (1, 0, cm.ALIAS)


def test_table_order_breaks_tie():
    tables = [["税前"], ["税前"]]
    assert cm.resolve("月薪（税前）", tables).table_pos == 0


def test_duplicate_header_takes_leftmost():
    index = cm.header_index(["编号", "姓名", "编号"])
    assert index["编号"] == 0
    tables = [["税前", "税前"]]
    assert cm.resolve("月薪（税前）", tables).column_index == 0


def test_unmatched_returns_none():
    assert cm.resolve("月薪（税前）", [["姓名"]]) is None
    assert cm.resolve("", [["姓名"]]) is None


def test_two_targets_can_share_one_source_column():
    tables = [["姓名", "部门"]]
    a = cm.resolve("姓名", tables)
    b = cm.resolve("联系人（姓名）", tables)
    assert a.column_index == b.column_index == 0


# ---------- 批量接口用 ----------

def test_match_columns_reports_via_and_raw_name():
    columns = [{"key": "c1", "name": "月薪（税前）"}, {"key": "c2", "name": "找不到"}]
    out = cm.match_columns(columns, [["税前"]])
    assert out == [{
        "key": "c1", "name": "月薪（税前）", "table_pos": 0,
        "column_index": 0, "column_name": "税前", "via": cm.ALIAS, "alias": "税前",
    }]


def test_match_columns_ignores_non_dict_items():
    assert cm.match_columns(["坏数据"], [["姓名"]]) == []


# ---------- 单表缓存版（engine 纵向合并用） ----------

def test_table_matcher_matches_and_caches():
    matcher = cm.TableMatcher(["税前", "姓名"])
    assert matcher.resolve("月薪（税前）") == (0, cm.ALIAS)
    assert matcher.resolve("月薪（税前）") == (0, cm.ALIAS)  # 第二次走缓存
    assert matcher.resolve("姓名") == (1, cm.NAME)
    assert matcher.resolve("不存在") == (-1, "")


def test_table_matcher_reuses_cache_for_same_column():
    matcher = cm.TableMatcher(["税前"])
    matcher.resolve("月薪（税前）")
    assert len(matcher._cache) == 1


# ---------- HTTP 接口 ----------

def test_api_match_columns(client):
    resp = client.post("/api/match-columns", json={
        "columns": [{"key": "c1", "name": "月薪（税前）"}, {"key": "c2", "name": "姓名"}],
        "tables": [{"id": "t1", "headers": ["姓名", "部门"]}, {"id": "t2", "headers": ["税前"]}],
    })
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["ok"] is True
    got = {m["key"]: m for m in data["matches"]}
    assert got["c1"]["table_id"] == "t2"
    assert got["c1"]["via"] == cm.ALIAS
    assert got["c1"]["alias"] == "税前"
    assert got["c2"]["table_id"] == "t1"
    assert got["c2"]["via"] == cm.NAME
    assert data["stats"] == {"checked": 2, "matched": 2, "by_name": 1, "by_alias": 1}


def test_api_match_columns_tolerates_empty_payload(client):
    resp = client.post("/api/match-columns", json={})
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["matches"] == []
    assert data["stats"]["matched"] == 0


def test_api_match_columns_rejects_wrong_type(client):
    resp = client.post("/api/match-columns", json={"columns": "x", "tables": []})
    assert resp.status_code == 400
    assert resp.get_json()["ok"] is False


# ---------- 纵向合并里真的能靠别名补列 ----------

def _make_xlsx(path, headers, rows):
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "数据"
    ws.append(headers)
    for row in rows:
        ws.append(row)
    wb.save(path)
    return path


def test_append_fills_other_tables_by_bracket_alias(client, workdir):
    """模板列叫「月薪（税前）」，工资表的列叫「税前」，纵向合并时要能对上。"""
    p1 = _make_xlsx(workdir / "工资.xlsx", ["姓名", "税前"], [["张三", 8000]])
    p2 = _make_xlsx(workdir / "通讯录.xlsx", ["姓名", "部门"], [["李四", "研发"]])
    up = client.post("/api/sources/upload", data={"files": [
        (open(p1, "rb"), p1.name), (open(p2, "rb"), p2.name),
    ]}, content_type="multipart/form-data").get_json()
    by_name = {s["name"]: s["meta"]["tables"][0]["id"] for s in up["created"]}
    t_wage, t_contact = by_name["工资.xlsx"], by_name["通讯录.xlsx"]

    config = {
        "mode": "append", "append_tables": [t_wage, t_contact], "auto_by_name": True,
        "target": {"kind": "blank", "sheet": "汇总", "header_row": 1, "columns": [
            {"key": "c0", "name": "姓名", "type": "auto", "included": True},
            {"key": "c1", "name": "月薪（税前）", "type": "number", "included": True},
        ]},
        # 映射指向通讯录；工资表那张要靠「严格名 → 括号别名」自动补齐
        "mappings": {
            "c0": {"mode": "table", "table_id": t_contact, "column_index": 0,
                   "transform": "direct", "fallback": ""},
            "c1": {"mode": "table", "table_id": t_contact, "column_index": 1,
                   "transform": "direct", "fallback": ""},
        },
    }
    data = client.post("/api/preview", json={"config": config, "limit": 10}).get_json()
    assert data["ok"] is True
    assert data["rows"] == [["张三", 8000], ["李四", "研发"]]
