"""帳號、密碼與權限測試。"""
from __future__ import annotations

from app import auth


def test_password_hash_roundtrip():
    h = auth.hash_password("secret123")
    assert auth.verify_password("secret123", h)
    assert not auth.verify_password("wrong", h)
    # 兩次雜湊不同(有 salt)
    assert h != auth.hash_password("secret123")


def test_default_admin_created_once(temp_db):
    r1 = auth.ensure_default_admin()
    assert r1 == {"username": "admin", "password": "admin"}
    r2 = auth.ensure_default_admin()  # 已存在
    assert r2 is None
    assert temp_db.count_users() == 1


def test_authenticate(temp_db):
    auth.ensure_default_admin()
    assert auth.authenticate("admin", "admin") is not None
    assert auth.authenticate("admin", "bad") is None
    assert auth.authenticate("nobody", "x") is None


def test_inactive_user_cannot_authenticate(temp_db):
    uid = temp_db.create_user("mary", "王小美", auth.hash_password("pw"), role="staff")
    assert auth.authenticate("mary", "pw") is not None
    temp_db.set_user_active(uid, False)
    assert auth.authenticate("mary", "pw") is None


def test_admin_has_all_capabilities(temp_db):
    auth.ensure_default_admin()
    admin = temp_db.get_user_by_username("admin")
    caps = auth.capabilities_of(admin)
    assert caps == set(auth.CAPABILITY_KEYS)


def test_staff_only_granted_capabilities(temp_db):
    uid = temp_db.create_user("mary", "王小美", auth.hash_password("pw"), role="staff")
    temp_db.set_user_permissions(uid, ["produce_reports", "view_outputs"])
    user = temp_db.get_user(uid)
    assert auth.has_capability(user, "produce_reports")
    assert auth.has_capability(user, "view_outputs")
    assert not auth.has_capability(user, "manage_users")
    assert not auth.has_capability(user, "manage_vendors")
