"""廠商自動辨識。

單一職責:給一份來源檔的解析結果 + 檔名,依廠商識別規則庫判斷屬於哪家廠商。
規則衝突(無符合 / 多筆符合)時**回報「需人工確認」**,絕不任選一家硬猜(Rule 9)。

支援的規則類型(vendor_signatures.rule_type):
- tax_id:            來源資料中出現此統一編號
- name_in_cell:      來源資料中任一儲存格文字包含此廠商名稱字串
- filename_keyword:  來源檔名包含此關鍵字
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from . import db
from .parsers.base import ParseResult


@dataclass
class IdentifyResult:
    status: str                    # matched / need_confirm
    vendor_id: int | None          # matched 時為該廠商 id
    candidates: list[int]          # 命中的廠商 id(可能 0、1 或多筆)
    reason: str                    # 中文說明(供畫面顯示)


def _iter_cell_texts(parsed: ParseResult) -> list[str]:
    texts: list[str] = []
    for row in parsed.rows:
        for v in row.values():
            if v not in (None, ""):
                texts.append(str(v))
    # 欄名本身也納入比對(有些來源把廠商名放在表頭)
    texts.extend(str(f) for f in parsed.fields)
    return texts


def _normalize_tax_id(s: str) -> str:
    return "".join(ch for ch in str(s) if ch.isdigit())


def _rule_matches(rule: dict[str, Any], parsed: ParseResult, filename: str, cell_texts: list[str]) -> bool:
    rtype = rule["rule_type"]
    rvalue = str(rule["rule_value"]).strip()
    if not rvalue:
        return False

    if rtype == "tax_id":
        target = _normalize_tax_id(rvalue)
        if not target:
            return False
        return any(target == _normalize_tax_id(t) or target in _normalize_tax_id(t) for t in cell_texts)

    if rtype == "name_in_cell":
        return any(rvalue in t for t in cell_texts)

    if rtype == "filename_keyword":
        return rvalue in filename

    return False


def identify(parsed: ParseResult, filename: str) -> IdentifyResult:
    """依規則庫辨識廠商。

    命中定義:某廠商至少有一條規則符合。若剛好一家命中 → matched;
    否則(0 家或 ≥2 家)→ need_confirm,交由使用者從清單點選。
    """
    signatures = db.list_signatures()
    cell_texts = _iter_cell_texts(parsed)

    matched_vendor_ids: set[int] = set()
    for rule in signatures:
        if _rule_matches(rule, parsed, filename, cell_texts):
            matched_vendor_ids.add(int(rule["vendor_id"]))

    candidates = sorted(matched_vendor_ids)

    if len(candidates) == 1:
        return IdentifyResult(
            status="matched",
            vendor_id=candidates[0],
            candidates=candidates,
            reason="依識別規則辨識成功。",
        )
    if len(candidates) == 0:
        return IdentifyResult(
            status="need_confirm",
            vendor_id=None,
            candidates=[],
            reason="沒有任何廠商規則符合,請手動點選這是哪家廠商。",
        )
    return IdentifyResult(
        status="need_confirm",
        vendor_id=None,
        candidates=candidates,
        reason=f"有 {len(candidates)} 家廠商規則同時符合,請手動點選確認正確廠商。",
    )
