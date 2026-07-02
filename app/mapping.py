"""自動建議對應 + 儲存/讀取對應表。

單一職責:比對來源欄位 vs 報表欄位,依欄名相似度產生建議;未對到的報表欄位
會被標記(前端顯示紅字),交給使用者手動指定。
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any

from . import db

# 相似度門檻:達到此值才自動建議對應,否則視為「未對應」需人工設定。
SUGGEST_THRESHOLD = 0.6


def _normalize(name: str) -> str:
    """正規化欄名以利比對:去空白、全形轉半形、統一常見同義詞。"""
    s = str(name).strip().lower()
    # 全形空白與標點
    s = s.replace("　", "").replace(" ", "")
    s = re.sub(r"[()（）\[\]【】:：,,、/／\-_]", "", s)
    # 常見同義詞歸一
    synonyms = {
        "統編": "統一編號",
        "統一编号": "統一編號",
        "廠商": "廠商名稱",
        "公司": "廠商名稱",
        "公司名稱": "廠商名稱",
        "名稱": "廠商名稱",
        "金額": "金額",
        "價格": "金額",
        "單價": "金額",
        "日期": "日期",
        "時間": "日期",
        "數量": "數量",
        "品名": "項目",
        "項次": "項目",
        "工程名稱": "工程名稱",
    }
    return synonyms.get(s, s)


def similarity(a: str, b: str) -> float:
    """回傳兩欄名的相似度 0~1。完全相等=1;正規化後相等接近 1。"""
    na, nb = _normalize(a), _normalize(b)
    if na == nb and na != "":
        return 1.0
    ratio = SequenceMatcher(None, na, nb).ratio()
    # 一方包含另一方時提高分數(例:「金額」vs「工程金額」)
    if na and nb and (na in nb or nb in na):
        ratio = max(ratio, 0.85)
    return ratio


def suggest(
    source_fields: list[str], report_fields: list[str]
) -> dict[str, Any]:
    """為每個報表欄位挑一個最相似的來源欄位(達門檻才建議)。

    回傳:
      suggestions:[{report_field, source_field, score, auto}]
        - auto=True 表系統自動建議;auto=False 表未達門檻(前端標紅字)。
      unmapped:未對到來源的報表欄位清單。
    """
    suggestions: list[dict[str, Any]] = []
    unmapped: list[str] = []
    used_sources: set[str] = set()

    for rf in report_fields:
        best_src = ""
        best_score = 0.0
        for sf in source_fields:
            if sf in used_sources:
                continue
            score = similarity(rf, sf)
            if score > best_score:
                best_score = score
                best_src = sf

        if best_score >= SUGGEST_THRESHOLD and best_src:
            used_sources.add(best_src)
            suggestions.append(
                {
                    "report_field": rf,
                    "source_field": best_src,
                    "score": round(best_score, 3),
                    "auto": True,
                }
            )
        else:
            unmapped.append(rf)
            suggestions.append(
                {
                    "report_field": rf,
                    "source_field": "",
                    "score": round(best_score, 3),
                    "auto": False,
                }
            )

    return {"suggestions": suggestions, "unmapped": unmapped}


def save_mappings(vendor_id: int, report_id: int, pairs: list[dict[str, Any]]) -> None:
    """儲存使用者確認後的對應(整批取代)。"""
    db.set_mappings(vendor_id, report_id, pairs)


def load_mappings(vendor_id: int, report_id: int) -> list[dict[str, Any]]:
    return db.list_mappings(vendor_id, report_id)


def unmapped_report_fields(vendor_id: int, report_id: int) -> list[str]:
    """回傳目前對應表中仍未對到來源(source_field 為空)的報表欄位。"""
    result = []
    for m in db.list_mappings(vendor_id, report_id):
        if not m.get("source_field"):
            result.append(m["report_field"])
    return result
