"""HTTP API 与应用装配。"""
from __future__ import annotations

import datetime as dt
import io
import json
import logging
import os
import platform
import re
import shutil
import subprocess
import sys
import traceback
from functools import wraps
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, jsonify, request, send_file, send_from_directory

from . import column_match, db
from .config import (
    APP_NAME,
    APP_SUBTITLE,
    APP_VERSION,
    COMPARE_DIR,
    DATA_DIR,
    LIMIT_REQUEST_MB,
    RUN_DIR,
    TMP_DIR,
    WEB_DIR,
)
from .diff import compare, export_compare
from .engine import Registry, build, validate_config
from .appcontrol import create_shortcuts, launch_target, schedule_exit, supports_shortcut
from .formula import FUNCTION_CATALOG, FormulaError, FormulaSyntaxError, compile_formula
from .ingest import delete_source, ingest_upload
from . import tmplib
from .templates import ingest_template, inspect_sheet, template_by_id
from .utils import UserError, display_value, now_iso, safe_filename, uid
from .writer import DATE_FORMATS, DEFAULT_DATE_FORMAT, write_output

log = logging.getLogger("huiyi")


def default_config(mode: str = "join") -> dict:
    return {
        "mode": mode,
        "primary_table": "",
        "primary_keys": [],
        "lookups": [],
        "append_tables": [],
        "auto_by_name": True,
        "target": {
            "kind": "blank",
            "template_id": None,
            "sheet": "汇总",
            "header_row": 1,
            "write_mode": "replace",
            "columns": [],
        },
        "mappings": {},
        "options": {"dedupe": True, "skip_empty_key": False},
    }


def _public_source(source: dict) -> dict:
    out = {k: v for k, v in source.items() if k != "path"}
    meta = dict(out.get("meta") or {})
    tables = []
    for table in meta.get("tables") or []:
        t = {k: v for k, v in table.items() if k != "path"}
        tables.append(t)
    meta["tables"] = tables
    out["meta"] = meta
    out["table_count"] = len(tables)
    out["row_total"] = sum(int(t.get("row_count") or 0) for t in tables)
    return out


def _source_tree() -> list[dict]:
    rows = [_public_source(s) for s in db.source_rows()]
    by_id = {s["id"]: {**s, "children": []} for s in rows}
    roots = []
    for source in by_id.values():
        parent = source.get("parent_id")
        if parent and parent in by_id:
            by_id[parent]["children"].append(source)
        else:
            roots.append(source)

    def sort_tree(nodes):
        nodes.sort(key=lambda x: x.get("created_at") or "")
        for n in nodes:
            sort_tree(n.get("children") or [])

    sort_tree(roots)
    return roots


def _public_profile(p: dict) -> dict:
    return {
        "id": p["id"],
        "name": p["name"],
        "note": p.get("note") or "",
        "config": p.get("config") or {},
        "created_at": p.get("created_at"),
        "updated_at": p.get("updated_at"),
        "last_run_at": p.get("last_run_at"),
    }


def _public_run(r: dict) -> dict:
    return {
        "id": r["id"],
        "profile_id": r.get("profile_id"),
        "profile_name": r.get("profile_name"),
        "created_at": r.get("created_at"),
        "status": r.get("status"),
        "output_name": r.get("output_name"),
        "summary": r.get("summary") or {},
        "error": r.get("error"),
        "duration_ms": r.get("duration_ms") or 0,
        "download_url": f"/api/runs/{r['id']}/download",
    }


def _stats(profiles: list, runs: list, sources: list) -> dict:
    table_count = sum(len((s.get("meta") or {}).get("tables") or []) for s in sources)
    last = runs[0] if runs else None
    try:
        run_total = int((db.query_one("SELECT COUNT(*) AS c FROM runs") or {}).get("c") or 0)
    except Exception:
        run_total = len(runs)
    return {
        "sources": len([s for s in sources if not s.get("parent_id")]),
        "files": len(sources),
        "tables": table_count,
        "profiles": len(profiles),
        "runs": run_total,
        "rows_last": int((last.get("summary") or {}).get("rows") or 0) if last else 0,
        "empty_profiles": len([p for p in profiles if not (p.get("config") or {}).get("target", {}).get("columns")]),
    }


def api_route(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            data = fn(*args, **kwargs)
            if hasattr(data, "status_code") or hasattr(data, "get_data"):
                return data
            if isinstance(data, tuple):
                payload, status = data
                return jsonify({"ok": True, **(payload or {})}), status
            return jsonify({"ok": True, **(data or {})})
        except UserError as exc:
            return jsonify({"ok": False, "error": str(exc)}), 400
        except Exception as exc:
            log.error("API error %s: %s\n%s", request.path, exc, traceback.format_exc())
            return jsonify({
                "ok": False,
                "error": f"服务器处理失败：{exc}",
            }), 500
    return wrapper


def _prune_runs() -> int:
    settings = db.get_settings()
    keep = max(5, int(settings.get("keep_runs") or 30))
    rows = db.query("SELECT id, output_path FROM runs ORDER BY created_at DESC")
    removed = 0
    for row in rows[keep:]:
        try:
            path = Path(row["output_path"] or "")
            if path.exists():
                if path.parent.name == row["id"]:
                    shutil.rmtree(path.parent, ignore_errors=True)
                else:
                    path.unlink(missing_ok=True)
        except Exception:
            pass
        db.execute("DELETE FROM runs WHERE id=?", (row["id"],))
        removed += 1
    return removed


def _cleanup_compares(days: int = 30) -> int:
    import datetime as dt
    cutoff = dt.datetime.now().astimezone() - dt.timedelta(days=days)
    removed = 0
    for row in db.query("SELECT id, path, created_at FROM compares"):
        try:
            created = dt.datetime.fromisoformat(row["created_at"])
        except Exception:
            created = cutoff - dt.timedelta(days=1)
        if created < cutoff:
            try:
                Path(row["path"]).unlink(missing_ok=True)
            except Exception:
                pass
            db.execute("DELETE FROM compares WHERE id=?", (row["id"],))
            removed += 1
    return removed


def create_app(port: int | None = None, host: str = "127.0.0.1") -> Flask:
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = LIMIT_REQUEST_MB * 1024 * 1024
    app.json.ensure_ascii = False
    loopback_only = host in ("127.0.0.1", "localhost", "::1")

    @app.before_request
    def guard_local_service():
        """只接受"本机页面"的写操作。

        没有这道校验时，任意网页都能向 127.0.0.1:9090 提交 multipart 表单
        （简单请求免预检），把文件塞进数据目录或直接 POST /api/cleanup
        清空历史记录。Host 校验同时挡住 DNS rebinding。
        """
        if not request.path.startswith("/api/"):
            return None
        if loopback_only:
            hostname = (urlsplit(f"//{request.host}").hostname or "").lower()
            if hostname not in ("127.0.0.1", "localhost", "::1"):
                return jsonify({"ok": False, "error": "仅允许本机访问。"}), 403
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("Origin")
            if origin:
                allowed = {f"http://{request.host}", f"https://{request.host}"}
                if origin not in allowed:
                    return jsonify({"ok": False, "error": "拒绝跨站请求。"}), 403
            site = request.headers.get("Sec-Fetch-Site")
            if site and site not in ("same-origin", "none"):
                return jsonify({"ok": False, "error": "拒绝跨站请求。"}), 403
        return None

    @app.after_request
    def security_headers(resp):
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "SAMEORIGIN"
        resp.headers["Referrer-Policy"] = "no-referrer"
        # 前端有 20 多处 innerHTML 拼接表格数据（虽然都过了 esc()），
        # CSP 是漏掉一处时的最后一道防线：脚本只能来自本站文件，
        # 内联 <script> 与 on* 属性一律不生效。样式仍需 inline，因为
        # 组件里大量用 style="..." 做局部微调。
        resp.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; "
            "font-src 'self'; "
            "connect-src 'self'; "
            "object-src 'none'; "
            "base-uri 'none'; "
            "form-action 'self'; "
            "frame-ancestors 'self'"
        )
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        elif request.path in ("/", "/index.html"):
            resp.headers["Cache-Control"] = "no-cache"
        return resp

    @app.errorhandler(413)
    def too_large(_):
        return jsonify({"ok": False, "error": "上传文件过大，单次上传总大小请控制在 200 MB 以内。"}), 413

    @app.get("/api/health")
    @api_route
    def health():
        return {"name": APP_NAME, "version": APP_VERSION, "port": port}

    @app.get("/api/bootstrap")
    @api_route
    def bootstrap():
        settings = db.get_settings()
        sources = _source_tree()
        profiles = [_public_profile(p) for p in db.profile_rows()]
        runs = [_public_run(r) for r in db.run_rows(100)]
        templates = tmplib.list_templates()["templates"]
        flat_sources = []
        def walk(items):
            for s in items:
                flat_sources.append(s)
                walk(s.get("children") or [])
        walk(sources)
        return {
            "app": {
                "name": APP_NAME,
                "subtitle": APP_SUBTITLE,
                "version": APP_VERSION,
                "data_dir": str(DATA_DIR),
                "platform": platform.system(),
                "port": port,
                "host": host,
                "exposed": host not in ("127.0.0.1", "localhost"),
                "offline": True,
                # 退出按钮与快捷方式按钮要靠这两个字段决定显示什么：
                # 源码跑到一半的 mac 上点「创建桌面快捷方式」应该是说明而不是报错。
                "frozen": bool(getattr(sys, "frozen", False)),
                "can_shortcut": supports_shortcut(),
                "exe_path": launch_target()[0],
            },
            "settings": settings,
            "sources": sources,
            "profiles": profiles,
            "templates": templates,
            "runs": runs,
            "stats": _stats(profiles, runs, flat_sources),
        }

    @app.post("/api/sources/upload")
    @api_route
    def upload_sources():
        files = request.files.getlist("files")
        if not files:
            raise UserError("没有收到文件，请重新选择。")
        created = []
        errors = []
        for f in files:
            if not f or not f.filename:
                continue
            try:
                created.extend(ingest_upload(f))
            except UserError as exc:
                errors.append(f"{f.filename}：{exc}")
            except Exception as exc:
                log.error("upload failed: %s", traceback.format_exc())
                errors.append(f"{f.filename}：解析失败（{exc}）")
        if not created and errors:
            raise UserError("；".join(errors))
        return {
            "created": [_public_source(s) for s in created],
            "errors": errors,
            "sources": _source_tree(),
        }

    @app.patch("/api/sources/<source_id>")
    @api_route
    def patch_source(source_id):
        source = db.query_one("SELECT * FROM sources WHERE id=?", (source_id,))
        if not source:
            raise UserError("数据源不存在。")
        source["meta"] = db.loads(source.get("meta"), {}) or {}
        payload = request.get_json(silent=True) or {}
        if payload.get("name"):
            name = safe_filename(str(payload["name"]))
            db.execute("UPDATE sources SET name=? WHERE id=?", (name, source_id))
            source["name"] = name
        table_id = payload.get("table_id")
        header_row = payload.get("header_row")
        if table_id and header_row is not None:
            tables = source["meta"].get("tables") or []
            # 优先按完整表 ID 精确匹配；只有当传入的是裸 key（不含 "::"）时
            # 才回退按 key 匹配。否则传别的数据源的 ::s0 会误改本源的表。
            if "::" in table_id:
                table = next((t for t in tables if t.get("id") == table_id), None)
            else:
                table = next((t for t in tables if t.get("key") == table_id), None)
            if not table:
                raise UserError("找不到要调整的数据表。")
            try:
                header_row = int(header_row)
            except (TypeError, ValueError):
                raise UserError("表头行号无效。")
            if header_row < 1 or header_row > 50:
                raise UserError("表头行号需在 1–50 之间。")
            from .readers import rebuild_table_meta
            updated = rebuild_table_meta(source, table, header_row)
            tables = [updated if t.get("id") == table["id"] else t for t in tables]
            source["meta"]["tables"] = tables
            db.execute("UPDATE sources SET meta=? WHERE id=?",
                       (db.dumps(source["meta"]), source_id))
            return {"source": _public_source(source), "table": {
                k: v for k, v in updated.items() if k != "path"
            }}
        return {"source": _public_source(source)}

    @app.delete("/api/sources/<source_id>")
    @api_route
    def remove_source(source_id):
        delete_source(source_id)
        return {"sources": _source_tree()}

    @app.get("/api/table-preview")
    @api_route
    def table_preview():
        table_id = request.args.get("table_id") or ""
        try:
            limit = max(1, min(100, int(request.args.get("limit") or 30)))
        except ValueError:
            limit = 30
        registry = Registry()
        if not registry.has(table_id):
            raise UserError("数据表不存在或已删除。")
        source, table = registry.get(table_id)
        headers, rows, truncated = registry.data(table_id)
        # 全空列探测：openpyxl 用 data_only=True 读的是公式缓存值，
        # 从未在 Excel 里打开过的文件，公式列会整列为空且不报错。
        # 这里扫前 5000 行给出提示，比让用户自己发现"这列怎么是空的"好。
        scan = rows[:5000]
        empty_cols = [
            headers[i] for i in range(len(headers))
            if scan and all(
                (r[i] is None or str(r[i]).strip() == "") if i < len(r) else True
                for r in scan
            )
        ][:8]
        return {
            "table_id": table_id,
            "label": registry.label(table_id),
            "headers": headers,
            "rows": rows[:limit],
            "row_count": len(rows),
            "shown": min(limit, len(rows)),
            "header_row": table.get("header_row"),
            "truncated": truncated,
            "empty_columns": empty_cols,
            "scanned_rows": len(scan),
            "source_id": source["id"],
        }

    # ---- 数据模板：与汇总方案平级的独立模块 -------------------------------
    @app.get("/api/template-options")
    @api_route
    def template_options():
        """字段类型、校验规则、状态、日期格式的词汇表，前端不再各写一份。"""
        return {
            "types": tmplib.FIELD_TYPES,
            "rules": tmplib.RULE_KINDS,
            "status": tmplib.TEMPLATE_STATUS,
            "date_formats": list(DATE_FORMATS.keys()),
            "max_fields": 200,
            "ref_syntax": "[字段名]",
        }

    @app.get("/api/templates")
    @api_route
    def list_templates():
        return tmplib.list_templates(
            q=request.args.get("q") or "",
            category=request.args.get("category") or "",
            tag=request.args.get("tag") or "",
            status=request.args.get("status") or "all",
            sort=request.args.get("sort") or "updated",
        )

    @app.post("/api/templates")
    @api_route
    def create_template():
        payload = request.get_json(silent=True) or {}
        detail = tmplib.create_template(payload)
        return {"template": detail, "templates": tmplib.list_templates()["templates"]}

    @app.get("/api/templates/<template_id>")
    @api_route
    def get_template(template_id):
        return {"template": tmplib.template_detail(template_id)}

    @app.put("/api/templates/<template_id>")
    @api_route
    def update_template(template_id):
        payload = request.get_json(silent=True) or {}
        detail = tmplib.update_template(template_id, payload)
        return {"template": detail, "templates": tmplib.list_templates()["templates"]}

    @app.post("/api/templates/upload")
    @api_route
    def upload_template():
        f = request.files.get("file")
        if not f or not f.filename:
            raise UserError("请选择模板文件。")
        extra = {
            "name": request.form.get("name") or "",
            "description": request.form.get("description") or "",
            "category": request.form.get("category") or "",
            "tags": [t for t in (request.form.get("tags") or "").split(",") if t.strip()],
        }
        record = ingest_template(f, extra)
        return {"template": tmplib.template_detail(record["id"]),
                "templates": tmplib.list_templates()["templates"]}

    @app.post("/api/templates/<template_id>/inspect")
    @api_route
    def template_inspect(template_id):
        payload = request.get_json(silent=True) or {}
        sheet = payload.get("sheet")
        if not sheet:
            raise UserError("请选择模板工作表。")
        row = template_by_id(template_id)
        if not row:
            raise UserError("模板不存在或已删除。")
        existing = (row.get("meta") or {}).get("fields") or []
        info = inspect_sheet(template_id, sheet, payload.get("header_row"), existing)
        return {"sheet": info}

    @app.post("/api/templates/<template_id>/duplicate")
    @api_route
    def duplicate_template(template_id):
        detail = tmplib.duplicate_template(template_id, (request.get_json(silent=True) or {}).get("name") or "")
        return {"template": detail, "templates": tmplib.list_templates()["templates"]}

    @app.delete("/api/templates/<template_id>")
    @api_route
    def remove_template(template_id):
        force = str(request.args.get("force") or "").lower() in ("1", "true", "yes")
        result = tmplib.delete_template(template_id, force=force)
        return {**result, "templates": tmplib.list_templates()["templates"]}

    @app.post("/api/templates/<template_id>/versions")
    @api_route
    def save_template_version(template_id):
        payload = request.get_json(silent=True) or {}
        tmplib.save_version(template_id, str(payload.get("note") or ""))
        return {"template": tmplib.template_detail(template_id)}

    @app.post("/api/templates/<template_id>/versions/<version_id>/restore")
    @api_route
    def restore_template_version(template_id, version_id):
        detail = tmplib.restore_version(template_id, version_id)
        return {"template": detail, "templates": tmplib.list_templates()["templates"]}

    @app.get("/api/templates/<template_id>/export")
    @api_route
    def export_template(template_id):
        payload = tmplib.export_template(template_id)
        # 下载名保留中文：Werkzeug 会按 RFC 5987 编码，浏览器能正确显示；
        # 只要把路径分隔符和 Windows 非法字符换成空格即可。
        clean = re.sub(r'[\\/:*?"<>|]+', " ", str(payload["template"]["name"] or "")).strip() or "模板"
        body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
        return send_file(
            io.BytesIO(body),
            mimetype="application/json",
            as_attachment=True,
            download_name=f"{clean[:60]} 模板定义.json",
        )

    @app.post("/api/templates/import")
    @api_route
    def import_template():
        payload = request.get_json(silent=True) or {}
        detail = tmplib.import_template(payload)
        return {"template": detail, "templates": tmplib.list_templates()["templates"]}

    @app.get("/api/templates/<template_id>/file")
    @api_route
    def download_template_file(template_id):
        row = template_by_id(template_id)
        if not row:
            raise UserError("模板不存在或已删除。")
        path = Path(row.get("path") or "")
        if not path.exists():
            raise UserError("模板文件已丢失，请重新上传或由字段定义重建。")
        return send_file(path, as_attachment=True, download_name=path.name)

    @app.post("/api/templates/<template_id>/validate")
    @api_route
    def validate_template_rows(template_id):
        """按模板字段规则校验一份输出数据（给方案预览用）。"""
        payload = request.get_json(silent=True) or {}
        row = template_by_id(template_id)
        if not row:
            raise UserError("模板不存在或已删除。")
        fields = (row.get("meta") or {}).get("fields") or []
        headers = payload.get("headers") or []
        rows = payload.get("rows") or []
        first = int(payload.get("first_row") or 2)
        return {"validation": tmplib.validate_rows(fields, headers, rows, first_data_row=first)}

    @app.post("/api/profiles")
    @api_route
    def create_profile():
        payload = request.get_json(silent=True) or {}
        name = str(payload.get("name") or "").strip()
        if not name:
            raise UserError("请填写方案名称。")
        mode = payload.get("mode") if payload.get("mode") in ("join", "append") else "join"
        config = payload.get("config") or default_config(mode)
        profile_id = uid("p_")
        ts = now_iso()
        db.execute(
            "INSERT INTO profiles(id, name, note, config, created_at, updated_at, last_run_at) "
            "VALUES(?, ?, ?, ?, ?, ?, NULL)",
            (profile_id, name[:80], str(payload.get("note") or "")[:500],
             db.dumps(config), ts, ts),
        )
        row = db.query_one("SELECT * FROM profiles WHERE id=?", (profile_id,))
        row["config"] = db.loads(row.get("config"), {})
        return {"profile": _public_profile(row)}

    @app.put("/api/profiles/<profile_id>")
    @api_route
    def update_profile(profile_id):
        row = db.query_one("SELECT * FROM profiles WHERE id=?", (profile_id,))
        if not row:
            raise UserError("方案不存在。")
        payload = request.get_json(silent=True) or {}
        name = str(payload.get("name") or row["name"]).strip()[:80] or row["name"]
        note = str(payload.get("note", row.get("note") or ""))[:500]
        config = payload.get("config")
        if config is None:
            config = db.loads(row.get("config"), {})
        db.execute(
            "UPDATE profiles SET name=?, note=?, config=?, updated_at=? WHERE id=?",
            (name, note, db.dumps(config), now_iso(), profile_id),
        )
        row = db.query_one("SELECT * FROM profiles WHERE id=?", (profile_id,))
        row["config"] = db.loads(row.get("config"), {})
        return {"profile": _public_profile(row)}

    @app.delete("/api/profiles/<profile_id>")
    @api_route
    def remove_profile(profile_id):
        db.execute("DELETE FROM profiles WHERE id=?", (profile_id,))
        return {}

    @app.post("/api/profiles/<profile_id>/duplicate")
    @api_route
    def duplicate_profile(profile_id):
        row = db.query_one("SELECT * FROM profiles WHERE id=?", (profile_id,))
        if not row:
            raise UserError("方案不存在。")
        new_id = uid("p_")
        ts = now_iso()
        name = f"{row['name']} 副本"
        db.execute(
            "INSERT INTO profiles(id, name, note, config, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)",
            (new_id, name, row.get("note") or "", row.get("config") or "{}", ts, ts),
        )
        new_row = db.query_one("SELECT * FROM profiles WHERE id=?", (new_id,))
        new_row["config"] = db.loads(new_row.get("config"), {})
        return {"profile": _public_profile(new_row)}

    # ---- 字段公式：速查 / 校验 / 试算 -------------------------------------
    @app.post("/api/match-columns")
    @api_route
    def match_columns():
        """按列名自动匹配来源列：严格同名优先，未命中时用模板列名括号里的备注名。

        规则全部在 `column_match` 里，前端不再自己实现一套，避免两边慢慢跑偏。
        请求：`{columns: [{key, name}], tables: [{id, headers}]}`，
        其中 `tables` 的顺序就是优先级（主表在前，关联表按添加顺序）。
        """
        payload = request.get_json(silent=True) or {}
        columns = payload.get("columns") or []
        tables = payload.get("tables") or []
        if not isinstance(columns, list) or not isinstance(tables, list):
            raise UserError("匹配请求格式不正确。")
        tables = [t for t in tables if isinstance(t, dict)]
        header_lists = [[str(h) for h in (t.get("headers") or [])] for t in tables]
        matches = column_match.match_columns(columns, header_lists)
        for item in matches:
            pos = item.pop("table_pos")
            item["table_id"] = tables[pos].get("id") if pos < len(tables) else None
        return {
            "matches": matches,
            "stats": {
                "checked": len(columns),
                "matched": len(matches),
                "by_name": sum(1 for m in matches if m["via"] == column_match.NAME),
                "by_alias": sum(1 for m in matches if m["via"] == column_match.ALIAS),
            },
        }

    @app.get("/api/formula/help")
    @api_route
    def formula_help():
        """函数速查与日期格式选项。前端只缓存这一份，避免两边各写一套。"""
        return {
            "functions": FUNCTION_CATALOG,
            "date_formats": list(DATE_FORMATS.keys()),
            "default_date_format": DEFAULT_DATE_FORMAT,
            "ref_syntax": "[字段名]",
            "example": "=[单价]*[数量]",
            "notes": [
                "公式以 = 开头，省略也可以。",
                "引用源字段写成 [字段名]，名字要和数据表里的表头一致。",
                "空值在算术里按 0 计算，在文字拼接里按空字符串。",
                "计算失败会写入 Excel 错误值（如 #DIV/0!），可用 IFERROR 兜底。",
            ],
        }

    def _formula_available_fields(registry: Registry, table_ids: list[str]) -> list[str]:
        fields: list[str] = []
        seen: set[str] = set()
        for tid in table_ids:
            for header in registry.headers(tid):
                name = str(header).strip()
                if name and name not in seen:
                    seen.add(name)
                    fields.append(name)
        return fields

    @app.post("/api/formula/check")
    @api_route
    def formula_check():
        """只做语法与字段引用校验，不需要完整方案配置。"""
        payload = request.get_json(silent=True) or {}
        text = str(payload.get("formula") or "")
        table_ids = [t for t in (payload.get("table_ids") or []) if isinstance(t, str)]
        registry = Registry()
        available = _formula_available_fields(registry, table_ids)

        if not text.strip():
            return {"valid": False, "error": "公式不能为空。可以填 =[字段名] 直接取原值。",
                    "refs": [], "fields": available}
        try:
            compiled = compile_formula(text)
        except FormulaSyntaxError as exc:
            return {"valid": False,
                    "error": f"语法错误：{exc.message}（第 {exc.pos} 个字符附近）",
                    "refs": [], "fields": available}

        missing = [r for r in compiled.refs if r not in available]
        if missing:
            shown = "、".join(f"[{m}]" for m in missing[:3])
            hint = "、".join(available[:8]) or "（还没有选择数据表）"
            return {"valid": False,
                    "error": f"找不到字段 {shown}。可引用：{hint}",
                    "refs": compiled.refs, "fields": available, "missing": missing}
        return {"valid": True, "error": None, "refs": compiled.refs,
                "fields": available, "missing": []}

    @app.post("/api/formula/try")
    @api_route
    def formula_try():
        """用指定表的前几行真算一遍，供编辑器里的实时预览。"""
        payload = request.get_json(silent=True) or {}
        text = str(payload.get("formula") or "")
        table_id = payload.get("table_id")
        try:
            limit = max(1, min(20, int(payload.get("limit") or 5)))
        except (TypeError, ValueError):
            limit = 5
        if not text.strip():
            raise UserError("公式不能为空。")
        try:
            compiled = compile_formula(text)
        except FormulaSyntaxError as exc:
            raise UserError(f"{exc.message}（第 {exc.pos} 个字符附近）") from exc

        registry = Registry()
        if not registry.has(table_id):
            raise UserError("请先选择一张数据表，才能试算公式。")
        headers, rows, truncated = registry.data(table_id)
        samples = []
        for index, row in enumerate(rows[:limit], start=1):
            fields = {h: (row[i] if i < len(row) else None) for i, h in enumerate(headers)}
            # 把公式实际用到的输入值一并回传，编辑器里能对照「输入 → 结果」
            inputs = {}
            for ref in compiled.refs:
                raw = fields.get(ref)
                if isinstance(raw, (dt.date, dt.datetime)):
                    raw = display_value(raw)
                inputs[ref] = raw
            try:
                value = compiled.evaluate(fields)
            except FormulaError as exc:
                samples.append({"row": index, "error": exc.code,
                                "message": exc.message, "inputs": inputs})
                continue
            if isinstance(value, (dt.date, dt.datetime)):
                value = display_value(value)
            samples.append({"row": index, "result": value, "inputs": inputs})
        return {
            "refs": compiled.refs,
            "headers": headers,
            "samples": samples,
            "total_rows": len(rows),
            "truncated": truncated,
        }

    @app.post("/api/preview")
    @api_route
    def preview_build():
        payload = request.get_json(silent=True) or {}
        config = payload.get("config") or {}
        try:
            limit = max(1, min(200, int(payload.get("limit") or 50)))
        except (TypeError, ValueError):
            limit = 50
        result = build(config, preview_limit=limit, include_rows=False)
        return {
            "headers": result["headers"],
            "rows": result["preview_rows"],
            "stats": result["stats"],
            "warnings": result["warnings"],
            "lookups": result["lookups"],
            "sources": result["sources"],
            "validation": validate_config(config),
            # 模板字段规则的校验结果：命中了哪些规则、第几行、什么值
            "field_validation": tmplib.validate_config_rows(config, result),
        }

    @app.post("/api/profiles/<profile_id>/run")
    @api_route
    def run_profile(profile_id):
        row = db.query_one("SELECT * FROM profiles WHERE id=?", (profile_id,))
        if not row:
            raise UserError("方案不存在。")
        payload = request.get_json(silent=True) or {}
        config = payload.get("config") or db.loads(row.get("config"), {})
        name = str(payload.get("name") or row["name"])[:80]
        # 先保存最新配置，避免运行结果与界面配置不一致
        db.execute("UPDATE profiles SET name=?, config=?, updated_at=? WHERE id=?",
                   (name, db.dumps(config), now_iso(), profile_id))
        result = build(config, include_rows=True)
        run_id = uid("r_")
        run_dir = RUN_DIR / run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        template = None
        target = config.get("target") or {}
        if target.get("kind") == "template":
            template = template_by_id(target.get("template_id") or "")
            if not template:
                raise UserError("目标模板不存在，请重新选择。")
        try:
            output = write_output(config, result, run_dir, name, template)
        except Exception:
            shutil.rmtree(run_dir, ignore_errors=True)
            raise
        summary = {
            **result["stats"],
            "sources": result["sources"],
            "lookups": result["lookups"],
            "warnings": result["warnings"],
            "mode": result["mode"],
            "output": {
                "headers": output["headers"],
                "sheet": output["sheet"],
                "header_row": output["header_row"],
                "data_start": output.get("data_start"),
                "columns": output.get("columns") or [],
                "size": output["size"],
            },
        }
        # 模板字段规则校验：只提示、不阻断——数据质量问题应该由人决定怎么处理
        field_validation = tmplib.validate_config_rows(config, result)
        if field_validation is not None:
            summary["field_validation"] = field_validation
            if field_validation.get("count"):
                first = (field_validation.get("violations") or [{}])[0]
                summary["warnings"] = [
                    *summary["warnings"],
                    f"按模板字段规则检查出 {field_validation['count']} 处问题，"
                    f"首个在第 {first.get('row')} 行「{first.get('field')}」：{first.get('reason')}。"
                    "结果已照常生成，建议核对后在模板里调整规则或修数据。",
                ]
        ts = now_iso()
        duration = result["stats"].get("duration_ms", 0)
        db.execute(
            "INSERT INTO runs(id, profile_id, profile_name, created_at, status, output_path, "
            "output_name, summary, config_snapshot, error, duration_ms) "
            "VALUES(?, ?, ?, ?, 'ok', ?, ?, ?, ?, NULL, ?)",
            (run_id, profile_id, name, ts, output["path"], output["name"],
             db.dumps(summary), db.dumps(config), duration),
        )
        db.execute("UPDATE profiles SET last_run_at=? WHERE id=?", (ts, profile_id))
        pruned = _prune_runs()
        run = db.query_one("SELECT * FROM runs WHERE id=?", (run_id,))
        run["summary"] = db.loads(run.get("summary"), {})
        return {"run": _public_run(run), "pruned": pruned}

    @app.get("/api/runs")
    @api_route
    def list_runs():
        return {"runs": [_public_run(r) for r in db.run_rows(100)]}

    @app.delete("/api/runs/<run_id>")
    @api_route
    def remove_run(run_id):
        row = db.query_one("SELECT * FROM runs WHERE id=?", (run_id,))
        if not row:
            raise UserError("运行记录不存在。")
        try:
            path = Path(row.get("output_path") or "")
            if path.exists():
                if path.parent.name == run_id:
                    shutil.rmtree(path.parent, ignore_errors=True)
                else:
                    path.unlink(missing_ok=True)
        except Exception:
            pass
        db.execute("DELETE FROM runs WHERE id=?", (run_id,))
        return {}

    @app.get("/api/runs/<run_id>/download")
    def download_run(run_id):
        row = db.query_one("SELECT * FROM runs WHERE id=?", (run_id,))
        if not row:
            return jsonify({"ok": False, "error": "运行记录不存在。"}), 404
        path = Path(row.get("output_path") or "")
        if not path.exists():
            return jsonify({"ok": False, "error": "结果文件不存在，可能已被清理。"}), 404
        return send_file(path, as_attachment=True,
                         download_name=row.get("output_name") or path.name,
                         conditional=True)

    @app.post("/api/compare")
    @api_route
    def compare_data():
        payload = request.get_json(silent=True) or {}
        left = payload.get("left") or {}
        right = payload.get("right") or {}
        keys = payload.get("keys") or []
        if not left or not right:
            raise UserError("请选择左右两侧要对比的数据。")
        result = compare(left, right, keys)
        export = export_compare(result)
        return {
            "summary": result["summary"],
            "changes": result["changes"],
            "added": result["added"],
            "removed": result["removed"],
            "warnings": result["warnings"],
            "truncated": result["truncated"],
            "export_url": f"/api/compares/{export['id']}/download",
            "export_name": export["name"],
        }

    @app.get("/api/compares/<compare_id>/download")
    def download_compare(compare_id):
        row = db.query_one("SELECT * FROM compares WHERE id=?", (compare_id,))
        if not row or not Path(row["path"]).exists():
            return jsonify({"ok": False, "error": "对比报告不存在。"}), 404
        return send_file(row["path"], as_attachment=True, download_name=row["name"],
                         conditional=True)

    @app.put("/api/settings")
    @api_route
    def update_settings():
        payload = request.get_json(silent=True) or {}
        patch = {}
        if "date_format" in payload:
            if payload["date_format"] not in ("yyyy-mm-dd", "yyyy/mm/dd", "yyyy年mm月dd日"):
                raise UserError("日期格式不受支持。")
            patch["date_format"] = payload["date_format"]
        if "trim_text" in payload:
            patch["trim_text"] = bool(payload["trim_text"])
        if "keep_runs" in payload:
            try:
                keep = int(payload["keep_runs"])
            except (TypeError, ValueError):
                raise UserError("保留记录数需为整数。")
            patch["keep_runs"] = max(5, min(500, keep))
        if "default_header_row" in payload:
            try:
                hr = int(payload["default_header_row"])
            except (TypeError, ValueError):
                raise UserError("默认表头行需为整数。")
            patch["default_header_row"] = max(1, min(20, hr))
        settings = db.save_settings(patch)
        return {"settings": settings}

    @app.post("/api/open-data-folder")
    @api_route
    def open_data_folder():
        try:
            if sys.platform.startswith("win"):
                os.startfile(str(DATA_DIR))  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", str(DATA_DIR)])
            else:
                # OrbStack 虚拟机里没有桌面环境，用 macctl 让 Mac 打开 Finder
                macctl = shutil.which("macctl")
                if macctl:
                    subprocess.Popen([macctl, "run", "open", str(DATA_DIR)])
                elif shutil.which("xdg-open"):
                    subprocess.Popen(["xdg-open", str(DATA_DIR)])
                else:
                    raise UserError(f"当前环境无法自动打开文件夹，请手动打开：{DATA_DIR}")
        except Exception as exc:
            raise UserError(f"无法打开文件夹：{exc}")
        return {"path": str(DATA_DIR)}

    @app.post("/api/app/shortcut")
    @api_route
    def make_shortcut():
        """在桌面 / 开始菜单创建快捷方式。

        每次调用都重写一遍（幂等），因为用户可能删了图标、也可能把程序
        挪了目录——后一种情况必须覆盖成新路径，否则快捷方式指向上一个位置。
        """
        result = create_shortcuts()
        if not result.get("ok"):
            raise UserError(result.get("message") or "创建快捷方式失败。")
        return result

    @app.post("/api/app/exit")
    @api_route
    def exit_app():
        """彻底退出整个进程（含 waitress 线程），控制台窗口随之关闭。

        只允许本机调用：如果被 --host 0.0.0.0 暴露到内网，任何人点一下
        就能把别人正在用的服务关掉，这是不能接受的。
        """
        if host not in ("127.0.0.1", "localhost", "::1"):
            raise UserError("当前服务监听在非本机地址，已拒绝远程退出。"
                            "请在运行程序的电脑上关闭启动窗口。")
        schedule_exit()
        log.info("页面请求退出应用（port=%s）", port)
        return {"stopping": True, "port": port}

    @app.post("/api/cleanup")
    @api_route
    def cleanup():
        removed_runs = _prune_runs()
        removed_compares = _cleanup_compares(30)
        for f in TMP_DIR.glob("*"):
            try:
                if f.is_file():
                    f.unlink()
            except Exception:
                pass
        return {"runs": removed_runs, "compares": removed_compares}

    @app.get("/")
    def index():
        return send_from_directory(WEB_DIR, "index.html")

    @app.get("/<path:filename>")
    def static_or_index(filename):
        candidate = (WEB_DIR / filename).resolve()
        try:
            candidate.relative_to(WEB_DIR.resolve())
        except ValueError:
            return jsonify({"ok": False, "error": "Not found"}), 404
        if candidate.is_file():
            return send_from_directory(WEB_DIR, filename)
        if filename.startswith("api/"):
            return jsonify({"ok": False, "error": "Not found"}), 404
        return send_from_directory(WEB_DIR, "index.html")

    return app
