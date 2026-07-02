"""PDF 匯出(最佳努力)。

依序嘗試:
1. LibreOffice(soffice --headless --convert-to pdf)—— 跨平台、免 MS Office。
2. docx2pdf(僅 Word 檔且電腦已安裝 Microsoft Word 時可用)。

若兩者皆不可用,回傳明確中文訊息,不讓使用者卡住(仍保有原始 Excel/Word 檔)。
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


class PdfExportError(Exception):
    pass


def _find_soffice() -> str | None:
    for name in ("soffice", "libreoffice"):
        path = shutil.which(name)
        if path:
            return path
    # Windows 常見安裝路徑
    for candidate in (
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    ):
        if Path(candidate).exists():
            return candidate
    return None


def to_pdf(source_path: str | Path) -> str:
    """把 Excel/Word 產出檔轉成 PDF,回傳 PDF 路徑。失敗拋 PdfExportError。"""
    src = Path(source_path)
    if not src.exists():
        raise PdfExportError(f"找不到要轉換的檔案:{src}")

    pdf_path = src.with_suffix(".pdf")

    soffice = _find_soffice()
    if soffice:
        try:
            subprocess.run(
                [soffice, "--headless", "--convert-to", "pdf", "--outdir",
                 str(src.parent), str(src)],
                check=True,
                capture_output=True,
                timeout=120,
            )
            if pdf_path.exists():
                return str(pdf_path)
        except Exception as exc:  # noqa: BLE001 - 轉下一個方法
            last = exc
        else:
            last = None
    else:
        last = None

    # 退而求其次:docx2pdf(需 Word)
    if src.suffix.lower() == ".docx":
        try:
            from docx2pdf import convert

            convert(str(src), str(pdf_path))
            if pdf_path.exists():
                return str(pdf_path)
        except Exception as exc:  # noqa: BLE001
            last = exc

    raise PdfExportError(
        "無法轉 PDF:未偵測到 LibreOffice(或 Microsoft Word)。"
        "請安裝 LibreOffice 後再試,原始檔仍可正常下載。"
        + (f"(細節:{last})" if last else "")
    )
