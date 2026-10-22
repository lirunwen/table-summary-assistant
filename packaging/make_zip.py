"""把发布目录打成 zip —— 保证中文文件名带 UTF-8 标志位。

为什么不用 `tar -a -c -f` 或 `Compress-Archive`：

- `tar.exe`（bsdtar）虽然是 Unicode 友好的，但它的命令行参数是经
  CreateProcess 的 **ANSI 代码页** 传进去的。GitHub Actions 的
  windows-latest 是 en-US（cp1252），`表格汇总助手` 这几个字在交给 tar
  之前就已经被替换成 `??????` 了 —— 打出来的包里目录名是六个问号，
  `安装.bat` 同理变成 `????.bat`，用户根本分不清该点哪个。
- `Compress-Archive` 是 .NET 实现，写中文名时不带 UTF-8 标志位（bit 11），
  在非中文 Windows 或第三方解压工具里会显示成乱码。

Python 的 zipfile 用宽字符 API 拿路径，且对非 ASCII 名自动置 bit 11，
两个坑都绕开了。所以打包这一步统一交给本脚本。

用法（不要从命令行传中文，顶层目录会自动识别）：

    python packaging/make_zip.py --src dist/stage --out dist/out.zip
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import zipfile
from pathlib import Path

# 中文名必须带这个标志位，解压端才知道按 UTF-8 解码
UTF8_FLAG = 0x800

# 这些后缀写进 zip 前强制转 CRLF：cmd.exe 解析纯 LF 批处理的 goto/标签并不可靠。
# 不依赖 .gitattributes 是否生效，包里一定是 CRLF。
CRLF_SUFFIXES = {".bat", ".cmd"}


def _to_crlf(data: bytes) -> bytes:
    return data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")


def _iter_entries(top: Path):
    """按稳定顺序产出 (磁盘路径, 包内相对路径, 是否目录)。"""
    for root, dirs, files in os.walk(top):
        dirs.sort()
        root_path = Path(root)
        rel_root = root_path.relative_to(top)
        for d in dirs:
            rel = rel_root / d
            yield root_path / d, rel, True
        for f in sorted(files):
            rel = rel_root / f
            yield root_path / f, rel, False


def build(src: str, out: str, top_name: str | None = None, expect_min: int = 0) -> dict:
    """把 src 下唯一的顶层目录打成一个 zip。

    返回 {out, entries, bytes, sha256, top}，供调用方打日志或写校验文件。
    """
    src_path = Path(src)
    if not src_path.is_dir():
        raise SystemExit(f"[make_zip] 目录不存在：{src_path}")

    if top_name is None:
        subs = [p for p in src_path.iterdir() if p.is_dir()]
        if len(subs) != 1:
            names = "、".join(p.name for p in subs) or "（空）"
            raise SystemExit(
                f"[make_zip] {src_path} 下应当只有一个顶层目录，实际有 {len(subs)} 个：{names}"
            )
        top = subs[0]
    else:
        top = src_path / top_name
        if not top.is_dir():
            raise SystemExit(f"[make_zip] 目录不存在：{top}")

    out_path = Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists():
        out_path.unlink()

    count = 0
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        # 顶层目录条目本身也要写，否则某些解压工具会直接把文件铺到当前目录
        zf.writestr(zipfile.ZipInfo(top.name + "/"), b"", zipfile.ZIP_DEFLATED)
        count += 1
        for disk, rel, is_dir in _iter_entries(top):
            arc = f"{top.name}/{rel.as_posix()}" + ("/" if is_dir else "")
            if is_dir:
                zf.writestr(zipfile.ZipInfo(arc), b"", zipfile.ZIP_DEFLATED)
            elif disk.suffix.lower() in CRLF_SUFFIXES:
                zi = zipfile.ZipInfo.from_file(disk, arc)
                zi.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(zi, _to_crlf(disk.read_bytes()))
            else:
                zf.write(disk, arc)
            count += 1

    info = verify(out_path, expect_min=expect_min)
    info["out"] = str(out_path)
    info["top"] = top.name
    return info


def verify(path: Path, expect_min: int = 0) -> dict:
    """重新打开 zip 自检：条目数、中文名是否带 UTF-8 标志位、有无问号残骸。"""
    with zipfile.ZipFile(path) as zf:
        infos = zf.infolist()
        non_ascii = [i for i in infos if not i.filename.isascii()]
        bad_flag = [i.filename for i in non_ascii if not (i.flag_bits & UTF8_FLAG)]
        # 名字里出现 '?' 说明在某个环节被 ANSI 转换过，属于打坏了
        lost = [i.filename for i in infos if "?" in i.filename]

    sha = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            sha.update(chunk)

    if lost:
        raise SystemExit(
            f"[make_zip] 文件名被破坏成问号（多半是经过了 ANSI 转换）：{lost[:5]}"
        )
    if bad_flag:
        raise SystemExit(
            f"[make_zip] 中文文件名缺少 UTF-8 标志位，换台机器解压会乱码：{bad_flag[:5]}"
        )
    if expect_min and len(infos) < expect_min:
        raise SystemExit(
            f"[make_zip] 条目数偏少：{len(infos)} < {expect_min}，打包可能不完整"
        )

    return {
        "entries": len(infos),
        "non_ascii": len(non_ascii),
        "bytes": path.stat().st_size,
        "sha256": sha.hexdigest(),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="打 Windows 发布 zip（中文名带 UTF-8 标志位）")
    ap.add_argument("--src", required=True, help="暂存目录，内含唯一的顶层目录")
    ap.add_argument("--out", required=True, help="输出 zip 路径")
    ap.add_argument("--top", default=None, help="顶层目录名（默认自动识别，一般不用传）")
    ap.add_argument("--expect-min", type=int, default=0, help="条目数下限，低于此值视为打包失败")
    args = ap.parse_args(argv)

    info = build(args.src, args.out, top_name=args.top, expect_min=args.expect_min)
    mb = round(info["bytes"] / 1048576, 1)
    print(f"[make_zip] 顶层目录：{info['top']}")
    print(f"[make_zip] 条目数：{info['entries']}（其中中文名 {info['non_ascii']} 条，均带 UTF-8 标志位）")
    print(f"[make_zip] 产物：{info['out']}  {mb} MB")
    print(f"[make_zip] SHA256：{info['sha256']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
