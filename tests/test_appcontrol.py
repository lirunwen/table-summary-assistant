"""桌面快捷方式与应用退出。

这两个功能的共同点是"只在 Windows 打包版里才真正生效"，所以测试不去
真的建 .lnk、更不能真的把进程杀掉，而是把它们拆成可替换的小件：
脚本拼装、输出归一化、退出钩子，各测各的。
"""
from __future__ import annotations

import time

from backend import appcontrol


# ---------------------------------------------------------------------------
# 快捷方式
# ---------------------------------------------------------------------------

def test_launch_target_is_absolute():
    target, args, workdir = appcontrol.launch_target()
    assert target
    assert workdir
    # 源码运行时参数应该是 app.py 的引号路径；打包版为空
    assert args == "" or args.startswith('"') and args.endswith('"')
    assert "app.py" in args or args == ""


def test_ps_literal_escapes_single_quotes():
    assert appcontrol._ps_lit(r"D:\it's here") == r"'D:\it''s here'"


def test_shortcut_script_quotes_paths_and_has_no_leftover_placeholder():
    script = appcontrol.build_shortcut_script(
        r"C:\Program Files\表格汇总助手\HuiYi.exe", "",
        r"C:\Program Files\表格汇总助手", r"C:\Temp\lnk.json")
    # 中文路径必须原样进入单引号字面量，不能被 .format 吃掉或被转义坏
    assert r"'C:\Program Files\表格汇总助手\HuiYi.exe'" in script
    assert r"'C:\Program Files\表格汇总助手'" in script
    assert r"'C:\Temp\lnk.json'" in script
    # .format 的花括号转义写错时，这里会露出 {0} 或报 KeyError
    assert "{0}" not in script and "{target}" not in script
    # 桌面与开始菜单两个位置，图标取自 exe 本身
    assert "GetFolderPath('Desktop')" in script
    assert "GetFolderPath('StartMenu')" in script
    assert "IconLocation" in script


def test_as_list_flattens_powershell_output():
    # ConvertTo-Json 会把单元素数组拍平成标量，这里必须归一化
    assert appcontrol._as_list(r"C:\Users\x\Desktop\a.lnk") == [r"C:\Users\x\Desktop\a.lnk"]
    assert appcontrol._as_list(["a.lnk", "b.lnk"]) == ["a.lnk", "b.lnk"]
    assert appcontrol._as_list(None) == []
    assert appcontrol._as_list([]) == []


def test_create_shortcuts_explains_itself_on_non_windows(monkeypatch):
    monkeypatch.setattr(appcontrol, "supports_shortcut", lambda: False)
    result = appcontrol.create_shortcuts()
    assert result["ok"] is False
    assert result["created"] == []
    assert "Windows" in result["message"]


def test_shortcut_api_returns_400_with_reason(client, monkeypatch):
    monkeypatch.setattr(appcontrol, "supports_shortcut", lambda: False)
    resp = client.post("/api/app/shortcut")
    assert resp.status_code == 400
    body = resp.get_json()
    assert body["ok"] is False
    assert "Windows" in body["error"]


# ---------------------------------------------------------------------------
# 退出
# ---------------------------------------------------------------------------

def test_schedule_exit_invokes_hook(monkeypatch):
    calls: list[int] = []
    monkeypatch.setattr(appcontrol, "_exit_hook", lambda code: calls.append(code))
    appcontrol.schedule_exit(delay=0.01)
    for _ in range(100):
        if calls:
            break
        time.sleep(0.01)
    assert calls == [0]


def test_exit_api_stops_process(client, monkeypatch):
    calls: list[int] = []
    monkeypatch.setattr(appcontrol, "_exit_hook", lambda code: calls.append(code))
    # 把等待时间调到最短，否则用例要空等半秒
    monkeypatch.setattr(appcontrol, "EXIT_DELAY", 0.01)

    resp = client.post("/api/app/exit")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["ok"] is True
    assert body["stopping"] is True
    assert body["port"] == 9090

    for _ in range(100):
        if calls:
            break
        time.sleep(0.01)
    assert calls == [0]


def test_exit_api_rejects_remote_host(monkeypatch):
    """被 --host 0.0.0.0 暴露到内网时，不能让人远程把服务关掉。"""
    from backend.api import create_app
    exposed = create_app(port=9090, host="0.0.0.0")
    exposed.config.update(TESTING=True)
    monkeypatch.setattr(appcontrol, "_exit_hook", lambda code: (_ for _ in ()).throw(
        AssertionError("远程请求不该触发退出")))
    with exposed.test_client() as c:
        # Host 头必须是 0.0.0.0 才不会被 before_request 拦成 403
        resp = c.post("/api/app/exit", headers={"Host": "0.0.0.0:9090"})
    assert resp.status_code == 400
    assert "拒绝远程退出" in resp.get_json()["error"]


# ---------------------------------------------------------------------------
# bootstrap 暴露的字段
# ---------------------------------------------------------------------------

def test_bootstrap_reports_shortcut_capability(client, monkeypatch):
    # 注意：api.py 是 `from .appcontrol import supports_shortcut` 名字导入，
    # 所以这里必须改 api 模块里的引用，改 appcontrol 那边不生效。
    from backend import api as api_module
    monkeypatch.setattr(api_module, "supports_shortcut", lambda: True)
    app = client.get("/api/bootstrap").get_json()["app"]
    assert app["can_shortcut"] is True
    assert app["frozen"] is False          # pytest 里不是打包版
    assert app["exe_path"]
