"""CSV 讀取器。

自動嘗試常見編碼(UTF-8 / UTF-8-BOM / 台灣常見的 Big5),避免中文亂碼。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .base import ParseError, ParseResult

_ENCODINGS = ["utf-8-sig", "utf-8", "big5", "cp950"]


def _clean(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return value


def parse(path: Path) -> ParseResult:
    import pandas as pd

    last_err: Exception | None = None
    df = None
    for enc in _ENCODINGS:
        try:
            df = pd.read_csv(path, dtype=object, encoding=enc)
            break
        except UnicodeDecodeError as exc:
            last_err = exc
            continue
    if df is None:
        raise ParseError(
            f"CSV 檔「{path.name}」編碼無法辨識(已嘗試 UTF-8 / Big5)。原因:{last_err}"
        )

    df = df.where(df.notna(), "")
    fields = [str(c).strip() for c in df.columns]
    if not fields:
        raise ParseError(f"CSV 檔「{path.name}」沒有欄位標題。")

    rows = [
        {f: _clean(v) for f, v in zip(fields, rec)}
        for rec in df.itertuples(index=False, name=None)
    ]
    return ParseResult(fields=fields, rows=rows)
