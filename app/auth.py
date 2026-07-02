"""帳號、密碼與權限。

- 密碼以 PBKDF2-HMAC-SHA256 雜湊(標準函式庫,不需額外套件)。
- 角色:admin(全功能,含使用者管理)、staff(僅限被開放的功能)。
- 管理者可逐項勾選要開放給某位使用者的功能(capabilities)。
"""
from __future__ import annotations

import hashlib
import hmac
import os
from typing import Any

from . import db

# 可授權的功能項目(顯示名稱給管理畫面用)
CAPABILITIES: list[tuple[str, str]] = [
    ("manage_vendors", "管理廠商"),
    ("manage_reports", "管理報表與範本"),
    ("manage_mappings", "設定對應"),
    ("produce_reports", "產出報表(單筆/彙總)"),
    ("view_outputs", "查看產出記錄"),
    ("manage_tracking", "交件追蹤"),
    ("manage_users", "使用者與權限管理(僅管理者)"),
]
CAPABILITY_KEYS = [c[0] for c in CAPABILITIES]

_PBKDF2_ROUNDS = 200_000


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${_PBKDF2_ROUNDS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, rounds, salt_hex, hash_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(rounds)
        )
        return hmac.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


def ensure_default_admin() -> dict[str, Any] | None:
    """若系統尚無任何使用者,建立預設管理者 admin / admin。

    回傳新建帳號資訊(供安裝畫面提示改密碼),已有帳號則回傳 None。
    """
    if db.count_users() == 0:
        db.create_user("admin", "系統管理者", hash_password("admin"), role="admin")
        return {"username": "admin", "password": "admin"}
    return None


def authenticate(username: str, password: str) -> dict[str, Any] | None:
    user = db.get_user_by_username(username)
    if not user or not user["active"]:
        return None
    if verify_password(password, user["password_hash"]):
        return user
    return None


def capabilities_of(user: dict[str, Any]) -> set[str]:
    """回傳使用者實際擁有的功能。admin 一律全開。"""
    if user["role"] == "admin":
        return set(CAPABILITY_KEYS)
    return set(db.list_user_permissions(user["id"]))


def has_capability(user: dict[str, Any] | None, capability: str) -> bool:
    if not user:
        return False
    return capability in capabilities_of(user)
