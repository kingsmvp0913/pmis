/**
 * project-routes.js — 工程主檔 + 規劃設計費計算
 *
 * Exports:
 *   registerRoutes(app) — 掛載所有工程路由(全走 verifyToken)
 *   computeDesignFeeActual(project) — 設計費計算(可獨立測試)
 *
 * 路由:
 *   GET    /api/projects        list(?q= 依工程名稱/編號搜尋)
 *   GET    /api/projects/:id    單筆(含 design_fee_actual)
 *   POST   /api/projects        建立
 *   PUT    /api/projects/:id    更新
 *   DELETE /api/projects/:id    刪除
 *
 * 設計費規則(design):
 *   lump_sum → 實際金額 = design_fee_amount
 *   pct      → 實際金額 = award_amount × design_fee_pct / 100(四捨五入到整數,half-up)
 *              award_amount 為空(未招標)→ 回 null 並標記 unbid=true
 */
const fs = require('fs');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const multer = require('multer');
const { saveAttachment } = require('./project-attachments-routes');
const { workbookPath } = require('./report-workbook');

// 決標公告先進記憶體:落檔目錄需要 project id,而 id 要 INSERT 之後才有。
const upload = multer({ storage: multer.memoryStorage() });

// 走決標公告路徑時的必填集合(spec §4.5)。手動新增仍只要求 name——
// 提高手動路徑的門檻會擋住沒有決標公告的舊案補登。
const AWARD_REQUIRED = ['project_no', 'name', 'award_amount', 'school_id', 'vendor_id'];

// 未填的判定:null/undefined/空字串/純空白/非純量一律視同未填(spec §4.5)。
// 「停在找不到廠商的狀態就送出」在 body 裡表現為 vendor_id 空字串,必須擋下。
// 陣列要另外擋:multipart 同名欄位重複出現時 body[k] 會是陣列,String(['a','b'])
// 得到 'a,b' 就這樣穿透必填檢查,再被當成單一值寫進 DB。
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

// 依工程資料算出實際設計費;回傳 { design_fee_actual, unbid }
function computeDesignFeeActual(p) {
  const type = p.design_fee_type;
  if (type === 'lump_sum') {
    const amount = p.design_fee_amount;
    return { design_fee_actual: amount == null ? null : Number(amount), unbid: false };
  }
  if (type === 'pct') {
    const award = p.award_amount;
    const pct = p.design_fee_pct;
    if (award == null || award === '') {
      // 決標金額未填 = 未招標,無法計算
      return { design_fee_actual: null, unbid: true };
    }
    if (pct == null) return { design_fee_actual: null, unbid: false };
    const actual = roundHalfUp(Number(award) * Number(pct) / 100);
    return { design_fee_actual: actual, unbid: false };
  }
  return { design_fee_actual: null, unbid: false };
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

function withComputed(row) {
  const fee = computeDesignFeeActual(row);
  return {
    ...row,
    design_fee_actual: fee.design_fee_actual,
    design_fee_unbid: fee.unbid,
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
  const empty = { has_kickoff: false, has_budget: false, contract_items: 0, log_days: 0 };
  return rows.map((r) => ({ ...withComputed(r), ...(flags.get(r.id) || empty) }));
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
          ORDER BY p.start_date DESC NULLS LAST, p.id DESC`
      );
      const list = rows
        .map((r) => ({ ...r, status: deriveStatus(r) }))
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
      if (q) {
        ({ rows } = await query(
          `SELECT * FROM projects WHERE name ILIKE $1 OR project_no ILIKE $1 ORDER BY id DESC`,
          [`%${q}%`]
        ));
      } else {
        ({ rows } = await query('SELECT * FROM projects ORDER BY id DESC'));
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
      res.json(withComputed(rows[0]));
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
      const cols = COLUMNS.join(', ');
      const params = COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
      const { rows } = await query(
        `INSERT INTO projects (${cols}) VALUES (${params}) RETURNING *`,
        COLUMNS.map((c) => data[c])
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
      res.json(withComputed(rows[0]));
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
}

module.exports = { registerRoutes, computeDesignFeeActual, roundHalfUp };
