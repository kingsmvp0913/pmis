# 工程頁改版：詳細頁分頁籤 + 列表頁直接操作

日期：2026-08-05
狀態：已與使用者確認，待實作

## 問題

**詳細頁太長。** `app/public/js/views/projects.js` 的 `renderEdit()` 把 7 個 card 垂直堆疊：
工程基本資料、監造報表基本資料、開工報告表、流程進度、契約詳細價目表、施工日誌、附件。
承辦人得一路捲到底才知道自己走到哪，而「流程進度」這個唯一會講「下一步該做什麼」的區塊
夾在第 4 個位置——捲到一半才看得到，本末倒置。

**列表頁什麼都不能做。** 每列只有「歷史／編輯／刪除」。要上傳任何一份文件都得先進詳細頁，
而多數情況承辦人只是要交一份檔案，不需要看全部欄位。

## 既有耦合（設計時必須遷就的事實）

這三塊目前互相纏著，不是獨立區塊：

- 開工報告表解析後**直接改寫**監造報表基本資料的 `工期I` / `開工I`
  （`projects.js:380,384,442,444`）。註解寫明這是刻意的：不同步的話承辦人以為改好了，
  寫進 Excel 的還是舊值。
- 開工報告表歸檔（confirm）時，送出的契約工期**以 `工期I` 為準**而非比對表那一格
  （`projects.js:473`）。這也是刻意的：工作天案例（明禮）比對表顯示「160 工作天」，
  承辦人必須在 `工期I` 自行換算日曆天，`kickoff-compare.js:96` 有對應的分流邏輯。
- 監造報表基本資料的「寫入」鈕讀工程基本資料的 `nameI` / `noI` / `awardI` / `schoolI` / `vendorI`。

## 決策

| 項目 | 決定 |
|---|---|
| 頁籤分組 | 依承辦流程分五個：基本資料／開工報告表／契約價目表／施工日誌／附件 |
| 監造報表基本資料 | 留在「基本資料」頁籤（需配套同步提示，見 §5） |
| 列表頁操作 | 四個流程操作全上：開工報告表／發包經費總表／施工日誌／登錄繳交 |
| 彈窗範圍 | 彈窗內能把整個流程做完，與詳細頁**共用同一份元件** |
| 彈窗的契約工期 | 元件在沒有外部欄位可用時自帶那兩欄；詳細頁沿用現有欄位，行為不變 |
| 列表狀態指示 | 要。按鈕帶 ✓ 與「下一步」標記（後端需加聚合欄位） |

## 1. 詳細頁：五個頁籤

流程進度列**移到頁籤上方常駐**。

```
工程：114學年度南棟教室西側廁所整修工程
✓決標公告  ✓基本資料  ○開工報告表  ·價目表  ·日誌
下一步：開工報告表 — 上傳並核對後歸檔
─────────────────────────────────────────
[基本資料] [開工報告表] [契約價目表] [施工日誌] [附件]
 ‾‾‾‾‾‾‾‾
```

**一次全建、切換只改 `display`。** 五個頁籤的內容在進頁面時全部建出來，切換頁籤只換
`display`。所有既有元素引用與事件因此完全不動，包括上述跨頁籤耦合——那些 DOM 一直都在。

**不採惰性建構。** 惰性會讓「開工報告表解析後要改基本資料頁籤的欄位」在那些 DOM 還不存在時
執行，耦合從「看不見」升級成「有時直接壞掉」；切回去若重建，承辦人未儲存的編輯也會被清掉。
API 請求量與現狀相同（現在本來就全建），不算退步。

**網址同步但不驅動重建。** `#/projects/5/kickoff` 只決定「預設顯示哪一頁」。
路由層維持現有的 `#/projects/:id`，第三段當作頁籤鍵解析；未知的鍵退回第一頁。

**新增工程（`isNew`）不套頁籤**：那時只有決標公告 + 基本資料兩塊，分頁只是多一次點擊。

頁籤鍵：`basics` / `kickoff` / `items` / `logs` / `files`。

## 2. 元件抽取

| 檔案 | 動作 |
|---|---|
| `app/public/js/views/kickoff-report.js` | **新增**。從 `projects.js` 抽出開工報告表整塊（約 250 行） |
| `app/public/js/dialog.js` | **新增** `modalDialog({title, content, wide})` |
| `app/public/js/views/projects.js` | 900 行 → 約 550 行 |
| `app/public/index.html` | 加一行 `<script src="/js/views/kickoff-report.js">`（須排在 projects.js 之前） |

### `KickoffReport.card(projectId, opts)`

回傳一個 card 元素，內部自足（只依賴 `PmisApp.el` / `Api` / `showToast`，
與 `ContractItems.card` / `DailyLogs.card` 同一種形狀）。

`opts` 只有兩個欄位：

- `opts.durationInput` / `opts.startDateInput`
  詳細頁傳入現有的 `工期I` / `開工I` → 行為 100% 不變（含「confirm 以 `工期I` 為準」
  與工作天不預填的既有語意）。
  彈窗**不傳** → 元件在比對表下方自己長出「契約工期(日曆天)」與「開工日期」兩欄，
  confirm 時讀自己這兩欄。兩種情境走同一段 confirm 程式碼，差別只在欄位從哪來。
- `opts.onArchived(result)`
  歸檔成功的 callback。詳細頁用來重載附件清單；列表頁用來刷新該列的流程狀態。

`ContractItems.card` 與 `DailyLogs.card` **完全不動**——它們已經只吃 `projectId`、
回傳完整 card、沒有外部 DOM 依賴，直接塞進 `modalDialog` 即可。

### `modalDialog({title, content, wide})`

`dialog.js` 目前只有 `confirmDialog`（純文字）與 `showToast`，沒有裝任意內容的彈窗；
而 `projects.js:11-50` 的 `submissionDialog` 已經手刻了第二套 overlay／Escape／
點外面關閉。這次新增第三種需求，故抽一支通用的，並讓 `submissionDialog` 改用它。

- `content` 為 DOM 節點，直接掛進 `.modal-body`。
- `wide` 為 true 時套較寬的 `.modal-wide`（開工報告表的九欄比對表需要）。
- 回傳 `{ close }`，呼叫端在流程完成時自行關閉。
- Escape 與點擊 overlay 關閉；**不做 Enter 送出**——彈窗內有多個輸入框與多顆按鈕，
  Enter 送出會誤觸（`confirmDialog` 是單一決策才適合）。

## 3. 列表頁

```
編號     名稱            設計費     流程
114-17   114學年度南棟…  6,319,000  [✓開工表][●價目表][日誌][繳交] ⋮
A1150505 元長國小老舊…   未招標     [✓開工表][✓價目表][✓日誌][●繳交] ⋮
```

四顆流程按鈕點了開對應彈窗：

| 按鈕 | 彈窗內容 |
|---|---|
| 開工表 | `KickoffReport.card(id)`（不傳 input，元件自帶工期/開工日） |
| 價目表 | `ContractItems.card(id)` |
| 日誌 | `DailyLogs.card(id)` |
| 繳交 | 現有的 `submissionDialog` 流程 |

狀態標記沿用 `WorkflowStatus` 已有的判定，**不重寫一份**：

- `✓` 已完成
- `●` 下一步（主色）— 第一個未完成的關卡
- 無標記且 `disabled` — 前置未完成；`title` 說明缺什麼（沿用 `steps[].缺` 的文案）

`⋮` 收合「歷史 / 詳細 / 刪除」。歷史展開面板維持現有行為不變。

彈窗完成操作後重新載入列表（沿用現有的 `load()`，整表重載），讓狀態標記即時更新。
純關閉（沒做任何事）不重載。

## 4. 後端：列表 API 加狀態欄位

`GET /api/projects` 每列多回四個欄位：`has_kickoff`、`has_budget`、`contract_items`、`log_days`。

**不得 N+1**（100 個工程會跑 300 次查詢）。改成三次聚合查詢後在 JS 合併：

```sql
SELECT DISTINCT project_id, kind FROM project_attachments
  WHERE kind IN ('kickoff_report', 'budget_sheet');

SELECT project_id, COUNT(*)::int AS n FROM contract_items GROUP BY project_id;

SELECT project_id, COUNT(*)::int AS n FROM
  (SELECT DISTINCT project_id, log_date FROM daily_records) t
  GROUP BY project_id;
```

第三個刻意用子查詢而非 `COUNT(DISTINCT log_date)`——`project-routes.js:132` 已記載
pg-mem 不支援後者，且會**靜默算錯**（同一天的多個項次被當成多天）。

搜尋模式（`?q=`）也要帶同樣欄位，否則搜尋後標記會全部消失。聚合查詢不加
`WHERE project_id IN (…)`：**假設**工程數量級在數千以內，三次全表聚合比動態組 IN 清單
簡單且夠快。這個假設未經量測——若日後工程數成長到讓列表變慢，改法是把三次聚合
收斂成一次 `LEFT JOIN LATERAL`，而不是回頭做 N+1。

失敗處理沿用 `workflow-status` 的既有做法——聚合查詢失敗不讓整個列表掛掉，
該欄位退回 0／false，列表照常顯示（承辦人看到的是「未完成」，點進去仍會被後端正確把關）。

## 5. 跨頁籤同步提示

「監造報表基本資料」留在基本資料頁籤，所以解析開工報告表會改到**另一個頁籤**的欄位。
不處理的話那是靜默改動。

- 開工報告表頁籤內顯示：
  「已同步更新『基本資料』頁籤的契約工期為 120 天、開工日為 2026-01-26」
- 「基本資料」頁籤標籤加一個小圓點，切過去後消失。

工作天案例維持現有行為（`工期I` 刻意留空 + 換算警示），提示文字改成
「契約工期為工作天，未自動帶入，請至『基本資料』頁籤自行換算填寫」——
現有文案沒有頁籤概念，不改的話承辦人會找不到那一格。

彈窗情境不需要這套提示：元件自帶的兩欄就在同一個彈窗裡，看得見。

## 6. 錯誤處理

沿用既有慣例，不新增機制：

- 彈窗內的錯誤顯示在彈窗內（各元件已有自己的 `error-msg` 區塊），**不用 toast**——
  toast 會在彈窗還開著時飄走。
- 彈窗內操作失敗**不關閉彈窗**，讓承辦人就地修正。
- 列表狀態聚合讀不到 → 該列退回無標記，不擋列表顯示。
- 配色一律走 `app.css` 的 CSS 變數／dark-aware class，禁止 inline 寫死淺色底
  （CLAUDE.md §2 的既有規則；頁籤與彈窗都是新版面，容易犯）。

## 7. 測試

`app/package.json` 的 `testEnvironment` 是 `node`，**前端沒有測試框架**。
§1、§2、§3、§5 全部落在沒有自動測試覆蓋的區域。誠實的處理方式：

**後端可測的就寫測試**（`app/tests/project.test.js`）：

- 列表回傳四個新欄位，值正確
- **同一天多個項次只算一天**（正是 pg-mem 會靜默算錯的那個坑，必須有測試釘住）
- 搜尋模式（`?q=`）同樣帶這四個欄位
- 無附件／無契約項目／無日誌的工程回 false／0，不是 null 或缺欄位

**前端靠端對端手動驗證**，實作完成後逐項實跑並回報結果：

1. 五個頁籤都能切換，切換後未儲存的編輯不消失
2. 開工報告表解析後，切到「基本資料」頁籤，契約工期與開工日確實是新值
3. 工作天案例（明禮）：`工期I` 仍留空，警示文字指向正確頁籤
4. 四個彈窗都能從頭走完流程並正確關閉
5. 彈窗歸檔後，列表該列的狀態標記有更新
6. 前置未完成的按鈕為 disabled 且 hover 有說明
7. 深色模式下頁籤與彈窗的文字可讀（不是白字白底）
8. 新增工程頁不套頁籤，流程與現在相同

**不為這次改動引入 jsdom**：那是獨立決策，範圍比這次大，混在版面改版裡會讓兩件事都難審。

## 8. 不做的事

- 不動 `ContractItems.card` / `DailyLogs.card` 的內部實作
- 不動開工報告表的解析／比對／歸檔邏輯（只搬家 + 加 `opts`）
- 不動歷史展開面板
- 不重寫流程判定邏輯（沿用 `WorkflowStatus`）
- 不改後端任何把關規則（列表 API 只加唯讀聚合欄位）

## 檔案變動總覽

| 檔案 | 動作 |
|---|---|
| `app/public/js/views/kickoff-report.js` | 新增 |
| `app/public/js/dialog.js` | 加 `modalDialog` |
| `app/public/js/views/projects.js` | 頁籤化、列表按鈕、移除已抽出的區塊 |
| `app/public/css/app.css` | 頁籤樣式、`.modal-wide`、狀態標記 |
| `app/public/index.html` | 載入新檔 |
| `app/server/project-routes.js` | 列表加四個聚合欄位 |
| `app/tests/project.test.js` | 補列表欄位測試 |
