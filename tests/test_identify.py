"""辨識測試:驗證正確辨識,以及規則衝突時回報「需人工確認」而非任選(規格 §9, Rule 9)。"""
from __future__ import annotations

from app import identify
from app.parsers.base import ParseResult


def _parsed(rows, fields=None):
    if fields is None:
        fields = list(rows[0].keys()) if rows else []
    return ParseResult(fields=fields, rows=rows, source_type="excel")


def test_match_by_tax_id(temp_db):
    vid = temp_db.create_vendor("大同營造", tax_id="12345678")
    temp_db.add_signature(vid, "tax_id", "12345678")

    parsed = _parsed([{"統一編號": "12345678", "金額": "1000"}])
    result = identify.identify(parsed, "any.xlsx")
    assert result.status == "matched"
    assert result.vendor_id == vid


def test_match_by_name_in_cell(temp_db):
    vid = temp_db.create_vendor("大同營造")
    temp_db.add_signature(vid, "name_in_cell", "大同")

    parsed = _parsed([{"備註": "本表由大同營造提供"}])
    result = identify.identify(parsed, "report.xlsx")
    assert result.status == "matched"
    assert result.vendor_id == vid


def test_match_by_filename_keyword(temp_db):
    vid = temp_db.create_vendor("中華工程")
    temp_db.add_signature(vid, "filename_keyword", "中華")

    parsed = _parsed([{"金額": "1000"}])
    result = identify.identify(parsed, "中華工程_2026.xlsx")
    assert result.status == "matched"
    assert result.vendor_id == vid


def test_no_match_needs_confirm(temp_db):
    vid = temp_db.create_vendor("大同營造")
    temp_db.add_signature(vid, "tax_id", "12345678")

    parsed = _parsed([{"統一編號": "99999999"}])
    result = identify.identify(parsed, "unknown.xlsx")
    assert result.status == "need_confirm"
    assert result.vendor_id is None
    assert result.candidates == []


def test_conflict_needs_confirm(temp_db):
    """兩家廠商規則同時符合時,必須回報需人工確認,不可任選一家(Rule 9)。"""
    v1 = temp_db.create_vendor("甲營造")
    v2 = temp_db.create_vendor("乙營造")
    # 兩家都用同一個關鍵字(模擬規則衝突)
    temp_db.add_signature(v1, "name_in_cell", "營造")
    temp_db.add_signature(v2, "name_in_cell", "營造")

    parsed = _parsed([{"名稱": "某某營造工程"}])
    result = identify.identify(parsed, "x.xlsx")
    assert result.status == "need_confirm"
    assert result.vendor_id is None
    assert set(result.candidates) == {v1, v2}
