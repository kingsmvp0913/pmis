"""文字型 PDF 讀取器(.pdf)。

以 pdfplumber 讀取。營造來源 PDF 常見兩種排版,兩者都支援:
1. **表格**:抽出第一個表格,第一列為表頭。
2. **鍵值文字**:如「廠商名稱:大同營造」,拆成 {欄位: 值} 單列。

明確不做:掃描版 PDF 的 OCR(範圍外)。若整份抽不到文字,回報明確錯誤。
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .base import ParseError, ParseResult

_KV_PATTERN = re.compile(r"^\s*(.+?)\s*[:：]\s*(.*\S)?\s*$")


def _table_to_result(table: list[list[Any]]) -> ParseResult | None:
    if not table or len(table) < 2:
        return None
    header = [(c or "").strip() for c in table[0]]
    fields = [h for h in header if h != ""]
    if not fields:
        return None

    data_rows: list[dict[str, Any]] = []
    for raw in table[1:]:
        cells = [(c or "").strip() for c in raw]
        record: dict[str, Any] = {}
        has_value = False
        for idx, name in enumerate(header):
            if name == "":
                continue
            val = cells[idx] if idx < len(cells) else ""
            if val != "":
                has_value = True
            record[name] = val
        if has_value:
            data_rows.append(record)
    if not data_rows:
        return None
    return ParseResult(fields=fields, rows=data_rows)


def _text_to_result(text: str) -> ParseResult | None:
    record: dict[str, Any] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        m = _KV_PATTERN.match(line)
        if m:
            key = m.group(1).strip()
            val = (m.group(2) or "").strip()
            if key:
                record[key] = val
    if not record:
        return None
    return ParseResult(fields=list(record.keys()), rows=[record])


def parse(path: Path) -> ParseResult:
    import pdfplumber

    all_text_parts: list[str] = []
    best_table: ParseResult | None = None

    with pdfplumber.open(str(path)) as pdf_doc:
        for page in pdf_doc.pages:
            for tbl in page.extract_tables() or []:
                res = _table_to_result(tbl)
                if res and (best_table is None or len(res.rows) > len(best_table.rows)):
                    best_table = res
            page_text = page.extract_text() or ""
            if page_text:
                all_text_parts.append(page_text)

    if best_table is not None:
        return best_table

    full_text = "\n".join(all_text_parts).strip()
    if not full_text:
        raise ParseError(
            f"PDF「{path.name}」抽不到任何文字,可能是掃描/圖片型 PDF(OCR 為範圍外,不支援)。"
        )

    kv = _text_to_result(full_text)
    if kv is not None:
        return kv

    raise ParseError(
        f"PDF「{path.name}」中找不到可辨識的表格或「欄位:值」內容。"
    )
