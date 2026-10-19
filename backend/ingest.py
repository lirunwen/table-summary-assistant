"""文件落盘、识别类型、建立数据源记录。"""
from __future__ import annotations

import csv
from pathlib import Path

from . import db
from .config import LIBRARY_DIR, SUPPORTED
from .email_reader import parse_mail
from .readers import table_for_csv, tables_for_excel
from .utils import UserError, now_iso, safe_filename, uid

MAIL_ATTACHMENT_LIMIT = 50 * 1024 * 1024


def kind_of(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in (".xlsx", ".xlsm", ".xltx", ".xltm"):
        return "excel"
    if suffix == ".xls":
        return "xls"
    if suffix in (".csv", ".txt", ".tsv"):
        return "csv"
    if suffix in (".msg", ".oft", ".eml"):
        return "email"
    return "other"


def _insert_source(source_id: str, name: str, kind: str, path: Path, size: int,
                   parent_id: str | None, meta: dict) -> dict:
    record = {
        "id": source_id,
        "name": name,
        "kind": kind,
        "path": str(path),
        "size": size,
        "parent_id": parent_id,
        "created_at": now_iso(),
        "meta": meta,
    }
    db.execute(
        "INSERT INTO sources(id, name, kind, path, size, parent_id, created_at, meta) "
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
        (source_id, name, kind, str(path), size, parent_id, record["created_at"],
         db.dumps(meta)),
    )
    return record


def _body_tables(source_id: str, email_dir: Path, tables: list[list[list[str]]]) -> list[dict]:
    out = []
    body_dir = email_dir / "body"
    body_dir.mkdir(exist_ok=True)
    for i, rows in enumerate(tables[:8]):
        target = body_dir / f"table_{i + 1}.csv"
        with open(target, "w", encoding="utf-8-sig", newline="") as fh:
            writer = csv.writer(fh)
            for row in rows:
                writer.writerow(row)
        try:
            # 邮件正文表格已经是一张规整表，默认第一行即表头
            meta = table_for_csv(target, source_id, label=f"正文表格 {i + 1}",
                                 header_row=1, key=f"b{i}", kind="mail_table",
                                 stored_path=str(target))
            out.append(meta)
        except Exception:
            continue
    return out


def _ingest_email(path: Path, original_name: str, parent_id: str | None,
                  depth: int) -> list[dict]:
    source_id = uid("s_")
    source_dir = LIBRARY_DIR / source_id
    source_dir.mkdir(parents=True, exist_ok=True)
    parsed = parse_mail(path)
    meta = {
        "tables": [],
        "warnings": [],
        "email": {
            "subject": parsed["subject"],
            "sender": parsed["sender"],
            "date": parsed["date"],
            "body_text": parsed["body_text"],
            "attachment_count": len(parsed["attachments"]),
        },
    }
    tables = _body_tables(source_id, source_dir, parsed["tables"])
    meta["tables"] = tables
    record = _insert_source(source_id, original_name, "email", path, path.stat().st_size,
                            parent_id, meta)
    created = [record]

    att_dir = source_dir / "attachments"
    att_dir.mkdir(exist_ok=True)
    for i, att in enumerate(parsed["attachments"]):
        filename = safe_filename(att.get("name") or f"附件{i + 1}")
        suffix = Path(filename).suffix.lower()
        if suffix not in SUPPORTED:
            meta["warnings"].append(f"已跳过附件「{filename}」（暂不支持该类型）")
            continue
        data = att.get("bytes") or b""
        if not data:
            continue
        if len(data) > MAIL_ATTACHMENT_LIMIT:
            meta["warnings"].append(f"已跳过附件「{filename}」（超过 50 MB）")
            continue
        target = att_dir / f"{i + 1:02d}_{filename}"
        target.write_bytes(data)
        try:
            children = ingest_path(target, filename, parent_id=source_id, depth=depth + 1,
                                   cleanup_on_error=True)
            created.extend(children)
        except UserError as exc:
            meta["warnings"].append(f"附件「{filename}」解析失败：{exc}")
        except Exception as exc:  # 单个附件失败不能影响整封邮件
            meta["warnings"].append(f"附件「{filename}」解析失败：{exc}")

    if not tables and len(created) == 1:
        meta["warnings"].append("这封邮件里没有找到可汇总的正文表格，也没有支持的附件。")
    db.execute("UPDATE sources SET meta=? WHERE id=?", (db.dumps(meta), source_id))
    record["meta"] = meta
    return created


def ingest_path(path: Path, original_name: str, parent_id: str | None = None,
                depth: int = 0, cleanup_on_error: bool = False) -> list[dict]:
    """把一个已落盘文件登记为数据源，邮件会递归登记附件。"""
    suffix = path.suffix.lower()
    kind = kind_of(path)
    if suffix in (".pst", ".ost"):
        raise UserError("暂不支持直接读取 .pst / .ost。请在 Outlook 中将需要的邮件另存为 .msg 后再上传。")
    if kind == "other":
        raise UserError(
            f"暂不支持「{suffix or '未知'}」格式。可上传 Excel（.xlsx/.xlsm/.xls）、"
            "CSV、Outlook 邮件（.msg/.oft）或 .eml。"
        )
    if depth > 2:
        raise UserError("邮件嵌套层级过深，已停止解析。")

    if kind == "email":
        return _ingest_email(path, original_name, parent_id, depth)

    source_id = uid("s_")
    meta = {"tables": [], "warnings": []}
    try:
        if kind in ("excel", "xls"):
            tables = tables_for_excel(path, source_id)
            if not tables:
                raise UserError("文件里没有找到可汇总的工作表（需要至少一行表头和数据）。")
            meta["tables"] = tables
        else:
            meta["tables"] = [table_for_csv(path, source_id)]
    except Exception:
        if cleanup_on_error:
            try:
                path.unlink(missing_ok=True)
            except Exception:
                pass
        raise
    record = _insert_source(source_id, original_name, kind, path, path.stat().st_size,
                            parent_id, meta)
    return [record]


def ingest_upload(file_storage, parent_id: str | None = None) -> list[dict]:
    filename = safe_filename(file_storage.filename or "上传文件")
    suffix = Path(filename).suffix.lower()
    if suffix in (".pst", ".ost"):
        raise UserError("暂不支持直接读取 .pst / .ost。请在 Outlook 中将需要的邮件另存为 .msg 后再上传。")
    if suffix not in SUPPORTED:
        raise UserError(f"「{filename}」格式不支持，请上传 Excel、CSV 或 Outlook 邮件文件。")
    source_id = uid("s_")
    source_dir = LIBRARY_DIR / source_id
    source_dir.mkdir(parents=True, exist_ok=True)
    target = source_dir / filename
    file_storage.save(target)
    if target.stat().st_size == 0:
        target.unlink(missing_ok=True)
        raise UserError(f"「{filename}」是空文件。")
    if target.stat().st_size > 100 * 1024 * 1024:
        target.unlink(missing_ok=True)
        raise UserError(f"「{filename}」超过 100 MB，请拆分后再上传。")
    try:
        return ingest_path(target, filename, parent_id=parent_id)
    except Exception:
        # 根级上传失败时清理目录，避免残留
        if parent_id is None:
            import shutil
            shutil.rmtree(source_dir, ignore_errors=True)
        raise


def delete_source(source_id: str) -> None:
    rows = db.source_rows()
    by_id = {r["id"]: r for r in rows}
    target = by_id.get(source_id)
    if not target:
        raise UserError("数据源不存在或已删除。")
    to_delete = []
    stack = [source_id]
    while stack:
        sid = stack.pop()
        if sid in to_delete:
            continue
        to_delete.append(sid)
        stack.extend(r["id"] for r in rows if r.get("parent_id") == sid)

    for sid in to_delete:
        record = by_id.get(sid)
        if not record:
            continue
        try:
            # 数据源自己的工作目录（邮件正文表格、附件）统一放在 library/<id>
            from .config import LIBRARY_DIR
            candidate = LIBRARY_DIR / sid
            if candidate.exists() and candidate.is_dir():
                import shutil
                shutil.rmtree(candidate, ignore_errors=True)
        except Exception:
            pass
        db.execute("DELETE FROM sources WHERE id=?", (sid,))

    # 清理引用这些表的数据源方案中的失效表，保持配置可用性由前端提示
    profiles = db.profile_rows()
    for profile in profiles:
        cfg = profile.get("config") or {}
        used = set()
        if cfg.get("primary_table"):
            used.add(cfg["primary_table"])
        for lk in cfg.get("lookups") or []:
            used.add(lk.get("table_id"))
        for t in cfg.get("append_tables") or []:
            used.add(t)
        if any(t and t.split("::")[0] in to_delete for t in used):
            pass  # 保留方案，前端会提示重新选择数据源
