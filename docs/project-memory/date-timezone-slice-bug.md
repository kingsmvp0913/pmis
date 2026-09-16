---
name: date-timezone-slice-bug
description: "前端日期欄位用 slice(0,10) 截 UTC 字串,顯示少一天且每按一次儲存就真的少一天——完整診斷、修法與待驗證狀態(2026-08-06 接手第一件事)"
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-05T14:29:38.100Z
---

2026-08-05 在端對端測試中發現。**這是會造成資料損壞的既有 bug,不是這次改版引入的**,
但因為新增了「開工報告表歸檔補主檔」讓 `start_date` 開始有值,它才變得可見且會被觸發。

## 完整證據鏈(瀏覽器時區 Asia/Taipei)

1. 透過開工報告表歸檔把 `start_date` 寫成台北時間 `2026-01-26`。
2. `GET /api/projects` 回的原始值是 `"2026-01-25T16:00:00.000Z"` —— **這是對的**,
   台北時間正好是 01-26 00:00。
3. 但工程詳細頁顯示 `2026-01-25`,契約竣工日同樣少一天。

根因:`projects.js` 用 `String(p.start_date).slice(0, 10)` 填 `<input type=date>`,
而那串的前 10 碼是 **UTC 日期**。

**真正危險的地方**:`save()` 送的是畫面上的值。承辦人只要開工程頁按一次「儲存」,
錯誤的 01-25 就覆蓋正確的 01-26 —— **每存一次少一天,而且沒有任何錯誤訊息**。

## 影響範圍

`app/public/js/views/projects.js` 共 7 處:開工日、契約竣工日、實際竣工日、
保險起日、保險迄日、寫入監造報表後回填的完工期限、附件上傳日。

**既有資料可能已經損壞**:有些工程的日期若曾被承辦人按過儲存,已經少了 N 天。
無從得知每筆少幾天,不可自動修復——要請使用者對照開工報告表/決標公告自行核對。

## 修法(已寫完,尚未驗證)

分支 `fix/project-date-timezone-slice`,已 commit(731 綠、node --check 過),
**但完全沒有瀏覽器實跑過**。明天接手第一件事就是驗它。

加 `PmisApp.toDateInputValue(v)` 集中處理,三種輸入分別對待:

- `Date` 物件 → 用在地時區 `getFullYear/getMonth/getDate`
- 帶 `T` 的 ISO 字串 → `new Date()` 後同上
- **純 `YYYY-MM-DD` 字串 → 原樣截斷**。這條是關鍵:那種值沒有時區資訊,
  硬套 Date 轉換反而會被瀏覽器時區誤轉一天。後端 `daily-log-routes.js:56` 的
  `toISODate` 只有這一個分支是對的,前端不能整份照抄。

**必驗情境**:開啟工程頁 → 什麼都不改 → 直接按「儲存」→ **日期不可改變**。
那是這個 bug 最終要防的事,單看畫面顯示對不對驗不出來。

相關:[[supervision-report-pipeline]]、[[kickoff-taichung-format-findings]]。
