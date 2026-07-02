"""交件行事曆:期限 CRUD 與缺件狀態判斷測試。"""
from __future__ import annotations


def test_deadline_status_upcoming(temp_db):
    rid = temp_db.create_report("月報")
    v1 = temp_db.create_vendor("甲營造")
    temp_db.set_report_vendors(rid, [v1])

    status = temp_db.deadline_status(rid, "2026-07", "2099-01-01", today="2026-07-01")
    assert status["state"] == "upcoming"
    assert status["total_count"] == 1


def test_deadline_status_ok_when_all_submitted(temp_db):
    rid = temp_db.create_report("月報")
    v1 = temp_db.create_vendor("甲營造")
    v2 = temp_db.create_vendor("乙營造")
    temp_db.set_report_vendors(rid, [v1, v2])
    temp_db.record_submission(rid, v1, "2026-07", None)
    temp_db.record_submission(rid, v2, "2026-07", None)

    status = temp_db.deadline_status(rid, "2026-07", "2026-07-05", today="2026-07-10")
    assert status["state"] == "ok"
    assert status["missing_count"] == 0


def test_deadline_status_missing_when_overdue_and_unsubmitted(temp_db):
    rid = temp_db.create_report("月報")
    v1 = temp_db.create_vendor("甲營造")
    v2 = temp_db.create_vendor("乙營造")
    temp_db.set_report_vendors(rid, [v1, v2])
    temp_db.record_submission(rid, v1, "2026-07", None)  # 乙未交

    status = temp_db.deadline_status(rid, "2026-07", "2026-07-05", today="2026-07-10")
    assert status["state"] == "missing"
    assert status["missing_count"] == 1


def test_create_list_delete_deadline(temp_db):
    rid = temp_db.create_report("月報")
    did = temp_db.create_deadline(rid, "2026-07", "2026-07-15", note="測試備註")

    rows = temp_db.list_deadlines_in_range("2026-07-01", "2026-07-31")
    assert len(rows) == 1
    assert rows[0]["report_id"] == rid
    assert rows[0]["report_name"] == "月報"
    assert rows[0]["note"] == "測試備註"

    # 範圍外查不到
    assert temp_db.list_deadlines_in_range("2026-08-01", "2026-08-31") == []

    temp_db.delete_deadline(did)
    assert temp_db.list_deadlines_in_range("2026-07-01", "2026-07-31") == []
    assert temp_db.get_deadline(did) is None


def test_deadline_cascade_deletes_with_report(temp_db):
    rid = temp_db.create_report("月報")
    temp_db.create_deadline(rid, "2026-07", "2026-07-15")

    temp_db.delete_report(rid)

    assert temp_db.list_deadlines_in_range("2026-01-01", "2026-12-31") == []
