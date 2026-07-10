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
 *   該週期有 monthly 紀錄 = 已繳(綠);已過 deadline 仍無 = 未繳(紅);未到期 = 中性。
 *   deadline = 該週期年月的 settlement_day 日。督導(supervision)不影響每月週期綠/紅。
 */
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { getSettlementDay } = require('./settings');

// 資料根:相對本檔求出(app/server → repo/data),禁止寫死絕對路徑。
// 測試可用 PMIS_DATA_DIR 覆寫,避免污染真 data/。
const DATA_DIR = process.env.PMIS_DATA_DIR
  ? path.resolve(process.env.PMIS_DATA_DIR)
  : path.resolve(__dirname, '../../data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

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
      // 逾期判定:now 已過該週期 deadline(當日結束)仍無 monthly 紀錄 = 未繳(紅)
      const dl = new Date(`${deadline}T23:59:59`);
      status = now > dl ? 'overdue' : 'pending';
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
    const dir = path.join(UPLOAD_DIR, `proj_${req.params.id}`);
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

const KIND_COLUMN = {
  daily_log: 'daily_log_path',
  report: 'report_path',
  official_doc: 'official_doc_path',
};

function registerRoutes(app) {
  // 上傳施工日誌 → 建立 submission_history(督導額外多插一筆)
  app.post('/api/projects/:id/submissions', verifyToken, upload.single('daily_log'), async (req, res) => {
    try {
      const projectId = req.params.id;
      const { rows: proj } = await query('SELECT id FROM projects WHERE id = $1', [projectId]);
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
      res.status(201).json(rows[0]);
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

      if (kind === 'report' || kind === 'official_doc') {
        return res.status(409).json({ error: '監造報表/公文尚未產出(待範本)' });
      }

      const rel = rows[0][col];
      if (!rel) return res.status(404).json({ error: '檔案不存在' });
      const abs = path.join(DATA_DIR, rel);
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
        const abs = path.join(DATA_DIR, rel);
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
  DATA_DIR,
  UPLOAD_DIR,
};
