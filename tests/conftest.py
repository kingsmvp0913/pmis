"""測試共用設定:每個測試用獨立的暫存資料庫,不污染真實 data/pmis.db。"""
from __future__ import annotations

from pathlib import Path

import pytest

from app import db


@pytest.fixture()
def temp_db(tmp_path, monkeypatch):
    """把 db 模組指向暫存資料庫並初始化。"""
    db_path = tmp_path / "test_pmis.db"
    monkeypatch.setattr(db, "DB_PATH", db_path)
    db.init_db()
    return db


@pytest.fixture()
def samples_dir() -> Path:
    d = Path(__file__).parent / "samples"
    d.mkdir(exist_ok=True)
    return d
