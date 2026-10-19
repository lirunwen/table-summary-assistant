#!/usr/bin/env python3
"""表格汇总助手 · 数据汇总工作台
启动一个只监听本机的轻量服务，浏览器就是工作台界面。无需联网。
"""
from __future__ import annotations

import argparse
import logging
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from logging.handlers import RotatingFileHandler
from pathlib import Path

from backend import db
from backend.api import create_app
from backend.config import APP_NAME, APP_SUBTITLE, APP_VERSION, DATA_DIR, LOG_DIR


def setup_logging():
    log = logging.getLogger("huiyi")
    log.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    try:
        fh = RotatingFileHandler(LOG_DIR / "huiyi.log", maxBytes=1_000_000,
                                 backupCount=3, encoding="utf-8")
        fh.setFormatter(fmt)
        log.addHandler(fh)
    except Exception:
        pass
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    log.addHandler(sh)


def port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
            return True
        except OSError:
            return False


def is_our_instance(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1.2) as resp:
            body = resp.read().decode("utf-8", "ignore")
            return "version" in body and "name" in body
    except Exception:
        return False


def pick_port(host: str, preferred: int) -> tuple[int, bool]:
    if port_free(host, preferred):
        return preferred, True
    if is_our_instance(preferred):
        return preferred, False
    for p in range(preferred + 1, preferred + 30):
        if port_free(host, p):
            return p, True
    raise SystemExit(f"端口 {preferred} 及后续端口都被占用，请用 --port 指定其他端口。")


def banner(url: str):
    line = "─" * 48
    print(f"\n  {line}")
    print(f"  {APP_NAME} · {APP_SUBTITLE}   v{APP_VERSION}")
    print(f"  {line}")
    print(f"  访问地址   {url}")
    print(f"  数据目录   {DATA_DIR}")
    print("  运行模式   仅本机 · 离线可用 · 数据不上传")
    print(f"  {line}")
    print("  关闭此窗口即停止服务。\n")


def main():
    parser = argparse.ArgumentParser(description=f"{APP_NAME} · {APP_SUBTITLE}")
    parser.add_argument("--port", type=int, default=8765, help="服务端口，默认 8765")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认仅本机")
    parser.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    parser.add_argument("--debug", action="store_true", help="开发模式（Flask 自动重载）")
    args = parser.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    setup_logging()
    db.init_db()

    host = args.host
    port, should_serve = pick_port(host, args.port)
    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{port}"
    if not should_serve:
        print(f"\n{APP_NAME} 已经在运行：{url}\n已为你打开浏览器。")
        if not args.no_browser:
            webbrowser.open(url)
        return

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    banner(url)
    if host not in ("127.0.0.1", "localhost"):
        print("  注意：当前监听所有网卡，同一内网的其他电脑也能访问，请确认网络环境安全。\n")

    app = create_app(port=port, host=host)
    if args.debug:
        app.run(host=host, port=port, debug=True, use_reloader=True)
        return
    try:
        from waitress import serve
        serve(app, host=host, port=port, threads=6, channel_timeout=120,
              ident=f"HuiYi/{APP_VERSION}")
    except ImportError:
        app.run(host=host, port=port, threaded=True)
    except KeyboardInterrupt:
        print("\n服务已停止。")


if __name__ == "__main__":
    main()
