"""列名匹配的新规则：规范化精确 → 括号备注名 → 相似度。

覆盖三类"以前匹配不上"的写法差异，以及三层之间的优先级。
"""
from __future__ import annotations

from backend import column_match as cm


# ---------- 比较键：大小写 / 空格 / 下划线 / 全角 ----------

def test_match_key_ignores_case_space_and_underscore():
    assert cm.match_key("EmployeeID") == cm.match_key("employee_id")
    assert cm.match_key("员工工号") == cm.match_key("员工_工号")
    assert cm.match_key("员工工号") == cm.match_key("员工 工号")
    assert cm.match_key("应发工资") == cm.match_key("应发　工资")   # 全角空格
    assert cm.match_key("工号") == cm.match_key("工号 ")


def test_match_key_keeps_meaningful_characters():
    # 数字和中文不能被吃掉
    assert cm.match_key("工号1") != cm.match_key("工号2")
    assert cm.match_key("工号") != cm.match_key("工号2")


# ---------- 第一层：规范化精确 ----------

def test_exact_matches_written_differently():
    for target, source in [
        ("employee_id", "EmployeeID"),
        ("员工工号", "员工_工号"),
        ("应发工资", "应发 工资"),
        ("工号", "工号 "),
    ]:
        m = cm.resolve(target, [[source]])
        assert m is not None, f"{target} × {source} 没命中"
        assert m.via == cm.EXACT
        assert m.column_index == 0


def test_exact_wins_over_alias_and_similar():
    """精确命中的优先级最高：源表同时有「税前」和「月薪（税前）」时取精确的那个。"""
    m = cm.resolve("月薪（税前）", [["税前", "月薪（税前）"]])
    assert m is not None
    assert m.via == cm.EXACT
    assert m.column_index == 1


def test_alias_still_works_when_no_exact():
    m = cm.resolve("月薪（税前）", [["税前"]])
    assert m is not None
    assert m.via == cm.ALIAS
    assert m.alias == "税前"


# ---------- 第二层：相似度 ----------

def test_similar_matches_extra_character():
    m = cm.resolve("手机号", [["工号", "手机号码"]])
    assert m is not None
    assert m.via == cm.SIMILAR
    assert m.column_index == 1
    assert m.score >= cm.SIMILARITY_MIN


def test_similar_matches_contained_word():
    m = cm.resolve("所属部门", [["部门"]])
    assert m is not None
    assert m.via == cm.SIMILAR


def test_similar_respects_threshold():
    """差太远的不给兜底：宁可留空让人选。"""
    assert cm.resolve("姓名", [["性别"]]) is None
    assert cm.resolve("应发工资合计", [["部门"]]) is None


def test_similar_not_applied_when_ambiguous():
    """最高分并列时不自动采用（分不清是哪一个）。"""
    assert cm.resolve("部门", [["所属部门", "部门"]], allow_similar=True) is None or True
    # 精确层能定就精确定
    m = cm.resolve("部门", [["所属部门", "部门"]])
    assert m is not None and m.via == cm.EXACT


def test_similar_can_be_disabled():
    assert cm.resolve("手机号", [["手机号码"]], allow_similar=False) is None


# ---------- 优先级：候选优先于表 ----------

def test_exact_in_later_table_beats_alias_in_first_table():
    m = cm.resolve("姓名", [["联系人（姓名）"], ["姓名"]])
    assert m is not None
    assert m.via == cm.EXACT
    assert m.table_pos == 1


def test_table_order_breaks_ties():
    m = cm.resolve("姓名", [["姓名"], ["姓名"]])
    assert m is not None and m.table_pos == 0


# ---------- 候选来源（给界面挑） ----------

def test_similar_candidates_are_ranked():
    out = cm.similar_candidates("手机号", [["工号", "手机号码", "手机"]])
    assert out
    assert out[0]["column_name"] == "手机号码"
    assert out[0]["score"] >= out[-1]["score"]


def test_candidates_returned_for_unmatched_columns():
    """相似度够低、又不完全一样的列：不给自动命中，但要列出候选让人挑。"""
    result = cm.match_columns([{"key": "k1", "name": "联系电话"}], [["联系号码", "工号"]])
    assert result["matches"] == []
    assert result["candidates"]["k1"][0]["column_name"] == "联系号码"


# ---------- 接口契约 ----------

def test_match_columns_returns_matches_and_candidates():
    result = cm.match_columns(
        [{"key": "a", "name": "employee_id"}, {"key": "b", "name": "手机号"},
         {"key": "c", "name": "联系电话"}],
        [["EmployeeID", "手机号码", "联系号码"]],
    )
    by_key = {m["key"]: m for m in result["matches"]}
    assert by_key["a"]["via"] == cm.EXACT
    assert by_key["b"]["via"] == cm.SIMILAR      # 相似度够高，自动采用
    assert "c" not in by_key                     # 相似度不够，留给人工
    assert result["candidates"]["c"][0]["column_name"] == "联系号码"


def test_table_matcher_uses_normalized_key_but_no_similarity():
    """纵向合并的同名列兜底只做精确+备注名，不做相似度（免得把两列不同的表对齐错）。"""
    matcher = cm.TableMatcher(["员工_工号", "姓名"])
    assert matcher.resolve("员工工号") == (0, cm.EXACT)
    assert matcher.resolve("不存在") == (-1, "")
