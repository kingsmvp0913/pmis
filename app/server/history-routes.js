/**
 * history-routes.js — 工程歷史檔案 / 繳交狀態 / 上傳 / 下載 / 刪除
 *
 * Exports:
 *   registerRoutes(app)                          — 掛載歷史路由(全走 verifyToken)
 *   computeDeadline(period, settlementDay)       — 依結算日算出某週期截止日(可獨立測試)
 *   buildSubmissionStatus(opts)                  — 產生每月繳交狀態清單(可獨立測試)
 *   DATA_DIR / UPLOAD_DIR                         — 資料根(相對本檔求出,不寫死絕對路徑)
 *
 * 路由:
 *   POST   /api/projects/:id/submissions          multipart 上傳施工日誌,建立 submission_history
 *   GET    /api/projects/:id/history              繳交狀態清單 + 所有紀錄
 *   GET    /api/submissions/:id/download/:kind    下載 daily_log / report / official_doc
 *   DELETE /api/submissions/:id                   刪紀錄並連同實體檔一起刪
 *
 * 繳交狀態邏輯(§5.2):
 *   自工程 start_date(無則 created_at)當月起到當前月,每月一「應繳週期」。
 *   該週期有 monthly 紀錄 = 已繳(綠);結算日凌晨(台灣 GMT+8 當日 00:00)起仍無 = 未繳(紅);之前 = 中性。
 *   deadline = 該週期年月的 settlement_day 日。督導(supervision)不影響每月週期綠/紅。
 */
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { getSettlementDay } = require('./settings');
const registry = require('./parsers/registry');
const { buildMonthlyReport } = require('./report');

// 資料根:相對本檔求出(app/server → repo/data),禁止寫死絕對路徑。
// 測試可用 PMIS_DATA_DIR 覆寫,避免污染真 data/。
const DATA_DIR = process.env.PMIS_DATA_DIR
  ? path.resolve(process.env.PMIS_DATA_DIR)
  : path.resolve(__dirname, '../../data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUTPUT_DIR = path.join(DATA_DIR, 'output');

// 兩位數補零
function pad2(n) { return String(n).padStart(2, '0'); }

// 以 period(YYYY-MM)+ 結算日算出截止日字串 YYYY-MM-DD
function computeDeadline(period, settlementDay) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!m) return null;
  const day = Math.min(Math.max(parseInt(settlementDay, 10) || 1, 1), 28);
  return `${m[1]}-${m[2]}-${pad2(day)}`;
}

// 將 Date 轉為當地 YYYY-MM
function ymOf(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

/**
 * 產生每月繳交狀態清單。
 *
 * @param {object}   opts
 * @param {string}   opts.startYm       起始週期(YYYY-MM),取自工程 start_date 或 created_at 的當月
 * @param {string}   opts.nowYm         當前週期(YYYY-MM)
 * @param {number}   opts.settlementDay 結算日
 * @param {Date}     opts.now           當前時間(判定是否逾期)
 * @param {string[]} opts.submittedMonthly 已有 monthly 紀錄的 period 集合(陣列)
 * @returns {Array<{ period, deadline, status }>} status ∈ 'submitted'|'overdue'|'pending'
 */
function buildSubmissionStatus(opts) {
  const { startYm, nowYm, settlementDay, now, submittedMonthly } = opts;
  const submitted = new Set(submittedMonthly || []);
  const list = [];

  const sm = /^(\d{4})-(\d{2})$/.exec(startYm);
  const nm = /^(\d{4})-(\d{2})$/.exec(nowYm);
  if (!sm || !nm) return list;

  let y = parseInt(sm[1], 10);
  let mo = parseInt(sm[2], 10);
  const endY = parseInt(nm[1], 10);
  const endMo = parseInt(nm[2], 10);

  // 防呆:起始晚於當前則不產生任何週期
  let guard = 0;
  while ((y < endY || (y === endY && mo <= endMo)) && guard < 1200) {
    guard++;
    const period = `${y}-${pad2(mo)}`;
    const deadline = computeDeadline(period, settlementDay);
    let status;
    if (submitted.has(period)) {
      status = 'submitted';
    } else {
      // 逾期判定(台灣時區 GMT+8):結算日「凌晨 00:00」一到,仍無 monthly 紀錄即算未繳(紅)。
      // deadline 語意為「須於當日前繳」,故當日 00:00 起即逾期。顯式帶 +08:00,不吃伺服器時區。
      const dl = new Date(`${deadline}T00:00:00+08:00`);
      status = now >= dl ? 'overdue' : 'pending';
    }
    list.push({ period, deadline, status });
    mo++;
    if (mo > 12) { mo = 1; y++; }
  }
  return list;
}

// multer:存 data/uploads/proj_<id>/,檔名 <時間戳>_<原名>(防碰撞)
const storage = multer.diskStorage({
  destination(req, file, cb) {
    // 防 Path Traversal:工程 id 一律為數字,拒絕含路徑字元的值
    const id = String(req.params.id);
    if (!/^\d+$/.test(id)) return cb(new Error('工程 id 不合法'));
    const dir = path.join(UPLOAD_DIR, `proj_${id}`);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    // multer 對非 latin1 檔名可能亂碼;統一以時間戳前綴避免碰撞,保留原副檔名
    const orig = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const safe = orig.replace(/[\\/:*?"<>|]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});
const upload = multer({ storage });

// 相對 DATA_DIR 的 POSIX 路徑(DB 只存相對路徑)
function relToData(absPath) {
  return path.relative(DATA_DIR, absPath).split(path.sep).join('/');
}

// 將 DB 存的相對路徑解析為絕對路徑,並確保**仍在 DATA_DIR 內**(防 Path Traversal)。
// 不合法(含 ../ 逃逸、絕對路徑逃逸)回傳 null。
function safeResolve(rel) {
  if (!rel) return null;
  const abs = path.resolve(DATA_DIR, rel);
  const relCheck = path.relative(DATA_DIR, abs);
  if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) return null;
  return abs;
}

const KIND_COLUMN = {
  daily_log: 'daily_log_path',
  report: 'report_path',
  official_doc: 'official_doc_path',
};

// 兩位數補零過的日期字串 → YYYY-MM(取月份)。填報日期形如 2026-04-08。
function periodOfDate(iso) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(iso || ''));
  return m ? `${m[1]}-${m[2]}` : null;
}

// 由工程主檔列組出 report.js 期望的「工程」欄位。缺欄留空(不編造)。
function projectToReportHeader(proj) {
  const p = proj || {};
  return {
    工程名稱: p.name || '',
    工程編號: p.project_no || '',
    契約金額: p.award_amount != null ? Number(p.award_amount) : '',
    決標金額: p.award_amount != null ? Number(p.award_amount) : '',
    開工日期: p.start_date ? String(p.start_date).slice(0, 10) : '',
    契約竣工日: p.contract_completion_date ? String(p.contract_completion_date).slice(0, 10) : '',
  };
}

/**
 * 上傳後嘗試產生監造報表。deterministic,絕不拋出:任何錯誤都收斂成
 * { report_generated:false, reason }。成功則寫檔 + 回填 report_path。
 *
 * @param {object} opts
 * @param {object} opts.proj        工程主檔列(含 name/vendor_id/…)
 * @param {number} opts.submissionId 剛 INSERT 的 submission_history.id
 * @param {string} opts.absDailyLog 上傳施工日誌絕對路徑
 * @param {string} opts.type        'monthly' | 'supervision'
 * @param {string} opts.period      YYYY-MM
 * @returns {Promise<{ report_generated: boolean, report_path?: string, reason?: string }>}
 */
async function tryGenerateReport({ proj, submissionId, absDailyLog, type, period }) {
  // 1. 查廠商名稱。
  let vendorName = null;
  if (proj.vendor_id != null) {
    const { rows } = await query('SELECT name FROM vendors WHERE id = $1', [proj.vendor_id]);
    if (rows[0]) vendorName = rows[0].name;
  }
  if (!vendorName) {
    return { report_generated: false, reason: '此工程尚未指定廠商,無法自動產生監造報表' };
  }

  // 2. 取該廠商讀取器。
  const parser = registry.getParser(vendorName);
  if (!parser || typeof parser.parseAll !== 'function') {
    return { report_generated: false, reason: '此廠商尚未安裝讀取器,無法自動產生監造報表' };
  }

  // 3. 解析 + 產表(整段包在 try:讀取器丟錯 / 檔格式不符 → 不 500)。
  try {
    const all = await parser.parseAll(absDailyLog);
    const list = Array.isArray(all) ? all : [];

    // 依 type 過濾天數:monthly 只取填報日期屬該 period 的天;supervision 取全部。
    let days = list;
    if (type === 'monthly') {
      days = list.filter(d => periodOfDate(d && d.header && d.header.填報日期) === period);
    }
    if (days.length === 0) {
      return { report_generated: false, reason: '施工日誌解析失敗:未取得可對應的日誌天數' };
    }

    const wb = await buildMonthlyReport({ 工程: projectToReportHeader(proj), days });

    // 4. 寫檔:data/output/proj_<id>/監造報表_<period>_<type>_<時間戳>.xlsx。
    const dir = path.join(OUTPUT_DIR, `proj_${proj.id}`);
    fs.mkdirSync(dir, { recursive: true });
    const fname = `監造報表_${period}_${type}_${Date.now()}.xlsx`;
    const absOut = path.join(dir, fname);
    await wb.xlsx.writeFile(absOut);

    const relPath = relToData(absOut);
    await query('UPDATE submission_history SET report_path = $1 WHERE id = $2', [relPath, submissionId]);
    return { report_generated: true, report_path: relPath };
  } catch (err) {
    return { report_generated: false, reason: `施工日誌解析失敗:${err.message}` };
  }
}

function registerRoutes(app) {
  // 上傳施工日誌 → 建立 submission_history(督導額外多插一筆)
  app.post('/api/projects/:id/submissions', verifyToken, upload.single('daily_log'), async (req, res) => {
    try {
      const projectId = req.params.id;
      const { rows: proj } = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
      if (!proj[0]) return res.status(404).json({ error: '工程不存在' });

      const type = req.body.type === 'supervision' ? 'supervision' : 'monthly';
      const period = (req.body.period || '').trim();
      if (!/^\d{4}-\d{2}$/.test(period)) {
        return res.status(400).json({ error: '週期格式須為 YYYY-MM' });
      }
      if (!req.file) return res.status(400).json({ error: '請上傳施工日誌檔' });

      const settlementDay = await getSettlementDay();
      const deadline = computeDeadline(period, settlementDay);
      const dailyLogPath = relToData(req.file.path);

      const { rows } = await query(
        `INSERT INTO submission_history
           (project_id, period, type, daily_log_path, deadline, submitted_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING *`,
        [projectId, period, type, dailyLogPath, deadline]
      );
      const record = rows[0];

      // 紀錄已建立;接著嘗試產生監造報表(絕不因報表失敗中斷/500)。
      const gen = await tryGenerateReport({
        proj: proj[0],
        submissionId: record.id,
        absDailyLog: req.file.path,
        type,
        period,
      });
      if (gen.report_generated) record.report_path = gen.report_path;

      res.status(201).json({ ...record, ...gen });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 繳交狀態清單 + 所有紀錄
  app.get('/api/projects/:id/history', verifyToken, async (req, res) => {
    try {
      const projectId = req.params.id;
      const { rows: proj } = await query(
        'SELECT id, start_date, created_at FROM projects WHERE id = $1', [projectId]
      );
      if (!proj[0]) return res.status(404).json({ error: '工程不存在' });

      const settlementDay = await getSettlementDay();
      const { rows: records } = await query(
        'SELECT * FROM submission_history WHERE project_id = $1 ORDER BY period, id',
        [projectId]
      );

      const submittedMonthly = records
        .filter(r => r.type === 'monthly' && r.period)
        .map(r => r.period);

      const now = new Date();
      const baseDate = proj[0].start_date
        ? new Date(proj[0].start_date)
        : new Date(proj[0].created_at || now);
      const startYm = ymOf(baseDate);
      const nowYm = ymOf(now);

      const status = buildSubmissionStatus({
        startYm, nowYm, settlementDay, now, submittedMonthly,
      });

      res.json({ settlement_day: settlementDay, status, records });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 下載:daily_log 正常;report / official_doc 尚未產出 → 409
  app.get('/api/submissions/:id/download/:kind', verifyToken, async (req, res) => {
    try {
      const kind = req.params.kind;
      const col = KIND_COLUMN[kind];
      if (!col) return res.status(400).json({ error: '未知的下載類型' });

      const { rows } = await query('SELECT * FROM submission_history WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: '紀錄不存在' });

      // 公文另做(待範本):一律 409。
      if (kind === 'official_doc') {
        return res.status(409).json({ error: '公文尚未產出(待範本)' });
      }
      // 監造報表:有檔才給,沒值才 409。
      if (kind === 'report' && !rows[0][col]) {
        return res.status(409).json({ error: '監造報表尚未產生' });
      }

      const rel = rows[0][col];
      if (!rel) return res.status(404).json({ error: '檔案不存在' });
      const abs = safeResolve(rel);
      if (!abs) return res.status(400).json({ error: '檔案路徑不合法' });
      if (!fs.existsSync(abs)) return res.status(404).json({ error: '檔案已遺失' });
      res.download(abs, path.basename(abs));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 刪除紀錄:先刪實體檔(存在才刪)再刪列;任一步失敗明確回報
  app.delete('/api/submissions/:id', verifyToken, async (req, res) => {
    try {
      const { rows } = await query('SELECT * FROM submission_history WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: '紀錄不存在' });
      const rec = rows[0];

      for (const col of ['daily_log_path', 'official_doc_path', 'report_path']) {
        const rel = rec[col];
        if (!rel) continue;
        const abs = safeResolve(rel);
        if (!abs) continue; // 路徑不合法(逃逸 DATA_DIR)→ 不觸碰檔案系統
        if (fs.existsSync(abs)) {
          try {
            fs.unlinkSync(abs);
          } catch (e) {
            return res.status(500).json({ error: `刪除實體檔失敗(${col}):${e.message}` });
          }
        }
      }

      await query('DELETE FROM submission_history WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  registerRoutes,
  computeDeadline,
  buildSubmissionStatus,
  safeResolve,
  DATA_DIR,
  UPLOAD_DIR,
  OUTPUT_DIR,
};
