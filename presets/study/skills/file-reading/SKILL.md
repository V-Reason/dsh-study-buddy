---
name: file-reading
description: 按用户给的路径读取资料文件（PDF/PPT/PPTX/PNG/JPG/图片/Word/文本/代码）的完整工具链、失败兜底与只读输出模板。用户给出文件路径要求"读取/看一下/读一下"时加载。
---

# 文件读取（仅读取，不讲解）

> 铁律：**读取 ≠ 讲解**。本技能只负责"把文件内容读出来并输出读取报告"。
> 不讲解、不分析、不联想、不出卡片预览、不推进四步闭环、不联网。
> 报告末尾回到待命，等用户下一条指令（讲解/继续读后续页/换文件）。

## 第一步：判定扩展名 → 选工具链

| 扩展名 | 工具链 | 说明 |
| :-- | :-- | :-- |
| `.png` `.jpg` `.jpeg` `.webp` `.gif` | `read_image`（file_path=绝对路径） | 唯一首选；失败如实说，请用户补文字 |
| `.txt` `.md` `.json` `.yml` `.yaml` `.csv` `.html` `.xml` 及代码文件 | `read` | 直接文本读取 |
| `.pdf` | ① `pwsh` + Python PyMuPDF 提取文本（见下）；② 文本近空 → 渲染 PNG 逐页 `read_image` | 扫描版走② |
| `.pptx` | `pwsh` + python-pptx 按 slide 提取文本 | 文本框 + 表格 |
| `.docx` | `pwsh` + Python 标准库（zipfile 解 `word/document.xml` 取 `w:t`） | 无需第三方库 |
| `.ppt` `.doc` `.xls`（旧二进制格式） | 不主动尝试 COM（易挂起）；请用户另存为 `.pptx/.pdf/.docx` 或导出文本后重读 | 转存后再读 |

## 第二步：执行命令（模板已在本机验证，直接使用）

路径含空格/中文均可直接传参；输出用 `-X utf8` 防中文乱码；`python -c` 后**不要加 `--`**，直接跟路径。

**PDF 提取文本（页数上限，默认 10 页，超长可续读）**：

```powershell
python -X utf8 -c "import fitz,sys; d=fitz.open(sys.argv[1]); n=len(d); print('pages:',n); [print('[page %d]'%(i+1)+chr(10)+d[i].get_text()) for i in range(min(n,int(sys.argv[2]) if len(sys.argv)>2 else 10))]" "文件绝对路径" 10
```

若提取结果基本为空（`pages: N` 但正文没内容）→ 扫描版，走渲染：

**PDF 渲染为 PNG（默认前 6 页，渲染到工作区可写目录）**：

```powershell
python -X utf8 -c "import fitz,sys,os; d=fitz.open(sys.argv[1]); os.chdir(sys.argv[2]); [d[i].get_pixmap(dpi=150).save('pdfpage%02d.png'%(i+1)) for i in range(min(len(d), int(sys.argv[3]) if len(sys.argv)>3 else 6))]; print('rendered')" "文件绝对路径" "工作区内临时目录" 6
```

渲染完成后对每个 `pdfpageNN.png` 调用 `read_image` 逐页读取；读完可清理临时 PNG。

**PPTX 按 slide 提取文本**：

```powershell
python -X utf8 -c "import sys; from pptx import Presentation; p=Presentation(sys.argv[1]); [print('[slide %d]'%(i+1)) or [print(sh.text) for sh in slide.shapes if getattr(sh,'has_text_frame',False) and sh.text_frame.text] for i,slide in enumerate(p.slides)]" "文件绝对路径"
```

**DOCX 提取文本（标准库）**：

```powershell
python -X utf8 -c "import sys,zipfile,re; x=zipfile.ZipFile(sys.argv[1]).read('word/document.xml').decode('utf-8'); print(re.sub(r'<w:p[ >]','\n',re.sub(r'<[^>]+>','',x)))" "文件绝对路径"
```

## 第三步：失败兜底链（按顺序，不跳过）

1. **文件不存在/路径错** → 如实报告，请用户核对路径（不猜测、不换相近路径）。
2. **命令报错**（库缺失/语法/格式损坏）→ 按表换备选：fitz 失败可试 `pypdf`/`pdfplumber`（若已装）；仍失败 → 如实报告错误，不编造内容。
3. **输出乱码** → 确认命令带 `-X utf8` 后重试；仍乱码 → 如实报告。
4. **超长文件** → 按页数上限读取，报告注明"已读前 N 页，可继续读后续页"。
5. **沙箱/权限拒绝**（文件在工作区或 vault 之外时可能发生）→ 如实报告：按平台拒绝流程处理（一次提升请求），或请用户把文件放入工作区/vault 后再读。绝不绕过限制。
6. **图片读不出/看不清** → 如实说，请用户补文字或提供更高清版本；不假装理解。

## 输出模板：读取报告

读完后**只**输出以下报告，其余一概不做：

```
已读取：<文件名>（<类型>，N 页/张）
内容骨架：
- <每页/每节一句话要点；图片则描述所见结构与关键内容>
重叠预警：<可选：card_search 一行命中摘要；无则省略此行>
（待命中。可指令：讲解 / 继续读后续页 / 换文件）
```

> 重叠预警只允许一行、不展开；是否讲解、怎么讲解，等用户下命令。
