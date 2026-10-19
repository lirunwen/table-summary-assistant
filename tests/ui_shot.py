"""用 Chrome DevTools Protocol 截图与检查前端（仅开发自测用）。"""
from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path

import websocket

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


class CDP:
    def __init__(self, port=9222):
        self.port = port
        self.ws = None
        self.seq = 0
        self.events = []

    def connect(self):
        for _ in range(160):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/list", timeout=1) as r:
                    targets = json.load(r)
                page = next((t for t in targets if t.get("type") == "page"), None)
                if page:
                    self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30)
                    return
            except Exception:
                pass
            time.sleep(.25)
        raise RuntimeError("无法连接 Chrome 调试端口")

    def send(self, method, params=None, wait=True):
        self.seq += 1
        msg_id = self.seq
        self.ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        if not wait:
            return None
        while True:
            raw = self.ws.recv()
            data = json.loads(raw)
            if data.get("id") == msg_id:
                if "error" in data:
                    raise RuntimeError(data["error"])
                return data.get("result")
            self.events.append(data)

    def drain(self, seconds=.2):
        end = time.time() + seconds
        self.ws.settimeout(.2)
        while time.time() < end:
            try:
                raw = self.ws.recv()
                if raw:
                    self.events.append(json.loads(raw))
            except Exception:
                pass
        self.ws.settimeout(30)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--width", type=int, default=1440)
    parser.add_argument("--height", type=int, default=1100)
    parser.add_argument("--wait", type=float, default=2.0)
    parser.add_argument("--click", default="")
    parser.add_argument("--js", default="")
    parser.add_argument("--file", default="")
    parser.add_argument("--file-selector", default="#file-input")
    args = parser.parse_args()

    profile = Path(__file__).resolve().parent.parent / "data" / "tmp" / f"chrome-cdp-{os.getpid()}"
    profile.mkdir(parents=True, exist_ok=True)
    log_path = Path("/tmp/huiyi-chrome.log")
    log_file = open(log_path, "w")
    proc = subprocess.Popen([
        CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-breakpad",
        "--disable-crash-reporter", "--no-first-run",
        "--remote-debugging-port=9222", "--remote-allow-origins=*", f"--user-data-dir={profile}",
        f"--window-size={args.width},{args.height}", "about:blank",
    ], stdout=log_file, stderr=log_file)
    try:
        cdp = CDP()
        try:
            cdp.connect()
        except Exception:
            print("Chrome 退出码:", proc.poll())
            print(log_path.read_text()[:4000])
            raise
        cdp.send("Page.enable")
        cdp.send("Runtime.enable")
        cdp.send("Log.enable")
        cdp.send("Emulation.setDeviceMetricsOverride", {
            "width": args.width, "height": args.height, "deviceScaleFactor": 1,
            "mobile": False,
        })
        cdp.send("Page.navigate", {"url": args.url})
        time.sleep(args.wait)
        cdp.drain(.5)
        if args.click:
            cdp.send("Runtime.evaluate", {
                "expression": f"document.querySelector({json.dumps(args.click)})?.click()",
                "awaitPromise": True,
            })
            time.sleep(3)
            cdp.drain(.5)
        if args.file:
            doc = cdp.send("DOM.getDocument", {"depth": 1})
            node = cdp.send("DOM.querySelector", {
                "nodeId": doc["root"]["nodeId"], "selector": args.file_selector,
            })
            if node.get("nodeId"):
                cdp.send("DOM.setFileInputFiles", {
                    "files": [str(Path(args.file).resolve())], "nodeId": node["nodeId"],
                })
                cdp.send("Runtime.evaluate", {
                    "expression": f"document.querySelector({json.dumps(args.file_selector)})?.dispatchEvent(new Event('change', {{bubbles:true}}))",
                })
                time.sleep(4)
                cdp.drain(.5)
        if args.js:
            evaluated = cdp.send("Runtime.evaluate", {"expression": args.js, "awaitPromise": True, "returnByValue": True})
            value = evaluated.get("result", {}).get("value")
            if value is not None:
                print("JS 结果:", value)
            time.sleep(2)
            cdp.drain(.5)
        shot = cdp.send("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
        Path(args.out).write_bytes(base64.b64decode(shot["data"]))
        errors = []
        for event in cdp.events:
            if event.get("method") == "Runtime.exceptionThrown":
                detail = event["params"].get("exceptionDetails", {})
                errors.append(detail.get("exception", {}).get("description") or detail.get("text"))
            if event.get("method") == "Log.entryAdded":
                entry = event["params"].get("entry", {})
                if entry.get("level") in ("error", "warning"):
                    errors.append(f'{entry.get("level")}: {entry.get("text")}')
        if errors:
            print("浏览器错误：")
            for e in errors:
                print(" -", e)
        print(f"已截图：{args.out}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
