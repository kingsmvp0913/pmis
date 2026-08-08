/**
 * daily-log-routes.js — 施工日誌 → 每日施工紀錄(SP3)
 *
 * 路由:
 *   POST /api/projects/:id/daily-logs/parse    上傳 → 39 條驗證 + 跨批次差異(唯讀)
 *   POST /api/projects/:id/daily-logs/confirm  無硬錯才寫入 .xlsm 並落庫
 *
 * 檔案送兩次的理由同 SP1B/SP2:parse 落檔的話,驗證沒過時會留下一份沒人確認過的
 * 來源檔。**confirm 一律重新解析與驗證**,不吃前端送來的資料。
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
const { validateDailyLog } = require('./daily-log-validate');
const { daysToOperations, diffDays, feeItemsPlan } = require('./daily-log-write');
const { ensureWorkbook } = require('./report-workbook');
const { fillTemplate } = require('./template-engine');
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
      let tmp = null;
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

        const dest = ensureWorkbook(req.params.id);
        tmp = dest.replace(/\.xlsm$/i, `.tmp-${process.pid}-${++tmpSeq}.xlsm`);
        // 竣工日期是費用項目推算的分母(見 daily-log-write.js)。承辦人還沒填時
        // 傳 null,那幾列就維持照日誌的原行為,不會擋住這份日誌寫入。
        await fillTemplate(dest, tmp,
          daysToOperations(days, ctx.contract, ctx.開工日, ctx.project.竣工日期));
        // ⚠️ fillTemplate 與 renameSync 之間不得插入任何 await(同 project-basics-routes.js:152)
        fs.renameSync(tmp, dest);
        tmp = null;

        // 報表寫成功才落庫:順序反過來,COM 失敗時會留下「DB 說有、報表沒有」的紀錄
        const dates = [...new Set(rows.map((r) => r.日期))];
        // 只清這批涵蓋的日期:分批提交是常態,清掉別批的日期等於把已寫入的進度弄丟
        if (dates.length) {
          await query(
            'DELETE FROM daily_records WHERE project_id = $1 AND log_date = ANY($2::date[])',
            [req.params.id, dates]
          );
        }
        for (const r of rows) {
          await query(
            'INSERT INTO daily_records (project_id, log_date, item_no, qty) VALUES ($1, $2, $3, $4)',
            [req.params.id, r.日期, r.項次, r.本日完成數量]
          );
        }

        await saveAttachment({
          projectId: req.params.id,
          kind: 'daily_log',
          buffer: req.file.buffer,
          originalName: realName(req.file),
          userId: req.userId || null,
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
      } finally {
        if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
      }
    });
}

module.exports = { registerRoutes };
