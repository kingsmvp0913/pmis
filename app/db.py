"""SQLite 資料存取層。

單一職責:建立資料表結構、提供連線與基本 CRUD。所有其他模組透過此處操作資料庫,
不直接寫 SQL 散落各處。使用者永遠不需要寫 SQL,一切走畫面。
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

from .base_paths import DATA_DIR

# 資料庫檔位置:C:\pmis\data\pmis.db
DB_PATH = DATA_DIR / "pmis.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS vendors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    tax_id      TEXT,
    note        TEXT,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vendor_signatures (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id   INTEGER NOT NULL,
    rule_type   TEXT NOT NULL,      -- tax_id / name_in_cell / filename_keyword
    rule_value  TEXT NOT NULL,
    FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    template_path TEXT,
    template_type TEXT,             -- excel / word
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS report_fields (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id   INTEGER NOT NULL,
    field_name  TEXT NOT NULL,
    location    TEXT,               -- 例:Excel 儲存格 B2、Word placeholder
    sort        INTEGER DEFAULT 0,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS vendor_templates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id       INTEGER NOT NULL,
    report_id       INTEGER NOT NULL,
    source_filename TEXT,
    source_type     TEXT,
    uploaded_at     TEXT NOT NULL,
    FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS source_fields (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_template_id INTEGER NOT NULL,
    field_name         TEXT NOT NULL,
    sample_value       TEXT,
    location           TEXT,
    FOREIGN KEY (vendor_template_id) REFERENCES vendor_templates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mappings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id    INTEGER NOT NULL,
    report_id    INTEGER NOT NULL,
    source_field TEXT,               -- 可為 NULL:報表欄位尚未對到來源
    report_field TEXT NOT NULL,
    FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS outputs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id   INTEGER,
    report_id   INTEGER NOT NULL,
    source_file TEXT,
    output_path TEXT,
    status      TEXT NOT NULL,       -- ok / warning / error / need_confirm
    warnings    TEXT,
    created_at  TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def get_connection() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """初始化資料庫結構(安裝時呼叫,重複呼叫安全)。"""
    with connect() as conn:
        conn.executescript(SCHEMA)


def _rows_to_dicts(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(r) for r in rows]


# --- vendors -------------------------------------------------------------

def create_vendor(name: str, tax_id: str = "", note: str = "") -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO vendors (name, tax_id, note, created_at) VALUES (?, ?, ?, ?)",
            (name, tax_id, note, now()),
        )
        return int(cur.lastrowid)


def list_vendors() -> list[dict[str, Any]]:
    with connect() as conn:
        return _rows_to_dicts(conn.execute("SELECT * FROM vendors ORDER BY id").fetchall())


def get_vendor(vendor_id: int) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM vendors WHERE id = ?", (vendor_id,)).fetchone()
        return dict(row) if row else None


def delete_vendor(vendor_id: int) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM vendors WHERE id = ?", (vendor_id,))


# --- vendor_signatures ---------------------------------------------------

def add_signature(vendor_id: int, rule_type: str, rule_value: str) -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO vendor_signatures (vendor_id, rule_type, rule_value) VALUES (?, ?, ?)",
            (vendor_id, rule_type, rule_value),
        )
        return int(cur.lastrowid)


def list_signatures(vendor_id: int | None = None) -> list[dict[str, Any]]:
    with connect() as conn:
        if vendor_id is None:
            rows = conn.execute("SELECT * FROM vendor_signatures ORDER BY id").fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM vendor_signatures WHERE vendor_id = ? ORDER BY id",
                (vendor_id,),
            ).fetchall()
        return _rows_to_dicts(rows)


def delete_signature(signature_id: int) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM vendor_signatures WHERE id = ?", (signature_id,))


# --- reports -------------------------------------------------------------

def create_report(name: str, template_path: str = "", template_type: str = "") -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO reports (name, template_path, template_type, created_at) VALUES (?, ?, ?, ?)",
            (name, template_path, template_type, now()),
        )
        return int(cur.lastrowid)


def list_reports() -> list[dict[str, Any]]:
    with connect() as conn:
        return _rows_to_dicts(conn.execute("SELECT * FROM reports ORDER BY id").fetchall())


def get_report(report_id: int) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM reports WHERE id = ?", (report_id,)).fetchone()
        return dict(row) if row else None


def delete_report(report_id: int) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM reports WHERE id = ?", (report_id,))


# --- report_fields -------------------------------------------------------

def set_report_fields(report_id: int, fields: list[dict[str, Any]]) -> None:
    """以整批取代方式寫入報表欄位(重新抽取時先清空)。"""
    with connect() as conn:
        conn.execute("DELETE FROM report_fields WHERE report_id = ?", (report_id,))
        for i, f in enumerate(fields):
            conn.execute(
                "INSERT INTO report_fields (report_id, field_name, location, sort) VALUES (?, ?, ?, ?)",
                (report_id, f["field_name"], f.get("location", ""), f.get("sort", i)),
            )


def list_report_fields(report_id: int) -> list[dict[str, Any]]:
    with connect() as conn:
        return _rows_to_dicts(
            conn.execute(
                "SELECT * FROM report_fields WHERE report_id = ? ORDER BY sort, id",
                (report_id,),
            ).fetchall()
        )


# --- vendor_templates & source_fields -----------------------------------

def create_vendor_template(
    vendor_id: int, report_id: int, source_filename: str, source_type: str
) -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO vendor_templates (vendor_id, report_id, source_filename, source_type, uploaded_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (vendor_id, report_id, source_filename, source_type, now()),
        )
        return int(cur.lastrowid)


def get_vendor_template(vendor_id: int, report_id: int) -> dict[str, Any] | None:
    """取最新一筆該廠商 × 報表的來源範本。"""
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM vendor_templates WHERE vendor_id = ? AND report_id = ? "
            "ORDER BY id DESC LIMIT 1",
            (vendor_id, report_id),
        ).fetchone()
        return dict(row) if row else None


def set_source_fields(vendor_template_id: int, fields: list[dict[str, Any]]) -> None:
    with connect() as conn:
        conn.execute(
            "DELETE FROM source_fields WHERE vendor_template_id = ?", (vendor_template_id,)
        )
        for f in fields:
            conn.execute(
                "INSERT INTO source_fields (vendor_template_id, field_name, sample_value, location) "
                "VALUES (?, ?, ?, ?)",
                (
                    vendor_template_id,
                    f["field_name"],
                    str(f.get("sample_value", "")),
                    f.get("location", ""),
                ),
            )


def list_source_fields(vendor_template_id: int) -> list[dict[str, Any]]:
    with connect() as conn:
        return _rows_to_dicts(
            conn.execute(
                "SELECT * FROM source_fields WHERE vendor_template_id = ? ORDER BY id",
                (vendor_template_id,),
            ).fetchall()
        )


# --- mappings ------------------------------------------------------------

def set_mappings(vendor_id: int, report_id: int, pairs: list[dict[str, Any]]) -> None:
    """整批取代某廠商 × 報表的對應設定。

    pairs:[{report_field, source_field}],source_field 可為空字串代表尚未對應。
    """
    with connect() as conn:
        conn.execute(
            "DELETE FROM mappings WHERE vendor_id = ? AND report_id = ?",
            (vendor_id, report_id),
        )
        for p in pairs:
            conn.execute(
                "INSERT INTO mappings (vendor_id, report_id, source_field, report_field) "
                "VALUES (?, ?, ?, ?)",
                (
                    vendor_id,
                    report_id,
                    p.get("source_field") or None,
                    p["report_field"],
                ),
            )


def list_mappings(vendor_id: int, report_id: int) -> list[dict[str, Any]]:
    with connect() as conn:
        return _rows_to_dicts(
            conn.execute(
                "SELECT * FROM mappings WHERE vendor_id = ? AND report_id = ? ORDER BY id",
                (vendor_id, report_id),
            ).fetchall()
        )


# --- outputs -------------------------------------------------------------

def create_output(
    report_id: int,
    vendor_id: int | None,
    source_file: str,
    output_path: str,
    status: str,
    warnings: str = "",
) -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO outputs (vendor_id, report_id, source_file, output_path, status, warnings, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (vendor_id, report_id, source_file, output_path, status, warnings, now()),
        )
        return int(cur.lastrowid)


def list_outputs() -> list[dict[str, Any]]:
    with connect() as conn:
        return _rows_to_dicts(
            conn.execute("SELECT * FROM outputs ORDER BY id DESC").fetchall()
        )
