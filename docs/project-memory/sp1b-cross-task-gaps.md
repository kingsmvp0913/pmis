---
name: sp1b-cross-task-gaps
description: "SP1B 階段一收尾時,全分支審查抓到的三處『個別 task 都對、合起來錯』的裂縫,以及留下的功能缺口"
metadata: 
  node_type: memory
  type: project
---

2026-08-01 SP1B 階段一(決標公告建工程)以 subagent-driven-development 執行,8 個 task 各自通過獨立審查,
但**最終全分支審查抓到三處跨 task 裂縫**。記下來是因為這類問題逐 task 審查抓不到,下次拆 task 時要留意。

## 三處裂縫(已修)

1. **前提被後面的 task 拆掉。** Task 6 把決標公告區塊關進 `if (isNew)`,程式碼註解寫「既有工程要重新裁決
   仍走原本的逐欄比對流程」——而 Task 7 把那條流程(`#/basics` 頁)整個刪了。連鎖後果:既有工程再也沒有
   入口補掛決標公告,且 `project-routes.js` 的 warning 還叫承辦人「稍後於工程頁重新上傳」,那是做不到的指示。
   **教訓:當 task A 的設計依賴「別處還存在的某條路徑」,而 task B 要刪那條路徑時,逐 task 審查看不到這個依賴。**

2. **折頁使兩個控制項綁上同一個 DB 欄位。** 「監造報表基本資料」卡片的 `開工I` 與主表單的 `startI` 都對應
   `projects.start_date`,而 `POST /:id/basics` 還會寫 `contract_completion_date`。序列:改開工日 → 按「寫入監造報表」
   (DB 已更新)→ 按「儲存」→ `PUT` 用畫面上**陳舊的**值寫回去,**靜默抹掉剛算出的完工期限**。
   兩者原本在不同頁面,此交互不存在。

3. **搬移時遺失了 fallback。** 舊 `project-basics.js` 用後端回的 `firms`(`p.supervisor_firm || defaults`)預填監造/
   設計單位;折進工程頁後只剩 `p.supervisor_firm || ''`。而該欄在第一次成功寫報表前恆為 NULL、後端 `REQUIRED`
   又含它 → **每個工程第一次寫報表都會被 400 擋下**。`GET/PUT /api/settings/firms` 與設定頁都還在,但設定等於失效。

## 另外兩個「測試綠但使用者踩得到」的坑

- **`api.js` 下載檔名 regex 先命中 ASCII fallback。** `content-disposition` 對中文檔名產出
  `filename="????.pdf"; filename*=UTF-8''%E6%B1%BA...`,舊 regex 解出 `????.pdf`。
  而後端測試斷言的是解碼後的 `filename*`,所以**測試全綠而使用者拿到亂碼**。修法:先試 `filename*`。
  (既有的施工日誌下載同樣中招,一併修好。)
- **`jest.spyOn(db, 'query')` 攔不到解構取得的參考。** 路由是 `const { query } = require('./db')`,
  換掉 module exports 屬性對已綁定的參考無效 → 測試**假綠**。要 spy 在 `db.getPool().query`
  (因為 `db.query()` 內部是 `getPool().query(...)`)。

## 已知留下的功能缺口(待使用者決定)

**既有工程無法補掛決標公告**:編輯模式沒有上傳入口,也沒有 `POST /api/projects/:id/attachments` 路由
(spec §4.3 的路由清單只有 GET/download/DELETE)。影響:
- 手動建立的工程永遠拿不到歸檔的決標公告
- 而**階段二明訂要拿歸檔的那份當比對基準**(見 [[kickoff-vs-award-comparison]])
- `POST /api/projects/:id/award-notice`(`project-basics-routes.js`)成為從 UI 到不了的死路由

目前的處置是把 warning 文案改成不承諾做不到的事;完整方案(加上傳端點+UI)超出階段一議定範圍,**排入階段二考量**。

## 判定為「可留」的項目

自動安全審查提報的附件端點 IDOR **不是新暴露面**:本專案無 `project_members`/租戶概念,`users` 只有 `role` 欄,
既有 `GET /api/projects`、`GET /api/submissions/:id/download/:kind` 同樣只驗 `verifyToken`。
要做「承辦人只看自己負責的工程」是**影響全部路由的另案需求**,不該只補在新端點上。
