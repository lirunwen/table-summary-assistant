@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
title 表格汇总助手 · 构建 Windows 免安装版

where py >nul 2>nul
if errorlevel 1 (
  echo 未找到 Python 启动器 py。请先安装 Python 3.11 / 3.12（64 位）。
  pause
  exit /b 1
)

if not exist ".buildvenv\Scripts\python.exe" (
  echo [1/4] 创建构建虚拟环境…
  py -3 -m venv .buildvenv
)

echo [2/4] 安装运行依赖与 PyInstaller…
call ".buildvenv\Scripts\activate.bat"
python -m pip install --upgrade pip
python -m pip install -r requirements.txt pyinstaller
if errorlevel 1 (
  echo 依赖安装失败，请检查网络或改用离线 wheels。
  pause
  exit /b 1
)

echo [3/4] 打包…
pyinstaller --noconfirm --clean packaging\huiyi.spec
if errorlevel 1 (
  echo 打包失败，请查看上方日志。
  pause
  exit /b 1
)

echo [4/4] 复制启动脚本与说明…
copy /Y start.bat "dist\HuiYi\start.bat" >nul
copy /Y "启动表格汇总助手.bat" "dist\HuiYi\启动表格汇总助手.bat" >nul
copy /Y README-使用说明.txt "dist\HuiYi\README-使用说明.txt" >nul
if not exist "dist\HuiYi\data" mkdir "dist\HuiYi\data"

echo.
echo 构建完成：dist\HuiYi\
echo 把整个 HuiYi 文件夹复制到目标电脑，双击「启动表格汇总助手.bat」即可。
echo 首次启动会在程序目录创建 data 文件夹。
pause
