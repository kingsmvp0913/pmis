"""對應建議測試:驗證建議結果與未對應清單(規格 §9)。"""
from __future__ import annotations

from app import mapping


def test_exact_and_similar_match():
    source = ["廠商名稱", "統編", "工程金額"]
    report = ["廠商名稱", "統一編號", "金額"]
    result = mapping.suggest(source, report)

    by_report = {s["report_field"]: s for s in result["suggestions"]}
    # 完全相同
    assert by_report["廠商名稱"]["source_field"] == "廠商名稱"
    assert by_report["廠商名稱"]["auto"] is True
    # 同義詞:統編 → 統一編號
    assert by_report["統一編號"]["source_field"] == "統編"
    # 包含關係:金額 vs 工程金額
    assert by_report["金額"]["source_field"] == "工程金額"
    assert result["unmapped"] == []


def test_unmapped_marked():
    source = ["公司抬頭"]
    report = ["廠商名稱", "完工日期"]
    result = mapping.suggest(source, report)
    # 完工日期沒有任何來源可對 → 未對應
    assert "完工日期" in result["unmapped"]
    unmapped_entry = next(s for s in result["suggestions"] if s["report_field"] == "完工日期")
    assert unmapped_entry["auto"] is False
    assert unmapped_entry["source_field"] == ""


def test_no_double_assignment():
    # 兩個報表欄位不應搶用同一個來源欄位
    source = ["名稱"]
    report = ["廠商名稱", "公司名稱"]
    result = mapping.suggest(source, report)
    used = [s["source_field"] for s in result["suggestions"] if s["source_field"]]
    assert len(used) == len(set(used))


def test_save_and_load(temp_db):
    vid = temp_db.create_vendor("大同營造")
    rid = temp_db.create_report("報表A")
    mapping.save_mappings(vid, rid, [
        {"report_field": "廠商名稱", "source_field": "名稱"},
        {"report_field": "金額", "source_field": ""},
    ])
    loaded = mapping.load_mappings(vid, rid)
    assert len(loaded) == 2
    assert mapping.unmapped_report_fields(vid, rid) == ["金額"]
