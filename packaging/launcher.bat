@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

if not exist "HuiYi.exe" (
  echo.
  echo   [错误] 当前目录没有 HuiYi.exe
  echo   请确认解压时保留了完整文件夹结构（HuiYi.exe 与 _internal 必须在同一目录）。
  echo.
  pause
  exit /b 1
)

if not exist "_internal" (
  echo.
  echo   [警告] 找不到 _internal 目录，程序可能无法启动。
  echo   请重新完整解压压缩包，不要只拖出 HuiYi.exe。
  echo.
)

echo.
echo   正在启动「表格汇总助手」，稍后会自动打开浏览器。
echo   关闭这个黑色窗口即停止服务。
echo.

"HuiYi.exe"

if errorlevel 1 (
  echo.
  echo   程序异常退出，错误码 %errorlevel%。
  echo   如果反复失败，请把本窗口的完整内容截图反馈。
  echo.
  pause
)
