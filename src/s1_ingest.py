"""S1: 投标 docx -> 章节树 JSON。

本模块只处理 Word（.docx/.doc）。**本次实测项目的真实投标文件全部是 PDF**
（原始资料/实际测试工程文件/ 下 241 个），且 PDF 无书签、无标题层级，
本模块对其完全不适用——PDF 路径尚未实现，切分策略未定，见 README §8 的 B8。
因此下面这条「投标文件本身结构良好」的前提，只对早期的 docx 样例成立。


依据 docx 自带的标题层级切块，不做定长 chunk 切分——投标文件本身结构良好，
按章节切出来的块天然对应评分项的检索目标。

输入: 一个目录下的所有 .docx 与 .doc（.doc 自动转换，见 ensure_docx）
输出: [{id, file, path, level, text, char_len, para_range}, ...]
"""
import json
import shutil
import subprocess
import re
import sys
from pathlib import Path

import docx

# Word 标题识别：优先 style，其次正文里的编号模式（很多标书正文伪装成标题）
_STYLE_H = re.compile(r"(?:Heading|标题)\s*(\d+)")
_NUM_H = re.compile(r"^\s*(?:第[一二三四五六七八九十百]+[章节]|[0-9]+(?:\.[0-9]+){0,4})[\s、.．]")


def _heading_level(p):
    """返回标题层级(1起)，非标题返回 None。"""
    m = _STYLE_H.search(p.style.name or "")
    if m:
        lv = int(m.group(1))
        return lv if 1 <= lv <= 6 else None
    # 兜底：短行 + 编号开头，当作标题
    t = p.text.strip()
    if t and len(t) <= 60 and _NUM_H.match(t):
        dots = t.split()[0].count(".")
        return min(dots + 2, 6)
    return None


def _iter_blocks(doc):
    """按文档顺序产出 (kind, payload)。表格转成制表符文本，跟在所属章节里。"""
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    body = doc.element.body
    for child in body.iterchildren():
        tag = child.tag.split("}")[-1]
        if tag == "p":
            yield "p", Paragraph(child, doc)
        elif tag == "tbl":
            yield "t", Table(child, doc)


def _table_text(tbl):
    rows = []
    for r in tbl.rows:
        cells = [c.text.strip().replace("\n", " ") for c in r.cells]
        if any(cells):
            rows.append("\t".join(cells))
    return "\n".join(rows)


def parse_docx(path: Path, file_key: str):
    doc = docx.Document(str(path))
    sections, stack, cur = [], [], None
    idx = 0

    def flush():
        if cur and cur["text"].strip():
            cur["char_len"] = len(cur["text"])
            sections.append(cur)

    for kind, obj in _iter_blocks(doc):
        if kind == "t":
            if cur is None:
                cur = {"id": f"{file_key}#0", "file": file_key, "path": ["(前言)"],
                       "level": 0, "text": ""}
            cur["text"] += "\n[表]\n" + _table_text(obj) + "\n"
            continue

        p = obj
        text = p.text.strip()
        if not text:
            continue
        lv = _heading_level(p)
        if lv is None:
            if cur is None:
                cur = {"id": f"{file_key}#0", "file": file_key, "path": ["(前言)"],
                       "level": 0, "text": ""}
            cur["text"] += text + "\n"
        else:
            flush()
            idx += 1
            while stack and stack[-1][0] >= lv:
                stack.pop()
            stack.append((lv, text))
            cur = {"id": f"{file_key}#{idx}", "file": file_key,
                   "path": [t for _, t in stack], "level": lv, "text": ""}
    flush()
    return sections


# ---- .doc 支持 ----------------------------------------------------------
# python-docx 只能读 OOXML 的 .docx，老的二进制 .doc 读不了。投标文件两种格式都会来，
# 所以 .doc 先转成 .docx 落到 _converted/ 缓存里，再走同一条解析路径。
# 转换器按可用性依次尝试；一个都没有就直接退出并说清楚怎么办，不静默跳过文件——
# 少解析一个文件等于该家标书凭空少一章，比报错难查得多。

def _convert_with_office(src: Path, dst: Path) -> bool:
    """走本机装的 Word 或 WPS（都注册 COM）。仅 Windows 可用。"""
    try:
        import win32com.client
    except ImportError:
        return False
    for prog_id in ("Word.Application", "KWps.Application"):
        app = None
        try:
            app = win32com.client.Dispatch(prog_id)
            app.Visible = False
            doc = app.Documents.Open(str(src.resolve()), ReadOnly=True)
            doc.SaveAs2(str(dst.resolve()), FileFormat=16)  # 16 = docx
            doc.Close(False)
            return dst.exists()
        except Exception:
            continue
        finally:
            if app is not None:
                try:
                    app.Quit()
                except Exception:
                    pass
    return False


def _convert_with_soffice(src: Path, dst: Path) -> bool:
    """走 LibreOffice/OpenOffice 命令行。跨平台兜底。"""
    exe = shutil.which("soffice") or shutil.which("libreoffice")
    if not exe:
        return False
    try:
        subprocess.run(
            [exe, "--headless", "--convert-to", "docx", "--outdir", str(dst.parent), str(src)],
            check=True, capture_output=True, timeout=300)
    except Exception:
        return False
    return dst.exists()


def ensure_docx(path: Path, cache_dir: Path) -> Path:
    """.docx 原样返回；.doc 转换后返回 .docx 路径。缓存比源文件新就直接复用。"""
    if path.suffix.lower() == ".docx":
        return path
    cache_dir.mkdir(parents=True, exist_ok=True)
    dst = cache_dir / (path.stem + ".docx")
    if dst.exists() and dst.stat().st_mtime >= path.stat().st_mtime:
        return dst
    print(f"  转换 {path.name} -> docx ...")
    if _convert_with_office(path, dst) or _convert_with_soffice(path, dst):
        return dst
    sys.exit(
        "无法把 %s 转成 docx。需要以下任一：Windows 上装了 Word 或 WPS 且已 "
        "pip install pywin32；或 PATH 里有 LibreOffice 的 soffice。"
        "也可以手工另存为 docx 放到 %s 后重跑。" % (path.name, dst))


def main(src_dir: str, out_path: str):
    src = Path(src_dir)
    files = sorted(p for p in src.iterdir()
                   if p.suffix.lower() in (".docx", ".doc") and not p.name.startswith("~$"))
    if not files:
        sys.exit(f"没有找到 doc/docx: {src}")
    cache_dir = src / "_converted"

    all_sections = []
    for f in files:
        key = f.stem.split(".")[0] or f.stem
        secs = parse_docx(ensure_docx(f, cache_dir), key)
        all_sections.extend(secs)
        chars = sum(s["char_len"] for s in secs)
        print(f"{f.name[:34]:36s} 章节 {len(secs):5d}  字数 {chars:8,d}")

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(
        json.dumps(all_sections, ensure_ascii=False, indent=1), encoding="utf-8")

    total = sum(s["char_len"] for s in all_sections)
    lens = sorted(s["char_len"] for s in all_sections)
    print(f"\n合计 {len(all_sections):,} 章节 / {total:,} 字")
    if lens:
        print(f"章节字数 中位数 {lens[len(lens)//2]:,}  "
              f"P90 {lens[int(len(lens)*.9)]:,}  最大 {lens[-1]:,}")
    print(f"-> {out_path}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
