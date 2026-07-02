"""集中管理資料夾路徑,避免各模組各自拼路徑造成不一致。"""
from __future__ import annotations

from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
ROOT_DIR = APP_DIR.parent
DATA_DIR = ROOT_DIR / "data"
UPLOADS_DIR = DATA_DIR / "uploads"
REPORT_TEMPLATES_DIR = DATA_DIR / "report_templates"
OUTPUT_DIR = DATA_DIR / "output"


def ensure_dirs() -> None:
    for d in (DATA_DIR, UPLOADS_DIR, REPORT_TEMPLATES_DIR, OUTPUT_DIR):
        d.mkdir(parents=True, exist_ok=True)
