"""格式偵測與分派。

對外統一介面:所有讀取器回傳 ``ParseResult``(欄位清單 + 資料列),
新增格式只需新增一個讀取器並在此註冊,不影響其他元件。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


class ParseError(Exception):
    """無法解析檔案時拋出,附帶明確中文訊息與偵測到的類型。"""


@dataclass
class ParseResult:
    """統一結構:欄位清單 + 資料列。

    fields:欄位名稱清單(順序即原始順序)。
    rows:每列為 {欄位名: 值} 的字典;文件型來源可能只有一列。
    source_type:偵測到的格式(excel/xls/csv/ods/word/pdf)。
    """

    fields: list[str]
    rows: list[dict[str, Any]]
    source_type: str = ""
    meta: dict[str, Any] = field(default_factory=dict)

    def sample_value(self, field_name: str) -> Any:
        """取某欄第一個非空範例值,供對應設定畫面顯示。"""
        for row in self.rows:
            v = row.get(field_name)
            if v not in (None, ""):
                return v
        return ""


# 副檔名 → 讀取器函式。延遲匯入避免載入未安裝的套件時整體崩潰。
def _load_dispatch() -> dict[str, Callable[[Path], ParseResult]]:
    from . import excel, csv_, ods, word, pdf

    return {
        ".xlsx": excel.parse,
        ".xlsm": excel.parse,
        ".xls": excel.parse,
        ".csv": csv_.parse,
        ".ods": ods.parse,
        ".docx": word.parse,
        ".pdf": pdf.parse,
    }


SUPPORTED_EXTENSIONS = {".xlsx", ".xlsm", ".xls", ".csv", ".ods", ".docx", ".pdf"}

# 明確不做(範圍外):圖片與掃描 PDF 的 OCR、PowerPoint 來源。
UNSUPPORTED_HINTS = {
    ".jpg": "圖片檔",
    ".jpeg": "圖片檔",
    ".png": "圖片檔",
    ".tiff": "圖片檔",
    ".ppt": "PowerPoint",
    ".pptx": "PowerPoint",
}


def detect_type(path: Path) -> str:
    """依副檔名回傳格式代碼;無法辨識則拋出明確錯誤。"""
    ext = path.suffix.lower()
    if ext in SUPPORTED_EXTENSIONS:
        return {
            ".xlsx": "excel",
            ".xlsm": "excel",
            ".xls": "xls",
            ".csv": "csv",
            ".ods": "ods",
            ".docx": "word",
            ".pdf": "pdf",
        }[ext]
    if ext in UNSUPPORTED_HINTS:
        raise ParseError(
            f"偵測到「{UNSUPPORTED_HINTS[ext]}」({ext}),本系統不支援此類來源(範圍外)。"
        )
    raise ParseError(f"無法辨識的檔案類型:{ext or '(無副檔名)'}。")


def parse(path: str | Path) -> ParseResult:
    """主要進入點:偵測格式並分派給對應讀取器。"""
    p = Path(path)
    if not p.exists():
        raise ParseError(f"找不到檔案:{p}")

    source_type = detect_type(p)  # 先驗證是否支援,並取得可讀類型
    dispatch = _load_dispatch()
    reader = dispatch.get(p.suffix.lower())
    if reader is None:  # 理論上 detect_type 已擋掉,防禦性處理
        raise ParseError(f"無對應讀取器:{p.suffix}")

    try:
        result = reader(p)
    except ParseError:
        raise
    except Exception as exc:  # 任何底層套件錯誤都轉成明確中文訊息
        raise ParseError(
            f"讀取「{p.name}」失敗(偵測類型:{source_type})。原因:{exc}"
        ) from exc

    result.source_type = source_type
    return result
