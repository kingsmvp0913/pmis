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
const { compareKickoff, hardErrors } = require('./kickoff-compare');
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
 * @returns {Promise<object|null>} 沒有附件或檔案已遺失回 null(不阻擋流程)
 */
async function loadAwardNotice(projectId) {
  const { rows } = await query(
    `SELECT file_path FROM project_attachments
      WHERE project_id = $1 AND kind = 'award_notice' ORDER BY id DESC LIMIT 1`,
    [projectId]
  );
  if (!rows[0]) return null;
  const abs = safeResolve(rows[0].file_path);
  if (!abs) return null;
  try { return await readAwardNotice(abs); }
  catch (err) {
    // 歸檔的公告解析失敗(如當初存的是掃描件)不得讓開工報告表流程整個掛掉
    console.error('[kickoff] 歸檔的決標公告解析失敗,改以無公告模式比對:', err);
    return null;
  }
}

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

        const kickoff = await withTempPdf(req.file.buffer, (p) => readKickoffReport(p));
        const award = await loadAwardNotice(req.params.id);
        res.json({
          kickoff,
          award,
          hasAward: !!award,
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

        const award = await loadAwardNotice(req.params.id);
        const compared = compareKickoff(values, award);
        const errs = hardErrors(compared);
        if (errs.length) {
          // 一次列全:逐條修正會讓承辦人來回發文好幾次
          return res.status(400).json({
            error: '以下欄位與決標公告不符,請確認後發文更正,不得標記為已核對',
            fields: errs.map((r) => r.欄位),
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
        });
        res.json({ ok: true, attachmentId: saved.id, rows: compared });
      } catch (err) {
        console.error('[kickoff] 開工報告表歸檔失敗:', err);
        res.status(500).json({ error: '開工報告表歸檔失敗,請稍後重試;若持續失敗請聯絡系統管理員' });
      }
    });
}

module.exports = { registerRoutes };
