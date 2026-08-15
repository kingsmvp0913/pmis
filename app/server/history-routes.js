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
 *   GET    /api/submissions/:id/download/:kind    下載 daily_log / official_doc
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
const { getSettlementDay, getFirmDefaults } = require('./settings');
const registry = require('./parsers/registry');
const { fillTemplate, toIsoDate, toRocDate, buildLogDescription } = require('./official-doc');

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

// report 已於本次退役:submission_history.report_path 自 2026-08-05 起就沒有任何寫入端,
// 留著只是讓那顆下載鈕必定回 409。監造報表是**工程層**的常駐 .xlsm(非單期產物),
// 下載走 GET /api/projects/:id/report/download。DB 欄位保留(db.js 只有 CREATE TABLE
// IF NOT EXISTS、無 ALTER 機制,拿掉只會讓新舊 DB 分岔),現存值全是 NULL。
const KIND_COLUMN = {
  daily_log: 'daily_log_path',
  official_doc: 'official_doc_path',
};

// 兩位數補零過的日期字串 → YYYY-MM(取月份)。填報日期形如 2026-04-08。
function periodOfDate(iso) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(iso || ''));
  return m ? `${m[1]}-${m[2]}` : null;
}

// 舊的「上傳施工日誌即自動產監造報表」已退役(2026-08-05)。那條路線從零手刻 xlsx、
// **完全不跑 SP3 的 42 條驗證**,也沒有 SP2 的契約基準,與新路線並存時承辦人從畫面上
// 看不出兩顆按鈕的差別,按錯就產出一份沒驗證過的報表。監造報表一律走
// daily-log-routes(驗證後寫入常駐 .xlsm);本檔只負責繳交紀錄本身。

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
      // 這裡只登錄「這一期繳了施工日誌」。要產監造報表請走工程頁的施工日誌區塊,
      // 那條路徑會跑 42 條驗證並寫進常駐 .xlsm(見本檔上方的退役說明)。
      res.status(201).json(record);
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

  // 產我方公文。文號一律人工輸入(事務所收發文簿可能與非本系統的案子共用流水,
  // 系統編不出來);廠商公文不解析(三家三種字號格式),只收文號與日期。
  app.post('/api/submissions/:id/official-doc', verifyToken, async (req, res) => {
    try {
      const ourNo = String(req.body.our_doc_no || '').trim();
      const vendorNo = String(req.body.vendor_doc_no || '').trim();
      const ourDate = toIsoDate(req.body.our_doc_date);
      const vendorDate = toIsoDate(req.body.vendor_doc_date);
      const copies = String(req.body.copies || '').trim() || '乙';
      const missing = [];
      if (!ourNo) missing.push('我方文號');
      if (!ourDate) missing.push('我方發文日期');
      if (!vendorNo) missing.push('廠商文號');
      if (!vendorDate) missing.push('廠商公文日期');
      // toIsoDate 對不合法字串(如 'abc')會原樣截斷回傳,truthy 但非日期,
      // 沒有這道檢查會讓後面 ourDate < vendorDate 變成字串比大小、發文日期整格空白仍回 200。
      const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
      if (ourDate && !DATE_RE.test(ourDate)) missing.push('我方發文日期格式不合法');
      if (vendorDate && !DATE_RE.test(vendorDate)) missing.push('廠商公文日期格式不合法');
      if (missing.length) {
        return res.status(400).json({ error: '缺必填欄位', fields: missing });
      }
      // 我方發文日期不得早於廠商公文日期(相等放行——樣本三份皆同日)。
      if (ourDate < vendorDate) {
        return res.status(400).json({
          error: `我方發文日期(${ourDate})不得早於廠商公文日期(${vendorDate})`,
          fields: ['我方發文日期'],
        });
      }

      const { rows: subRows } = await query(
        'SELECT * FROM submission_history WHERE id = $1', [req.params.id]);
      const sub = subRows[0];
      if (!sub) return res.status(404).json({ error: '紀錄不存在' });
      if (!sub.period) return res.status(400).json({ error: '此紀錄沒有繳交週期,無法產公文' });

      const { rows: projRows } = await query(
        `SELECT p.*, s.name AS school_name, v.name AS vendor_name
         FROM projects p
         LEFT JOIN schools s ON s.id = p.school_id
         LEFT JOIN vendors v ON v.id = p.vendor_id
         WHERE p.id = $1`, [sub.project_id]);
      const proj = projRows[0];
      if (!proj) return res.status(404).json({ error: '工程不存在' });

      // 公文正文寫的是「檢送施工日誌」,該期沒有日誌卻發文等於發出一份不實的函。
      // 用日期區間而非 to_char(log_date,'YYYY-MM'):測試用的 pg-mem 不支援 to_char
      // (同理見 project-routes.js 對 COUNT(DISTINCT …) 的迴避)。
      const pm = /^(\d{4})-(\d{2})$/.exec(sub.period);
      if (!pm) return res.status(400).json({ error: `週期格式不合法:${sub.period}` });
      const periodStart = `${pm[1]}-${pm[2]}-01`;
      const nextMo = Number(pm[2]) === 12 ? 1 : Number(pm[2]) + 1;
      const nextYear = Number(pm[2]) === 12 ? Number(pm[1]) + 1 : Number(pm[1]);
      const periodEnd = `${nextYear}-${String(nextMo).padStart(2, '0')}-01`;
      const { rows: logRows } = await query(
        `SELECT COUNT(*)::int AS n FROM daily_records
         WHERE project_id = $1 AND log_date >= $2 AND log_date < $3`,
        [sub.project_id, periodStart, periodEnd]);
      if (!logRows[0] || logRows[0].n === 0) {
        return res.status(400).json({ error: `${sub.period} 這期沒有任何施工日誌,不產公文` });
      }

      // 專案層有值用專案層,空則吊 settings 預設(同 project-basics-routes.js 的既有慣例)。
      // 建立工程時 supervisor_firm 不會自動寫入,只靠承辦人另外進基本資料頁存檔才有值,
      // 沒有這道 fallback 剛建好的工程產公文會信頭全空、firms 也必然查無。
      const firmDefaults = await getFirmDefaults();
      const supervisorFirmName = proj.supervisor_firm || firmDefaults.supervisor_firm || '';
      const { rows: firmRows } = await query(
        'SELECT * FROM firms WHERE name = $1', [supervisorFirmName]);
      const firm = firmRows[0];
      if (!supervisorFirmName || !firm) {
        return res.status(400).json({
          error: '監造單位尚未設定,請先於工程基本資料或系統設定中指定監造單位,否則公文信頭無法產出',
          fields: ['監造單位'],
        });
      }

      const values = {
        發文單位: supervisorFirmName,
        發文地址: firm.address || '',
        電話: firm.phone || '',
        傳真: firm.fax || '',
        聯絡人: firm.contact || '',
        電子信箱: firm.email || '',
        受文者: proj.school_name || '',
        發文日期: toRocDate(ourDate),
        發文字號: ourNo,
        工程名稱: proj.name || '',
        日誌描述: buildLogDescription(sub.period, proj.start_date, proj.actual_completion_date),
        份數: copies,
        廠商名稱: proj.vendor_name || '',
        廠商公文日期: toRocDate(vendorDate),
        廠商文號: vendorNo,
      };

      const buffer = await fillTemplate(values);
      const dir = path.join(OUTPUT_DIR, `proj_${sub.project_id}`);
      fs.mkdirSync(dir, { recursive: true });
      // 檔名帶紀錄 id:submission_history 沒有 (project_id, period) 唯一約束,同一期
      // 兩列各自產公文若同名會互相覆蓋(重下載會拿到另一列的文號,或刪一列牽連另一列)。
      const abs = path.join(dir, `${sub.period}_公文_${sub.id}.docx`);
      fs.writeFileSync(abs, buffer);

      // 一期一份公文,重產直接覆蓋;欄位值一併更新,下次開彈窗才帶得出上次填的值。
      await query(
        `UPDATE submission_history
         SET official_doc_path = $1, our_doc_no = $2, our_doc_date = $3,
             vendor_doc_no = $4, vendor_doc_date = $5, copies = $6
         WHERE id = $7`,
        [relToData(abs), ourNo, ourDate, vendorNo, vendorDate, copies, req.params.id]);

      res.json({ ok: true, path: relToData(abs) });
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

      // 公文:有檔才給,沒值才 409。
      if (kind === 'official_doc' && !rows[0][col]) {
        return res.status(409).json({ error: '公文尚未產出' });
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

      for (const col of ['daily_log_path', 'official_doc_path']) {
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
  relToData,
  DATA_DIR,
  UPLOAD_DIR,
  OUTPUT_DIR,
};
