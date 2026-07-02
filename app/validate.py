"""數字驗算 —— 小計 / 總計 / 稅額(5%)。

金額欄位由使用者在報表設定中標記(report_fields.field_role = 'amount')。
提供:欄位加總、稅額計算、以及「宣稱總計 vs 實算總計」的一致性檢查(對不起來標警告)。
"""
from __future__ import annotations

import re
from typing import Any

TAX_RATE = 0.05  # 台灣營業稅 5%


def to_number(value: Any) -> float | None:
    """把儲存格值轉成數字;無法解析回傳 None。容忍千分位逗號與貨幣符號。"""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    s = re.sub(r"[,,$＄元\s]", "", s)
    try:
        return float(s)
    except ValueError:
        return None


def sum_column(rows: list[dict[str, Any]], field_name: str) -> float:
    total = 0.0
    for row in rows:
        n = to_number(row.get(field_name))
        if n is not None:
            total += n
    return total


def column_totals(rows: list[dict[str, Any]], amount_fields: list[str]) -> dict[str, float]:
    return {f: sum_column(rows, f) for f in amount_fields}


def tax_of(amount: float) -> float:
    return round(amount * TAX_RATE, 2)


def format_amount(value: float) -> str:
    """整數就不顯示小數,否則保留兩位。"""
    if abs(value - round(value)) < 1e-9:
        return f"{int(round(value)):,}"
    return f"{value:,.2f}"


def check_declared_total(
    rows: list[dict[str, Any]], amount_field: str, declared_total: Any
) -> str | None:
    """比對某金額欄的逐列加總 vs 使用者宣稱的總計。不一致回傳警告字串。"""
    declared = to_number(declared_total)
    if declared is None:
        return None
    actual = sum_column(rows, amount_field)
    if abs(actual - declared) > 0.5:  # 容許 0.5 元四捨五入誤差
        return (
            f"金額欄「{amount_field}」逐列加總為 {format_amount(actual)},"
            f"但宣稱總計為 {format_amount(declared)},兩者不符,請確認。"
        )
    return None
