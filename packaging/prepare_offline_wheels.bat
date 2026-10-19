@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
title 表格汇总助手 · 准备离线依赖包
echo 将在 packaging\wheels 下下载 Windows 运行依赖。
echo 请在一台可联网的 Windows 电脑上运行本脚本，再把整个项目文件夹拷到内网电脑。
if not exist "packaging\wheels" mkdir "packaging\wheels"
py -3 -m pip download -r requirements.txt -d packaging\wheels
if errorlevel 1 (
  echo 下载失败，请检查网络或 Python 版本。
  pause
  exit /b 1
)
echo.
echo 完成。离线电脑上执行：
echo   py -3 -m pip install --no-index --find-links packaging\wheels -r requirements.txt
pause
