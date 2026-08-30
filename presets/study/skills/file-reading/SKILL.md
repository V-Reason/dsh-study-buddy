---
name: file-reading
description: 按用户给的路径读取资料文件（PDF/PPT/PPTX/PNG/JPG/图片/Word/文本/代码）的完整工具链、内嵌图片提取、失败兜底与只读输出模板。用户给出文件路径要求"读取/看一下/读一下"时加载。
---

# 文件读取（仅读取，不讲解）

> 铁律：**读取 ≠ 讲解**。本技能只负责"把文件内容读出来并输出读取报告"。
> 不讲解、不分析、不联想、不出卡片预览、不推进四步闭环、不联网。
> 报告末尾回到待命，等用户下一条指令（讲解/继续读后续页/换文件）。
> 图片同样只读不讲解：读完只描述所见结构，不展开讲原理。

## 第一步：判定扩展名 → 选工具链

| 扩展名 | 工具链 | 说明 |
| :-- | :-- | :-- |
| `.png` `.jpg` `.jpeg` `.webp` `.gif` | `read_image`（file_path=绝对路径） | 唯一首选；失败如实说，请用户补文字 |
| `.txt` `.md` `.json` `.yml` `.yaml` `.csv` `.html` `.xml` 及代码文件 | `read` | 直接文本读取 |
| `.pdf` | ① `pwsh` + Python PyMuPDF 提取文本（见下）；② 同一步用 PyMuPDF 找含图页并渲染 PNG → `read_image` | 文本 + 内嵌图片都要给模型；扫描版天然走含图页渲染 |
| `.pptx` | ① `pwsh` + python-pptx 按 slide 提取文本；② python-pptx 提取图片 shape（`PICTURE`）→ `read_image`；zipfile 解 `ppt/media/*` 兜底 | 文本框 + 表格 + 图片；slide 背景/母版图可能遗漏（见备注） |
| `.docx` | ① `pwsh` + Python 标准库（zipfile 解 `word/document.xml` 取 `w:t`）；② zipfile 解 `word/media/*` 提取图片 → `read_image` | 无需第三方库；Word 粘贴图常为 png，绘图对象可能为 emf/wmf（需转换） |
| `.ppt` `.doc` `.xls`（旧二进制格式） | 不主动尝试 COM（易挂起）；请用户另存为 `.pptx/.pdf/.docx` 或导出文本/图片后重读 | 转存后再读 |

**图片格式白名单**（`read_image` 可读）：`png / jpg / jpeg / webp / gif`。其他（`svg / emf / wmf / bmp / tiff`）只列进报告的「需转换」清单，**绝不假装读取**——提示用户另存为 PNG 或把文件另存为 PDF 重走 PDF 链路。

## 第二步：执行命令（模板已在本机验证，直接使用）

路径含空格/中文均可直接传参；输出用 `-X utf8` 防中文乱码；`python -c` 后**不要加 `--`**，直接跟路径。三张/提取命令统一用 PowerShell here-string（`$code = @'…'@`），多行可读、注释不干扰执行。

**PDF 提取文本（页数上限，默认 10 页，超长可续读）**：

```powershell
$code = @'
import fitz, sys
d = fitz.open(sys.argv[1])
n = len(d)
print("pages:", n)
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 10
for i in range(min(n, limit)):
    print("[page %d]" % (i + 1) + chr(10) + d[i].get_text())
'@
python -X utf8 -c $code "文件绝对路径" 10
```

**PDF 找含图页并渲染 PNG（默认前 12 个含图页，输出清单）**——文本近空时同样用本命令（扫描版每页都含图）：

```powershell
$code = @'
import fitz, os, sys
doc = fitz.open(sys.argv[1])
out = sys.argv[2]
max_pages = int(sys.argv[3]) if len(sys.argv) > 3 else 12
os.makedirs(out, exist_ok=True)
image_pages = [i for i in range(len(doc)) if doc[i].get_image_info()]
if not image_pages:
    print("image_pages: 0")
else:
    saved = []
    for i in image_pages[:max_pages]:
        path = os.path.join(out, "pdfpage%03d.png" % (i + 1))
        doc[i].get_pixmap(dpi=200).save(path)
        saved.append("page %d -> %s" % (i + 1, path))
    print("image_pages: %d (rendered %d)" % (len(image_pages), len(saved)))
    print(chr(10).join(saved))
'@
python -X utf8 -c $code "文件绝对路径" "工作区内临时目录\pdf_media" 12
```

> 含图页以外若有 "文本近空" 的页，也用本命令注明的办法逐页渲染读图；渲染后对每个 `pdfpageNNN.png` 调 `read_image`，读完可清理临时文件。

**PPTX 提取文本（含表格）**：

```powershell
$code = @'
import sys
from pptx import Presentation
p = Presentation(sys.argv[1])
for i, slide in enumerate(p.slides):
    print("[slide %d]" % (i + 1))
    for sh in slide.shapes:
        if getattr(sh, "has_text_frame", False) and sh.text_frame.text:
            print(sh.text_frame.text)
'@
python -X utf8 -c $code "文件绝对路径"
```

**PPTX 提取图片（PICTURE shape，GROUP 递归；后台/母版图可能遗漏，遗漏时提示用户另存 PDF 重读）**：

```powershell
$code = @'
import os, sys
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE
prs = Presentation(sys.argv[1])
out = sys.argv[2]
os.makedirs(out, exist_ok=True)
count = 0
paths = []
def walk(shapes, slide_no):
    global count
    for sh in shapes:
        if sh.shape_type == MSO_SHAPE_TYPE.PICTURE:
            count += 1
            ext = getattr(sh.image, "ext", None) or "png"
            path = os.path.join(out, "slide%03d_img%02d.%s" % (slide_no, count, ext))
            with open(path, "wb") as f:
                f.write(sh.image.blob)
            paths.append("slide %d -> %s" % (slide_no, path))
        elif sh.shape_type == MSO_SHAPE_TYPE.GROUP:
            walk(sh.shapes, slide_no)
for i, slide in enumerate(prs.slides):
    walk(slide.shapes, i + 1)
print("images: %d" % count)
print(chr(10).join(paths))
'@
python -X utf8 -c $code "文件绝对路径" "工作区内临时目录\pptx_media"
```

**PPTX 图片兜底（zipfile 解 `ppt/media/*`，丢掉 slide 映射）**——python-pptx 缺库或漏图时用：

```powershell
$code = @'
import zipfile, os, sys
z = zipfile.ZipFile(sys.argv[1])
out = sys.argv[2]
os.makedirs(out, exist_ok=True)
saved = []
for name in z.namelist():
    if not name.startswith("ppt/media/"):
        continue
    path = os.path.join(out, os.path.basename(name))
    with open(path, "wb") as f:
        f.write(z.read(name))
    saved.append("%s -> %s" % (name, path))
print("media: %d" % len(saved))
print(chr(10).join(saved))
'@
python -X utf8 -c $code "文件绝对路径" "工作区内临时目录\pptx_media"
```

**DOCX 提取文本（标准库）**：

```powershell
$code = @'
import sys, zipfile, re
x = zipfile.ZipFile(sys.argv[1]).read("word/document.xml").decode("utf-8")
print(re.sub(r"<w:p[ >]", "\n", re.sub(r"<[^>]+>", "", x)))
'@
python -X utf8 -c $code "文件绝对路径"
```

**DOCX 提取图片（标准库：`word/media/*` 原样落盘）**：

```powershell
$code = @'
import zipfile, os, sys
z = zipfile.ZipFile(sys.argv[1])
out = sys.argv[2]
os.makedirs(out, exist_ok=True)
saved = []
for name in z.namelist():
    if not name.startswith("word/media/"):
        continue
    path = os.path.join(out, os.path.basename(name))
    with open(path, "wb") as f:
        f.write(z.read(name))
    saved.append("%s -> %s" % (name, path))
print("media: %d" % len(saved))
print(chr(10).join(saved))
'@
python -X utf8 -c $code "文件绝对路径" "工作区内临时目录\docx_media"
```

**读图轮次**：清单输出后，按清单顺序对**白名单格式**逐张 `read_image(file_path=绝对路径)`；清单 >12 张时先读前 12 张，并在报告注明"已读前 12 张，共 N 张，可继续读后续"。每张读完记一句"图N（第M页/第 K 张）：所见结构"。

## 第三步：失败兜底链（按顺序，不跳过）

1. **文件不存在/路径错** → 如实报告，请用户核对路径（不猜测、不换相近路径）。
2. **命令报错**（库缺失/语法/格式损坏）→ 按表换备选：fitz 失败可试 `pypdf`/`pdfplumber`（若已装）；PPTX 图片换 zipfile 兜底命令；仍失败 → 如实报告错误，不编造内容。
3. **输出乱码** → 确认命令带 `-X utf8` 后重试；仍乱码 → 如实报告。
4. **超长文件** → 按页数/张数上限执行，报告注明"已读前 N 页/张，可继续读后续"。
5. **沙箱/权限拒绝**（文件在工作区或 vault 之外时可能发生）→ 如实报告：按平台拒绝流程处理（一次提升请求），或请用户把文件放入工作区/vault 后再读。绝不绕过限制。
6. **图片读不出/看不清** → 如实说，请用户补文字或提供更高清版本；不假装理解。
7. **图片提取数为 0 但用户明确"图里有内容"** → 先换兜底命令再试（PPTX→zipfile；PDF→渲染整页）；仍无 → 请用户提供截图/导出图片/另存 PDF 重读，明说"未提取到图片"。
8. **非白名单格式（svg/emf/wmf/bmp/tiff）** → 报告"需转换"清单，不假读；建议在 Office 中另存为 PNG，或整个文件另存为 PDF 重走 PDF 链路。

## 输出模板：读取报告

读完后**只**输出以下报告，其余一概不做：

```
已读取：<文件名>（<类型>，N 页/张）
内容骨架：
- <每页/每节一句话要点；图片则描述所见结构与关键内容>
图片：N 张
- 图1（第 3 页）：<所见结构一句话>
- 图2（第 5 页）：<所见结构一句话>
（卡图时注明"已读前 N 张，共 M 张，可继续读后续"；有需转换格式则列"需转换：<清单>"）
重叠预警：<可选：card_search 一行命中摘要；无则省略此行>
（待命中。可指令：讲解 / 继续读后续页 / 换文件）
```

> 重叠预警只允许一行、不展开；是否讲解、怎么讲解，等用户下命令。
> 读图只为识图，讲与不讲的主动权永远在用户——读完图仍只出报告。
