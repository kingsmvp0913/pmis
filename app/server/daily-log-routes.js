/**
 * daily-log-routes.js — 施工日誌 → 每日施工紀錄(SP3)
 *
 * 路由:
 *   POST /api/projects/:id/daily-logs/parse           上傳 → 39 條驗證 + 跨批次差異(唯讀)
 *   POST /api/projects/:id/daily-logs/confirm         無硬錯才寫入 .xlsm 並落庫
 *   POST /api/projects/:id/daily-logs/scan            掃描件 → OCR 預填(唯讀)
 *   POST /api/projects/:id/daily-logs/confirm-scanned 承辦人逐格確認後才寫入
 *
 * 檔案送兩次的理由同 SP1B/SP2:parse 落檔的話,驗證沒過時會留下一份沒人確認過的
 * 來源檔。**confirm 一律重新解析與驗證**,不吃前端送來的資料。
 *
 * ## 掃描件為什麼要另開一條路,而不是把 OCR 接成 parse 的後備
 *
 * 上面那條「不吃前端資料」的鐵則,前提是**檔案本身自動解析得出來**——重新解析
 * 一定會得到同一個答案,前端送什麼都不重要。掃描件不成立:OCR 的 dailyRows 層
 * 實測只有 62.8% 對、1.7% 讀成另一個合法數字(6 份文件 296 格,量測基座在
 * `data/parser-tools/ocr-ab/`),**必須由承辦人逐格確認**,而確認的結果只存在於
 * 前端。硬套原鐵則就等於把承辦人改的值丟掉。
 *
 * 所以 `confirm-scanned` 收前端送來的 days,但:①欄位型別逐一消毒(見 sanitizeDays)
 * ②39 條驗證照跑,不因為「人確認過」就放行 ③落庫標記 source='ocr_confirmed',
 * 事後查得出哪些數字是這條路來的。文字層那條路一行都沒動。
 *
 * 硬錯**整份擋下**(2026-08-05 裁決):一天不對就不寫。只跳過有問題的那幾天會讓
 * 報表停在「進度不完整」的狀態,而累計金額與完成百分比都是公式自算的——算出來的
 * 數字會是錯的,但看起來完全正常。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const registry = require('./parsers/registry');
const filetypes = require('./parsers/filetypes');
const { extractItemsOcr } = require('./parsers/filetypes/pdf');
const ocr = require('./ocr');
const { validateDailyLog } = require('./daily-log-validate');
const { daysToOperations, diffDays, feeItemsPlan } = require('./daily-log-write');
const { scanDays, scanCoverage } = require('./daily-log-scan');
const { ensureWorkbook } = require('./report-workbook');
const { fillTemplate } = require('./template-engine');
const { applyProtection } = require('./report-protect');
const { saveAttachment } = require('./project-attachments-routes');

const upload = multer({ storage: multer.memoryStorage() });

const INT4_MAX = 2147483647;
function isIdShape(id) {
  return /^[1-9][0-9]*$/.test(String(id)) && Number(id) <= INT4_MAX;
}

let tmpSeq = 0;
const realName = (f) => Buffer.from(f.originalname, 'latin1').toString('utf8');

/** 落暫存檔給讀取器用(讀取器吃路徑),用完必刪。 */
async function withTempFile(file, fn) {
  const name = realName(file);
  const p = path.join(os.tmpdir(),
    `sp3-${process.pid}-${++tmpSeq}${path.extname(name) || '.pdf'}`);
  fs.writeFileSync(p, file.buffer);
  try { return await fn(p); }
  finally { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } }
}

const NO_CONTRACT = '此工程尚未建立契約詳細價目表,無法核對施工日誌的項目。請先上傳發包經費總表。';
const NO_START = '此工程尚未填開工日期,無法決定每一天要寫進報表的哪一欄。請先完成工程基本資料。';

/**
 * DATE 欄位 → 'YYYY-MM-DD'。
 * 不能用 toISOString():pg 把 DATE 解析成**本地時區**午夜的 Date,轉 UTC 會讓
 * 台北時間整批日期倒退一天,而報表上只會看到進度整體平移、找不出原因。
 */
function toISODate(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 取驗證與寫入所需的三份基準:契約表、專案主檔、讀取器。
 * 缺哪一份就明講缺哪一份——回一句籠統的「無法處理」會讓承辦人不知道要去補什麼。
 */
async function loadContext(projectId) {
  const { rows: p } = await query(
    `SELECT p.*, v.name AS vendor_name FROM projects p
       LEFT JOIN vendors v ON v.id = p.vendor_id WHERE p.id = $1`, [projectId]);
  if (!p[0]) return { error: { status: 404, message: '找不到工程' } };

  const { rows: items } = await query(
    `SELECT item_no AS "項次", name AS "項目", unit AS "單位",
            quantity AS "數量", unit_price AS "單價"
       FROM contract_items WHERE project_id = $1 ORDER BY seq`, [projectId]);
  if (!items.length) return { error: { status: 400, message: NO_CONTRACT } };
  if (!p[0].start_date) return { error: { status: 400, message: NO_START } };

  const vendorKey = p[0].vendor_name;
  const parser = vendorKey ? registry.getParser(vendorKey) : null;
  if (!parser || typeof parser.parseAll !== 'function') {
    return {
      error: {
        status: 400,
        message: vendorKey
          ? `尚未安裝「${vendorKey}」的施工日誌讀取器,無法解析這份日誌`
          : '此工程尚未綁定承包廠商,無法決定要用哪一份讀取器',
      },
    };
  }

  const 開工日 = toISODate(p[0].start_date);
  return {
    contract: items.map((i) => ({ ...i, 數量: Number(i.數量), 單價: Number(i.單價) })),
    開工日,
    parser,
    project: {
      工程名稱: p[0].name,
      承包廠商: vendorKey,
      開工日期: 開工日,
      契約金額: p[0].award_amount == null ? null : Number(p[0].award_amount),
      竣工日期: toISODate(p[0].contract_completion_date),
    },
  };
}

/** 已寫入的逐日逐項紀錄(供跨批次差異)。 */
async function loadRecords(projectId) {
  const { rows } = await query(
    `SELECT log_date, item_no AS "項次", qty AS "本日完成數量"
       FROM daily_records WHERE project_id = $1 ORDER BY log_date, id`, [projectId]);
  return rows.map((r) => ({
    日期: toISODate(r.log_date),
    項次: r.項次,
    本日完成數量: r.本日完成數量 == null ? null : Number(r.本日完成數量),
  }));
}

/**
 * 這批日誌最早日期**之前**已寫入的累計(各項次的數量與金額)。
 *
 * 驗證層需要它當起點:施工日誌分批提交,第二批的「累計完成數量」包含前面批次
 * 做過的量,從 0 起算的話 B3 在每一批的第一天都必然誤判。
 * 金額用「數量 × 契約單價」還原——daily_records 只存數量。
 */
function priorCum(records, 最早日, contract) {
  const priceOf = new Map(contract.map((c) => [String(c.項次), Number(c.單價)]));
  const out = {};
  for (const r of records) {
    if (最早日 && r.日期 >= 最早日) continue;
    const q = Number(r.本日完成數量) || 0;
    const cur = out[r.項次] || { 數量: 0, 金額: 0 };
    cur.數量 += q;
    cur.金額 += q * (priceOf.get(r.項次) || 0);
    out[r.項次] = cur;
  }
  return out;
}

/** 這批涵蓋的最早日期。沒有可用日期時回 null(視為沒有前期累計)。 */
const 最早日 = (rows) => (rows.length ? rows.map((r) => r.日期).sort()[0] : null);

/** 把解析出的天數攤平成逐日逐項列(與 daily_records 同形狀)。 */
function flatten(days) {
  const out = [];
  for (const d of days) {
    const 日期 = (d.header || {}).填報日期;
    if (!日期) continue;
    for (const r of d.dailyRows || []) {
      if (r.項次 == null) continue;
      out.push({
        日期,
        項次: String(r.項次),
        本日完成數量: r.本日完成數量 == null ? null : Number(r.本日完成數量),
      });
    }
  }
  return out;
}

/**
 * 寫入監造報表 + 落庫 + 存附件。兩條確認路徑(文字層 / 掃描件)共用。
 *
 * 抽出來是因為這裡有三個順序上的鐵則,各留一份遲早會漂掉:
 * ① fillTemplate 與 renameSync 之間不得插入任何 await(同 project-basics-routes.js:152)
 * ② 報表寫成功才落庫——反過來會在 COM 失敗時留下「DB 說有、報表沒有」的紀錄
 * ③ 只清這批涵蓋的日期:分批提交是常態,清掉別批等於把已寫入的進度弄丟
 *
 * @param {{projectId:string, days:Array, rows:Array, ctx:object, file:object,
 *          source:string, userId:number|null}} p
 *   source 進 daily_records.source:'parser' | 'ocr_confirmed'
 */
async function writeDays({ projectId, days, rows, ctx, file, source, userId }) {
  const dest = ensureWorkbook(projectId);
  let tmp = dest.replace(/\.xlsm$/i, `.tmp-${process.pid}-${++tmpSeq}.xlsm`);
  try {
    // 竣工日期是費用項目推算的分母(見 daily-log-write.js)。承辦人還沒填時
    // 傳 null,那幾列就維持照日誌的原行為,不會擋住這份日誌寫入。
    await fillTemplate(dest, tmp, applyProtection(dest,
      daysToOperations(days, ctx.contract, ctx.開工日, ctx.project.竣工日期)));
    // ⚠️ fillTemplate 與 renameSync 之間不得插入任何 await
    fs.renameSync(tmp, dest);
    tmp = null;
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
  }

  const dates = [...new Set(rows.map((r) => r.日期))];
  if (dates.length) {
    await query(
      'DELETE FROM daily_records WHERE project_id = $1 AND log_date = ANY($2::date[])',
      [projectId, dates]
    );
  }
  for (const r of rows) {
    await query(
      'INSERT INTO daily_records (project_id, log_date, item_no, qty, source) VALUES ($1, $2, $3, $4, $5)',
      [projectId, r.日期, r.項次, r.本日完成數量, source]
    );
  }

  await saveAttachment({
    projectId,
    kind: 'daily_log',
    buffer: file.buffer,
    originalName: realName(file),
    userId: userId || null,
  });
}

// 前端送回來的 days 的上限。不是效能考量——沒有上限的話一個請求就能塞爆
// Excel 寫入與 DB。範本鋪到 753 天,單日列數取契約表可能的最大項目數再放寬。
const MAX_DAYS = 800;
const MAX_ROWS_PER_DAY = 500;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// 承辦人在畫面上改的就是這幾個數值欄,所以只有它們會被轉成數字;其餘欄位原樣收下。
//
// ⚠️ 這**不是**「其他欄位改不了」——scan 與 confirm-scanned 是兩次獨立請求,
// 後端沒有留著「上次 OCR 讀到什麼」,無從比對。防線在驗證層而不是這裡:
// 項次被改成契約表沒有的值會被 E1 擋下,單位/契約數量對不上會被 E 類擋下。
// 這裡只保證**型別**乾淨,不保證內容沒被動過。
const EDITABLE_NUM_FIELDS = ['本日完成數量', '累計完成數量', '本日完成金額'];

const numOrNull = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 消毒前端送來的 days。**不是白名單欄位而是逐欄限型別**:讀取器逐家欄位不同
 * (摯東沒有「本日完成金額」),白名單會把某些家的欄位吃掉,反而讓驗證層以為
 * 那欄整份都缺、跳過對應規則。
 *
 * @throws {Error} 形狀不合法(訊息寫給承辦人看)
 */
function sanitizeDays(input) {
  if (!Array.isArray(input) || !input.length) throw new Error('沒有收到要寫入的日誌內容');
  if (input.length > MAX_DAYS) throw new Error(`一次最多 ${MAX_DAYS} 天`);
  return input.map((d, i) => {
    const h = (d && d.header) || {};
    const 填報日期 = String(h.填報日期 == null ? '' : h.填報日期).slice(0, 10);
    if (!ISO_DATE.test(填報日期)) {
      throw new Error(`第 ${i + 1} 天缺少填報日期,或格式不是 YYYY-MM-DD`);
    }
    const rows = Array.isArray(d.dailyRows) ? d.dailyRows : [];
    if (rows.length > MAX_ROWS_PER_DAY) throw new Error(`${填報日期} 的明細超過 ${MAX_ROWS_PER_DAY} 列`);
    const header = {};
    for (const [k, v] of Object.entries(h)) {
      if (v == null) { header[k] = null; continue; }
      header[k] = typeof v === 'number' ? v : String(v).slice(0, 500);
    }
    header.填報日期 = 填報日期;
    return {
      header,
      dailyRows: rows.map((r) => {
        const out = {};
        for (const [k, v] of Object.entries(r || {})) {
          if (EDITABLE_NUM_FIELDS.includes(k)) out[k] = numOrNull(v);
          else if (v == null) out[k] = null;
          else if (typeof v === 'number') out[k] = v;
          else out[k] = String(v).slice(0, 500);
        }
        return out;
      }),
    };
  });
}

function registerRoutes(app) {
  app.post('/api/projects/:id/daily-logs/parse', verifyToken,
    upload.single('daily_log'), async (req, res) => {
      try {
        if (!req.file || !req.file.buffer || !req.file.buffer.length) {
          return res.status(400).json({ error: '請上傳施工日誌' });
        }
        if (!isIdShape(req.params.id)) return res.status(404).json({ error: '找不到工程' });
        const ctx = await loadContext(req.params.id);
        if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.message });

        const days = await withTempFile(req.file, (p) => ctx.parser.parseAll(p));
        const rows = flatten(days);
        const records = await loadRecords(req.params.id);
        const result = validateDailyLog({
          days, contract: ctx.contract, project: ctx.project,
          prior: priorCum(records, 最早日(rows), ctx.contract),
        });
        const diff = diffDays(records, rows);

        res.json({
          天數: days.length,
          日期範圍: days.length
            ? [days[0].header && days[0].header.填報日期,
              days[days.length - 1].header && days[days.length - 1].header.填報日期]
            : null,
          ...result,
          diff,
        });
      } catch (err) {
        console.error('[daily-log] 施工日誌解析失敗:', err);
        res.status(500).json({ error: '施工日誌解析失敗,請稍後重試;若持續失敗請聯絡系統管理員' });
      }
    });

  app.post('/api/projects/:id/daily-logs/confirm', verifyToken,
    upload.single('daily_log'), async (req, res) => {
      try {
        if (!req.file || !req.file.buffer || !req.file.buffer.length) {
          return res.status(400).json({ error: '請上傳施工日誌' });
        }
        if (!isIdShape(req.params.id)) return res.status(404).json({ error: '找不到工程' });
        const ctx = await loadContext(req.params.id);
        if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.message });

        // 重新解析與驗證,不吃前端送來的任何資料
        const days = await withTempFile(req.file, (p) => ctx.parser.parseAll(p));
        const rows = flatten(days);
        const result = validateDailyLog({
          days, contract: ctx.contract, project: ctx.project,
          prior: priorCum(await loadRecords(req.params.id), 最早日(rows), ctx.contract),
        });
        if (result.errors.length) {
          // 一次列全:逐條修正會讓承辦人與廠商來回好幾趟
          return res.status(400).json({
            error: `施工日誌有 ${result.errors.length} 項硬錯,未寫入監造報表`,
            ...result,
          });
        }

        await writeDays({
          projectId: req.params.id,
          days,
          rows,
          ctx,
          file: req.file,
          source: 'parser',
          userId: req.userId,
        });

        // 承辦人選的是「報表版面不動,改在系統畫面標示」,所以哪幾列是系統推算的
        // 必須在這裡講清楚——報表本身看不出來。
        const plan = feeItemsPlan(ctx.contract, ctx.開工日, ctx.project.竣工日期);
        res.json({
          ok: true,
          天數: days.length,
          筆數: rows.length,
          warnings: result.warnings,
          費用推算: { 工期天數: plan.工期天數, 項目: plan.items.map((f) => f.項目) },
        });
      } catch (err) {
        if (/projectId 不合法/.test(err.message || '')) {
          return res.status(400).json({ error: '網址中的工程 id 不合法' });
        }
        // daysToOperations 的日期越界屬「這份日誌不能用」,訊息本就寫給承辦人看
        if (/超出|早於開工日/.test(err.message || '')) {
          return res.status(400).json({ error: err.message });
        }
        console.error('[daily-log] 寫入每日施工紀錄失敗:', err);
        res.status(500).json({ error: '寫入監造報表失敗,請稍後重試;若持續失敗請聯絡系統管理員' });
      }
    });

  // 掃描件:OCR 預填。**唯讀**,而且刻意不回傳「可以寫入了」之類的結論——
  // 這條路的產出是要給承辦人逐格看過的草稿,不是答案。
  app.post('/api/projects/:id/daily-logs/scan', verifyToken,
    upload.single('daily_log'), async (req, res) => {
      try {
        if (!req.file || !req.file.buffer || !req.file.buffer.length) {
          return res.status(400).json({ error: '請上傳施工日誌' });
        }
        if (!isIdShape(req.params.id)) return res.status(404).json({ error: '找不到工程' });
        const ctx = await loadContext(req.params.id);
        if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.message });

        const out = await withTempFile(req.file, async (p) => {
          // 涵蓋範圍先算:讀取器整份 throw 時(實測 8 份裡有 2 份會),這是唯一
          // 還答得出來的東西——至少告訴承辦人這份涵蓋哪些日期、要人工補幾天。
          const coverage = await scanCoverage(p, { ocr, extractItemsOcr });
          let days = null;
          let 讀取器錯誤 = null;
          try {
            days = await scanDays(p, { ocr, extractItemsOcr, filetypes, parser: ctx.parser });
          } catch (e) {
            讀取器錯誤 = e.message;
          }
          return { coverage, days, 讀取器錯誤 };
        });

        if (!out.days) {
          return res.json({
            掃描件: true,
            可預填: false,
            讀取器錯誤: out.讀取器錯誤,
            涵蓋範圍: out.coverage,
          });
        }

        // 驗證只是給承辦人參考:草稿本來就會有一堆硬錯(OCR 漏掉的格子)。
        // 真正決定能不能寫的是 confirm-scanned 那一次。
        const rows = flatten(out.days);
        const records = await loadRecords(req.params.id);
        const result = validateDailyLog({
          days: out.days, contract: ctx.contract, project: ctx.project,
          prior: priorCum(records, 最早日(rows), ctx.contract),
        });

        res.json({
          掃描件: true,
          可預填: true,
          天數: out.days.length,
          days: out.days,
          涵蓋範圍: out.coverage,
          契約項目: ctx.contract,
          ...result,
          diff: diffDays(records, rows),
        });
      } catch (err) {
        console.error('[daily-log] 掃描件 OCR 失敗:', err);
        res.status(500).json({ error: '掃描件辨識失敗,請稍後重試;若持續失敗請聯絡系統管理員' });
      }
    });

  // 掃描件:承辦人逐格確認後寫入。**這是唯一會吃前端 days 的路由**,理由見檔頭。
  app.post('/api/projects/:id/daily-logs/confirm-scanned', verifyToken,
    upload.single('daily_log'), async (req, res) => {
      try {
        if (!req.file || !req.file.buffer || !req.file.buffer.length) {
          return res.status(400).json({ error: '請上傳施工日誌原始檔' });
        }
        if (!isIdShape(req.params.id)) return res.status(404).json({ error: '找不到工程' });
        if (req.body.confirmed !== 'true') {
          // 前端要明確表態承辦人逐格看過了。少了這一關,這條路就只是個
          // 「繞過驗證直接寫 DB」的 API。
          return res.status(400).json({ error: '請先逐格確認辨識結果' });
        }
        const ctx = await loadContext(req.params.id);
        if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.message });

        let days;
        try {
          days = sanitizeDays(JSON.parse(req.body.days || 'null'));
        } catch (e) {
          return res.status(400).json({ error: `送出的內容不合法:${e.message}` });
        }

        const rows = flatten(days);
        const result = validateDailyLog({
          days, contract: ctx.contract, project: ctx.project,
          prior: priorCum(await loadRecords(req.params.id), 最早日(rows), ctx.contract),
        });
        if (result.errors.length) {
          // 「人確認過」不等於放行:OCR 漏掉的格子承辦人也可能漏補,
          // 39 條驗證照擋——這正是它存在的理由。
          return res.status(400).json({
            error: `確認後的內容仍有 ${result.errors.length} 項硬錯,未寫入監造報表`,
            ...result,
          });
        }

        await writeDays({
          projectId: req.params.id,
          days,
          rows,
          ctx,
          file: req.file,
          source: 'ocr_confirmed',
          userId: req.userId,
        });

        const plan = feeItemsPlan(ctx.contract, ctx.開工日, ctx.project.竣工日期);
        res.json({
          ok: true,
          天數: days.length,
          筆數: rows.length,
          warnings: result.warnings,
          來源: 'ocr_confirmed',
          費用推算: { 工期天數: plan.工期天數, 項目: plan.items.map((f) => f.項目) },
        });
      } catch (err) {
        if (/projectId 不合法/.test(err.message || '')) {
          return res.status(400).json({ error: '網址中的工程 id 不合法' });
        }
        if (/超出|早於開工日/.test(err.message || '')) {
          return res.status(400).json({ error: err.message });
        }
        console.error('[daily-log] 寫入每日施工紀錄失敗(掃描件):', err);
        res.status(500).json({ error: '寫入監造報表失敗,請稍後重試;若持續失敗請聯絡系統管理員' });
      }
    });
}

module.exports = { registerRoutes };
