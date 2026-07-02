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
    version       INTEGER DEFAULT 1,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS report_fields (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id   INTEGER NOT NULL,
    field_name  TEXT NOT NULL,
    location    TEXT,               -- 例:Excel 儲存格 B2、Word placeholder
    sort        INTEGER DEFAULT 0,
    field_role  TEXT DEFAULT 'normal',  -- normal / amount(金額,可驗算)
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

-- 報表範本版本歷史(範本改版保留舊版)
CREATE TABLE IF NOT EXISTS report_template_versions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id     INTEGER NOT NULL,
    version       INTEGER NOT NULL,
    template_path TEXT,
    template_type TEXT,
    created_at    TEXT NOT NULL,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

-- 某報表「應交」的廠商清單(交件追蹤用)
CREATE TABLE IF NOT EXISTS report_vendors (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id  INTEGER NOT NULL,
    vendor_id  INTEGER NOT NULL,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
    FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
);

-- 交件記錄(報表 × 廠商 × 期別)
CREATE TABLE IF NOT EXISTS submissions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id  INTEGER NOT NULL,
    vendor_id  INTEGER NOT NULL,
    period     TEXT NOT NULL,        -- 例:2026-07
    output_id  INTEGER,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE,
    FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
);

-- 使用者帳號
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'staff',  -- admin / staff
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL
);

-- 每位使用者被開放的功能權限(admin 不受此表限制,一律全開)
CREATE TABLE IF NOT EXISTS user_permissions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    capability TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_id        INTEGER,
    report_id        INTEGER NOT NULL,
    source_file      TEXT,
    output_path      TEXT,
    status           TEXT NOT NULL,       -- ok / warning / error / need_confirm
    warnings         TEXT,
    created_at       TEXT NOT NULL,
    period           TEXT,                -- 期別(選填)
    template_version INTEGER,             -- 產出時使用的範本版本
    values_json      TEXT,                -- 已填入的報表欄位值(供上期帶入)
    pdf_path         TEXT,                -- 轉出的 PDF(若有)
    kind             TEXT DEFAULT 'single' -- single / summary(彙總總表)
);
"""

# 既有資料庫的欄位補齊(SQLite 無 IF NOT EXISTS for ADD COLUMN,故先檢查)
_MIGRATIONS: dict[str, list[tuple[str, str]]] = {
    "report_fields": [("field_role", "TEXT DEFAULT 'normal'")],
    "outputs": [
        ("period", "TEXT"),
        ("template_version", "INTEGER"),
        ("values_json", "TEXT"),
        ("pdf_path", "TEXT"),
        ("kind", "TEXT DEFAULT 'single'"),
    ],
    "reports": [("version", "INTEGER DEFAULT 1")],
}


def _migrate(conn: sqlite3.Connection) -> None:
    for table, cols in _MIGRATIONS.items():
        existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        for name, decl in cols:
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


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
        _migrate(conn)


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
        ts = now()
        cur = conn.execute(
            "INSERT INTO reports (name, template_path, template_type, version, created_at) "
            "VALUES (?, ?, ?, 1, ?)",
            (name, template_path, template_type, ts),
        )
        report_id = int(cur.lastrowid)
        conn.execute(
            "INSERT INTO report_template_versions (report_id, version, template_path, template_type, created_at) "
            "VALUES (?, 1, ?, ?, ?)",
            (report_id, template_path, template_type, ts),
        )
        return report_id


def update_report_template(report_id: int, template_path: str, template_type: str) -> int:
    """上傳新範本 → 版本 +1,保留舊版歷史。回傳新版本號。"""
    with connect() as conn:
        row = conn.execute("SELECT version FROM reports WHERE id = ?", (report_id,)).fetchone()
        new_version = int(row["version"] or 1) + 1 if row else 1
        ts = now()
        conn.execute(
            "UPDATE reports SET template_path = ?, template_type = ?, version = ? WHERE id = ?",
            (template_path, template_type, new_version, report_id),
        )
        conn.execute(
            "INSERT INTO report_template_versions (report_id, version, template_path, template_type, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (report_id, new_version, template_path, template_type, ts),
        )
        return new_version


def list_template_versions(report_id: int) -> list[dict[str, Any]]:
    with connect() as conn:
        return _rows_to_dicts(
            conn.execute(
                "SELECT * FROM report_template_versions WHERE report_id = ? ORDER BY version DESC",
                (report_id,),
            ).fetchall()
        )


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
                "INSERT INTO report_fields (report_id, field_name, location, sort, field_role) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    report_id,
                    f["field_name"],
                    f.get("location", ""),
                    f.get("sort", i),
                    f.get("field_role", "normal"),
                ),
            )


def set_field_roles(report_id: int, roles: dict[str, str]) -> None:
    """更新報表欄位的角色(normal / amount),用於數字驗算。"""
    with connect() as conn:
        for field_name, role in roles.items():
            conn.execute(
                "UPDATE report_fields SET field_role = ? WHERE report_id = ? AND field_name = ?",
                (role if role in ("normal", "amount") else "normal", report_id, field_name),
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
    period: str = "",
    template_version: int | None = None,
    values_json: str = "",
    kind: str = "single",
) -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO outputs (vendor_id, report_id, source_file, output_path, status, warnings, "
            "created_at, period, template_version, values_json, kind) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                vendor_id, report_id, source_file, output_path, status, warnings,
                now(), period, template_version, values_json, kind,
            ),
        )
        return int(cur.lastrowid)


def set_output_pdf(output_id: int, pdf_path: str) -> None:
    with connect() as conn:
        conn.execute("UPDATE outputs SET pdf_path = ? WHERE id = ?", (pdf_path, output_id))


def get_output(output_id: int) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM outputs WHERE id = ?", (output_id,)).fetchone()
        return dict(row) if row else None


def latest_output_values(report_id: int, vendor_id: int) -> dict[str, Any]:
    """取某報表 × 廠商最近一次成功產出的欄位值(供上期帶入)。"""
    import json

    with connect() as conn:
        row = conn.execute(
            "SELECT values_json FROM outputs WHERE report_id = ? AND vendor_id = ? "
            "AND values_json IS NOT NULL AND values_json != '' AND status != 'error' "
            "ORDER BY id DESC LIMIT 1",
            (report_id, vendor_id),
        ).fetchone()
    if not row or not row["values_json"]:
        return {}
    try:
        return json.loads(row["values_json"])
    except Exception:
        return {}


def list_outputs() -> list[dict[str, Any]]:
    with connect() as conn:
        return _rows_to_dicts(
            conn.execute("SELECT * FROM outputs ORDER BY id DESC").fetchall()
        )


# --- report_vendors(應交廠商)------------------------------------------

def set_report_vendors(report_id: int, vendor_ids: list[int]) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM report_vendors WHERE report_id = ?", (report_id,))
        for vid in vendor_ids:
            conn.execute(
                "INSERT INTO report_vendors (report_id, vendor_id) VALUES (?, ?)",
                (report_id, vid),
            )


def list_report_vendors(report_id: int) -> list[int]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT vendor_id FROM report_vendors WHERE report_id = ?", (report_id,)
        ).fetchall()
        return [int(r["vendor_id"]) for r in rows]


# --- submissions(交件記錄)---------------------------------------------

def record_submission(report_id: int, vendor_id: int, period: str, output_id: int | None) -> None:
    """登記某報表 × 廠商 × 期別已交件(同期重覆則更新)。"""
    if not period:
        return
    with connect() as conn:
        existing = conn.execute(
            "SELECT id FROM submissions WHERE report_id = ? AND vendor_id = ? AND period = ?",
            (report_id, vendor_id, period),
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE submissions SET output_id = ?, updated_at = ? WHERE id = ?",
                (output_id, now(), existing["id"]),
            )
        else:
            conn.execute(
                "INSERT INTO submissions (report_id, vendor_id, period, output_id, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (report_id, vendor_id, period, output_id, now()),
            )


def list_submissions(report_id: int, period: str) -> list[dict[str, Any]]:
    with connect() as conn:
        return _rows_to_dicts(
            conn.execute(
                "SELECT * FROM submissions WHERE report_id = ? AND period = ?",
                (report_id, period),
            ).fetchall()
        )


# --- users & permissions -------------------------------------------------

def create_user(
    username: str, display_name: str, password_hash: str, role: str = "staff"
) -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO users (username, display_name, password_hash, role, active, created_at) "
            "VALUES (?, ?, ?, ?, 1, ?)",
            (username, display_name, password_hash, role, now()),
        )
        return int(cur.lastrowid)


def get_user_by_username(username: str) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        return dict(row) if row else None


def get_user(user_id: int) -> dict[str, Any] | None:
    with connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None


def list_users() -> list[dict[str, Any]]:
    with connect() as conn:
        return _rows_to_dicts(conn.execute("SELECT * FROM users ORDER BY id").fetchall())


def count_users() -> int:
    with connect() as conn:
        return int(conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"])


def set_user_active(user_id: int, active: bool) -> None:
    with connect() as conn:
        conn.execute("UPDATE users SET active = ? WHERE id = ?", (1 if active else 0, user_id))


def set_user_password(user_id: int, password_hash: str) -> None:
    with connect() as conn:
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))


def delete_user(user_id: int) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM users WHERE id = ?", (user_id,))


def set_user_permissions(user_id: int, capabilities: list[str]) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM user_permissions WHERE user_id = ?", (user_id,))
        for cap in capabilities:
            conn.execute(
                "INSERT INTO user_permissions (user_id, capability) VALUES (?, ?)",
                (user_id, cap),
            )


def list_user_permissions(user_id: int) -> list[str]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT capability FROM user_permissions WHERE user_id = ?", (user_id,)
        ).fetchall()
        return [r["capability"] for r in rows]
