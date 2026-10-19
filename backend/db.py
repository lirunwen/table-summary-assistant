"""SQLite 元数据存储。数据表结构保持简单，业务配置以 JSON 保存。"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from typing import Any, Iterator

from .config import DB_PATH, DEFAULT_SETTINGS

SCHEMA = """
CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    parent_id TEXT,
    created_at TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_sources_parent ON sources(parent_id);

CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    note TEXT DEFAULT '',
    config TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_run_at TEXT
);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    profile_id TEXT,
    profile_name TEXT,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    output_path TEXT,
    output_name TEXT,
    summary TEXT DEFAULT '{}',
    config_snapshot TEXT DEFAULT '{}',
    error TEXT,
    duration_ms INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at DESC);

CREATE TABLE IF NOT EXISTS compares (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    summary TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


@contextmanager
def session() -> Iterator[sqlite3.Connection]:
    """一次操作一个连接：成功提交、失败回滚、无论如何都关闭。

    注意：`with sqlite3.connect(...)` 只负责事务提交，不会关闭连接
    （sqlite3.Connection 的上下文管理器语义如此），长期运行会持续堆积
    文件描述符与 db-wal 文件锁。这里显式 close。
    """
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        yield conn
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def init_db() -> None:
    with session() as conn:
        conn.executescript(SCHEMA)
        for k, v in DEFAULT_SETTINGS.items():
            conn.execute(
                "INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)",
                (k, json.dumps(v, ensure_ascii=False)),
            )


def query(sql: str, args: tuple = ()) -> list[dict]:
    with session() as conn:
        rows = conn.execute(sql, args).fetchall()
        return [dict(r) for r in rows]


def query_one(sql: str, args: tuple = ()) -> dict | None:
    with session() as conn:
        row = conn.execute(sql, args).fetchone()
        return dict(row) if row else None


def execute(sql: str, args: tuple = ()) -> None:
    with session() as conn:
        conn.execute(sql, args)


def get_settings() -> dict:
    values = {**DEFAULT_SETTINGS}
    for row in query("SELECT key, value FROM settings"):
        try:
            values[row["key"]] = json.loads(row["value"])
        except Exception:
            values[row["key"]] = row["value"]
    return values


def save_settings(patch: dict) -> dict:
    with session() as conn:
        for k, v in patch.items():
            if k not in DEFAULT_SETTINGS:
                continue
            conn.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (k, json.dumps(v, ensure_ascii=False)),
            )
        conn.commit()
    return get_settings()


def loads(text: Any, default=None):
    if text is None:
        return default
    if isinstance(text, (dict, list)):
        return text
    try:
        return json.loads(text)
    except Exception:
        return default


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def source_rows() -> list[dict]:
    rows = query(
        "SELECT id, name, kind, path, size, parent_id, created_at, meta "
        "FROM sources ORDER BY created_at ASC"
    )
    for r in rows:
        r["meta"] = loads(r.get("meta"), {}) or {}
    return rows


def template_rows() -> list[dict]:
    rows = query("SELECT id, name, path, size, created_at, meta FROM templates ORDER BY created_at DESC")
    for r in rows:
        r["meta"] = loads(r.get("meta"), {}) or {}
    return rows


def profile_rows() -> list[dict]:
    rows = query(
        "SELECT * FROM profiles ORDER BY "
        "CASE WHEN last_run_at IS NOT NULL AND last_run_at > updated_at "
        "THEN last_run_at ELSE updated_at END DESC"
    )
    for r in rows:
        r["config"] = loads(r.get("config"), {}) or {}
    return rows


def run_rows(limit: int | None = 50) -> list[dict]:
    sql = "SELECT * FROM runs ORDER BY created_at DESC"
    if limit:
        sql += f" LIMIT {int(limit)}"
    rows = query(sql)
    for r in rows:
        r["summary"] = loads(r.get("summary"), {}) or {}
        r["config_snapshot"] = loads(r.get("config_snapshot"), {}) or {}
        # 不把服务器绝对路径暴露给前端
        r.pop("output_path", None)
    return rows
