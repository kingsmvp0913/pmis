/**
 * contract-items-routes.js — 發包經費總表 → 契約詳細價目表(SP2)
 *
 * 路由:
 *   POST /api/projects/:id/contract-items/parse    上傳 → 挑表 + 卡控 + 差異(純唯讀)
 *   POST /api/projects/:id/contract-items/confirm  承辦人選定的分頁 → 寫入 .xlsm + 落庫
 *
 * 檔案要送兩次,理由同 SP1B:parse 階段落檔的話,卡控沒過時系統裡會留下一份
 * 沒人確認過的來源檔與價目表。
 *
 * **confirm 不吃前端送來的項目**,只吃「選了哪幾張分頁」,項目一律由後端重新
 * 解析——信任前端送的項目等於讓任何人繞過卡控直接寫進契約價目表。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const x = require('xlsx');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { readSheets, findCandidates } = require('./budget-sheet');
const {
  selectSheets, validateItems, diffItems, itemsToOperations,
  supervisionItemRowCount, formulaItemRowCount, INDEX_ROWS,
} = require('./contract-items');
const { ensureWorkbook } = require('./report-workbook');
const { fillTemplate } = require('./template-engine');
const { applyProtection } = require('./report-protect');
const { saveAttachment } = require('./project-attachments-routes');

const upload = multer({ storage: multer.memoryStorage() });

// 沿用既有三處同名判斷(project-attachments-routes / project-basics-routes /
// kickoff-routes):非此形狀的 id 會讓 PostgreSQL 丟型別錯誤被 catch 成 500,
// 承辦人會以為系統壞了。依裁決不抽共用模組,第四份照抄保留。
const INT4_MAX = 2147483647;
function isIdShape(id) {
  return /^[1-9][0-9]*$/.test(String(id)) && Number(id) <= INT4_MAX;
}

let tmpSeq = 0;

// multer 的 originalname 以 latin1 解碼,中文檔名要轉回 utf8(沿用 project-routes.js)
const realName = (f) => Buffer.from(f.originalname, 'latin1').toString('utf8');

/**
 * 把上傳的 buffer 落到暫存檔再讀。SheetJS 的 readFile 吃路徑,
 * 而 .xls(BIFF) 不是靠副檔名而是靠內容判型,故暫存檔沿用原副檔名。
 */
function withTempFiles(files, fn) {
  const made = [];
  try {
    for (const f of files) {
      const name = realName(f);
      const p = path.join(os.tmpdir(),
        `sp2-${process.pid}-${++tmpSeq}${path.extname(name) || '.xls'}`);
      fs.writeFileSync(p, f.buffer);
      made.push({ file: name, path: p });
    }
    return fn(made);
  } finally {
    for (const m of made) { try { fs.rmSync(m.path, { force: true }); } catch { /* ignore */ } }
  }
}

/** 每個上傳檔 → { file, candidates }。讀不開的檔一律讓錯誤往上拋。 */
function collectCandidates(made) {
  return made.map((m) => ({ file: m.file, candidates: findCandidates(readSheets(m.path)) }));
}

/** 該工程已落庫的價目表項目(供差異比對)。沒有就回 null。 */
async function loadExisting(projectId) {
  const { rows } = await query(
    `SELECT item_no AS "項次", name AS "項目", unit AS "單位",
            quantity AS "數量", unit_price AS "單價"
       FROM contract_items WHERE project_id = $1 ORDER BY seq`, [projectId]);
  if (!rows.length) return null;
  return rows.map((r) => ({ ...r, 數量: Number(r.數量), 單價: Number(r.單價) }));
}

/**
 * 各分頁目前有幾列項目列,由**實檔**量出——報表是常駐檔,可能已被前一次寫入刪過列,
 * 也可能是承辦人自己上傳的那份。用範本常數推會刪到報表正文,而刪掉的正文不會有
 * 任何錯誤訊息。
 *
 * 監造報表看得到正文錨點(項目區正下方就是正文);另兩個分頁下方是空白,只能數
 * 「從第 2 列起連續有公式的列」。讀不到就回 null → 那個分頁只擴不刪。
 */
function itemRowCounts(xlsmPath) {
  const 空 = { 監造報表: null, 每日施工紀錄: null, 契約詳細價目表: null };
  let wb;
  try { wb = x.readFile(xlsmPath, { sheets: ['監造報表', '每日施工紀錄', '契約詳細價目表'] }); }
  catch { return 空; }
  const 逐列 = (sheet, col, pick) => {
    const ws = wb.Sheets[sheet];
    if (!ws || !ws['!ref']) return [];
    const { e } = x.utils.decode_range(ws['!ref']);
    return Array.from({ length: e.r + 1 }, (_, i) => pick(ws[`${col}${i + 1}`]));
  };
  const 值 = (c) => (c == null || c.v == null ? '' : String(c.v));
  const 是公式 = (c) => !!(c && c.f);
  try {
    return {
      監造報表: supervisionItemRowCount(逐列('監造報表', 'A', 值)),
      每日施工紀錄: formulaItemRowCount(逐列('每日施工紀錄', 'A', 是公式),
        INDEX_ROWS.每日施工紀錄.first),
      契約詳細價目表: formulaItemRowCount(逐列('契約詳細價目表', 'F', 是公式),
        INDEX_ROWS.契約詳細價目表.first),
    };
  } catch { return 空; }
}

/**
 * 取決標金額。挑表的唯一客觀判準——沒有它就只能靠分頁名稱猜,而實測那樣會
 * 挑到舊底稿殘留的那張(5 個檔案的第一張表施工小計全是南陽的 1,185,308)。
 */
async function loadAward(projectId) {
  const { rows } = await query('SELECT award_amount FROM projects WHERE id = $1', [projectId]);
  if (!rows[0]) return { found: false, amount: null };
  const a = rows[0].award_amount;
  return { found: true, amount: a == null || a === '' ? null : Number(a) };
}

const NO_AWARD_AMOUNT = '此工程尚未填決標金額,無法判斷該用哪一張詳細價目表。' +
  '請先以決標公告完成工程基本資料。';
const NO_DETAIL = '上傳的檔案裡沒有施工項目明細(只有經費總表/預算總表這類只到大類的表)。' +
  '請確認上傳的是含詳細價目表的發包經費總表。';

function registerRoutes(app) {
  app.post('/api/projects/:id/contract-items/parse', verifyToken,
    upload.array('budget_sheets'), async (req, res) => {
      try {
        const files = req.files || [];
        if (!files.length) return res.status(400).json({ error: '請上傳發包經費總表' });
        if (!isIdShape(req.params.id)) return res.status(404).json({ error: '找不到工程' });
        const award = await loadAward(req.params.id);
        if (!award.found) return res.status(404).json({ error: '找不到工程' });
        if (award.amount == null) return res.status(400).json({ error: NO_AWARD_AMOUNT });

        const per = withTempFiles(files, collectCandidates);
        if (!per.some((p) => p.candidates.length)) {
          return res.status(400).json({ error: NO_DETAIL });
        }

        const picked = selectSheets(per, award.amount);
        const existing = await loadExisting(req.params.id);
        res.json({
          決標金額: award.amount,
          selected: picked.matched
            ? {
              matched: picked.matched.map((m) => ({ file: m.file, name: m.name, 合計: m.合計 })),
              items: picked.items,
              合計: picked.合計,
            }
            : null,
          candidates: picked.candidates.map((c) => ({
            file: c.file, name: c.name, 項目數: c.items.length, 合計: c.合計,
          })),
          errors: validateItems(picked.items),
          diff: diffItems(existing, picked.items),
        });
      } catch (err) {
        if (err.code === 'BAD_BUDGET_FILE') return res.status(400).json({ error: err.message });
        console.error('[contract-items] 發包經費總表解析失敗:', err);
        res.status(500).json({ error: '發包經費總表解析失敗,請稍後重試;若持續失敗請聯絡系統管理員' });
      }
    });

  app.post('/api/projects/:id/contract-items/confirm', verifyToken,
    upload.array('budget_sheets'), async (req, res) => {
      let tmp = null;
      try {
        const files = req.files || [];
        if (!files.length) return res.status(400).json({ error: '請上傳發包經費總表' });
        if (!isIdShape(req.params.id)) return res.status(404).json({ error: '找不到工程' });
        const award = await loadAward(req.params.id);
        if (!award.found) return res.status(404).json({ error: '找不到工程' });
        if (award.amount == null) return res.status(400).json({ error: NO_AWARD_AMOUNT });

        let picks;
        try { picks = JSON.parse(req.body && req.body.picks); }
        catch { return res.status(400).json({ error: '選定的分頁格式不正確' }); }
        if (!Array.isArray(picks) || !picks.length) {
          return res.status(400).json({ error: '請選擇要採用的詳細價目表分頁' });
        }

        const per = withTempFiles(files, collectCandidates);
        // 依承辦人選的 (檔名, 分頁名) 取項目。找不到就是前端與後端對不上,
        // 硬跑下去會寫進一份與他看到的不同的價目表。
        const chosen = [];
        for (const p of picks) {
          const f = per.find((x) => x.file === p.file);
          const c = f && f.candidates.find((x) => x.name === p.name);
          if (!c) {
            return res.status(400).json({ error: `找不到選定的分頁:${p.file} / ${p.name}` });
          }
          chosen.push(c);
        }
        const items = chosen.flatMap((c) => c.items);
        const 合計 = chosen.reduce((s, c) => s + c.合計, 0);

        // 合計必須等於決標金額。這條同時是挑表的判準與寫入的卡控——承辦人手動
        // 選錯組合時,擋在這裡的就是它。
        if (合計 !== award.amount) {
          return res.status(400).json({
            error: `選定分頁的合計 ${合計.toLocaleString()} 與決標金額 ` +
              `${award.amount.toLocaleString()} 不符,請確認選的是正確的詳細價目表`,
            合計, 決標金額: award.amount,
          });
        }
        const errors = validateItems(items);
        if (errors.length) {
          return res.status(400).json({ error: '詳細價目表內容不成立,請確認檔案', errors });
        }

        const existing = await loadExisting(req.params.id);
        const dest = ensureWorkbook(req.params.id);
        // 各分頁現有幾列項目列,一律量實檔(見 itemRowCounts)
        const 現有列數 = itemRowCounts(dest);
        // 先寫暫存再換掉本尊:COM 中途失敗時原檔完好,不會留下半寫的活頁簿
        tmp = dest.replace(/\.xlsm$/i, `.tmp-${process.pid}-${++tmpSeq}.xlsm`);
        await fillTemplate(dest, tmp,
          applyProtection(dest, itemsToOperations(
            items, existing ? existing.length : 0, 現有列數)));
        // ⚠️ fillTemplate 與 renameSync 之間不得插入任何 await(同 project-basics-routes.js:152):
        // 並行安全靠 fillTemplate 內部的 _chain 序列化 + renameSync 在同一個 microtask 續行中
        // 同步跑完。中間一 await,另一個請求的 COM job 就會插隊。
        fs.renameSync(tmp, dest);
        tmp = null;

        // 報表寫成功才落庫:順序反過來的話,COM 失敗時系統裡會留下一份
        // 「DB 說有、報表沒有」的價目表。
        await query('DELETE FROM contract_items WHERE project_id = $1', [req.params.id]);
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          await query(
            `INSERT INTO contract_items (project_id, seq, item_no, name, unit, quantity, unit_price)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [req.params.id, i + 1, it.項次, it.項目, it.單位, it.數量, it.單價]
          );
        }

        for (const f of files) {
          await saveAttachment({
            projectId: req.params.id,
            kind: 'budget_sheet',
            buffer: f.buffer,
            originalName: realName(f),
            userId: req.userId || null,
            // 只留最新一份:重傳修正版是常態,累積多份會讓承辦人分不出哪份才算數
            replace: files.indexOf(f) === 0,
          });
        }

        res.json({ ok: true, count: items.length, 合計, workbookPath: dest });
      } catch (err) {
        if (err.code === 'BAD_BUDGET_FILE') return res.status(400).json({ error: err.message });
        if (/projectId 不合法/.test(err.message || '')) {
          return res.status(400).json({ error: '網址中的工程 id 不合法' });
        }
        console.error('[contract-items] 寫入契約詳細價目表失敗:', err);
        res.status(500).json({ error: '寫入監造報表失敗,請稍後重試;若持續失敗請聯絡系統管理員' });
      } finally {
        if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
      }
    });
}

module.exports = { registerRoutes };
