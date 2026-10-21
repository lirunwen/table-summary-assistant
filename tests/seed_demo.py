"""生成一套干净的演示数据（仅供截图 / 试用，不属于应用运行依赖）。"""
from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "_demo"
shutil.rmtree(DATA, ignore_errors=True)
os.environ["HUIYI_DATA_DIR"] = str(DATA)
sys.path.insert(0, str(ROOT))

from backend import db  # noqa: E402
from backend.api import create_app  # noqa: E402

db.init_db()
app = create_app(port=9090)
app.config.update(TESTING=True)
client = app.test_client()
samples = ROOT / "samples"


def post_json(url, payload, method="post"):
    resp = getattr(client, method)(url, json=payload)
    data = resp.get_json()
    assert resp.status_code == 200, (url, data)
    assert data.get("ok"), (url, data)
    return data


def upload(files):
    payload = [(open(samples / name, "rb"), name) for name in files]
    resp = client.post("/api/sources/upload", data={"files": payload},
                       content_type="multipart/form-data")
    data = resp.get_json()
    assert data["ok"], data
    return data


upload(["员工主表.xlsx", "考勤统计.xlsx", "工资表.csv", "通讯录更新.eml"])
with open(samples / "人员汇总模板.xlsx", "rb") as fh:
    tpl = client.post("/api/templates/upload", data={"file": (fh, "人员汇总模板.xlsx")},
                      content_type="multipart/form-data").get_json()["template"]
boot = client.get("/api/bootstrap").get_json()
sources = boot["sources"]


def source(name):
    return next(s for s in sources if s["name"] == name)


emp = source("员工主表.xlsx")
att = source("考勤统计.xlsx")
sal = source("工资表.csv")
mail = source("通讯录更新.eml")
attachment = mail["children"][0]
emp_t = emp["meta"]["tables"][0]
att_t = att["meta"]["tables"][0]
sal_t = sal["meta"]["tables"][0]
body_t = mail["meta"]["tables"][0]
attach_t = attachment["meta"]["tables"][0]
sheet = tpl["meta"]["sheets"][0]

# 第二个方案：邮件正文 + 附件，补齐分机号
cfg2 = {
    "mode": "join",
    "primary_table": body_t["id"],
    "primary_keys": [0],
    "lookups": [{"table_id": attach_t["id"], "keys": [0]}],
    "append_tables": [],
    "auto_by_name": True,
    "target": {
        "kind": "blank", "template_id": None, "sheet": "通讯录汇总",
        "header_row": 1, "write_mode": "replace",
        "columns": [
            {"key": "m0", "name": "工号", "type": "text", "width": 12, "included": True},
            {"key": "m1", "name": "企业邮箱", "type": "text", "width": 30, "included": True},
            {"key": "m2", "name": "办公地点", "type": "text", "width": 16, "included": True},
            {"key": "m3", "name": "分机号", "type": "text", "width": 12, "included": True},
        ],
    },
    "mappings": {
        "m0": {"mode": "table", "table_id": body_t["id"], "column_index": 0, "transform": "trim", "fallback": ""},
        "m1": {"mode": "table", "table_id": body_t["id"], "column_index": 1, "transform": "direct", "fallback": ""},
        "m2": {"mode": "table", "table_id": body_t["id"], "column_index": 2, "transform": "direct", "fallback": ""},
        "m3": {"mode": "table", "table_id": attach_t["id"], "column_index": 2, "transform": "direct", "fallback": "—"},
    },
    "options": {"dedupe": True},
}
p2 = post_json("/api/profiles", {"name": "通讯录分机补齐", "mode": "join", "note": "从邮件正文与附件补齐办公地点、分机号"})["profile"]
post_json(f"/api/profiles/{p2['id']}", {"name": p2["name"], "config": cfg2}, method="put")
post_json(f"/api/profiles/{p2['id']}/run", {"config": cfg2})


columns = []
for i, h in enumerate(sheet["headers"]):
    columns.append({"key": f"t{i}", "name": h, "type": "auto", "width": 14,
                    "included": True, "template_col": i})
config = {
    "mode": "join",
    "primary_table": emp_t["id"],
    "primary_keys": [0],
    "lookups": [
        {"table_id": att_t["id"], "keys": [0]},
        {"table_id": sal_t["id"], "keys": [0]},
        {"table_id": body_t["id"], "keys": [0]},
    ],
    "append_tables": [],
    "auto_by_name": True,
    "target": {
        "kind": "template", "template_id": tpl["id"], "sheet": sheet["name"],
        "header_row": 2, "write_mode": "replace", "columns": columns,
    },
    "mappings": {
        "t0": {"mode": "table", "table_id": emp_t["id"], "column_index": 0, "transform": "trim", "fallback": ""},
        "t1": {"mode": "table", "table_id": emp_t["id"], "column_index": 1, "transform": "direct", "fallback": ""},
        "t2": {"mode": "table", "table_id": emp_t["id"], "column_index": 2, "transform": "direct", "fallback": ""},
        "t3": {"mode": "table", "table_id": emp_t["id"], "column_index": 3, "transform": "direct", "fallback": ""},
        "t4": {"mode": "table", "table_id": att_t["id"], "column_index": 1, "transform": "number", "fallback": ""},
        "t5": {"mode": "table", "table_id": att_t["id"], "column_index": 2, "transform": "number", "fallback": ""},
        "t6": {"mode": "table", "table_id": sal_t["id"], "column_index": 1, "transform": "number", "fallback": ""},
        "t7": {"mode": "const", "value": "2026-10"},
    },
    "options": {"dedupe": True},
}
profile = post_json("/api/profiles", {"name": "10月人员信息汇总", "mode": "join", "note": "每月人员台账：主表 + 考勤 + 工资 + 通讯录"})["profile"]
post_json(f"/api/profiles/{profile['id']}", {"name": profile["name"], "config": config}, method="put")
post_json(f"/api/profiles/{profile['id']}/run", {"config": config})
time.sleep(1.1)
config["mappings"]["t7"] = {"mode": "const", "value": "2026-11"}
run = post_json(f"/api/profiles/{profile['id']}/run", {"config": config})["run"]

post_json("/api/settings", {"date_format": "yyyy-mm-dd", "trim_text": True, "keep_runs": 30}, method="put")
final = client.get("/api/bootstrap").get_json()
print("演示数据已生成：", DATA)
print("方案：", [(p["name"], p["id"]) for p in final["profiles"]])
print("运行：", [(r["profile_name"], r["id"]) for r in final["runs"]])
print("主结果：", run["output_name"])
