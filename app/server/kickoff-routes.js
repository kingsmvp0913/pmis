/**
 * kickoff-routes.js — 開工報告表的解析與歸檔(SP1B 階段二)
 *
 * 路由:
 *   POST /api/projects/:id/kickoff-report/parse    上傳 → OCR 預填 + 與歸檔的決標公告比對
 *                                                  (純唯讀,不落庫、不落檔)
 *   POST /api/projects/:id/kickoff-report/confirm  承辦人逐欄確認後的值 + 同一份檔案
 *                                                  → 無硬錯才歸檔
 *
 * 為何檔案要送兩次:parse 有硬錯時若已落檔,系統裡就會留下一份「未核對卻已歸檔」的
 * 附件,而 spec §5.1 規定有硬錯不得標記已核對。前端本就持有 File 物件(沿用階段一
 * projects.js 的 awardFile 模式),重送成本為零。
 *
 * 「已核對」不另設欄位:有硬錯就不得歸檔,故 kind='kickoff_report' 的存在即等價於
 * 已核對。多開一個布林欄位會產生規格上不存在的「已歸檔但未核對」狀態。
 */
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { readKickoffReport } = require('./kickoff-report');
const { readAwardNotice } = require('./award-notice');
const { compareKickoff, hardErrors, validateValues } = require('./kickoff-compare');
const { saveAttachment } = require('./project-attachments-routes');
const { safeResolve } = require('./history-routes');

// OCR 需要實體檔(WinRT 的 GetFileFromPathAsync 吃路徑),故落暫存檔再刪。
// 與決標公告的記憶體路徑不同,這是 OCR 的硬需求。
const upload = multer({ storage: multer.memoryStorage() });

// projects.id 是 SERIAL(int4),非此形狀的 :id 永遠比不到任何一列,且會讓
// PostgreSQL 丟型別錯誤被 catch 成 500,讓承辦人以為系統壞了。
// 本專案已有兩份同名判斷(project-attachments-routes.js、project-basics-routes.js)——
// 依裁決不抽共用模組,第三份照抄保留。
const INT4_MAX = 2147483647;
function isIdShape(id) {
  return /^[1-9][0-9]*$/.test(String(id)) && Number(id) <= INT4_MAX;
}

// 契約工期比對的性質與其餘硬錯欄位不同:它是開工報告表**自身**的內部自洽性檢查
// (表列工期 vs 表上開工/竣工日推導值),不是跨文件比對——kickoff-compare.js 的
// 「決標公告值」欄此時顯示的是「（表內推導）N」,不是真的公告資料。
// 若固定回「與決標公告不符,請發文更正」,唯一硬錯是契約工期時會叫承辦人
// 拿決標公告去跟廠商發文,而實際上該做的是檢查開工報告表自己填的三個數字對不對。
const DURATION_FIELD = '契約工期';

// 工程一律由決標公告建立(2026-08-05 裁決,手動新增已移除),故「沒有決標公告」
// 不是可補件的狀態,而是這個工程當初就沒照規則建立——要他重建,不是要他補掛。
const NO_AWARD_MESSAGE = '此工程未歸檔決標公告,無法核對開工報告表。請以決標公告重新建立工程。';

/**
 * 依硬錯欄位組成挑文案:跨文件欄位與契約工期(表內自洽)所需的下一步動作不同,
 * 混在一起講會讓其中一種問題被誤讀成另一種。
 * @param {string[]} fields hardErrors() 的欄位清單(不受此函式影響,原樣照列)
 * @returns {string}
 */
function buildHardErrorMessage(fields) {
  const hasDuration = fields.includes(DURATION_FIELD);
  const hasOther = fields.some((f) => f !== DURATION_FIELD);
  if (hasDuration && hasOther) {
    return '以下欄位不得標記為已核對:契約工期是開工報告表自身數字兜不起來(表列工期與開工/竣工日推導值不符),' +
      '請確認表格填寫;其餘欄位則與決標公告不符,請確認後發文更正';
  }
  if (hasDuration) {
    return '開工報告表自身的契約工期與開工/竣工日推導值不符,請確認表格填寫,不得標記為已核對';
  }
  return '以下欄位與決標公告不符,請確認後發文更正,不得標記為已核對';
}

let tmpSeq = 0;

// 把上傳的 buffer 落到暫存檔給 OCR 用,用完必刪。檔名含 pid 與遞增序號:
// 共用檔名的話,A 的清除會刪掉 B 還在讀的檔(沿用 project-basics-routes 的教訓)。
async function withTempPdf(buffer, fn) {
  const tmp = path.join(require('os').tmpdir(), `sp1b-kickoff-${process.pid}-${++tmpSeq}.pdf`);
  fs.writeFileSync(tmp, buffer);
  try { return await fn(tmp); }
  finally { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
}

/**
 * 取該工程已歸檔的決標公告並重新解析。DB 沒存決標日期/履約地點/履約起迄,
 * 只能從歸檔的那份 PDF 重新讀。
 *
 * 回傳要區分「沒有附件」與「有附件但讀不出來」:前者代表這個工程當初沒照
 * 規則建立(要重建),後者的工程本身合法、只是檔案壞了(要換檔)。兩者都回
 * null 的話,承辦人會被叫去砍掉一個其實沒問題的案子。
 *
 * @returns {Promise<{found:boolean, award:object|null}>}
 */
async function loadAwardNotice(projectId) {
  const { rows } = await query(
    `SELECT file_path FROM project_attachments
      WHERE project_id = $1 AND kind = 'award_notice' ORDER BY id DESC LIMIT 1`,
    [projectId]
  );
  if (!rows[0]) return { found: false, award: null };
  const abs = safeResolve(rows[0].file_path);
  if (!abs) return { found: true, award: null };
  try { return { found: true, award: await readAwardNotice(abs) }; }
  catch (err) {
    console.error('[kickoff] 歸檔的決標公告解析失敗:', err);
    return { found: true, award: null };
  }
}

// 有附件卻讀不出來:工程本身是合法的,該換的是那份檔案。
const BAD_AWARD_MESSAGE = '此工程歸檔的決標公告無法讀取(檔案損毀或不是決標公告),' +
  '請重新上傳正確的決標公告後再核對開工報告表。';

function registerRoutes(app) {
  app.post('/api/projects/:id/kickoff-report/parse', verifyToken,
    upload.single('kickoff_report'), async (req, res) => {
      try {
        if (!req.file || !req.file.buffer || !req.file.buffer.length) {
          return res.status(400).json({ error: '請上傳開工報告表 PDF' });
        }
        if (!isIdShape(req.params.id)) return res.status(404).json({ error: '找不到工程' });
        const { rows } = await query('SELECT id FROM projects WHERE id = $1', [req.params.id]);
        if (!rows[0]) return res.status(404).json({ error: '找不到工程' });

        // 決標公告先查:沒有它就沒有比對基準,而規則已改成「工程一律由決標公告
        // 建立」,這種工程要重建而不是補件。擋在 OCR 之前——讓承辦人等完數十秒
        // 的 OCR 才被告知這個工程不能歸檔,等於白等。
        const { found, award } = await loadAwardNotice(req.params.id);
        if (!award) {
          return res.status(400).json({ error: found ? BAD_AWARD_MESSAGE : NO_AWARD_MESSAGE });
        }

        const kickoff = await withTempPdf(req.file.buffer, (p) => readKickoffReport(p));
        res.json({
          kickoff,
          award,
          hasAward: true,
          rows: compareKickoff(kickoff, award),
        });
      } catch (err) {
        // 「這份檔案不能用」屬 400,訊息本就寫給承辦人看,原樣回
        if (err.code === 'NOT_KICKOFF_REPORT') return res.status(400).json({ error: err.message });
        // 其餘(OCR 驅動失敗、DB 故障)是伺服器問題:內部路徑與驅動細節只留 log
        console.error('[kickoff] 開工報告表解析失敗:', err);
        res.status(500).json({ error: '開工報告表解析失敗,請稍後重試;若持續失敗請聯絡系統管理員' });
      }
    });

  app.post('/api/projects/:id/kickoff-report/confirm', verifyToken,
    upload.single('kickoff_report'), async (req, res) => {
      try {
        if (!req.file || !req.file.buffer || !req.file.buffer.length) {
          return res.status(400).json({ error: '請上傳開工報告表 PDF' });
        }
        if (!isIdShape(req.params.id)) return res.status(404).json({ error: '找不到工程' });
        const { rows } = await query('SELECT id FROM projects WHERE id = $1', [req.params.id]);
        if (!rows[0]) return res.status(404).json({ error: '找不到工程' });

        let values;
        try { values = JSON.parse(req.body && req.body.values); }
        catch { return res.status(400).json({ error: '確認值格式不正確' }); }
        if (!values || typeof values !== 'object' || Array.isArray(values)) {
          return res.status(400).json({ error: '確認值格式不正確' });
        }

        const { found, award } = await loadAwardNotice(req.params.id);
        if (!award) {
          return res.status(400).json({ error: found ? BAD_AWARD_MESSAGE : NO_AWARD_MESSAGE });
        }

        // 必填/值域先擋,與跨文件比對分兩段回報:前者是「這份表還沒填完或填得
        // 不成立」,承辦人自己補得了;後者是「與決標公告記載不同」,要發文請廠商
        // 更正。混在同一則訊息裡列出,兩種完全不同的下一步動作會被誤讀成同一種。
        const validated = validateValues(values);
        const invalid = validated.filter((e) => e.級別 === 'hard');
        if (invalid.length) {
          return res.status(400).json({
            error: '以下欄位尚未填寫或內容不成立,請對照 PDF 補正:' +
              invalid.map((e) => `${e.欄位}(${e.訊息})`).join('、'),
            fields: invalid.map((e) => e.欄位),
            // 逐欄原因:只給欄位清單的話,前端只能套一句通用文案(目前那句是
            // 「與決標公告不符」),而必填漏填不是跨文件比對的問題,會指錯方向。
            fieldMessages: Object.fromEntries(invalid.map((e) => [e.欄位, e.訊息])),
            rows: compareKickoff(values, award, { confirmed: true }),
          });
        }

        const compared = compareKickoff(values, award, { confirmed: true });
        const errs = hardErrors(compared);
        if (errs.length) {
          // 一次列全:逐條修正會讓承辦人來回發文好幾次
          const fields = errs.map((r) => r.欄位);
          return res.status(400).json({
            error: buildHardErrorMessage(fields),
            fields,
            rows: compared,
          });
        }

        const saved = await saveAttachment({
          projectId: req.params.id,
          kind: 'kickoff_report',
          buffer: req.file.buffer,
          // multer 的 originalname 以 latin1 解碼,中文檔名要轉回 utf8
          // (沿用 project-routes.js:159)
          originalName: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
          userId: req.userId || null,
          // 重傳修正版是常態(OCR 讀錯、傳錯檔);留著舊的只會讓承辦人在附件
          // 清單看到兩份開工報告表卻分不出哪份才算數。
          replace: true,
        });
        // 提示級不擋歸檔,但一定要回:承辦人看不到就等於這條規則沒做。
        res.json({
          ok: true,
          attachmentId: saved.id,
          rows: compared,
          warnings: validated.filter((e) => e.級別 === 'hint'),
        });
      } catch (err) {
        console.error('[kickoff] 開工報告表歸檔失敗:', err);
        res.status(500).json({ error: '開工報告表歸檔失敗,請稍後重試;若持續失敗請聯絡系統管理員' });
      }
    });
}

module.exports = { registerRoutes };
