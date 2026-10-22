"""应用级控制：桌面快捷方式、进程退出。

两件事都只有在「打包成 exe 在 Windows 上跑」时才真正有用，但逻辑放在 Python
里而不是 .bat 里，是因为：

* 中文路径在 cmd → PowerShell 之间传递极易变成乱码（cmd 用 OEM 代码页，
  PowerShell 按 ANSI 解释）。把脚本写成带 BOM 的 .ps1 再用 `-File` 调用，
  编码在文件层面就定死了，不经过控制台那层转换。
* 「安装.bat 建快捷方式」和「页面上的按钮建快捷方式」必须是同一段代码，
  否则两边的前缀、图标、工作目录迟早会漂移。
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from .config import APP_NAME, APP_SUBTITLE, ROOT, TMP_DIR

log = logging.getLogger("huiyi.appcontrol")

SHORTCUT_NAME = APP_NAME                        # 桌面上显示的名字
SHORTCUT_DESC = f"{APP_NAME} · {APP_SUBTITLE}"

# 退出前留出的时间：让 HTTP 响应先写完，再动刀。太短会出现「页面转圈、
# 服务已死」，太长又让用户觉得点了没反应。
EXIT_DELAY = 0.45

# 真正的退出实现。测试里替换掉它，否则一次接口调用会把 pytest 进程杀掉。
_exit_hook = os._exit

_SHORTCUT_PS = """
$ErrorActionPreference = 'Stop'
$out = [ordered]@{{ created = @(); failed = @() }}
$target = {target}
$workdir = {workdir}
$argline = {argline}
$outfile = {outfile}
try {{
  $shell = New-Object -ComObject WScript.Shell
}} catch {{
  $out.failed += ('无法创建 WScript.Shell 对象：' + $_.Exception.Message)
  ($out | ConvertTo-Json -Compress) | Set-Content -LiteralPath $outfile -Encoding UTF8
  exit 0
}}
$jobs = @(
  @{{ dir = [Environment]::GetFolderPath('Desktop'); kind = 'desktop' }},
  @{{ dir = (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'); kind = 'startmenu' }}
)
foreach ($job in $jobs) {{
  try {{
    if (-not (Test-Path -LiteralPath $job.dir)) {{ throw ('目录不存在：' + $job.dir) }}
    $path = Join-Path $job.dir ({name} + '.lnk')
    $lnk = $shell.CreateShortcut($path)
    $lnk.TargetPath = $target
    $lnk.WorkingDirectory = $workdir
    if ($argline -ne '') {{ $lnk.Arguments = $argline }}
    $lnk.IconLocation = ($target + ',0')
    $lnk.Description = {desc}
    # 1 = 常规窗口。这里刻意不留隐藏窗口：启动失败时命令行上的报错
    # 是唯一的线索，藏起来等于让用户对着一个打不开的图标干瞪眼。
    $lnk.WindowStyle = 1
    $lnk.Save()
    $out.created += $path
  }} catch {{
    $out.failed += ($job.kind + ': ' + $_.Exception.Message)
  }}
}}
($out | ConvertTo-Json -Compress) | Set-Content -LiteralPath $outfile -Encoding UTF8
"""


def _ps_lit(value: str) -> str:
    """PowerShell 单引号字面量：内部单引号写两遍。"""
    return "'" + str(value).replace("'", "''") + "'"


def _as_list(value) -> list[str]:
    """PowerShell 的 ConvertTo-Json 会把单元素数组拍平成标量，这里统一回数组。"""
    if value in (None, "", [], {}):
        return []
    if isinstance(value, (list, tuple)):
        return [str(item) for item in value]
    return [str(value)]


def supports_shortcut() -> bool:
    """只有 Windows 有 .lnk 这套东西。"""
    return sys.platform.startswith("win")


def launch_target() -> tuple[str, str, str]:
    """返回 (可执行文件, 参数, 工作目录)。

    打包版直接指向 HuiYi.exe；源码运行则用 python 拉起 app.py，
    这样在 Windows 上跑源码调试时也能生成一个能用的快捷方式。
    """
    if getattr(sys, "frozen", False):
        exe = Path(sys.executable).resolve()
        return str(exe), "", str(exe.parent)
    app_py = (ROOT / "app.py").resolve()
    return str(Path(sys.executable).resolve()), f'"{app_py}"', str(ROOT)


def _temp_path(prefix: str, suffix: str) -> str:
    """在数据目录的 tmp 下要一个临时文件名（先建后用，用完删）。"""
    handle, path = tempfile.mkstemp(prefix=prefix, suffix=suffix, dir=str(TMP_DIR))
    os.close(handle)
    return path


def build_shortcut_script(target: str, argline: str, workdir: str, outfile: str) -> str:
    """拼出创建快捷方式的 PowerShell 脚本。

    单独拆出来是为了能在非 Windows 上做语法检查——这段代码一旦拼错，
    用户在 Windows 上只会看到「没能创建快捷方式」，没有任何线索。
    """
    return _SHORTCUT_PS.format(
        target=_ps_lit(target),
        workdir=_ps_lit(workdir),
        argline=_ps_lit(argline),
        name=_ps_lit(SHORTCUT_NAME),
        desc=_ps_lit(SHORTCUT_DESC),
        outfile=_ps_lit(outfile),
    )


def create_shortcuts() -> dict:
    """在桌面与开始菜单创建快捷方式。

    返回 {ok, created:[路径], failed:[原因], message}。
    不抛异常：无论成败都要给出人能看懂的一句话。
    """
    if not supports_shortcut():
        return {
            "ok": False,
            "created": [],
            "failed": [],
            "message": "当前系统不是 Windows，只有 Windows 才有「桌面快捷方式」。"
                       "源码运行时请直接用 python app.py 启动。",
        }

    target, args, workdir = launch_target()
    out_path = _temp_path("lnk_", ".json")
    script_path = _temp_path("lnk_", ".ps1")
    # 用 -File 而不是 -EncodedCommand：编码命令是企业 EDR 的重点关注特征，
    # 一个"本地小工具建桌面图标"被安全软件拦下来，用户根本没法排查。
    # 中文靠脚本文件本身带 BOM（utf-8-sig）解决——PowerShell 5.1 认 BOM。
    Path(script_path).write_text(
        build_shortcut_script(target, args, workdir, out_path),
        encoding="utf-8-sig",
    )
    proc = None
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive",
             "-ExecutionPolicy", "Bypass", "-File", script_path],
            capture_output=True, timeout=40,
        )
    except FileNotFoundError:
        return {"ok": False, "created": [], "failed": [],
                "message": "找不到 powershell，无法创建快捷方式。"
                           "请改用「启动.bat」，或手动把 HuiYi.exe 发送到桌面。"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "created": [], "failed": [],
                "message": "创建快捷方式超时（系统可能拦截了脚本执行）。"
                           "可右键 HuiYi.exe →「发送到 → 桌面快捷方式」手动创建。"}
    finally:
        try:
            Path(script_path).unlink(missing_ok=True)
        except Exception:
            pass

    data: dict = {}
    try:
        raw = Path(out_path).read_text(encoding="utf-8-sig").strip()
        if raw:
            data = json.loads(raw)
    except Exception as exc:              # 文件没写出来 / 内容不是 JSON
        log.warning("快捷方式脚本输出无法解析：%s", exc)
    finally:
        try:
            Path(out_path).unlink(missing_ok=True)
        except Exception:
            pass

    created = _as_list(data.get("created"))
    failed = _as_list(data.get("failed"))
    if created:
        where = "、".join("桌面" if Path(p).parent.name == "Desktop" else "开始菜单"
                          for p in created)
        message = f"已在{where}创建「{SHORTCUT_NAME}」快捷方式。以后从这里双击即可打开。"
        if failed:
            message += "（部分位置失败：" + "；".join(failed) + "）"
        return {"ok": True, "created": created, "failed": failed, "message": message}

    stderr = (proc.stderr or b"").decode("utf-8", "replace").strip() if proc else ""
    detail = "；".join(failed) or stderr[-300:] or "脚本没有返回任何结果"
    return {
        "ok": False, "created": [], "failed": failed,
        "message": f"没能创建快捷方式：{detail}。"
                   f"可右键 HuiYi.exe →「发送到 → 桌面快捷方式」手动创建。",
    }


def schedule_exit(delay: float | None = None) -> None:
    """在 delay 秒后杀掉整个进程（含 waitress 的所有线程）。

    用 os._exit 而不是 sys.exit：sys.exit 只结束调用它的那个线程，
    waitress 的主循环还在，服务不会真的停。这里要的是「进程没了，
    控制台窗口跟着关闭」，所以必须是硬退出。
    """
    delay = EXIT_DELAY if delay is None else delay

    def _die() -> None:
        time.sleep(delay)
        log.info("收到页面退出请求，进程即将结束")
        logging.shutdown()
        _exit_hook(0)

    threading.Thread(target=_die, name="huiyi-exit", daemon=True).start()
