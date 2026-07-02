"""ODF 試算表讀取器(.ods)。

以 pandas 的 odf 引擎讀取(內部走 odfpy),第一列為欄位標題。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .base import ParseError, ParseResult


def _clean(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return value


def parse(path: Path) -> ParseResult:
    import pandas as pd

    df = pd.read_excel(path, engine="odf", dtype=object)
    df = df.where(df.notna(), "")
    fields = [str(c).strip() for c in df.columns]
    if not fields:
        raise ParseError(f"ODS 檔「{path.name}」沒有欄位標題。")

    rows = [
        {f: _clean(v) for f, v in zip(fields, rec)}
        for rec in df.itertuples(index=False, name=None)
    ]
    return ParseResult(fields=fields, rows=rows)
