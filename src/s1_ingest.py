"""S1: 投标文件（PDF/Word） -> 章节树 JSON。

PDF 路径按真实工程标书的结构信号切块：行首编号确定层级，
再用当前 PDF 自己的满行宽 P90 过滤正文中的伪编号。Word 路径保留原有标题层级逻辑。

输入: 一个文件或目录。目录可递归发现 PDF；Word 文件仍兼容原有目录用法。
输出: [{id, file, item_guid, path, level, page, text, char_len, ...}, ...]
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import docx
import fitz

# Word 标题识别：优先 style，其次正文里的编号模式（很多标书正文伪装成标题）
_STYLE_H = re.compile(r"(?:Heading|标题)\s*(\d+)")
_NUM_H = re.compile(r"^\s*(?:第[一二三四五六七八九十百]+[章节]|[0-9]+(?:\.[0-9]+){0,4})[\s、.．]")

_GUID = re.compile(
    r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.pdf$",
    re.IGNORECASE,
)

# 顺序很重要：长的点号编号必须先于 N.N，避免 2.6.1 被识别成 2.6。
_PDF_NUMBERING = (
    (1, re.compile(r"^\s*第[一二三四五六七八九十百\d]+[章节篇部分]")),
    (2, re.compile(r"^\s*[一二三四五六七八九十百]{1,3}、")),
    (4, re.compile(r"^\s*\d+\.\d+\.\d+(?!\d)")),
    (4, re.compile(r"^\s*\d+\.\d+(?!\d)")),
    (3, re.compile(r"^\s*\d{1,2}[、.．](?!\d)")),
    (5, re.compile(r"^\s*[（(][一二三四五六七八九十百\d]{1,3}[）)]")),
)


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


def _new_section(file_key, path, level, page=None, item_guid=None, file_name=None):
    return {
        "id": f"{file_key}#0",
        "file": file_name if file_name is not None else file_key,
        "item_guid": item_guid,
        "path": path,
        "level": level,
        "page": page,
        "text": "",
    }


def _finish(section, file_key, idx, file_name=None):
    if not section or not section["text"].strip():
        return None
    section = dict(section)
    section["id"] = f"{file_key}#{idx}"
    section["text"] = section["text"].strip()
    section["char_len"] = len(section["text"])
    if file_name is not None:
        section["file"] = file_name
    return section


def parse_docx(path: Path, file_key: str):
    doc = docx.Document(str(path))
    sections, stack, cur = [], [], None
    idx = 0

    def flush():
        nonlocal cur, idx
        result = _finish(cur, file_key, idx + 1)
        if result:
            idx += 1
            sections.append(result)

    for kind, obj in _iter_blocks(doc):
        if kind == "t":
            if cur is None:
                cur = _new_section(file_key, ["(前言)"], 0)
            cur["text"] += "\n[表]\n" + _table_text(obj) + "\n"
            continue

        p = obj
        text = p.text.strip()
        if not text:
            continue
        lv = _heading_level(p)
        if lv is None:
            if cur is None:
                cur = _new_section(file_key, ["(前言)"], 0)
            cur["text"] += text + "\n"
        else:
            flush()
            while stack and stack[-1][0] >= lv:
                stack.pop()
            stack.append((lv, text))
            cur = _new_section(file_key, [t for _, t in stack], lv)
    flush()
    return sections


def _pdf_item_guid(path: Path):
    match = _GUID.search(path.name)
    return match.group(1).lower() if match else None


def _pdf_heading_level(text: str):
    """返回 PDF 编号形式对应的层级；正文伪编号也先返回层级，交由行长过滤。"""
    for level, pattern in _PDF_NUMBERING:
        if pattern.match(text):
            return level
    return None


def _p90(values):
    """与结构探针相同的离散 P90，避免引入随样本漂移的绝对阈值。"""
    if not values:
        return 0
    ordered = sorted(values)
    return ordered[min(int(len(ordered) * 0.9), len(ordered) - 1)]


def _pdf_lines(path: Path):
    """按视觉行提取 (页码, 文本) 列表与总页数，页码从 1 开始。"""
    doc = fitz.open(str(path))
    try:
        lines = []
        for page_number, page in enumerate(doc, start=1):
            blocks = page.get_text("dict").get("blocks", [])
            for block in blocks:
                for line in block.get("lines", []):
                    spans = line.get("spans", [])
                    text = "".join(span.get("text", "") for span in spans).strip()
                    if text:
                        lines.append((page_number, text))
        return lines, doc.page_count
    finally:
        doc.close()


def _chunk_lines(lines, file_key, item_guid=None, file_name=None):
    """把 (页码, 文本) 视觉行列表切成章节块。纯函数，便于单测。

    标题判定：编号命中且行长 < 0.8 × 本文档行长 P90。
    """
    threshold = 0.8 * _p90([len(text) for _, text in lines])
    file_name = file_name if file_name is not None else file_key
    sections, stack, cur = [], [], None
    idx = 0

    def flush():
        nonlocal cur, idx
        result = _finish(cur, file_key, idx + 1, file_name)
        if result:
            idx += 1
            sections.append(result)

    for page, text in lines:
        level = _pdf_heading_level(text)
        is_heading = level is not None and len(text) < threshold
        if is_heading:
            flush()
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, text))
            cur = _new_section(file_key, [t for _, t in stack], level, page, item_guid, file_name)
        else:
            if cur is None:
                cur = _new_section(file_key, ["(前言)"], 0, page, item_guid, file_name)
            cur["text"] += text + "\n"
    flush()
    return sections


def parse_pdf(path: Path, file_key: str):
    """按编号+相对行长规则切一份 PDF，返回 (章节块列表, 页数)。"""
    lines, page_count = _pdf_lines(path)
    return _chunk_lines(lines, file_key, _pdf_item_guid(path), path.name), page_count


# ---- .doc 支持 ----------------------------------------------------------
# python-docx 只能读 OOXML 的 .docx，老的二进制 .doc 读不了。
# .doc 先转成 .docx 落到 _converted/ 缓存里，再走同一条解析路径。


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
            doc.SaveAs2(str(dst.resolve()), FileFormat=16)
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
    """.docx 原样返回；.doc 转换后返回 .docx 路径。"""
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
        "无法把 %s 转成 docx。需要 Windows 上的 Word/WPS + pywin32，"
        "或 PATH 里的 LibreOffice soffice；也可以手工另存为 docx 放到 %s 后重跑。"
        % (path.name, dst)
    )


def _discover_files(src: Path):
    """发现输入文件；PDF 递归扫描，排除招标文件，避免混入投标章节树。"""
    if src.is_file():
        return [src]
    pdfs = sorted(
        p for p in src.rglob("*.pdf")
        if "招标文件" not in p.name and not p.name.startswith("~$")
    )
    if pdfs:
        return pdfs
    # docx/doc 递归查找时排除 _converted 缓存目录，避免第二次运行重复解析
    return sorted(
        p for p in src.rglob("*")
        if p.is_file()
        and p.suffix.lower() in (".docx", ".doc")
        and not p.name.startswith("~$")
        and "_converted" not in p.parts
    )


def main(src_dir: str, out_path: str):
    src = Path(src_dir)
    if not src.exists():
        sys.exit(f"输入路径不存在: {src}")
    files = _discover_files(src)
    if not files:
        sys.exit(f"没有找到 PDF/doc/docx: {src}")

    all_sections = []
    zero_block_files = 0
    for file_index, f in enumerate(files, start=1):
        key = str(file_index)
        if f.suffix.lower() == ".pdf":
            secs, pages = parse_pdf(f, key)
        else:
            cache_dir = f.parent / "_converted"
            secs = parse_docx(ensure_docx(f, cache_dir), key)
            pages = None
        all_sections.extend(secs)
        chars = sum(s["char_len"] for s in secs)
        if not secs:
            zero_block_files += 1
            print(f"⚠ 警告：{f.name} 切出 0 个章节块，可能是扫描件或空文件，将整项缺失")
            continue
        page_info = f" 页 {pages}" if pages is not None else ""
        print(f"{f.name[:34]:36s} 章节 {len(secs):5d}  字数 {chars:8,d}{page_info}")

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(
        json.dumps(all_sections, ensure_ascii=False, indent=1), encoding="utf-8"
    )

    total = sum(s["char_len"] for s in all_sections)
    lens = sorted(s["char_len"] for s in all_sections)
    print(f"\n合计 {len(all_sections):,} 章节 / {total:,} 字")
    if lens:
        print(
            f"章节字数 中位数 {lens[len(lens)//2]:,}  "
            f"P90 {lens[min(int(len(lens)*.9), len(lens)-1)]:,}  最大 {lens[-1]:,}"
        )
    if zero_block_files:
        print(f"⚠ 0 块文件数：{zero_block_files}")
    print(f"-> {out_path}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
