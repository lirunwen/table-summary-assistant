"""HTTP API 与应用装配。"""
from __future__ import annotations

import logging
import os
import platform
import shutil
import subprocess
import sys
import traceback
from functools import wraps
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, jsonify, request, send_file, send_from_directory

from . import db
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
from .ingest import delete_source, ingest_upload
from .templates import delete_template, ingest_template, inspect_sheet, template_by_id
from .utils import UserError, now_iso, safe_filename, uid
from .writer import write_output

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


def _public_template(t: dict) -> dict:
    return {k: v for k, v in t.items() if k != "path"}


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

        没有这道校验时，任意网页都能向 127.0.0.1:8765 提交 multipart 表单
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
        templates = [_public_template(t) for t in db.template_rows()]
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

    @app.post("/api/templates/upload")
    @api_route
    def upload_template():
        f = request.files.get("file")
        if not f or not f.filename:
            raise UserError("请选择模板文件。")
        record = ingest_template(f)
        return {"template": _public_template(record), "templates": [_public_template(t) for t in db.template_rows()]}

    @app.post("/api/templates/<template_id>/inspect")
    @api_route
    def template_inspect(template_id):
        payload = request.get_json(silent=True) or {}
        sheet = payload.get("sheet")
        if not sheet:
            raise UserError("请选择模板工作表。")
        info = inspect_sheet(template_id, sheet, payload.get("header_row"))
        return {"sheet": info}

    @app.delete("/api/templates/<template_id>")
    @api_route
    def remove_template(template_id):
        delete_template(template_id)
        return {"templates": [_public_template(t) for t in db.template_rows()]}

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
