@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo  ============================================================
echo   表格汇总助手 - 安装（创建桌面快捷方式）
echo  ============================================================
echo.

if not exist "HuiYi.exe" (
  echo   [错误] 当前目录没有 HuiYi.exe
  echo   请确认解压时保留了完整文件夹结构（HuiYi.exe 与 _internal 必须在同一目录）。
  echo.
  pause
  exit /b 1
)

if not exist "_internal" (
  echo   [警告] 找不到 _internal 目录，程序可能无法启动。
  echo   请重新完整解压压缩包，不要只拖出 HuiYi.exe。
  echo.
)

rem 快捷方式由程序自己创建：中文路径、图标、工作目录都在 Python 里处理，
rem 比在 bat 里拼 PowerShell 稳（cmd 的 OEM 代码页会把中文变成乱码）。
"HuiYi.exe" --create-shortcut
if errorlevel 1 (
  echo.
  echo   [提示] 自动创建失败。可以手动创建：
  echo          右键 HuiYi.exe -^> 「发送到」 -^> 「桌面快捷方式」
)

echo.
echo  ------------------------------------------------------------
echo   以后双击桌面上的「表格汇总助手」图标即可打开，不必再找这个文件夹。
echo   若把整个文件夹移动到别处，快捷方式会失效——在新位置重新运行一次本文件即可。
echo  ------------------------------------------------------------
echo.
set "GO=Y"
set /p GO=现在启动「表格汇总助手」吗？(Y/n) 
if /i "%GO%"=="n" goto :done

rem start 会新开一个窗口给程序，本窗口随即关闭，用户不会看到两个黑窗口
start "" "HuiYi.exe"

:done
echo.
echo   完成。本窗口 3 秒后自动关闭。
timeout /t 3 >nul
exit /b 0
