# PMIS 交件行事曆 — 設計書

- **日期**:2026-07-02
- **狀態**:設計待審閱
- **專案路徑**:`C:\pmis\`
- **前置依賴**:既有「交件追蹤」功能(`report_vendors`、`submissions` 表,`/tracking` 頁面)

---

## 1. 目的

在既有交件追蹤之外,提供一個**行事曆視角**:使用者可以在月曆上手動標出「哪個報表、哪一期,幾號到期」,系統自動在到期後標示出哪些廠商還沒交件,不用每次都手動去 `/tracking` 頁面逐一查詢。

---

## 2. 資料模型

新增一張表,不改動既有任何表:

```sql
CREATE TABLE IF NOT EXISTS report_deadlines (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id   INTEGER NOT NULL,
    period      TEXT NOT NULL,       -- 沿用既有 period 慣例,如 "2026-07"
    due_date    TEXT NOT NULL,       -- "YYYY-MM-DD"
    note        TEXT,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);
```

- `period` 沿用 `submissions.period` 的既有慣例(自由文字,如 `"2026-07"`),兩者用同一個字串比對交件記錄。
- 同一個 `report_id + period` 理論上只會有一筆 `report_deadlines`(同一期只有一個到期日),但不加 UNIQUE 限制 —— 若使用者手滑建立重複,允許並存,行事曆上會顯示兩筆,使用者可自行刪除多餘的一筆。不做防呆是因為這是單機小工具,寧可讓使用者自己修正,也不要用複雜的 upsert 邏輯增加出錯面。

---

## 3. 缺件狀態判斷(共用邏輯)

新增共用函式(建議放 `app/db.py` 或 `app/main.py` 內,供 `/tracking` 與 `/calendar` 共用,避免同一段「應交－已交」邏輯寫兩份):

```python
def deadline_status(report_id: int, period: str, due_date: str, today: str) -> dict:
    """回傳 {missing_count, total_count, state}
    state: "upcoming"(未到期) / "ok"(已過期但全交) / "missing"(已過期且有缺件)
    """
```

邏輯:
```
expected = report_vendors(report_id)              # 應交廠商清單
submitted = submissions(report_id, period)         # 已交廠商清單
missing_count = len(expected) - len(submitted 中屬於 expected 的)
if due_date > today:
    state = "upcoming"
elif missing_count > 0:
    state = "missing"
else:
    state = "ok"
```

此函式直接重用 `/tracking` 頁面現有的「應交清單 − 已交清單」計算方式,兩處呼叫同一份邏輯。

**範圍外(明確不做)**:到期前的提前提醒(例如「還有 3 天到期」的黃色預警)。目前只在**已過期**時標紅顯示缺件,未到期一律用一般樣式顯示。使用者已確認先簡化,之後有需要再擴充。

---

## 4. 頁面 / 路由

沿用既有 `manage_tracking` 權限,不新增權限種類。導覽列在「交件追蹤」旁加一個「行事曆」連結。

| Route | 說明 |
|---|---|
| `GET /calendar?year=&month=` | 月曆格狀圖,預設當月。每格顯示當天到期的項目(報表名稱＋期別＋狀態徽章:🔴缺件(N家) / 🟢已全交 / ⚪一般)。可上一月/下一月切換 |
| `GET /calendar/new?date=YYYY-MM-DD` | 點格子上的「＋新增期限」出現的小表單:選報表(下拉)、填期別(文字)、日期(已預填成點擊的那天)、備註(可空) |
| `POST /calendar/deadline` | 建立一筆 `report_deadlines` |
| `POST /calendar/deadline/{id}/delete` | 刪除一筆 `report_deadlines` |

每個到期項目的徽章可點擊,直接連到既有的 `/tracking?report_id=X&period=Y`,看該期完整的各廠商交件明細 —— 不重複做一份廠商清單 UI,行事曆只負責「哪天到期＋狀態總覽」。

**範圍外(明確不做)**:新增期限時一次選多個報表/期別批次建立。目前一次只能建立一筆,之後有需要再擴充成批次表單。

---

## 5. UI 樣式

比照既有 `tracking.html` / `reports.html` 的表格化中文介面風格(非既有專案沒有的花俏元件)。月曆格狀圖:
- 7 欄(日一二三四五六)× 週數列的標準格狀表格(HTML `<table>`,不引入額外前端框架,與專案現有「伺服器端渲染 Jinja2 模板」風格一致)
- 每格內:日期數字 + 最多顯示幾筆到期項目的小標籤(chip),超過則顯示「還有 N 筆」
- 格子右上角小連結「＋」新增當天期限

---

## 6. 測試

新增 `tests/test_calendar.py`,涵蓋:
1. 建立期限後,`deadline_status` 在「未到期」情況回傳 `state="upcoming"`
2. 到期日已過 + 所有應交廠商都已交件 → `state="ok"`
3. 到期日已過 + 有廠商未交 → `state="missing"`,`missing_count` 正確
4. 跨月邊界:月曆正確顯示上月最後幾天/下月開頭幾天(若格狀圖需要補齊整週)
5. 刪除期限後,`/calendar` 該筆不再出現
6. `report_id` 對應的報表被刪除時,`report_deadlines` 隨 `ON DELETE CASCADE` 一併清除

---

## 7. 與既有系統的關聯

- 不修改 `reports`、`vendors`、`report_vendors`、`submissions` 既有表結構
- 沿用 `period` 字串慣例,與既有 `/tracking`、產出報表時記錄 `submissions` 的邏輯完全相容,不需要遷移既有資料
- 沿用既有 `manage_tracking` 權限與 `_ensure_cap` 檢查模式
