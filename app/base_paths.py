"""集中管理資料夾路徑,避免各模組各自拼路徑造成不一致。"""
from __future__ import annotations

from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
ROOT_DIR = APP_DIR.parent
DATA_DIR = ROOT_DIR / "data"
UPLOADS_DIR = DATA_DIR / "uploads"
REPORT_TEMPLATES_DIR = DATA_DIR / "report_templates"
OUTPUT_DIR = DATA_DIR / "output"


SECRET_FILE = DATA_DIR / ".session_secret"


def ensure_dirs() -> None:
    for d in (DATA_DIR, UPLOADS_DIR, REPORT_TEMPLATES_DIR, OUTPUT_DIR):
        d.mkdir(parents=True, exist_ok=True)


def get_session_secret() -> str:
    """取得(或首次產生並持久化)Session 簽章金鑰,讓登入狀態在重啟後仍有效。"""
    import os

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if SECRET_FILE.exists():
        return SECRET_FILE.read_text(encoding="utf-8").strip()
    secret = os.urandom(32).hex()
    SECRET_FILE.write_text(secret, encoding="utf-8")
    return secret
