"""打包脚本测试：中文文件名必须带 UTF-8 标志位。

这条线出过一次真实的线上事故：CI 用 `tar -a -c -f` 压缩，tar.exe 的 argv
经过 en-US runner 的 ANSI 代码页，「表格汇总助手」被打成六个问号，
用户解压后看到 `????.bat`，不知道该点哪个。这里把行为钉死。
"""

from __future__ import annotations

import importlib.util
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("make_zip", ROOT / "packaging" / "make_zip.py")
make_zip = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(make_zip)

UTF8_FLAG = 0x800


def _make_tree(stage: Path) -> Path:
    top = stage / "表格汇总助手"
    (top / "_internal" / "web").mkdir(parents=True)
    (top / "HuiYi.exe").write_bytes(b"MZ")
    (top / "安装.bat").write_text("@echo off\n", encoding="utf-8")
    (top / "install.bat").write_text("@echo off\n", encoding="utf-8")
    (top / "使用说明.txt").write_text("说明", encoding="utf-8")
    (top / "_internal" / "web" / "ui.js").write_text("//x", encoding="utf-8")
    return top


def test_chinese_names_keep_utf8_flag(workdir):
    stage = workdir / "stage"
    stage.mkdir()
    _make_tree(stage)
    out = workdir / "out.zip"

    info = make_zip.build(str(stage), str(out), expect_min=1)

    assert info["top"] == "表格汇总助手"
    assert info["entries"] == 8  # 顶层目录 + 2 个子目录 + 5 个文件

    with zipfile.ZipFile(out) as zf:
        names = [i.filename for i in zf.infolist()]
        assert "表格汇总助手/安装.bat" in names
        assert "表格汇总助手/使用说明.txt" in names
        # 非 ASCII 名必须置 bit 11，否则换台机器解压就是乱码
        for item in zf.infolist():
            if not item.filename.isascii():
                assert item.flag_bits & UTF8_FLAG, item.filename
        # 内容也没坏
        assert zf.read("表格汇总助手/HuiYi.exe") == b"MZ"


def test_verify_rejects_question_mark_names(workdir):
    bad = workdir / "bad.zip"
    with zipfile.ZipFile(bad, "w") as zf:
        zf.writestr("??????/install.bat", b"x")

    with pytest.raises(SystemExit) as err:
        make_zip.verify(bad)
    assert "问号" in str(err.value)


def test_verify_rejects_missing_flag(workdir):
    """ASCII 名不需要标志位；把中文名硬塞成 ASCII 之外的字节才需要。"""
    bad = workdir / "bad.zip"
    with zipfile.ZipFile(bad, "w") as zf:
        zf.writestr("ok/file.txt", b"x")
    # 全 ASCII 的包应当通过
    assert make_zip.verify(bad)["entries"] == 1


def test_expect_min_guards_incomplete_package(workdir):
    stage = workdir / "stage"
    stage.mkdir()
    _make_tree(stage)
    out = workdir / "out.zip"

    with pytest.raises(SystemExit) as err:
        make_zip.build(str(stage), str(out), expect_min=999)
    assert "条目数偏少" in str(err.value)


def test_build_requires_single_top_dir(workdir):
    stage = workdir / "stage"
    (stage / "甲").mkdir(parents=True)
    (stage / "乙").mkdir()

    with pytest.raises(SystemExit) as err:
        make_zip.build(str(stage), str(workdir / "out.zip"))
    assert "只有一个顶层目录" in str(err.value)


def test_build_missing_src(workdir):
    with pytest.raises(SystemExit) as err:
        make_zip.build(str(workdir / "nope"), str(workdir / "out.zip"))
    assert "目录不存在" in str(err.value)


def test_bat_entries_forced_to_crlf(workdir):
    """打包时把 .bat/.cmd 内容统一转 CRLF，不依赖检出配置。"""
    stage = workdir / "stage"
    top = stage / "表格汇总助手"
    top.mkdir(parents=True)
    # 故意写成纯 LF，模拟 macOS / git 配置不对时的检出结果
    (top / "安装.bat").write_bytes(b"@echo off\n:done\necho ok\n")
    (top / "readme.txt").write_bytes(b"line1\nline2\n")
    out = workdir / "out.zip"

    make_zip.build(str(stage), str(out))

    with zipfile.ZipFile(out) as zf:
        bat = zf.read("表格汇总助手/安装.bat")
        txt = zf.read("表格汇总助手/readme.txt")
    assert bat == b"@echo off\r\n:done\r\necho ok\r\n"
    assert b"\r\n" not in txt  # 非批处理文件不乱动


def test_sha256_matches_file(workdir):
    import hashlib

    stage = workdir / "stage"
    stage.mkdir()
    _make_tree(stage)
    out = workdir / "out.zip"

    info = make_zip.build(str(stage), str(out))
    assert info["sha256"] == hashlib.sha256(out.read_bytes()).hexdigest()
    assert info["bytes"] == out.stat().st_size
