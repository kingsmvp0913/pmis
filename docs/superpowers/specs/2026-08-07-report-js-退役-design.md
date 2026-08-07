# report.js 退役 + 監造報表下載入口 — 設計

日期：2026-08-07

## 背景

「上傳施工日誌即自動產監造報表」這條從零手刻 xlsx 的路線，已於 2026-08-05 在路由層退役
（見 `app/server/history-routes.js` 的退役註解、`app/tests/submission-report.test.js`）。
本次收尾剩下的三件事。

盤點結果：

- `app/server/report.js`（350 行）**沒有任何 production 呼叫端**，只剩
  `app/scripts/gen-sample-report.js` 與 `app/tests/report.test.js` 在養它。
  `exceljs` 這個 dependency 也只被這兩個檔用到。
- 繳交紀錄列上的「監造報表」下載鈕（`app/public/js/views/projects.js`）指向
  `submission_history.report_path`，而該欄**已無任何寫入端** → 那顆鈕**必定**回
  409「監造報表尚未產生」。
- 真正的成品（`data/reports/project_<id>/監造報表.xlsm`，SP1/SP2/SP3 一路寫入的常駐檔）
  **畫面上完全沒有下載入口**。承辦人跑完整條 pipeline 拿不到東西。

第三點是本次的主軸——刪死碼只是順手，補下載入口才是使用者看得到的缺口。

## §1 新增下載端點

**`GET /api/projects/:id/report/download`**，掛在 `app/server/project-routes.js`。

放這裡的理由：SP1（`project-basics-routes`）／SP2（`contract-items-routes`）／
SP3（`daily-log-routes`）三支都是「**寫入**」報表的語意，把唯一的「讀出」掛到其中任一支，
另外兩支看起來就少了一半。`/api/projects/:id/...` 家族的歸屬本來就是 `project-routes.js`。

行為：

| 情況 | 回應 |
|---|---|
| 未帶 token | 401（`verifyToken`） |
| 工程不存在 | 404 `工程不存在` |
| 常駐 .xlsm 尚未建立 | 409 `監造報表尚未建立,請先送出工程基本資料` |
| 正常 | 200 + `res.download()`，檔名 `<工程名>_監造報表.xlsm` |

用 `workbookPath()` 而**不是** `ensureWorkbook()`：下載不該有副作用。若按下載就悄悄由範本
複製一份空報表出來，承辦人會拿到一份空表卻以為 pipeline 跑過了——那比 409 更糟。

工程名做檔名清理：去掉 `\ / : * ? " < > |` 與控制字元。非 ASCII 檔名由 Express 的
`res.download` 依 RFC 6266 同時輸出 `filename` 與 `filename*`，前端 `Api.download`
已優先解 `filename*`。

前端入口：`app/public/js/views/daily-logs.js` 的「確認並寫入監造報表」旁加一顆
「下載監造報表」。放這裡是因為寫入後馬上要取，動作相鄰最好找。

## §2 拆掉永遠 409 的舊入口

- 刪 `app/public/js/views/projects.js` 繳交紀錄列的「監造報表」鈕
- 刪 `app/server/history-routes.js` 的 `KIND_COLUMN.report`
  → `/api/submissions/:id/download/report` 變 400「未知的下載類型」
- 刪同檔刪除紀錄時清檔迴圈裡的 `report_path`（該欄永不寫入，留著是誤導），
  並在 `KIND_COLUMN` 旁註明退役
- **DB `report_path` 欄位保留不動**：`app/server/db.js` 只有 `CREATE TABLE IF NOT EXISTS`、
  沒有 ALTER migration 機制。從 `db.js` 拿掉只會讓新建 DB 與既有 DB 分岔，
  既有 DB 的欄位照樣還在。該欄現存資料全是 NULL，留著零成本。

## §3 刪死碼

- 刪 `app/server/report.js`
- 刪 `app/tests/report.test.js`
- 刪 `app/scripts/gen-sample-report.js`
- `app/package.json` 移除 `exceljs` dependency

## 測試

新增 `app/tests/project-report-download.test.js`：

- 未帶 token → 401
- 工程不存在 → 404
- 報表檔不存在 → 409，且**斷言呼叫後檔案仍不存在**（釘住「下載不得有副作用」，
  這正是 `ensureWorkbook` 與 `workbookPath` 的差別，寫錯了功能面看不出來）
- 報表檔存在 → 200，檔內容正確，`Content-Disposition` 的 `filename*` 解出來帶工程名

既有測試調整：

- `app/tests/history.test.js` 的「report / official_doc 下載回 409」改成只測 `official_doc`
- `app/tests/submission-report.test.js` 不受影響（測的是 `official_doc`）

## 成功判準

1. 全跑測試綠（帶 `SP0_SKIP_EXCEL=1`），無新增 flaky
2. `grep -r exceljs app/server app/scripts app/public` 無命中
3. 畫面上沒有任何會必定回 409 的「監造報表」按鈕
4. 跑完 SP1 的工程，從施工日誌區塊按「下載監造報表」拿得到 .xlsm
