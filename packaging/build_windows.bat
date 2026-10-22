@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0.."
title 表格汇总助手 · 构建 Windows 离线安装包

echo.
echo  ============================================================
echo   构建 Windows 离线安装包（PyInstaller 目录版 + zip）
echo   产物：dist\TableSummaryAssistant-vX.Y.Z-windows-x64.zip
echo  ============================================================
echo.

where py >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Python 启动器 py。
  echo        请先安装 Python 3.11 或 3.12（64 位），安装时勾选 Add to PATH。
  pause
  exit /b 1
)

if not exist ".buildvenv\Scripts\python.exe" (
  echo [1/6] 创建构建虚拟环境 .buildvenv ...
  py -3 -m venv .buildvenv
  if errorlevel 1 (
    echo [错误] 创建虚拟环境失败。
    pause
    exit /b 1
  )
) else (
  echo [1/6] 复用已有 .buildvenv
)

call ".buildvenv\Scripts\activate.bat"
python -m pip install --upgrade pip --quiet

echo.
echo [2/6] 安装依赖与 PyInstaller ...
python -m pip install -r requirements.txt pyinstaller --quiet
if errorlevel 1 (
  echo.
  echo [提示] 直接安装失败，通常是 red-black-tree-mod 的 sdist 解包问题。
  echo        正在尝试兜底方案 ...
  if not exist ".cache\rbtm" mkdir ".cache\rbtm"
  python -m pip download red-black-tree-mod==1.22 --no-deps --no-binary :all: -d ".cache\rbtm"
  tar -xzf ".cache\rbtm\red-black-tree-mod-1.22.tar.gz" -C ".cache\rbtm"
  python -m pip install ".cache\rbtm\red-black-tree-mod-1.22" --quiet
  python -m pip install -r requirements.txt pyinstaller --quiet
  if errorlevel 1 (
    echo [错误] 兜底方案也失败，请检查网络或改用 packaging\prepare_offline_wheels.bat。
    pause
    exit /b 1
  )
)

echo.
echo [3/6] 校验依赖 ...
python -c "import flask, openpyxl, xlrd, waitress, extract_msg; print('  依赖 OK')"
if errorlevel 1 (
  echo [错误] 依赖不完整。
  pause
  exit /b 1
)

echo.
echo [4/6] 运行回归测试 ...
python -m pytest tests\test_regressions.py -q
if errorlevel 1 (
  echo [错误] 回归测试未通过，已中止打包。
  pause
  exit /b 1
)

echo.
echo [5/6] PyInstaller 打包 ...
if exist "build" rmdir /S /Q "build"
if exist "dist" rmdir /S /Q "dist"
pyinstaller --noconfirm --clean packaging\huiyi.spec
if errorlevel 1 (
  echo [错误] 打包失败，请查看上方日志。
  pause
  exit /b 1
)

echo.
echo [6/6] 组装发布目录并压缩 ...
if not exist ".cache" mkdir ".cache"
python -c "from backend.config import APP_VERSION; open('.cache/version.txt','w',encoding='utf-8').write(APP_VERSION)"
set APPVER=0.0.0
if exist ".cache\version.txt" set /p APPVER=<.cache\version.txt
echo       版本号：%APPVER%

set STAGE=dist\stage\表格汇总助手
if exist "dist\stage" rmdir /S /Q "dist\stage"
mkdir "%STAGE%"
xcopy "dist\HuiYi\*" "%STAGE%\" /E /I /H /Y >nul
copy /Y "packaging\launcher.bat" "%STAGE%\启动.bat" >nul
rem 再放一份 ASCII 名字的启动器，防止解压工具把中文名解成乱码后找不到入口
copy /Y "packaging\launcher.bat" "%STAGE%\start.bat" >nul
rem 安装器：建桌面与开始菜单快捷方式；同样留一份 ASCII 名字
copy /Y "packaging\install.bat" "%STAGE%\安装.bat" >nul
copy /Y "packaging\install.bat" "%STAGE%\install.bat" >nul
copy /Y "packaging\使用说明-打包版.txt" "%STAGE%\使用说明.txt" >nul
if exist "LICENSE" copy /Y "LICENSE" "%STAGE%\LICENSE.txt" >nul
if exist "samples" xcopy "samples" "%STAGE%\samples\" /E /I /Y >nul

set ZIP=dist\TableSummaryAssistant-v%APPVER%-windows-x64.zip
rem 压缩交给 make_zip.py：tar.exe 的命令行参数要过 ANSI 代码页，中文目录名可能
rem 被替换成问号；Compress-Archive 又不写 UTF-8 标志位。脚本会自检并失败退出。
python packaging\make_zip.py --src "dist\stage" --out "%ZIP%" --expect-min 500
if errorlevel 1 (
  echo [错误] 压缩失败，见上方 make_zip.py 输出。
  pause
  exit /b 1
)
if not exist "%ZIP%" (
  echo [错误] 压缩失败。
  pause
  exit /b 1
)

echo.
echo  ============================================================
echo   构建完成
echo   免安装目录：dist\HuiYi\
echo   分发压缩包：%ZIP%
echo.
echo   用法：把 zip 发给同事，解压后双击「启动.bat」即可。
echo   目标电脑不需要 Python，也不需要管理员权限。
echo  ============================================================
echo.
pause
