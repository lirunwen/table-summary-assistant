@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title 表格汇总助手 · 数据汇总工作台
if exist "HuiYi.exe" (
  "HuiYi.exe"
  goto :end
)
if exist "runtime\python.exe" (
  "runtime\python.exe" app.py
  goto :end
)
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" app.py
  goto :end
)
where py >nul 2>nul
if not errorlevel 1 (
  py -3 app.py
  goto :end
)
where python >nul 2>nul
if not errorlevel 1 (
  python app.py
  goto :end
)
echo.
echo  未找到 Python 运行环境。
echo  如果拿到的是打包版，请确认 HuiYi.exe 与 start.bat 在同一个文件夹。
echo  如果是源码版，请先安装 Python 3.11+ 并在本目录执行：
echo      pip install -r requirements.txt
echo.
pause
exit /b 1
:end
if errorlevel 1 pause
