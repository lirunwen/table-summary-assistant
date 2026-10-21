"""pytest 公共夹具：把数据目录指到临时目录，再装配一个测试用 Flask 应用。

注意：backend.config 在 import 时就读取 HUIYI_DATA_DIR 并创建目录，
所以环境变量必须在任何 backend 模块被导入之前设好——这也是本文件
放在 tests/ 顶层、且把 os.environ 赋值写在最前面的原因。
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

TMP_DATA = Path(tempfile.mkdtemp(prefix="huiyi_pytest_"))
os.environ["HUIYI_DATA_DIR"] = str(TMP_DATA)

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pytest  # noqa: E402

from backend import db  # noqa: E402
from backend.api import create_app  # noqa: E402

SAMPLE_DIR = ROOT / "samples"


@pytest.fixture(scope="session")
def app():
    db.init_db()
    application = create_app(port=9090, host="127.0.0.1")
    application.config.update(TESTING=True)
    return application


@pytest.fixture()
def client(app):
    """每个用例从干净的表开始。"""
    for table in ("compares", "runs", "profiles", "templates", "sources", "settings"):
        db.execute(f"DELETE FROM {table}")
    db.init_db()  # 重新写入默认设置
    with app.test_client() as c:
        yield c


@pytest.fixture()
def sample():
    """用法：sample("员工主表.xlsx") → 样例文件的绝对路径。"""
    def _get(name: str) -> Path:
        return SAMPLE_DIR / name
    return _get


@pytest.fixture()
def workdir():
    """自管临时目录。

    不用 pytest 内置 tmp_path：某些受限环境（沙箱 / 特殊权限）下
    pytest 建 <basetemp>/pytest-of-<user> 会因目录代理策略失败。
    """
    import uuid
    path = TMP_DATA / "work" / uuid.uuid4().hex[:8]
    path.mkdir(parents=True, exist_ok=True)
    return path
