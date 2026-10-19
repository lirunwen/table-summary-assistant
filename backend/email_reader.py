"""Outlook .msg / .eml 解析：主题、发件人、正文表格与附件。

.pst / .ost 暂不支持（Outlook 数据文件格式复杂，建议在 Outlook 中另存为 .msg）。
"""
from __future__ import annotations

import email
import email.policy
import re
from email.header import decode_header, make_header
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from .utils import safe_filename


class _TableCollector(HTMLParser):
    """只提取顶层 HTML 表格，足够覆盖邮件正文中的常见表格。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables: list[list[list[str]]] = []
        self._table_depth = 0
        self._rows: list[list[str]] | None = None
        self._row: list[str] | None = None
        self._cell: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag == "table":
            self._table_depth += 1
            if self._table_depth == 1:
                self._rows = []
                self.tables.append(self._rows)
            return
        if self._table_depth != 1:
            return
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th"):
            self._cell = []

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag == "table":
            self._table_depth = max(0, self._table_depth - 1)
            if self._table_depth == 0:
                self._rows = None
            return
        if self._table_depth != 1:
            return
        if tag in ("td", "th"):
            if self._row is not None:
                text = re.sub(r"\s+", " ", "".join(self._cell or [])).strip()
                self._row.append(text)
            self._cell = None
        elif tag == "tr":
            if self._row and any(c for c in self._row):
                self._rows.append(self._row)
            self._row = None

    def handle_data(self, data):
        if self._table_depth == 1 and self._cell is not None:
            self._cell.append(data)


class _TextCollector(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag.lower() in ("script", "style", "head"):
            self._skip += 1
        elif tag.lower() in ("br", "p", "div", "tr", "li"):
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag.lower() in ("script", "style", "head") and self._skip:
            self._skip -= 1

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(html: str) -> str:
    parser = _TextCollector()
    try:
        parser.feed(html or "")
    except Exception:
        return re.sub(r"<[^>]+>", " ", html or "")
    text = "".join(parser.parts)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_html_tables(html: str) -> list[list[list[str]]]:
    parser = _TableCollector()
    try:
        parser.feed(html or "")
    except Exception:
        return []
    cleaned = []
    for table in parser.tables[:8]:
        rows = []
        for row in table[:5000]:
            cells = [_clean_text(c) for c in row]
            if any(cells):
                rows.append(cells)
        if len(rows) < 2:
            continue
        width = max(len(r) for r in rows)
        if width < 2:
            continue
        rows = [(r + [""] * width)[:width] for r in rows]
        # 至少要有“表头 + 一行数据”
        if len(rows) >= 2:
            cleaned.append(rows)
    return cleaned


def _clean_text(value: Any) -> str:
    """Outlook 字段中可能夹带 NUL 等控制字符，写入 JSON / 页面之前清掉。"""
    text = str(value or "").replace("\x00", "")
    text = "".join(ch for ch in text if ch in "\n\t" or ord(ch) >= 32)
    return text.strip()


def _decode_mime(value: Any) -> str:
    if not value:
        return ""
    try:
        return _clean_text(str(make_header(decode_header(str(value)))))
    except Exception:
        return _clean_text(value)


def _date_text(value: Any) -> str:
    if not value:
        return ""
    if hasattr(value, "isoformat"):
        try:
            return _clean_text(value.isoformat(sep=" ", timespec="seconds"))
        except Exception:
            return _clean_text(value)
    try:
        parsed = parsedate_to_datetime(str(value))
        return _clean_text(parsed.isoformat(sep=" ", timespec="seconds"))
    except Exception:
        return _clean_text(value)


def _msg_attachment_name(att) -> str:
    for attr in ("getFilename", "longFilename", "shortFilename", "name"):
        try:
            value = getattr(att, attr, None)
            if callable(value):
                value = value()
            if value:
                return safe_filename(str(value))
        except Exception:
            continue
    return "附件"


def parse_msg(path: Path) -> dict:
    try:
        import extract_msg
    except ImportError as exc:
        raise RuntimeError("未安装 extract-msg 组件，无法读取 .msg 文件。") from exc
    msg = None
    try:
        msg = extract_msg.openMsg(str(path))
        html = ""
        try:
            raw_html = msg.htmlBody
            if isinstance(raw_html, bytes):
                html = raw_html.decode("utf-8", "ignore")
            elif raw_html:
                html = str(raw_html)
        except Exception:
            html = ""
        body = ""
        try:
            body = msg.body or ""
        except Exception:
            body = ""
        tables = extract_html_tables(html)
        attachments = []
        try:
            atts = list(msg.attachments or [])
        except Exception:
            atts = []
        for att in atts[:60]:
            try:
                data = att.data
                if isinstance(data, str):
                    data = data.encode("utf-8", "ignore")
                if not data:
                    continue
                attachments.append({"name": _msg_attachment_name(att), "bytes": data})
            except Exception:
                continue
        return {
            "subject": _decode_mime(getattr(msg, "subject", "") or path.stem),
            "sender": _decode_mime(getattr(msg, "sender", "") or ""),
            "date": _date_text(getattr(msg, "date", "")),
            "body_text": _clean_text((body or html_to_text(html))[:500]),
            "tables": tables,
            "attachments": attachments,
            "warnings": [],
        }
    except Exception as exc:
        if isinstance(exc, RuntimeError):
            raise
        raise RuntimeError(f"解析 Outlook 邮件失败：{exc}") from exc
    finally:
        if msg is not None:
            try:
                msg.close()
            except Exception:
                pass


def parse_eml(path: Path) -> dict:
    data = path.read_bytes()
    try:
        message = email.message_from_bytes(data, policy=email.policy.default)
    except Exception as exc:
        raise RuntimeError(f"解析 .eml 邮件失败：{exc}") from exc

    html = ""
    text_body = ""
    try:
        html_part = message.get_body(preferencelist=("html",))
        if html_part:
            html = html_part.get_content()
    except Exception:
        html = ""
    try:
        text_part = message.get_body(preferencelist=("plain",))
        if text_part:
            text_body = text_part.get_content()
    except Exception:
        text_body = ""

    if not html:
        try:
            for part in message.walk():
                if part.get_content_type() == "text/html":
                    html = part.get_content()
                    break
        except Exception:
            pass

    tables = extract_html_tables(html)
    attachments = []
    for part in message.walk():
        try:
            filename = part.get_filename()
            if not filename:
                continue
            name = safe_filename(_decode_mime(filename))
            payload = part.get_payload(decode=True)
            if payload:
                attachments.append({"name": name, "bytes": payload})
        except Exception:
            continue

    return {
        "subject": _decode_mime(message.get("Subject", "")) or path.stem,
        "sender": _decode_mime(message.get("From", "")),
        "date": _date_text(message.get("Date", "")),
        "body_text": _clean_text((text_body or html_to_text(html))[:500]),
        "tables": tables,
        "attachments": attachments[:60],
        "warnings": [],
    }


def parse_mail(path: Path) -> dict:
    suffix = path.suffix.lower()
    if suffix in (".msg", ".oft"):
        return parse_msg(path)
    if suffix == ".eml":
        return parse_eml(path)
    raise RuntimeError("不支持的邮件格式")
