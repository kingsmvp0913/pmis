# 工程頁改版（詳細頁分頁籤 + 列表頁直接操作）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把工程詳細頁的 7 個垂直堆疊區塊改成 5 個頁籤，並讓工程列表頁能直接開彈窗完成四種文件作業，不必進詳細頁。

**Architecture:** 詳細頁一次全建五個頁籤、切換只改 `display`（既有的跨區塊耦合因此完全不受影響）。開工報告表區塊抽成可重用元件 `KickoffReport.card()`，詳細頁與列表頁彈窗共用同一份程式碼。列表頁新增四顆流程按鈕，狀態標記由列表 API 新增的四個聚合欄位驅動。

**Tech Stack:** 原生 DOM（無框架）、hash router、Express + PostgreSQL、Jest + supertest + pg-mem。

## Global Constraints

- 設計依據：`docs/superpowers/specs/2026-08-05-project-page-tabs-design.md`
- 前端配色一律走 `app.css` 的 CSS 變數（`--text` / `--bg` / `--surface` / `--border` / `--primary` / `--text-muted`）或 dark-aware class（`.hint` / `.error-msg`）。**禁止 inline 寫死淺色 `background` 而不同時寫死文字色**——深色模式下文字色吃 `var(--text)` 會翻白＝隱形（CLAUDE.md §2）。
- 深色模式的覆寫選擇器是 `[data-theme="dark"]`（`app.css:55`）。
- 建立 DOM 一律用 `PmisApp.el(tag, attrs, children)`；`attrs` 支援 `class` / `html` / `onXxx`（事件）/ 其他 setAttribute。
- 專案檔案內**禁止寫死絕對路徑**（CLAUDE.md §0）。
- Commit 訊息格式：`[Module]: Why (not what)`，結尾加 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`。
- 測試指令：`cd app && SP0_SKIP_EXCEL=1 npx jest --runInBand --silent --noStackTrace --no-color`。預期 **0 紅、6 skipped**（6 skipped 是既有預期值，不是漏跑）。
- **前端沒有測試框架**（`package.json` 的 `testEnvironment` 是 `node`）。Task 2–5 因此沒有 red-green 循環，改以 Task 6 的端對端手動驗證收尾。**不引入 jsdom**。
- 不動 `ContractItems.card` / `DailyLogs.card` 的內部實作；不動開工報告表的解析／比對／歸檔邏輯；不改任何後端把關規則。

---

### Task 1: 列表 API 加四個流程狀態欄位

**Files:**
- Modify: `app/server/project-routes.js:96-113`（`GET /api/projects`）
- Test: `app/tests/project.test.js`（新增一個 describe 區塊）

**Interfaces:**
- Consumes: 既有的 `withComputed(row)`（`project-routes.js:91`）、`query`（`../server/db`）
- Produces: `GET /api/projects` 每列多回 `has_kickoff: boolean`、`has_budget: boolean`、`contract_items: number`、`log_days: number`。Task 5 的列表頁按鈕狀態依賴這四個欄位。

- [ ] **Step 1: 寫失敗測試**

在 `app/tests/project.test.js` 檔案**最末**加入：

```js
describe('GET /api/projects 流程狀態欄位', () => {
  let app, token;
  beforeEach(async () => {
    db._setPoolForTesting(freshPool());
    await db.migrate();
    ({ app, token } = await makeAppWithToken());
  });
  afterEach(() => db._setPoolForTesting(null));

  // 列表頁的四顆流程按鈕靠這四個欄位決定 ✓／下一步／disabled。少了它們,
  // 承辦人得逐個點開才知道哪個做過了——那正是這次改版要消滅的來回。
  test('回傳附件種類、契約項目數與施工日誌天數', async () => {
    const created = await createViaAward(app, token, { name: '狀態工程' });
    const id = created.body.id;
    await db.query(
      `INSERT INTO project_attachments (project_id, kind, file_path)
       VALUES ($1, 'kickoff_report', 'k.pdf')`, [id]
    );
    await db.query(
      `INSERT INTO contract_items (project_id, seq, item_no, name, quantity, unit_price)
       VALUES ($1, 1, '1', '項目A', 10, 100), ($1, 2, '2', '項目B', 5, 200)`, [id]
    );
    const res = await request(app).get('/api/projects')
      .set('Authorization', `Bearer ${token}`).expect(200);
    const row = res.body.find((r) => r.id === id);
    expect(row.has_kickoff).toBe(true);
    expect(row.has_budget).toBe(false);
    expect(row.contract_items).toBe(2);
    expect(row.log_days).toBe(0);
  });

  // pg-mem 不支援 COUNT(DISTINCT …) 且會**靜默算錯**(project-routes.js:132 已記載),
  // 故這條必須釘住:同一天的多個項次只能算一天,否則列表會顯示「已寫 3 天」
  // 而實際只有 2 天。
  test('同一天多個項次只算一天', async () => {
    const created = await createViaAward(app, token, { name: '日誌工程' });
    const id = created.body.id;
    await db.query(
      `INSERT INTO daily_records (project_id, log_date, item_no, qty)
       VALUES ($1, '2026-01-26', '1', 3), ($1, '2026-01-26', '2', 4),
              ($1, '2026-01-27', '1', 5)`, [id]
    );
    const res = await request(app).get('/api/projects')
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.find((r) => r.id === id).log_days).toBe(2);
  });

  // 搜尋走的是另一條 SQL 分支。少補這一條的話,一搜尋標記就全部消失,
  // 而承辦人最常用的正是搜尋。
  test('搜尋模式同樣帶這四個欄位', async () => {
    const created = await createViaAward(app, token, { name: '可搜尋工程' });
    const id = created.body.id;
    await db.query(
      `INSERT INTO project_attachments (project_id, kind, file_path)
       VALUES ($1, 'budget_sheet', 'b.xlsx')`, [id]
    );
    const res = await request(app).get('/api/projects?q=可搜尋')
      .set('Authorization', `Bearer ${token}`).expect(200);
    const row = res.body.find((r) => r.id === id);
    expect(row.has_budget).toBe(true);
    expect(row.has_kickoff).toBe(false);
    expect(row.contract_items).toBe(0);
    expect(row.log_days).toBe(0);
  });

  // 什麼都沒有的工程要回 false/0,不是 null 或缺欄位——前端用 `row.contract_items > 0`
  // 判定,undefined 會靜默變成 false 而看不出是「沒資料」還是「後端沒回」。
  test('無附件無項目的工程回 false 與 0,欄位不得缺漏', async () => {
    const created = await createViaAward(app, token, { name: '空工程' });
    const row = (await request(app).get('/api/projects')
      .set('Authorization', `Bearer ${token}`).expect(200))
      .body.find((r) => r.id === created.body.id);
    expect(row.has_kickoff).toBe(false);
    expect(row.has_budget).toBe(false);
    expect(row.contract_items).toBe(0);
    expect(row.log_days).toBe(0);
  });
});
```

- [ ] **Step 2: 跑測試確認失敗**

```bash
cd app && npx jest tests/project.test.js -t "流程狀態欄位" --silent --noStackTrace --no-color
```

Expected: FAIL —— `expect(received).toBe(expected)`，`row.has_kickoff` 是 `undefined`。

- [ ] **Step 3: 實作聚合**

在 `app/server/project-routes.js` 的 `withComputed`（第 91-94 行）**之後**加入這個函式：

```js
// 列表的流程狀態。**一律三次全表聚合後在 JS 合併,不得改成每列查一次**——
// 100 個工程會變成 300 次查詢。
//
// 施工日誌天數刻意用子查詢而非 COUNT(DISTINCT log_date):測試用的 pg-mem
// 不支援後者,而且是**靜默**算錯(同一天的多個項次被當成多天),
// 與 workflow-status 路由(第 132 行)同一個理由。
async function loadWorkflowFlags() {
  const [atts, items, days] = await Promise.all([
    query(`SELECT DISTINCT project_id, kind FROM project_attachments
             WHERE kind IN ('kickoff_report', 'budget_sheet')`),
    query('SELECT project_id, COUNT(*)::int AS n FROM contract_items GROUP BY project_id'),
    query(`SELECT project_id, COUNT(*)::int AS n FROM
             (SELECT DISTINCT project_id, log_date FROM daily_records) t
             GROUP BY project_id`),
  ]);
  const flags = new Map();
  const at = (id) => {
    if (!flags.has(id)) {
      flags.set(id, { has_kickoff: false, has_budget: false, contract_items: 0, log_days: 0 });
    }
    return flags.get(id);
  };
  for (const r of atts.rows) {
    if (r.kind === 'kickoff_report') at(r.project_id).has_kickoff = true;
    else at(r.project_id).has_budget = true;
  }
  for (const r of items.rows) at(r.project_id).contract_items = r.n;
  for (const r of days.rows) at(r.project_id).log_days = r.n;
  return flags;
}

// 聚合失敗不讓整個列表掛掉(沿用 workflow-status 的既有做法):該欄位退回
// false/0,承辦人看到的是「未完成」,點進去仍會被後端正確把關。
async function withWorkflowFlags(rows) {
  let flags = new Map();
  try { flags = await loadWorkflowFlags(); }
  catch (err) { console.error('[projects] 讀取流程狀態失敗:', err); }
  const empty = { has_kickoff: false, has_budget: false, contract_items: 0, log_days: 0 };
  return rows.map((r) => ({ ...withComputed(r), ...(flags.get(r.id) || empty) }));
}
```

- [ ] **Step 4: 兩條查詢分支都套用**

把 `app/server/project-routes.js:109` 的

```js
      res.json(rows.map(withComputed));
```

改成

```js
      res.json(await withWorkflowFlags(rows));
```

（`GET /api/projects/:id` 第 119 行的 `withComputed(rows[0])` **不動**——單筆有專屬的 `workflow-status` 路由，不需要重複。）

- [ ] **Step 5: 跑測試確認通過**

```bash
cd app && npx jest tests/project.test.js --silent --noStackTrace --no-color
```

Expected: PASS，全檔綠。

- [ ] **Step 6: 跑全套確認沒弄壞別的**

```bash
cd app && SP0_SKIP_EXCEL=1 npx jest --runInBand --silent --noStackTrace --no-color
```

Expected: 0 紅、6 skipped。

- [ ] **Step 7: Commit**

```bash
git add app/server/project-routes.js app/tests/project.test.js
git commit -m "$(cat <<'EOF'
[project-routes]: 列表看不出哪個工程做到哪,承辦人得逐個點開才知道

列表頁要長出四顆流程按鈕並標示「已完成/下一步」,但列表 API 只回主檔欄位。
補 has_kickoff/has_budget/contract_items/log_days 四個聚合欄位。

三次全表聚合後在 JS 合併,不做每列一次查詢——100 個工程會變成 300 次。
日誌天數用子查詢而非 COUNT(DISTINCT):pg-mem 不支援且會靜默把同一天的
多個項次算成多天,與 workflow-status 路由同一個理由,已寫成測試釘住。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 通用彈窗 `modalDialog`

**Files:**
- Modify: `app/public/js/dialog.js`（在 `confirmDialog` 之後、`showToast` 之前插入）
- Modify: `app/public/css/app.css:129`（`.modal` 之後加 `.modal-wide`）
- Modify: `app/public/js/views/projects.js:11-50`（`submissionDialog` 改用 `modalDialog`）

**Interfaces:**
- Consumes: 既有的 `.modal-overlay` / `.modal` / `.modal-title` / `.modal-body` CSS class
- Produces: 全域函式 `modalDialog({ title, content, wide }) → { close() }`。`content` 是 DOM 節點。Task 3 與 Task 5 都用它。

**為什麼要抽：** `dialog.js` 目前只有 `confirmDialog`（純文字），而 `projects.js:11-50` 的 `submissionDialog` 已經手刻了第二套 overlay／Escape／點外面關閉。這次需要第三種（裝任意內容），不抽就會有三套各自漂移的關閉邏輯。

- [ ] **Step 1: 加 `modalDialog`**

在 `app/public/js/dialog.js` 的 `window.confirmDialog = confirmDialog;` 那一行**之後**插入：

```js
// modalDialog({ title, content, wide, onClose }) → { close }
// 裝任意 DOM 的彈窗。與 confirmDialog 的差別:那支是「一句話 + 是/否」,
// 這支裡面有多個輸入框與多顆按鈕,故**刻意不做 Enter 送出**——那會誤觸。
// 關閉時機由呼叫端自己決定(流程走完才關),所以回傳 close 而不是 Promise。
// onClose 在任何關閉路徑(Escape、點 overlay、呼叫 close)都會觸發一次,
// 讓以 Promise 包裝的呼叫端有機會 resolve——少了它,使用者按 Escape 放棄操作
// 會讓那個 Promise 永遠擱置。
function modalDialog(opts = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal' + (opts.wide ? ' modal-wide' : '');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const titleEl = document.createElement('div');
  titleEl.className = 'modal-title';
  titleEl.textContent = opts.title || '';

  const body = document.createElement('div');
  body.className = 'modal-body';
  if (opts.content) body.appendChild(opts.content);

  modal.appendChild(titleEl);
  modal.appendChild(body);
  overlay.appendChild(modal);

  let closed = false;
  function close() {
    if (closed) return;          // onClose 只跑一次:呼叫端可能已自行 close 過
    closed = true;
    window.removeEventListener('keydown', onKey);
    overlay.remove();
    if (opts.onClose) opts.onClose();
  }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  window.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  return { close };
}
window.modalDialog = modalDialog;
```

- [ ] **Step 2: 加 `.modal-wide` 樣式**

在 `app/public/css/app.css` 第 129 行（`.modal { … }`）**之後**插入：

```css
/* 開工報告表的九欄比對表與價目表差異清單塞不進 440px。內容高度不可預期,
   故限制在視窗高度內並讓內容自己捲,否則長表格會把彈窗撐出畫面外、
   按鈕點不到。 */
.modal-wide { width: 960px; }
.modal-wide .modal-body { max-height: 70vh; overflow-y: auto; padding-bottom: var(--space-6); }
```

- [ ] **Step 3: `submissionDialog` 改用 `modalDialog`**

把 `app/public/js/views/projects.js` 第 11-50 行整個 `submissionDialog` 函式替換成：

```js
  function submissionDialog(defaultPeriod) {
    return new Promise((resolve) => {
      const typeSel = el('select', { class: 'form-control' }, [
        el('option', { value: 'monthly' }, '每月'),
        el('option', { value: 'supervision' }, '督導')
      ]);
      const periodI = el('input', { class: 'form-control', type: 'month', value: defaultPeriod || '' });
      const fileI = el('input', { class: 'form-control', type: 'file' });
      const errBox = el('div', { class: 'error-msg', style: 'display:none' });

      // 關閉路徑有四條(送出、取消鈕、Escape、點 overlay)。一律由 modalDialog
      // 的 onClose 收斂成一次 resolve,四條各自 resolve 會漏掉後兩條——
      // 使用者按 Escape 放棄操作時,那個 Promise 會永遠擱置。
      let result = null;
      function submit() {
        const period = periodI.value.trim();
        if (!/^\d{4}-\d{2}$/.test(period)) { errBox.textContent = '請選擇週期(年月)'; errBox.style.display = ''; return; }
        if (!fileI.files || !fileI.files[0]) { errBox.textContent = '請選擇施工日誌檔'; errBox.style.display = ''; return; }
        result = { type: typeSel.value, period, file: fileI.files[0] };
        dlg.close();
      }

      const body = el('div', {}, [
        errBox,
        el('div', { class: 'form-group' }, [el('label', {}, '類型'), typeSel]),
        el('div', { class: 'form-group' }, [el('label', {}, '週期'), periodI]),
        el('div', { class: 'form-group' }, [el('label', {}, '施工日誌檔'), fileI]),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-outline', onClick: () => dlg.close() }, '取消'),
          el('button', { class: 'btn btn-primary', onClick: submit }, '送出')
        ])
      ]);
      const dlg = modalDialog({
        title: '登錄繳交(上傳施工日誌)', content: body,
        onClose: () => resolve(result),
      });
    });
  }
```

**注意：** 四條關閉路徑（送出、取消鈕、Escape、點 overlay）全部收斂到 `onClose` 的單一 `resolve(result)`。`result` 預設 `null`，只有 `submit()` 通過驗證才會被賦值——所以放棄操作一律 resolve 成 `null`，呼叫端 `generate()`（`projects.js:863`）的 `if (!r) return;` 照常成立。

- [ ] **Step 4: 手動驗證**

啟動服務後在瀏覽器操作：

1. 工程列表 → 任一工程「歷史」→「＋ 登錄繳交」→ 彈窗出現、三個欄位都在
2. 不選檔案直接送出 → 紅字「請選擇施工日誌檔」顯示在彈窗內
3. Escape 關閉彈窗
4. 切深色模式（`document.documentElement.dataset.theme = 'dark'`）→ 彈窗文字可讀、不是白字白底

- [ ] **Step 5: Commit**

```bash
git add app/public/js/dialog.js app/public/css/app.css app/public/js/views/projects.js
git commit -m "$(cat <<'EOF'
[dialog,projects]: 第三種彈窗需求出現前,先把手刻的第二套收掉

dialog.js 只有 confirmDialog(純文字),而 submissionDialog 自己手刻了一套
overlay/Escape/點外面關閉。列表頁要開「裝整個流程」的彈窗是第三種,
再手刻一次就會有三套各自漂移的關閉邏輯。

抽 modalDialog({title, content, wide}) 並讓 submissionDialog 改用它。
刻意不做 Enter 送出:彈窗內有多個輸入框與多顆按鈕,Enter 會誤觸——
confirmDialog 是單一決策才適合。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 抽出 `KickoffReport` 元件

**Files:**
- Create: `app/public/js/views/kickoff-report.js`
- Modify: `app/public/index.html`（新增一行 script）
- Modify: `app/public/js/views/projects.js:289-534`（移除已抽出的區塊，改為呼叫元件）

**Interfaces:**
- Consumes: `PmisApp.el`、`Api.upload`、`showToast`（皆為既有全域）
- Produces: `KickoffReport.card(projectId, opts) → HTMLElement`
  - `opts.durationInput`（可選）：外部的「契約工期(日曆天)」`<input>`。傳入時 confirm 以它為準；不傳則元件自建。
  - `opts.startDateInput`（可選）：外部的「開工日期」`<input>`。同上。
  - `opts.onArchived`（可選）：`() => void`，歸檔成功後呼叫。
  - Task 4 傳入前兩者，Task 5 都不傳。

**這是純搬家 + 加參數。** 解析、比對、渲染、歸檔的邏輯一行都不改——包括那些寫著「為什麼」的長註解，全部原樣帶過去。

- [ ] **Step 1: 建立新檔**

建立 `app/public/js/views/kickoff-report.js`：

```js
/**
 * kickoff-report.js — 開工報告表區塊(上傳 → OCR 預填 → 九欄比對 → 歸檔)
 *
 * 從 projects.js 抽出,讓工程詳細頁的頁籤與工程列表頁的彈窗**共用同一份**。
 * 兩邊各寫一份的話,比對表的編輯同步規則遲早漂成兩套行為。
 *
 * 契約工期與開工日有兩種來源,由 opts 決定:
 *   詳細頁 → 傳入「監造報表基本資料」既有的兩個 input,行為與抽出前完全相同
 *            (含「confirm 以該欄為準」與「工作天不預填」的既有語意)
 *   彈窗   → 不傳,元件在比對表下方自建這兩欄
 * confirm 走的是同一段程式碼,差別只在欄位從哪來。
 *
 * Exports: KickoffReport.card(projectId, opts) → HTMLElement
 */
const KickoffReport = (() => {
  const el = PmisApp.el;

  const 狀態文字 = { match: '相符', diff: '不符', missing: '未讀到', no_award: '無決標公告可比' };

  // 比對表中文標籤 → extractFields 的實際鍵名(兩邊命名不完全相同,
  // 如「決標日」對應 kickoffValues.決標日期、「學校」對應 .主辦機關)。
  const FIELD_KEY = {
    工程名稱: '工程名稱', 契約編號: '契約編號', 契約金額: '契約金額',
    決標日: '決標日期', 學校: '主辦機關', 縣市: '縣市',
    契約工期: '契約工期', 契約規定開工日: '契約規定開工日', 契約規定竣工日: '契約規定竣工日',
  };
  const DATE_FIELDS = new Set(['決標日', '契約規定開工日', '契約規定竣工日']);
  const NUMBER_FIELDS = new Set(['契約金額', '契約工期']);

  function card(projectId, opts = {}) {
    // OCR 只作預填不作裁決:逐欄辨識率 77%、契約工期僅 46%,
    // 讓 OCR 下裁決會每三欄產生一個假警報,承辦人幾次之後就學會忽略警告。
    let kickoffFile = null;
    let kickoffValues = null;
    // r.欄位(比對表中文標籤)→ resultSpan 元素,供 confirm 失敗後用後端回傳的
    // 最新 fields 清單回頭標紅——每次 renderKickoffRows 重繪時整批換新。
    let koResultCells = {};

    // 外部有給就用外部的(詳細頁),沒有就自建(彈窗)。自建的那組要顯示出來,
    // 外部的那組已經在別處顯示,這裡不能重複畫。
    const owns = !opts.durationInput || !opts.startDateInput;
    const 工期I = opts.durationInput
      || el('input', { class: 'form-control', type: 'number', step: '1', min: '1' });
    const 開工I = opts.startDateInput
      || el('input', { class: 'form-control', type: 'date' });

    const koFileI = el('input', { class: 'form-control', type: 'file', accept: '.pdf' });
    const koParseBtn = el('button', { class: 'btn', type: 'button' }, '解析並比對');
    const koConfirmBtn = el('button', { class: 'btn btn-primary', type: 'button', style: 'display:none' }, '確認無誤並歸檔');
    const koErr = el('div', { class: 'error-msg', style: 'display:none' });
    // 工作天案例的專屬警示:與 koErr 分開,因為 koErr 是「這次操作失敗」,
    // 這個是「操作成功但有一格刻意不填」——同時顯示不衝突,語意也不同。
    const koDurationWarn = el('div', { class: 'error-msg', style: 'display:none' });
    // 歸檔成功但有提示級問題(如決標日晚於開工日)。與 koErr 分開:那是「這次
    // 操作失敗」,這是「已歸檔但有一點要回頭確認」。
    const koWarn = el('div', { class: 'hint', style: 'display:none' });
    // 解析會改到工期/開工日。外部欄位在別的頁籤時那是**看不見的改動**,
    // 故明講改了什麼(自建欄位就在眼前,不需要這條)。
    const koSyncNote = el('div', { class: 'hint', style: 'display:none' });
    const koHint = el('div', { class: 'hint' },
      '上傳後系統以 OCR 預填候選值並與已歸檔的決標公告比對。讀不到的欄位留空,請對照 PDF 自行填寫。' +
      '「開工報告表」欄可直接編輯(如 OCR 讀錯字),改完按「確認無誤並歸檔」由後端重新比對。' +
      '除「學校」與「決標日」外皆為必填,留空無法歸檔。');
    const koBox = el('div', { class: 'table-wrap' });

    function renderKickoffRows(rows) {
      koBox.innerHTML = '';
      koResultCells = {};
      if (!rows || !rows.length) return;
      const trs = rows.map((r) => {
        // 級別與狀態一起決定顯示:提示級的 diff 不是錯,是「決標公告寫的是預估值」
        let 標記 = 狀態文字[r.狀態] || r.狀態;
        // 配色一律走 app.css 的 CSS 變數,不寫死淺色底(深色模式會讓文字翻白＝隱形)
        let cls = r.狀態 === 'diff' && r.級別 === 'hard' ? 'error-msg' : 'hint';
        if (r.狀態 === 'diff' && r.級別 === 'hint') {
          標記 = `提示:差 ${r.差異天數 == null ? '?' : r.差異天數} 天`;
        } else if (r.欄位 === '契約工期' && r.狀態 === 'missing' &&
          typeof r.開工報告表值 === 'string' && r.開工報告表值.includes('工作天')) {
          // 這格「有讀到值」(如 160 工作天),只是工作天無法跟日曆天比較——
          // 灰色「未讀到」會讓承辦人以為這格是空的而略過核對,實際上工期I
          // 被刻意留空正是因為讀到了這個工作天數字,兩者要分開強調。
          標記 = '工作天,單位不同無法比對,請自行核對填寫';
          cls = 'error-msg';
        }
        const resultSpan = el('span', { class: cls }, 標記);
        koResultCells[r.欄位] = resultSpan;

        // 開工報告表值改為可編輯輸入框:元長案例(OCR 把「-」讀成「—」)證明
        // 唯讀比對表在真的遇到 OCR 誤讀時,承辦人無計可施,合法文件永遠歸不了檔。
        // 讀不到的欄位維持留空(不預先填東西進去),沿用 spec §5.1 的「確認或修正」。
        const key = FIELD_KEY[r.欄位];
        const isDate = DATE_FIELDS.has(r.欄位);
        const isNumber = NUMBER_FIELDS.has(r.欄位);
        const type = isDate ? 'date' : (isNumber ? 'number' : 'text');
        const initVal = r.欄位 === '契約工期'
          ? (kickoffValues.契約工期 && kickoffValues.契約工期.天數 != null ? kickoffValues.契約工期.天數 : '')
          : (kickoffValues[key] == null ? '' : kickoffValues[key]);
        const valInput = el('input', {
          class: 'form-control', type, value: String(initVal),
          ...(isNumber ? { step: '1' } : {}),
        });
        valInput.addEventListener('input', () => {
          // 舊的 match/diff 是上一輪解析值的判定,編輯後繼續掛著會誤導承辦人
          // 以為「還是原本那個結果」——改採中性提示,真正的裁決留給後端在
          // 「確認無誤並歸檔」時用 kickoff-compare.js 重新決定(前端不重造一份
          // 判斷邏輯,避免兩邊規則漂走)。
          resultSpan.className = 'hint';
          resultSpan.textContent = '已修改,尚未送出確認';

          if (r.欄位 === '契約工期') {
            const n = valInput.value.trim();
            const 基準 = (kickoffValues.契約工期 && kickoffValues.契約工期.基準) || null;
            kickoffValues.契約工期 = {
              天數: n !== '' && Number.isFinite(Number(n)) ? Number(n) : null,
              基準,
            };
            // 「工期I」是「寫入監造報表」實際會用的值,兩邊沒同步的話,承辦人
            // 會以為改好了,結果寫進 Excel 的還是舊值(commit a0cef03 抓過的型態)。
            // 工作天不是日曆天,不可互填,維持既有警示與空白,不同步。
            if (基準 !== '工作天') {
              工期I.value = kickoffValues.契約工期.天數 != null ? kickoffValues.契約工期.天數 : '';
            }
          } else if (r.欄位 === '契約規定開工日') {
            kickoffValues.契約規定開工日 = valInput.value || null;
            開工I.value = valInput.value || '';
          } else if (isNumber) {
            const n = valInput.value.trim();
            kickoffValues[key] = n !== '' && Number.isFinite(Number(n)) ? Number(n) : null;
          } else if (isDate) {
            kickoffValues[key] = valInput.value || null;
          } else {
            const t = valInput.value.trim();
            kickoffValues[key] = t === '' ? null : t;
          }
        });

        return el('tr', {}, [
          el('td', {}, r.欄位),
          el('td', {}, valInput),
          el('td', {}, r.決標公告值 == null ? '—' : String(r.決標公告值)),
          el('td', {}, resultSpan),
        ]);
      });
      koBox.appendChild(el('table', { class: 'data' }, [
        el('thead', {}, el('tr', {}, [
          el('th', {}, '欄位'), el('th', {}, '開工報告表(可編輯)'),
          el('th', {}, '決標公告'), el('th', {}, '結果'),
        ])),
        el('tbody', {}, trs),
      ]));
    }

    koParseBtn.addEventListener('click', async () => {
      koErr.style.display = 'none';
      koDurationWarn.style.display = 'none';
      koSyncNote.style.display = 'none';
      if (!koFileI.files[0]) {
        koErr.textContent = '請先選擇開工報告表 PDF';
        koErr.style.display = '';
        return;
      }
      koParseBtn.disabled = true;
      koParseBtn.textContent = '解析中(OCR 需數秒)…';
      try {
        const fd = new FormData();
        fd.append('kickoff_report', koFileI.files[0]);
        const data = await Api.upload('projects/' + projectId + '/kickoff-report/parse', fd);
        kickoffFile = koFileI.files[0];
        kickoffValues = data.kickoff;
        renderKickoffRows(data.rows);
        // 預填既有的兩格。**只在讀到值時覆蓋**——讀不到就留著承辦人已填的內容,
        // 用 null 蓋掉會把他剛打好的字清空。
        const 工期 = data.kickoff.契約工期;
        const synced = [];
        if (工期 && 工期.基準 === '工作天') {
          // 「工期I」標示的是日曆天,工作天不是同一單位,不可直接互填——
          // 硬塞會產生「數字看起來正常、單位卻是錯的」這種最難察覺的資料損壞。
          // 寧可留空讓承辦人自己核對 PDF 換算,也要用明顯的警示說明「為什麼沒填」,
          // 靜默跳過跟靜默填錯一樣糟。
          koDurationWarn.textContent =
            `開工報告表上的工期是「${工期.天數 == null ? '?' : 工期.天數} 工作天」,` +
            '而此欄位要的是日曆天,兩者不可直接互填,請' +
            (owns ? '對照 PDF 自行換算後填入下方欄位' : '至「基本資料」頁籤自行換算填寫') +
            '(系統不自動預填)。';
          koDurationWarn.style.display = '';
        } else if (工期 && 工期.天數 != null) {
          工期I.value = 工期.天數;
          synced.push(`契約工期 ${工期.天數} 天`);
        }
        if (data.kickoff.契約規定開工日) {
          開工I.value = data.kickoff.契約規定開工日;
          synced.push(`開工日 ${data.kickoff.契約規定開工日}`);
        }
        // 外部欄位在別的頁籤,改了看不見。自建的就在眼前,不必多此一舉。
        if (!owns && synced.length) {
          koSyncNote.textContent = '已同步更新「基本資料」頁籤的' + synced.join('、') + '。';
          koSyncNote.style.display = '';
        }
        // 未歸檔決標公告的工程已由後端擋在 parse 之前(要求以決標公告重建工程),
        // 走到這裡必然有比對基準,不再有「僅預填、未比對」這種半套狀態。
        koConfirmBtn.style.display = '';
      } catch (e) {
        koErr.textContent = e.message;
        koErr.style.display = '';
        koConfirmBtn.style.display = 'none';
        // 解析失敗時不能留著「上一份文件」的解析結果——沒清的話,承辦人看到
        // 的會是一句「這個檔認不得」配一整張看起來屬於它的比對表,很容易
        // 誤讀成「雖然有警告,但還是解析出東西了」。這裡清的都是「描述剛才
        // 那份文件解析結果」的畫面元素;工期I/開工I 是承辦人自己的工作區
        // (可能已經手動改過),解析失敗不該動它,故不在清空之列。
        kickoffFile = null;
        kickoffValues = null;
        renderKickoffRows(null);
      } finally {
        koParseBtn.disabled = false;
        koParseBtn.textContent = '解析並比對';
      }
    });

    koConfirmBtn.addEventListener('click', async () => {
      koErr.style.display = 'none';
      if (!kickoffFile || !kickoffValues) return;
      koConfirmBtn.disabled = true;
      try {
        // 送出承辦人確認後的值:工期與開工日以畫面上的為準(他可能修正過 OCR 的錯讀),
        // 其餘欄位沿用解析值。
        const 工期raw = 工期I.value.trim();
        const values = {
          ...kickoffValues,
          契約工期: {
            天數: 工期raw !== '' && Number.isFinite(Number(工期raw)) ? Number(工期raw) : null,
            基準: (kickoffValues.契約工期 && kickoffValues.契約工期.基準) || null,
          },
          契約規定開工日: 開工I.value || null,
        };
        const fd = new FormData();
        fd.append('kickoff_report', kickoffFile);
        fd.append('values', JSON.stringify(values));
        const r = await Api.upload('projects/' + projectId + '/kickoff-report/confirm', fd);
        renderKickoffRows(r.rows);
        // 提示級不擋歸檔,但用 toast 講會隨著跳轉消失,而這是要承辦人回頭確認的
        // 東西——留在畫面上,與 koDurationWarn 同一種「已完成但有一點要看」的位置。
        if (r.warnings && r.warnings.length) {
          koWarn.textContent = r.warnings.map((w) => `${w.欄位}:${w.訊息}`).join('；');
          koWarn.style.display = '';
        }
        showToast('開工報告表已核對並歸檔', 'success');
        koConfirmBtn.style.display = 'none';
        if (opts.onArchived) opts.onArchived();
      } catch (e) {
        // 硬錯清單一次列全,逐條修正會讓承辦人來回發文
        const suffix = e.fields && e.fields.length ? '：' + e.fields.join('、') : '';
        koErr.textContent = e.message + suffix;
        koErr.style.display = '';
        // 後端已用這次送出的 values 重新跑過 compareKickoff,e.fields 就是
        // 最新的硬錯清單——藉此把表格上「這次仍不符」的那幾列標紅,不讓
        // 承辦人誤以為畫面上的中性提示代表已經沒事。api.js 的 apiError()
        // 只透傳 fields、不傳 rows(跨檔案限制,見 task-8-report),故只能
        // 標記出「哪幾欄還錯」,無法整表用新結果重繪。
        if (e.fields && e.fields.length) {
          for (const f of e.fields) {
            const span = koResultCells[f];
            if (!span) continue;
            span.className = 'error-msg';
            // 必填/值域的硬擋帶逐欄原因(fieldMessages),直接照用——那類問題是
            // 「這欄沒填或填得不成立」,套下面的跨文件文案會把承辦人指去對決標公告。
            // 契約工期則是開工報告表自身的內部自洽性檢查(表列工期 vs 開工/竣工日
            // 推導值),同樣不可套「與決標公告不符」,那會跟 koErr 頂部訊息自相矛盾
            // (buildHardErrorMessage 已刻意分流,見 kickoff-routes.js)
            const note = e.fieldMessages && e.fieldMessages[f];
            span.textContent = note || (f === '契約工期'
              ? '仍不符,請確認表格填寫'
              : '與決標公告不符,請確認後修正');
          }
        }
      } finally { koConfirmBtn.disabled = false; }
    });

    // 自建的兩欄放在比對表下方——歸檔送出的就是這兩格,不顯示等於要承辦人
    // 對著看不見的值按確認。外部欄位已在別處顯示,這裡不重複畫。
    const ownFields = owns ? el('div', { class: 'form-row', style: 'margin-top:12px' }, [
      el('div', { class: 'form-group' }, [el('label', {}, '契約工期(日曆天)'), 工期I]),
      el('div', { class: 'form-group' }, [el('label', {}, '開工日期'), 開工I]),
    ]) : null;

    return el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, '開工報告表'),
      koHint,
      el('div', { class: 'form-group' }, [el('label', {}, '開工報告表 PDF'), koFileI]),
      el('div', { class: 'form-actions' }, [koParseBtn, koConfirmBtn]),
      koErr,
      koDurationWarn,
      koSyncNote,
      koWarn,
      koBox,
      ownFields,
    ]);
  }

  return { card };
})();
```

- [ ] **Step 2: 載入新檔**

在 `app/public/index.html` 的 `<script src="/js/views/daily-logs.js"></script>` 那一行**之後**加入：

```html
  <script src="/js/views/kickoff-report.js"></script>
```

（排在 `projects.js` 之前，與 `contract-items.js` / `daily-logs.js` 的既有慣例一致。）

- [ ] **Step 3: `projects.js` 改為呼叫元件**

刪除 `app/public/js/views/projects.js` 第 289 行（註解 `// ── 開工報告表(SP1B 階段二)────`）到第 534 行（該區塊 `content.appendChild(...)` 的結尾 `]));`）之間的**全部內容**，替換成：

```js
      // 開工報告表(SP1B 階段二)。已抽成 views/kickoff-report.js,讓這裡的頁籤
      // 與工程列表頁的彈窗共用同一份——兩邊各寫一份的話,比對表的編輯同步規則
      // 遲早漂成兩套行為。
      // 傳入既有的工期/開工日 input:歸檔仍以那兩格為準(工作天案例要承辦人
      // 自行換算日曆天),與抽出前完全相同。
      content.appendChild(KickoffReport.card(id, {
        durationInput: 工期I,
        startDateInput: 開工I,
        onArchived: () => loadAttachments(),
      }));
```

- [ ] **Step 4: 語法檢查**

```bash
cd app && node --check public/js/views/kickoff-report.js && node --check public/js/views/projects.js
```

Expected: 兩個都無輸出（通過）。

- [ ] **Step 5: 手動驗證（此步驟不可略過——這是純搬家，唯一的驗證方式是實跑）**

1. 進任一工程詳細頁 → 開工報告表區塊外觀與抽出前相同，**沒有**多出「契約工期/開工日期」兩欄（因為傳入了外部欄位）
2. 上傳 `docs/samples/開工報告表/元長國小老舊廁所整修_開工報告表.pdf` → 解析成功、九欄比對表出現
3. 解析後「監造報表基本資料」的契約工期與開工日**有被帶入**，且開工報告表區塊出現「已同步更新『基本資料』頁籤的…」提示
4. 改比對表的「契約工期」→「監造報表基本資料」的工期跟著變
5. 按「確認無誤並歸檔」→ 成功後附件清單有更新（`onArchived` 生效）

- [ ] **Step 6: 跑全套（確認沒動到後端）**

```bash
cd app && SP0_SKIP_EXCEL=1 npx jest --runInBand --silent --noStackTrace --no-color
```

Expected: 0 紅、6 skipped。

- [ ] **Step 7: Commit**

```bash
git add app/public/js/views/kickoff-report.js app/public/js/views/projects.js app/public/index.html
git commit -m "$(cat <<'EOF'
[kickoff-report,projects]: 列表頁彈窗要用同一塊 UI,再複製一份就會漂成兩套

開工報告表區塊(解析→比對→逐欄修正→歸檔)原本埋在 projects.js 裡,而列表頁
的彈窗需要同一塊。複製一份的話,比對表那些「編輯後改中性提示」「工作天不預填」
的同步規則遲早在兩邊漂走。

抽成 KickoffReport.card(projectId, opts)。邏輯一行未改,只加 opts:
詳細頁傳入既有的工期/開工日 input(歸檔仍以那兩格為準,行為不變);
彈窗不傳,元件自建那兩欄並顯示出來——歸檔送出的就是它們,不顯示等於
要承辦人對著看不見的值按確認。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 詳細頁改成五個頁籤

**Files:**
- Modify: `app/public/js/views/projects.js`（`renderEdit` 的組裝部分）
- Modify: `app/public/css/app.css`（新增頁籤樣式）

**Interfaces:**
- Consumes: Task 3 的 `KickoffReport.card`、既有的 `ContractItems.card` / `DailyLogs.card` / `WorkflowStatus.bar`
- Produces: 詳細頁的五個頁籤區塊。Task 5 不依賴此任務。

**核心原則：一次全建、切換只改 `display`。** 既有元素引用與事件完全不動。

- [ ] **Step 1: 加頁籤樣式**

在 `app/public/css/app.css` 檔案**最末**加入：

```css
/* 工程詳細頁的頁籤。色彩全走變數:深色模式下寫死淺色底會讓 var(--text)
   翻白而隱形(CLAUDE.md §2)。 */
.tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin-bottom: var(--space-4); }
.tab { padding: 9px 16px; font-size: var(--fs-base); color: var(--text-muted); background: none;
  border: none; border-bottom: 2px solid transparent; cursor: pointer; white-space: nowrap; }
.tab:hover { color: var(--text); }
.tab.active { color: var(--primary); border-bottom-color: var(--primary); font-weight: var(--fw-semibold); }
/* 有未看過的同步改動時的小圓點(見 kickoff-report.js 的 koSyncNote) */
.tab .dot { display: inline-block; width: 6px; height: 6px; margin-left: 5px; border-radius: 50%;
  background: var(--primary); vertical-align: middle; }
```

- [ ] **Step 2: 在 `renderEdit` 內加入頁籤骨架**

在 `app/public/js/views/projects.js` 的 `renderEdit` 中，找到 `content.appendChild(el('div', { class: 'page-title' }, isNew ? '新增工程' : '編輯工程'));`（第 86 行），在其**之後**加入：

```js
    // 頁籤只用於既有工程。新增工程時只有決標公告 + 基本資料兩塊,分頁只是多一次點擊。
    //
    // **一次全建、切換只改 display**:開工報告表解析後會直接改寫「監造報表基本資料」
    // 的工期/開工日,惰性建構會讓那些 DOM 還不存在時就被寫入;切回去若重建,
    // 承辦人未儲存的編輯也會被清掉。全建等於「現狀 + 分堆隱藏」,既有引用完全不動。
    const TABS = [
      { key: 'basics', label: '基本資料' },
      { key: 'kickoff', label: '開工報告表' },
      { key: 'items', label: '契約價目表' },
      { key: 'logs', label: '施工日誌' },
      { key: 'files', label: '附件' },
    ];
    const panes = {};
    const tabBtns = {};
    let tabBar = null;

    function showTab(key) {
      const k = panes[key] ? key : TABS[0].key;
      for (const t of TABS) {
        panes[t.key].style.display = t.key === k ? '' : 'none';
        tabBtns[t.key].className = 'tab' + (t.key === k ? ' active' : '');
      }
      // 看過就把小圓點收掉
      const dot = tabBtns[k].querySelector('.dot');
      if (dot) dot.remove();
      // 網址同步,但**不觸發重建**:路由只讀第二段當 id,第三段在這裡自行解析。
      const target = '/projects/' + id + '/' + k;
      if (window.location.hash.replace(/^#/, '') !== target) {
        history.replaceState(null, '', '#' + target);
      }
    }

    // 在「基本資料」頁籤標籤上點一個小圓點(解析開工報告表改到了那頁的欄位時)
    function markTab(key) {
      const btn = tabBtns[key];
      if (!btn || btn.classList.contains('active') || btn.querySelector('.dot')) return;
      btn.appendChild(el('span', { class: 'dot' }));
    }

    if (!isNew) {
      tabBar = el('div', { class: 'tabs' });
      for (const t of TABS) {
        panes[t.key] = el('div', { style: 'display:none' });
        const btn = el('button', { class: 'tab', type: 'button', onClick: () => showTab(t.key) }, t.label);
        tabBtns[t.key] = btn;
        tabBar.appendChild(btn);
      }
    }

    // 既有工程把區塊放進對應頁籤;新增工程維持直接往 content 疊。
    const into = (key) => (isNew ? content : panes[key]);
```

- [ ] **Step 3: 把各區塊改放進對應頁籤**

在同一個檔案中做以下五處替換（**逐處對照，不要整段複製**）：

1. 主表單 card（第 229 行附近）：

```js
    content.appendChild(card);
```

改成

```js
    into('basics').appendChild(card);
```

2. 監造報表基本資料 card（Task 3 之後在第 277 行附近，`content.appendChild(el('div', { class: 'card' }, [` 且 `card-title` 為 `'監造報表基本資料'` 的那一段）：把開頭的 `content.appendChild(` 改成 `into('basics').appendChild(`。

3. 開工報告表（Task 3 留下的那段）：

```js
      content.appendChild(KickoffReport.card(id, {
```

改成

```js
      into('kickoff').appendChild(KickoffReport.card(id, {
```

並把 `onArchived` 改成同時標記頁籤：

```js
        onArchived: () => loadAttachments(),
        onSynced: () => markTab('basics'),
```

**注意：** `KickoffReport.card` 在 Task 3 定義的 `opts` 沒有 `onSynced`。要在 `kickoff-report.js` 補上——找到設定 `koSyncNote` 的那段（`if (!owns && synced.length) {`），在 `koSyncNote.style.display = '';` 之後加一行：

```js
          if (opts.onSynced) opts.onSynced();
```

4. 流程狀態列（第 538-549 行附近）：**位置不動**（維持在 `if (!isNew)` 區塊內原處），只刪掉那一行

```js
      content.appendChild(wfBox);
```

`wfBox` 的建立與那個非同步 IIFE 都保留原樣。實際的 append 順序統一在 Step 4 處理——因為所有 card 現在都進了 `panes`，`content` 上只剩「進度列 → 頁籤列 → 五個 pane」三件事，集中在一處排序比散在各處清楚。

5. 契約價目表、施工日誌、附件：

```js
      content.appendChild(ContractItems.card(id));
      content.appendChild(DailyLogs.card(id));
```

改成

```js
      into('items').appendChild(ContractItems.card(id));
      into('logs').appendChild(DailyLogs.card(id));
```

而附件 card（第 559-563 行附近的 `content.appendChild(attCard);`）改成：

```js
      into('files').appendChild(attCard);
```

- [ ] **Step 4: 掛上 pane 並設定初始頁籤**

在 `renderEdit` 的 `if (!isNew) { … }` 區塊**最末**（`loadAttachments();` 那一行之後）加入：

```js
      // content 上只有這三件事,順序即畫面由上而下。
      // 流程進度列常駐在頁籤**上方**:它是唯一會講「下一步該做什麼」的區塊,
      // 放進頁籤內容裡等於要承辦人先選對頁籤才看得到,本末倒置。
      content.appendChild(wfBox);
      content.appendChild(tabBar);
      for (const t of TABS) content.appendChild(panes[t.key]);

      // 網址第三段決定預設頁籤;沒有或不認得就回第一頁。
      const wanted = (window.location.hash.replace(/^#/, '').split('/')[3] || '').trim();
      showTab(wanted);
```

**注意：** `wfBox` 是在區塊中段建立的（Step 3 第 4 點保留了那段），這裡才 append。若實作時發現 `wfBox` 的宣告在此行之後，把它的宣告上移到 `if (!isNew) {` 開頭即可——`const` 不會提升，順序錯了會是 ReferenceError 而非靜默失敗，跑一次就會發現。

- [ ] **Step 5: 語法檢查**

```bash
cd app && node --check public/js/views/projects.js && node --check public/js/views/kickoff-report.js
```

Expected: 無輸出。

- [ ] **Step 6: 手動驗證**

1. 進既有工程 → 流程進度列在最上方、其下是五個頁籤、預設顯示「基本資料」
2. 逐一點五個頁籤都能切換，內容正確
3. 在「基本資料」改工程名稱（不儲存）→ 切到「附件」再切回來 → **改的字還在**（證明沒重建）
4. 切到「開工報告表」→ 網址變成 `#/projects/<id>/kickoff` → 重新整理頁面 → 仍停在開工報告表頁籤
5. 上傳開工報告表解析 → 「基本資料」頁籤標籤出現小圓點 → 點進去圓點消失、工期與開工日是新值
6. 新增工程頁（`#/projects/new`）→ **沒有頁籤**，版面與現在相同
7. 深色模式下頁籤文字與底線可讀

- [ ] **Step 7: Commit**

```bash
git add app/public/js/views/projects.js app/public/js/views/kickoff-report.js app/public/css/app.css
git commit -m "$(cat <<'EOF'
[projects,css]: 七個區塊垂直堆疊,講「下一步」的那塊還夾在第四個位置

詳細頁要一路捲到底才知道自己走到哪,而唯一會指出下一步的流程進度列
反而埋在中間。改成五個頁籤(依承辦流程),進度列移到頁籤上方常駐。

刻意採「一次全建、切換只改 display」而非惰性建構:開工報告表解析後會
直接改寫監造報表基本資料的工期/開工日,惰性會讓那些 DOM 還不存在時
就被寫入;切回去若重建,未儲存的編輯也會被清掉。

配套解決分頁後的靜默改動:解析改到「基本資料」頁籤的欄位時,當場說明
改了什麼,並在該頁籤標籤點一個小圓點,看過即消。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 列表頁四顆流程按鈕 + 狀態標記

**Files:**
- Modify: `app/public/js/views/projects.js`（`renderList`，第 747-801 行附近）
- Modify: `app/public/css/app.css`（狀態標記與下拉選單樣式）

**Interfaces:**
- Consumes: Task 1 的 `has_kickoff` / `has_budget` / `contract_items` / `log_days`；Task 2 的 `modalDialog`；Task 3 的 `KickoffReport.card`；既有的 `ContractItems.card` / `DailyLogs.card`
- Produces: 無（終端功能）

- [ ] **Step 1: 加樣式**

在 `app/public/css/app.css` 檔案**最末**加入：

```css
/* 列表頁的流程按鈕。✓ 已完成、● 下一步、灰底 disabled = 前置未完成。 */
.flow-btns { display: flex; gap: 4px; align-items: center; }
.flow-btns .btn { padding: 4px 9px; font-size: var(--fs-sm); }
.flow-btns .btn.done { color: var(--success); border-color: var(--success); }
.flow-btns .btn:disabled { opacity: 0.45; cursor: not-allowed; }
/* 「更多」下拉。position:relative 掛在按鈕的容器上,選單絕對定位於其下。 */
.more-wrap { position: relative; display: inline-block; }
.more-menu { position: absolute; right: 0; top: 100%; z-index: var(--z-modal);
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: var(--shadow-lg); min-width: 96px; padding: 4px; }
.more-menu button { display: block; width: 100%; text-align: left; padding: 6px 10px;
  background: none; border: none; color: var(--text); font-size: var(--fs-base);
  cursor: pointer; border-radius: var(--radius-sm); }
.more-menu button:hover { background: var(--bg); }
.more-menu button.danger { color: var(--danger); }
```

- [ ] **Step 2: 加流程按鈕與彈窗開啟邏輯**

在 `app/public/js/views/projects.js` 的 `renderList` 內、`async function load() {` 之**前**，加入：

```js
    // 流程關卡。判定與 WorkflowStatus.bar 同一套語意(附件種類、契約項目數、
    // 日誌天數),不重寫一份規則——真正的把關仍在各自的後端路由。
    // 「前置未完成」的按鈕 disabled:按了也只會被後端擋下,不如先講清楚缺什麼。
    function flowSteps(p) {
      return [
        { key: 'kickoff', 名: '開工表', 好: !!p.has_kickoff, 缺: '需先建立工程(上傳決標公告)' },
        { key: 'items', 名: '價目表', 好: (p.contract_items || 0) > 0, 缺: '需先有決標金額,再上傳發包經費總表' },
        { key: 'logs', 名: '日誌', 好: (p.log_days || 0) > 0, 缺: '需先建立契約詳細價目表與開工日期' },
        { key: 'submit', 名: '繳交', 好: false, 缺: '需先寫入施工日誌' },
      ];
    }

    // 開對應彈窗。四種都在彈窗內走完整流程,故一律 wide;完成後重載列表
    // 讓狀態標記更新(純關閉不重載——什麼都沒做就不必打 API)。
    function openFlow(p, key) {
      if (key === 'submit') { generate(p, null); return; }
      const title = { kickoff: '開工報告表', items: '契約詳細價目表', logs: '施工日誌' }[key];
      let changed = false;
      const done = () => { changed = true; };
      const content = key === 'kickoff'
        ? KickoffReport.card(p.id, { onArchived: done })
        : (key === 'items' ? ContractItems.card(p.id) : DailyLogs.card(p.id));
      const dlg = modalDialog({ title: `${title}—${p.name}`, content, wide: true });
      const close = el('div', { class: 'modal-actions' }, [
        el('button', {
          class: 'btn btn-outline',
          onClick: () => { dlg.close(); if (changed) load(); },
        }, '關閉'),
      ]);
      content.appendChild(close);
    }
```

**注意：** `ContractItems.card` 與 `DailyLogs.card` 沒有 `onArchived` 這種 callback（它們不在本次改動範圍）。因此價目表與日誌的彈窗關閉後**一律重載列表**——多一次 API 呼叫，換取狀態一定正確。把上面的 `onClick` 改為：

```js
          onClick: () => { dlg.close(); if (changed || key !== 'kickoff') load(); },
```

- [ ] **Step 3: 改寫列的操作欄**

把 `app/public/js/views/projects.js` 第 788-797 行的 `const tr = el('tr', {}, [ … ]);` 整段替換成：

```js
        const steps = flowSteps(p);
        // 第一個未完成的關卡就是「下一步」;它之前若還有未完成的,後面按了
        // 也只會被後端擋下,故 disabled 並在 title 說明缺什麼。
        const next = steps.find((s) => !s.好);
        const flowCell = el('div', { class: 'flow-btns' }, steps.map((s, i) => {
          const 前置未完成 = steps.slice(0, i).some((x) => !x.好);
          const btn = el('button', {
            class: 'btn' + (s.好 ? ' btn-outline done' : (s === next ? ' btn-primary' : ' btn-outline')),
            type: 'button',
            title: 前置未完成 ? s.缺 : '',
            onClick: () => openFlow(p, s.key),
          }, (s.好 ? '✓' : (s === next ? '●' : '')) + s.名);
          if (前置未完成) btn.disabled = true;
          return btn;
        }));

        // 歷史/詳細/刪除收進「⋮」:一列已經有四顆流程按鈕,七顆並排會擠爆。
        const menu = el('div', { class: 'more-menu', style: 'display:none' }, [
          el('button', { type: 'button', onClick: () => { menu.style.display = 'none'; toggleHistory(p, panelRow); } }, '歷史'),
          el('button', { type: 'button', onClick: () => { window.location.hash = '/projects/' + p.id; } }, '詳細'),
          el('button', { class: 'danger', type: 'button', onClick: () => { menu.style.display = 'none'; remove(p); } }, '刪除'),
        ]);
        const moreBtn = el('button', { class: 'btn btn-outline', type: 'button' }, '⋮');
        moreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const open = menu.style.display !== 'none';
          // 先關掉別列已開的選單,否則會同時開好幾個
          document.querySelectorAll('.more-menu').forEach((m) => { m.style.display = 'none'; });
          menu.style.display = open ? 'none' : '';
        });

        const tr = el('tr', {}, [
          el('td', {}, p.project_no || '—'),
          el('td', {}, p.name),
          el('td', {}, feeText),
          el('td', { class: 'actions' }, [
            flowCell,
          ]),
          el('td', { class: 'actions' }, [
            el('div', { class: 'more-wrap' }, [moreBtn, menu]),
          ]),
        ]);
```

- [ ] **Step 4: 表頭改成五欄**

把第 758-763 行的 `thead` 替換成：

```js
        el('thead', {}, [el('tr', {}, [
          el('th', { style: 'width:110px' }, '編號'),
          el('th', {}, '名稱'),
          el('th', { style: 'width:140px' }, '設計費'),
          el('th', { style: 'width:300px' }, '流程'),
          el('th', { style: 'width:50px' }, '')
        ])]),
```

並把第 778 行「沒有資料」那列的 `colspan: '4'` 改成 `colspan: '5'`，以及第 786 行 `panelCell` 的 `colspan: '4'` 改成 `colspan: '5'`。

- [ ] **Step 5: 點空白處關閉下拉選單**

在 `renderList` 的 `load();`（函式最末那一行）之**前**加入：

```js
    // 點畫面任何其他地方就收起下拉。掛在 content 上而非 document:
    // 這個 view 被換掉時節點一起消失,不會留下孤兒監聽器。
    content.addEventListener('click', () => {
      document.querySelectorAll('.more-menu').forEach((m) => { m.style.display = 'none'; });
    });
```

- [ ] **Step 6: `generate` 容許 `cell` 為 null**

`openFlow` 的 `submit` 分支傳了 `null` 當 `cell`。把 `generate` 函式（第 860 行附近）結尾的

```js
        await renderHistory(p, cell);
```

改成

```js
        if (cell) await renderHistory(p, cell);
        else load();
```

- [ ] **Step 7: 語法檢查**

```bash
cd app && node --check public/js/views/projects.js
```

Expected: 無輸出。

- [ ] **Step 8: 手動驗證**

1. 工程列表每列有四顆流程按鈕 + `⋮`
2. 已上傳開工報告表的工程 → 「開工表」按鈕帶 ✓ 且為綠框
3. 第一個未完成的關卡 → 主色按鈕帶 ●
4. 前置未完成的按鈕 → 灰、不能點、hover 顯示缺什麼
5. 點「開工表」→ 彈窗開啟、可上傳解析、**彈窗內自帶「契約工期/開工日期」兩欄**
6. 彈窗內歸檔成功 → 關閉後該列「開工表」變 ✓
7. 點「價目表」「日誌」→ 各自的彈窗正常運作
8. 點「繳交」→ 登錄繳交彈窗
9. `⋮` → 歷史／詳細／刪除都正常；點別處選單收起；點另一列的 `⋮` 不會同時開兩個
10. 搜尋後狀態標記仍在（Task 1 的搜尋分支）
11. 深色模式下按鈕與下拉選單可讀

- [ ] **Step 9: 跑全套**

```bash
cd app && SP0_SKIP_EXCEL=1 npx jest --runInBand --silent --noStackTrace --no-color
```

Expected: 0 紅、6 skipped。

- [ ] **Step 10: Commit**

```bash
git add app/public/js/views/projects.js app/public/css/app.css
git commit -m "$(cat <<'EOF'
[projects,css]: 交一份檔案也得先進詳細頁,而列表看不出哪個工程缺什麼

列表每列只有歷史/編輯/刪除。承辦人多數時候只是要交一份文件,卻得先進
詳細頁、捲到對的區塊。

每列改放四顆流程按鈕(開工表/價目表/日誌/繳交),點了開彈窗就地走完;
歷史/詳細/刪除收進「⋮」,否則七顆並排會擠爆。按鈕帶 ✓/● 標記,判定沿用
WorkflowStatus 同一套語意,前置未完成者 disabled 並在 title 講清楚缺什麼
——按了也只會被後端擋下,不如先說。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 端對端驗證與收尾

**Files:**
- Modify: `app/tests/project.test.js`（若驗證發現缺口）
- Modify: `.claude/CLAUDE.md`（若測試基線有變）

**Interfaces:**
- Consumes: Task 1–5 的全部成果
- Produces: 一份誠實的驗證報告

**這一步不可省略。** Task 2–5 全落在沒有自動測試的區域，這是唯一的驗證。

- [ ] **Step 1: 跑完整測試（含 Excel 整合測）**

```bash
cd app && npx jest --runInBand --silent --noStackTrace --no-color
```

Expected: 0 skipped。唯一可接受的紅是 `tests/template-engine.integration.test.js`（Excel COM 間歇失敗，flaky）。**若它紅了先重跑一次確認是否換一支紅**；換了就是 flaky，不要追。

- [ ] **Step 2: 逐項實跑 spec §7 的八項清單**

依序驗證並記錄結果（PASS／FAIL + 實際觀察）：

1. 五個頁籤都能切換，切換後未儲存的編輯不消失
2. 開工報告表解析後，切到「基本資料」頁籤，契約工期與開工日確實是新值
3. 工作天案例：用 `docs/samples/開工報告表/明禮國小廁所開工報告書.pdf`，確認 `工期I` 仍留空、警示文字指向正確位置（詳細頁說「至『基本資料』頁籤」；彈窗說「填入下方欄位」）
4. 四個彈窗都能從頭走完流程並正確關閉
5. 彈窗歸檔後，列表該列的狀態標記有更新
6. 前置未完成的按鈕為 disabled 且 hover 有說明
7. 深色模式下頁籤與彈窗的文字可讀（不是白字白底）
8. 新增工程頁不套頁籤，流程與現在相同

- [ ] **Step 3: 如實回報**

把每一項的結果寫出來。**任何一項 FAIL 就停下修正，不要標記為完成**（CLAUDE.md Rule 12：「Completed」是錯的，如果有任何東西被靜默跳過）。

- [ ] **Step 4: 若測試基線改變則更新 CLAUDE.md**

Task 1 新增了 4 個測試。`.claude/CLAUDE.md` §6 刻意**不記確切通過數**（會隨 commit 過期），所以通常不用改。只有在「預期紅/skipped 的清單」有變時才更新該節。

- [ ] **Step 5: Commit（僅在有修正時）**

```bash
git add -A
git commit -m "$(cat <<'EOF'
[projects]: 端對端驗證發現的修正

<實際修正內容>

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage：**

| Spec 節 | 實作於 |
|---|---|
| §1 五個頁籤、全建、網址同步、isNew 不套 | Task 4 |
| §2 `kickoff-report.js`、`modalDialog`、index.html | Task 2、Task 3 |
| §3 列表四顆按鈕、狀態標記、`⋮` | Task 5 |
| §4 後端四個聚合欄位、不 N+1、pg-mem 子查詢 | Task 1 |
| §5 跨頁籤同步提示、小圓點、工作天文案 | Task 3（提示）、Task 4（小圓點） |
| §6 錯誤處理（彈窗內顯示、失敗不關閉、配色變數） | Task 2、Task 3、Global Constraints |
| §7 後端測試、前端八項手動驗證、不引入 jsdom | Task 1、Task 6 |
| §8 不做的事 | Global Constraints |

**Type consistency：** `KickoffReport.card(projectId, opts)` 的 `opts` 在 Task 3 定義為 `{durationInput, startDateInput, onArchived}`，Task 4 追加 `onSynced`（該步驟已明示要回頭補進 `kickoff-report.js`）。Task 5 只用 `{onArchived}`。四個後端欄位名 `has_kickoff` / `has_budget` / `contract_items` / `log_days` 在 Task 1 定義、Task 5 使用，一致。

**已知取捨（實作時不要當成 bug 修）：**

- 價目表與日誌的彈窗關閉一律重載列表（那兩個元件沒有完成 callback，且不在本次改動範圍）。多一次 API 呼叫換狀態一定正確。
