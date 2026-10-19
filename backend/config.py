"""应用路径与全局常量。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "表格汇总助手"
APP_SUBTITLE = "多源数据汇总工作台"
APP_VERSION = "0.2.1"
APP_ID = "huiyi"


def _app_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


ROOT = _app_root()
DATA_DIR = Path(os.environ.get("HUIYI_DATA_DIR") or (ROOT / "data")).resolve()

LIBRARY_DIR = DATA_DIR / "library"
TEMPLATE_DIR = DATA_DIR / "templates"
RUN_DIR = DATA_DIR / "runs"
COMPARE_DIR = DATA_DIR / "compares"
TMP_DIR = DATA_DIR / "tmp"
LOG_DIR = DATA_DIR / "logs"
DB_PATH = DATA_DIR / "huiyi.db"

for _d in (DATA_DIR, LIBRARY_DIR, TEMPLATE_DIR, RUN_DIR, COMPARE_DIR, TMP_DIR, LOG_DIR):
    _d.mkdir(parents=True, exist_ok=True)


def web_dir() -> Path:
    """开发态在项目根目录，PyInstaller 打包后在 _MEIPASS 内。"""
    candidates = []
    if getattr(sys, "_MEIPASS", None):
        candidates.append(Path(sys._MEIPASS) / "web")
    candidates.append(ROOT / "web")
    candidates.append(Path(__file__).resolve().parent.parent / "web")
    for c in candidates:
        if (c / "index.html").exists():
            return c
    return candidates[-1]


WEB_DIR = web_dir()

DEFAULT_SETTINGS = {
    "date_format": "yyyy-mm-dd",
    "trim_text": True,
    "keep_runs": 30,
    "default_header_row": 1,
}

# ---------------------------------------------------------------------------
# 容量上限：集中在这里，别再往业务代码里撒魔数（以前 100/120/200/50 MB
# 分别硬编码在 ingest / readers / api 三处，改一处忘两处）。
# ---------------------------------------------------------------------------
MAX_ROWS = 200_000          # 单表最大数据行
MAX_COLS = 300              # 单表最大列数
MAX_CELLS = 3_000_000       # 单工作表最大单元格数（约 250–400 MB 内存），防 OOM
PREVIEW_ROWS = 8

LIMIT_UPLOAD_MB = 100       # 单个数据源文件
LIMIT_EXCEL_MB = 120        # 单个 Excel（解压后体积通常远大于此，故另设单元格上限）
LIMIT_ATTACHMENT_MB = 50    # 邮件单个附件
LIMIT_REQUEST_MB = 200      # 单次 HTTP 请求总量

ALLOWED_EXCEL = {".xlsx", ".xlsm", ".xltx", ".xltm"}
ALLOWED_LEGACY = {".xls"}
ALLOWED_CSV = {".csv", ".txt", ".tsv"}
ALLOWED_MAIL = {".msg", ".oft", ".eml"}
SUPPORTED = ALLOWED_EXCEL | ALLOWED_LEGACY | ALLOWED_CSV | ALLOWED_MAIL
