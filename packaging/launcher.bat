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
echo   服务端口：9090（地址 http://127.0.0.1:9090）
echo   退出方式：页面左侧「退出应用」，或直接关闭这个黑色窗口。
echo   首次使用建议先运行「安装.bat」，桌面就有图标了。
echo.

:: 端口固定为 9090。想换端口就改下面这行末尾的数字。
:: 9090 仍被别的程序占用时，程序会自动往后找 9091~9119，
:: 并把实际使用的地址打印在窗口里，以窗口显示的地址为准。
"HuiYi.exe" --port 9090 %*

if errorlevel 1 (
  echo.
  echo   程序异常退出，错误码 %errorlevel%。
  echo   如果反复失败，请把本窗口的完整内容截图反馈。
  echo.
  pause
)
