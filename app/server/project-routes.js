/**
 * project-routes.js — 工程主檔 + 規劃設計費計算
 *
 * Exports:
 *   registerRoutes(app) — 掛載所有工程路由(全走 verifyToken)
 *   computeDesignFeeActual(project) — 設計費計算(可獨立測試)
 *
 * 路由:
 *   GET    /api/projects        list(?q= 依工程名稱/工程編號/事務所編號搜尋)
 *   GET    /api/projects/:id    單筆(含 design_fee_actual)
 *   POST   /api/projects        建立
 *   PUT    /api/projects/:id    更新
 *   DELETE /api/projects/:id    刪除
 *
 * 設計費規則(design):
 *   lump_sum → 實際金額 = design_fee_amount
 *   pct      → 實際金額 = **建造費用** × design_fee_pct / 100(四捨五入到整數,half-up)
 *              建造費用 = 發包工程費 − 保險費 − 營業稅,由契約詳細價目表算出
 *              award_amount 為空(未招標)→ 回 null 並標記 unbid=true
 *              還沒有價目表 → 回 null 並標記 needs_items=true
 */
const fs = require('fs');
const path = require('path');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { constructionCost } = require('./contract-items');
const multer = require('multer');
const { saveAttachment } = require('./project-attachments-routes');
const { safeResolve } = require('./history-routes');
const { readAwardNotice } = require('./award-notice');
const { loadGroup } = require('./award-group');
const { workbookPath } = require('./report-workbook');
const { verifyWorkbook } = require('./report-verify');
const { scanFilledCells, saveProtected } = require('./report-protect');

// 決標公告先進記憶體:落檔目錄需要 project id,而 id 要 INSERT 之後才有。
const upload = multer({ storage: multer.memoryStorage() });
// 監造報表是 .xlsm,實測公版就 680KB,填過的更大。multer 預設無上限,
// 但這裡明確給一個:上傳一個 200MB 的檔會把整台機器的記憶體吃掉。
const reportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
let uploadSeq = 0;

// 走決標公告路徑時的必填集合(spec §4.5)。手動新增仍只要求 name——
// 提高手動路徑的門檻會擋住沒有決標公告的舊案補登。
const AWARD_REQUIRED = ['project_no', 'name', 'award_amount', 'school_id', 'vendor_id'];

// 未填的判定:null/undefined/空字串/純空白/非純量一律視同未填(spec §4.5)。
// 「停在找不到廠商的狀態就送出」在 body 裡表現為 vendor_id 空字串,必須擋下。
// 陣列要另外擋:multipart 同名欄位重複出現時 body[k] 會是陣列,String(['a','b'])
// 得到 'a,b' 就這樣穿透必填檢查,再被當成單一值寫進 DB。
// projects.id 是 SERIAL(int4):非此形狀的 :id 永遠比不到任何一列,且會讓
// PostgreSQL 丟型別錯誤被 catch 成 500,承辦人會以為系統壞了。
// 本專案已有四份同名判斷(project-attachments-routes / project-basics-routes /
// kickoff-routes / contract-items-routes)——依裁決不抽共用模組,第五份照抄保留。
const INT4_MAX = 2147483647;
function isIdShape(id) {
  return /^[1-9][0-9]*$/.test(String(id)) && Number(id) <= INT4_MAX;
}

function isBlank(v) {
  return v == null || !(typeof v === 'number' || typeof v === 'string') || String(v).trim() === '';
}

// 工程名稱是承辦人自由輸入的,直接拿來當下載檔名的話,`/` `:` 這類字元會讓
// Content-Disposition 被解成路徑或整個下載失敗。只清字元、不截斷長度。
function safeFileName(name) {
  // eslint-disable-next-line no-control-regex
  return String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim() || '監造報表';
}

// 台灣四捨五入(half-up),避免 JS Math.round 對負數/浮點誤差的偏差。
// 以字串處理小數第一位進位到整數,杜絕 IEEE754 誤差(如 0.5 邊界)。
function roundHalfUp(value) {
  if (value == null || Number.isNaN(Number(value))) return null;
  const n = Number(value);
  const neg = n < 0;
  const abs = Math.abs(n);
  // 加 0.5 後取 floor 即為 half-up;為避免浮點邊界誤差,先做微幅修正
  const rounded = Math.floor(abs + 0.5 + Number.EPSILON);
  return neg ? -rounded : rounded;
}

/**
 * 依工程資料算出實際設計費。
 *
 * ⚠️ **百分比法乘的是「建造費用」,不是決標金額**(使用者清單第 20 項):
 * 建造費用 = 發包工程費 − 保險費 − 營業稅,49 案實測穩定落在決標金額的
 * 94.6%~95.1%,用決標金額會讓設計費一律多算約 5%。
 *
 * 建造費用要有契約詳細價目表才算得出來(見 contract-items.constructionCost)。
 * 算不出來時**回 null 並標記 needs_items**,不退回用決標金額硬算——那正是原本
 * 錯的那個數,而且錯得看起來完全正常。
 *
 * @param {object} p 工程列
 * @param {number|null} [建造費用] 由契約詳細價目表算出;未給/為 null 代表算不出來
 * @returns {{design_fee_actual:number|null, unbid:boolean, needs_items:boolean}}
 */
function computeDesignFeeActual(p, 建造費用 = null) {
  const none = { design_fee_actual: null, unbid: false, needs_items: false };
  const type = p.design_fee_type;
  if (type === 'lump_sum') {
    const amount = p.design_fee_amount;
    return { ...none, design_fee_actual: amount == null ? null : Number(amount) };
  }
  if (type === 'pct') {
    const award = p.award_amount;
    const pct = p.design_fee_pct;
    if (award == null || award === '') {
      // 決標金額未填 = 未招標,無法計算
      return { ...none, unbid: true };
    }
    if (pct == null) return none;
    // 建造費用算不出來(還沒建立契約詳細價目表,或表裡認不出保險費/營業稅)
    if (建造費用 == null) return { ...none, needs_items: true };
    return { ...none, design_fee_actual: roundHalfUp(Number(建造費用) * Number(pct) / 100) };
  }
  return none;
}

const COLUMNS = [
  'project_no', 'firm_doc_no', 'name', 'vendor_id', 'school_id', 'start_date', 'duration_basis',
  'contract_completion_date', 'actual_completion_date', 'award_amount',
  'insurer_id', 'insurance_type_id', 'insurance_start', 'insurance_end',
  'design_fee_type', 'design_fee_amount', 'design_fee_pct'
];

// 把 body 欄位正規化:空字串 → null(數字/日期欄位)
function normalize(body) {
  const out = {};
  for (const col of COLUMNS) {
    let v = body[col];
    if (v === '' || v === undefined) v = null;
    out[col] = v;
  }
  return out;
}

// 今天(當地時區)的 YYYY-MM-DD。不可用 toISOString():那會轉 UTC,
// 台北時間的凌晨會倒退成前一天,開工日剛好是今天的案子就被判成「尚未施工」。
function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const asISO = (v) => {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * 工程狀態。**推導而不是存欄位**:三個日期已經決定了答案,多存一個狀態欄
 * 就會有「日期改了狀態沒改」的不一致,而那種不一致沒有人會發現。
 *
 * 竣工看的是**實際**竣工日,不是契約竣工日——後者只是預定,過了不代表完工。
 * @returns {'未開工'|'施工中'|'已竣工'}
 */
function deriveStatus(row) {
  if (asISO(row.actual_completion_date)) return '已竣工';
  const start = asISO(row.start_date);
  if (!start || start > todayISO()) return '未開工';
  return '施工中';
}

/**
 * 一個工程投保的險種 id 清單。一個工程常同時投營造綜合保險與意外責任險等數種,
 * 原本的單一 FK 只存得下一個。
 */
async function loadInsuranceTypes(projectId) {
  const { rows } = await query(
    `SELECT insurance_type_id FROM project_insurance_types
      WHERE project_id = $1 ORDER BY insurance_type_id`, [projectId]
  );
  return rows.map((r) => r.insurance_type_id);
}

/**
 * 整批取代某工程的險種(沿用 insurer-routes.replaceTypes 的作法)。
 *
 * **傳 undefined 代表「這次不動險種」,不是「清空」**:PUT 是整筆取代,
 * 而別處(如開工報告表補寫主檔)送的 body 裡本來就沒有這個欄位,
 * 一律當成清空會把承辦人選好的險種靜默清掉。
 */
async function replaceInsuranceTypes(projectId, ids) {
  if (ids === undefined) return;
  await query('DELETE FROM project_insurance_types WHERE project_id = $1', [projectId]);
  const list = Array.isArray(ids) ? ids : [];
  // 去重:前端重複送同一個 id 不該在表裡留兩列
  for (const id of [...new Set(list)]) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) continue;
    await query(
      'INSERT INTO project_insurance_types (project_id, insurance_type_id) VALUES ($1, $2)',
      [projectId, n]
    );
  }
}

// contract_items 的列 → constructionCost 吃的形狀。複價不存在 DB(權威是 .xlsm
// 的公式),由數量×單價重算,見 contract-items.constructionCost。
const asItem = (r) => ({
  項次: r.item_no, 項目: r.name, 數量: Number(r.quantity), 單價: Number(r.unit_price),
});

/** 單一工程的建造費用;沒有價目表或認不出保險費/營業稅時回 null。 */
async function loadConstructionCost(projectId) {
  const { rows } = await query(
    'SELECT item_no, name, quantity, unit_price FROM contract_items WHERE project_id = $1 ORDER BY seq',
    [projectId]
  );
  const c = constructionCost(rows.map(asItem));
  return c ? c.建造費用 : null;
}

/**
 * 全部工程的建造費用。**一次全表聚合後在 JS 分組,不得改成每列查一次**
 * ——理由同 loadWorkflowFlags(100 個工程會變成 100 次查詢)。
 */
async function loadConstructionCosts() {
  const { rows } = await query(
    'SELECT project_id, item_no, name, quantity, unit_price FROM contract_items ORDER BY project_id, seq'
  );
  const byProject = new Map();
  for (const r of rows) {
    if (!byProject.has(r.project_id)) byProject.set(r.project_id, []);
    byProject.get(r.project_id).push(asItem(r));
  }
  const out = new Map();
  for (const [id, items] of byProject) {
    const c = constructionCost(items);
    out.set(id, c ? c.建造費用 : null);
  }
  return out;
}

function withComputed(row, 建造費用 = null) {
  const fee = computeDesignFeeActual(row, 建造費用);
  return {
    ...row,
    design_fee_actual: fee.design_fee_actual,
    design_fee_unbid: fee.unbid,
    // 百分比法但還沒有契約詳細價目表 → 建造費用算不出來。畫面要講出缺什麼,
    // 不然承辦人只看到一個「—」,會以為是系統壞了。
    design_fee_needs_items: fee.needs_items,
    design_fee_base: 建造費用,
    status: deriveStatus(row),
  };
}

// 列表的流程狀態。**一律三次全表聚合後在 JS 合併,不得改成每列查一次**——
// 100 個工程會變成 300 次查詢。
//
// 施工日誌天數刻意用子查詢而非 COUNT(DISTINCT log_date):測試用的 pg-mem
// 不支援後者,而且是**靜默**算錯(同一天的多個項次被當成多天),
// 與 /workflow-status 路由的 logDays 子查詢同一個理由。
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
  // 建造費用同樣不讓失敗拖垮整個列表:退回 null,設計費那格顯示「待補價目表」,
  // 而不是顯示一個用錯基數算出來的金額。
  let costs = new Map();
  try { costs = await loadConstructionCosts(); }
  catch (err) { console.error('[projects] 讀取建造費用失敗:', err); }
  const empty = { has_kickoff: false, has_budget: false, contract_items: 0, log_days: 0 };
  return rows.map((r) => ({
    ...withComputed(r, costs.get(r.id) == null ? null : costs.get(r.id)),
    ...(flags.get(r.id) || empty),
  }));
}

function registerRoutes(app) {
  // ── 狀態總表 ──
  // 承辦人手上同時有十幾案,要的是「哪幾案還在施工、各自到哪了」這一張表,
  // 而工程列表是為了「找到某一案然後進去做事」設計的(逐案的流程關卡佔滿版面)。
  // 兩者的資訊密度需求相反,故另開一條路由而不是在列表上加欄位。
  //
  // 預設只回施工中的:那才是每天要盯的。?status=全部 可看全部。
  app.get('/api/projects/status-board', verifyToken, async (req, res) => {
    try {
      const want = (req.query.status || '施工中').trim();
      const { rows } = await query(
        `SELECT p.id, p.firm_doc_no, p.project_no, p.name,
                p.start_date, p.contract_completion_date, p.actual_completion_date,
                p.award_amount, v.name AS vendor_name, s.name AS school_name
           FROM projects p
           LEFT JOIN vendors v ON v.id = p.vendor_id
           LEFT JOIN schools s ON s.id = p.school_id
          ORDER BY p.firm_doc_no ASC NULLS LAST, p.id DESC`
      );
      // 一張決標含多個標的時,兩列在總表上看起來像兩個不相干的案子。標出
      // 「這是 N 個標的之一」——**不改排序**:依事務所編號排是承辦人指定的規則
      // (清單第 21 項),為了讓同群組相鄰而動它,是拿他要的東西換我覺得好的東西。
      // 統計要在**過濾之前**做:一個標的完工、另一個施工中時,只看得到一列,
      // 而那一列仍該顯示「2 個標的之一」——否則承辦人以為這案就這一個。
      const 群組筆數 = new Map();
      for (const r of rows) {
        const no = (r.project_no || '').trim();
        if (no) 群組筆數.set(no, (群組筆數.get(no) || 0) + 1);
      }
      const list = rows
        .map((r) => ({
          ...r,
          status: deriveStatus(r),
          同決標標的數: 群組筆數.get((r.project_no || '').trim()) || 1,
        }))
        .filter((r) => want === '全部' || r.status === want);
      res.json({ status: want, 筆數: list.length, projects: list });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects', verifyToken, async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      let rows;
      // 排序依事務所編號:承辦人平常找檔案用的就是這個編號,不是契約編號
      // (使用者清單第 19/21 項)。沒填編號的排在最後,同組再依 id 新的在前。
      const ORDER = 'ORDER BY firm_doc_no ASC NULLS LAST, id DESC';
      if (q) {
        ({ rows } = await query(
          `SELECT * FROM projects
            WHERE name ILIKE $1 OR project_no ILIKE $1 OR firm_doc_no ILIKE $1 ${ORDER}`,
          [`%${q}%`]
        ));
      } else {
        ({ rows } = await query(`SELECT * FROM projects ${ORDER}`));
      }
      res.json(await withWorkflowFlags(rows));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/projects/:id', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: '工程不存在' });
      res.json({
        ...withComputed(rows[0], await loadConstructionCost(req.params.id)),
        insurance_type_ids: await loadInsuranceTypes(req.params.id),
        // 同一張決標的其他標的 + 加總檢核(見 award-group.js)
        award_group: await loadGroup(query, rows[0].project_no),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 工程頁流程狀態列要的兩個計數。專開一支輕量端點而不是塞進 GET /projects/:id:
  // 那支是列表與編輯頁共用的,每次都多兩個 COUNT 只為了一列狀態並不划算。
  app.get('/api/projects/:id/workflow-status', verifyToken, async (req, res) => {
    try {
      const { rows: items } = await query(
        'SELECT COUNT(*)::int AS n FROM contract_items WHERE project_id = $1', [req.params.id]
      );
      // 用子查詢而非 COUNT(DISTINCT …):測試用的 pg-mem 不支援後者,會靜默把
      // 每一筆都算進去(同一天的多個項次會被當成多天)。
      const { rows: days } = await query(
        `SELECT COUNT(*)::int AS n FROM
           (SELECT DISTINCT log_date FROM daily_records WHERE project_id = $1) t`,
        [req.params.id]
      );
      res.json({ contractItems: items[0].n, logDays: days[0].n });
    } catch (err) {
      // 狀態列失敗不該讓整個工程頁進不去,回 0 讓前端照常顯示「未完成」
      console.error('[projects] 讀取流程狀態失敗:', err);
      res.json({ contractItems: 0, logDays: 0 });
    }
  });

  /**
   * 一張決標拆成多個標的時,從既有工程複製出下一個。
   *
   * ## 為什麼是「複製」而不是「一個工程對多份報表」
   *
   * 2026-08-13 已裁決維持**一標的一工程**(見 award-group.js):系統無法從日誌內容
   * 判斷標的——橋頭與許厝兩份日誌的工程名稱一模一樣、單價還共用同一套。
   * 既然標的一定要人指定,做成一對多要在 contract_items/daily_records/報表路徑
   * 三處都加一層標的維度,而操作成本並不會比較低。缺的只是「第二個工程要重打
   * 一次共同欄位」,這支就是補那個缺口。
   *
   * ## 複製什麼、不複製什麼
   *
   * 用**排除清單**而不是列舉:欄位是會長的(duration_days 就是今天才加的),
   * 列舉法會讓新欄位默默不被複製,而那種漏最難發現——畫面上兩個工程長得一樣,
   * 只有報表寫出來才看得到差別。
   *
   * - `name` 由承辦人指定(兩個標的就是靠名稱分辨)
   * - `actual_completion_date` 是各自的實際完工日,不是決標帶來的
   * - `firm_doc_no` 是事務所自己的歸檔編號,一案一號
   *
   * **決標金額照抄總額**(承辦人 2026-08-15 選的:「我上傳附件後自己拆」)。
   * 忘了拆的後果由 contract-items 那關擋:合計對不上決標金額時會擋下,
   * 而那句訊息已經會講「這張決標有 N 個標的」(見該路由的 NO_AWARD_AMOUNT 附近)。
   *
   * 明細一律**不複製**:contract_items 與 daily_records 正是兩個標的不同的地方,
   * 複製過去只會讓承辦人以為已經做過。監造報表檔同理,由 ensureWorkbook 另建。
   */
  const NOT_COPIED = new Set(['id', 'created_at', 'name', 'actual_completion_date', 'firm_doc_no']);
  const COPY_ATTACHMENT_KINDS = ['award_notice', 'kickoff_report'];

  app.post('/api/projects/:id/duplicate', verifyToken, async (req, res) => {
    try {
      if (!isIdShape(req.params.id)) return res.status(404).json({ error: '找不到工程' });
      const name = String((req.body && req.body.name) || '').trim();
      if (!name) return res.status(400).json({ error: '請輸入新工程的名稱' });

      const { rows: src } = await query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
      if (!src[0]) return res.status(404).json({ error: '找不到工程' });
      const s = src[0];
      if (String(s.name).trim() === name) {
        return res.status(400).json({ error: '新工程的名稱要與原工程不同,否則兩個標的分不出來' });
      }
      // 沿用建案的重複判準:案號 + 名稱都相同才算重複(同一案號下本來就會有多個標的)。
      // 用 `= $1` 而不是 `IS NOT DISTINCT FROM`:後者測試用的 pg-mem 不支援
      // (同 project-routes 既有的 COUNT(DISTINCT) / to_char 兩處註記)。
      // project_no 建案時是必填,實務上不會是 null;真的是 null 時這條查不到、
      // 不擋——與建案那條路的行為一致。
      const { rows: dup } = await query(
        'SELECT id, name FROM projects WHERE project_no = $1 AND name = $2',
        [s.project_no, name]
      );
      if (dup[0]) {
        return res.status(400).json({ error: `已有同案號同名的工程「${dup[0].name}」,請換一個名稱` });
      }

      const cols = Object.keys(s).filter((c) => !NOT_COPIED.has(c));
      const { rows: made } = await query(
        `INSERT INTO projects (name, ${cols.join(', ')})
         VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING *`,
        [name, ...cols.map((c) => s[c])]
      );
      const created = made[0];

      // 附件:承辦人 2026-08-15 選「都複製過去」——同一張決標、同一份開工報告表,
      // 新工程立刻可以直接做價目表,不必把同樣的檔案再傳一次、九欄再核對一次。
      // 複製失敗不 rollback 工程(沿用建案的立場:工程已建好,砍掉是更差的狀態),
      // 但要誠實回報是哪一種附件沒帶過去。
      const warnings = [];
      for (const kind of COPY_ATTACHMENT_KINDS) {
        const { rows: atts } = await query(
          `SELECT file_path, original_name FROM project_attachments
            WHERE project_id = $1 AND kind = $2 ORDER BY id DESC LIMIT 1`,
          [s.id, kind]
        );
        if (!atts[0]) continue;
        try {
          const abs = safeResolve(atts[0].file_path);
          if (!abs) throw new Error('附件路徑不合法');
          await saveAttachment({
            projectId: created.id,
            kind,
            buffer: fs.readFileSync(abs),
            originalName: atts[0].original_name || `${kind}`,
            userId: req.userId || null,
          });
        } catch (err) {
          console.error(`[projects] 複製附件 ${kind} 失敗:`, err);
          warnings.push(kind === 'award_notice' ? '決標公告' : '開工報告表');
        }
      }

      res.json({
        ok: true,
        project: withComputed(created),
        // 金額照抄的是**總額**,要當場講明白——他選的流程是自己拆,而忘了拆的話
        // 要到價目表那關才會被擋,那時訊息講的是「合計對不上」,不會提醒他這件事。
        提醒: s.award_amount != null
          ? `決標金額照抄了原工程的 ${Number(s.award_amount).toLocaleString()},請改成本標的的金額`
          : null,
        attachment_warning: warnings.length ? `${warnings.join('、')}沒有複製過去,請手動上傳` : null,
      });
    } catch (err) {
      console.error('[projects] 複製工程失敗:', err);
      res.status(500).json({ error: '複製工程失敗,請稍後重試;若持續失敗請聯絡系統管理員' });
    }
  });

  app.post('/api/projects', verifyToken, upload.single('award_notice'), async (req, res) => {
    try {
      const hasAward = !!(req.file && req.file.buffer && req.file.buffer.length);
      const body = req.body || {};

      // 建案入口只剩決標公告一條(2026-08-05 裁決)。沒有公告的工程到開工報告表
      // 那關必然被擋(比對沒有基準),先建起來只是讓承辦人白填一次再重建。
      if (!hasAward) {
        return res.status(400).json({ error: '建立工程必須上傳決標公告' });
      }

      // 一次列全,不在第一個問題就中斷——只報第一個會讓承辦人來回送好幾次。
      const fields = AWARD_REQUIRED.filter((k) => isBlank(body[k]));
      if (fields.length) {
        return res.status(400).json({ error: '以下欄位尚未填寫或尚未綁定', fields });
      }

      // 同一份決標公告傳兩次(忘記已建過、兩人同時處理)會產生兩個內容相同的
      // 工程,之後的施工日誌與監造報表分岔到兩邊,而畫面上看不出它們是同一件事。
      //
      // 但**契約編號本身不是唯一的**:實務上會出現同一個案號底下有多個工程
      // (一次決標含多個標的、或機關的編號規則就會重複)。只看案號會把合法的
      // 第二個工程擋在門外,而承辦人沒有別的路可以建。故改判「案號 + 工程名稱」
      // 都相同才算重複——名稱不同就是不同的工程,放行。
      const projectNo = String(body.project_no).trim();
      const projectName = String(body.name).trim();
      const { rows: dup } = await query(
        'SELECT id, name, project_no FROM projects WHERE project_no = $1 AND name = $2',
        [projectNo, projectName]
      );
      if (dup[0]) {
        return res.status(400).json({
          error: `契約編號 ${projectNo} 已建立同名工程「${dup[0].name}」,請勿重複建立`,
          existing: dup[0],
        });
      }

      // name 此時已通過必填檢查(非 blank),trim 前後空白後才寫入——
      // 舊版 JSON 路徑本就會 trim,拆成兩條路徑不能讓這行為悄悄漂走。
      const data = normalize({
        ...body, name: String(body.name).trim(), project_no: projectNo,
      });

      // 決標總額由**伺服器自己重新解析決標公告**取得,不吃 body:承辦人在建案表單
      // 上會把金額改成該標的的金額(一張決標多個標的時的既有作法),那個值進
      // award_amount 是對的,但拿它當決標總額就等於把加總的基準也一起改掉了。
      // 讀不到就留 null——寧可讓檢核顯示「無法檢核」,也不要拿一個錯的基準去算差額。
      let awardTotal = null;
      try {
        const parsed = await readAwardNotice(req.file.buffer);
        const v = parsed && parsed.契約金額;
        if (v != null && Number.isFinite(Number(v))) awardTotal = Number(v);
      } catch (err) {
        console.error('[projects] 建案時重新解析決標公告失敗(決標總額留空):', err.message);
      }

      const insertCols = [...COLUMNS, 'award_total'];
      const cols = insertCols.join(', ');
      const params = insertCols.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await query(
        `INSERT INTO projects (${cols}) VALUES (${params}) RETURNING *`,
        [...COLUMNS.map((c) => data[c]), awardTotal]
      );
      const project = withComputed(rows[0]);

      if (hasAward) {
        // 落檔失敗不 rollback 工程:工程本身已建立成功,砍掉是更差的狀態
        // (承辦人剛填完一整份表單)。附件可後補,故只帶 warning。
        try {
          await saveAttachment({
            projectId: rows[0].id,
            kind: 'award_notice',
            buffer: req.file.buffer,
            originalName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
            userId: req.userId || null,
          });
        } catch (err) {
          console.error('[projects] 決標公告歸檔失敗:', err);
          // 不寫「請稍後於工程頁重新上傳」:編輯模式沒有任何上傳決標公告的入口,
          // 叫承辦人去做一件做不到的事,只會讓他反覆找不到而懷疑自己。
          project.attachment_warning = '工程已建立,但決標公告歸檔失敗,請聯絡系統管理員';
        }
      }

      // 同一張決標的其他標的:建完立刻講,不要等他自己發現。少建一個標的
      // 不會有任何錯誤訊息,而每一份監造報表都會照樣產出來、金額也都合理。
      project.award_group = await loadGroup(query, projectNo);
      res.status(201).json(project);
    } catch (err) {
      console.error('[projects] 建立工程失敗:', err);
      res.status(500).json({ error: '建立工程失敗' });
    }
  });

  app.put('/api/projects/:id', verifyToken, async (req, res) => {
    try {
      const name = (req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: '工程名稱為必填' });
      const data = normalize({ ...req.body, name });
      const setClause = COLUMNS.map((c, i) => `${c} = $${i + 1}`).join(', ');
      const values = COLUMNS.map(c => data[c]);
      values.push(req.params.id);
      const { rows } = await query(
        `UPDATE projects SET ${setClause} WHERE id = $${COLUMNS.length + 1} RETURNING *`,
        values
      );
      if (!rows[0]) return res.status(404).json({ error: '工程不存在' });
      await replaceInsuranceTypes(req.params.id, req.body.insurance_type_ids);
      res.json({
        ...withComputed(rows[0], await loadConstructionCost(req.params.id)),
        insurance_type_ids: await loadInsuranceTypes(req.params.id),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/projects/:id', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('DELETE FROM projects WHERE id = $1 RETURNING id', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: '工程不存在' });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 下載該工程的常駐監造報表。掛在工程主檔路由而非 SP1/SP2/SP3 任一支:那三支都是
  // 「寫入」報表的語意,把唯一的「讀出」掛進其中一支,另外兩支就看起來少了一半。
  //
  // 走 workbookPath 而**不是** ensureWorkbook:下載不得有副作用。若按下載就由公版範本
  // 複製一份空報表出來,承辦人拿到的是空表卻以為 pipeline 跑過了——比 409 更糟。
  app.get('/api/projects/:id/report/download', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('SELECT name FROM projects WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: '工程不存在' });

      const abs = workbookPath(req.params.id);
      if (!fs.existsSync(abs)) {
        return res.status(409).json({ error: '監造報表尚未建立,請先送出工程基本資料' });
      }
      res.download(abs, `${safeFileName(rows[0].name)}_監造報表.xlsm`);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 上傳「已經做到一半的監造報表」當作這一案的常駐檔。
  //
  // 承辦人手上常有一份自己填了一部分的報表,原本只能從空白公版重做。上傳之後
  // 系統接著往下填,而**上傳當下已經有值的儲存格永遠不再被覆蓋**
  // (使用者裁決:以上傳那一刻為界,見 report-protect.js)。
  app.post('/api/projects/:id/report/upload', verifyToken,
    reportUpload.single('report'), async (req, res) => {
      let tmp = null;
      try {
        if (!req.file || !req.file.buffer || !req.file.buffer.length) {
          return res.status(400).json({ error: '請上傳監造報表 .xlsm' });
        }
        const { rows } = await query('SELECT id FROM projects WHERE id = $1', [req.params.id]);
        if (!rows[0]) return res.status(404).json({ error: '工程不存在' });

        const dest = workbookPath(req.params.id);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        // 先落暫存驗證,通過才取代本尊:驗不過時原本的報表要完好無損
        tmp = `${dest}.upload-${process.pid}-${++uploadSeq}.xlsm`;
        fs.writeFileSync(tmp, req.file.buffer);

        const v = verifyWorkbook(tmp);
        if (!v.ok) {
          return res.status(400).json({
            error: '這份報表的版面與系統預期的不一樣,沒有上傳。系統是靠固定的分頁與'
              + '欄位位置寫入的,版面不同會把資料寫進錯的格子而且看不出來。',
            problems: v.problems,
          });
        }

        // 保護清單要在**取代之前**掃:掃的就是這份上傳檔的內容
        const filled = scanFilledCells(tmp);
        fs.renameSync(tmp, dest);
        tmp = null;
        saveProtected(dest, filled);

        const 保護格數 = Object.values(filled).reduce((n, a) => n + a.length, 0);
        res.json({
          ok: true,
          保護格數,
          分頁: Object.fromEntries(Object.entries(filled).map(([k, a]) => [k, a.length])),
          warnings: v.problems,          // 只剩提醒級的
        });
      } catch (err) {
        if (/projectId 不合法/.test(err.message || '')) {
          return res.status(400).json({ error: '網址中的工程 id 不合法' });
        }
        console.error('[report] 上傳既有監造報表失敗:', err);
        res.status(500).json({ error: '上傳失敗,請稍後重試;若持續失敗請聯絡系統管理員' });
      } finally {
        if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
      }
    });
}

module.exports = { registerRoutes, computeDesignFeeActual, roundHalfUp };
