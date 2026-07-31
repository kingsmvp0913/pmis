/**
 * project-basics-routes.js — SP1 工程基本資料的兩支端點
 *
 * 路由:
 *   POST /api/projects/:id/award-notice  multipart 上傳決標公告 → 解析 + 與主檔比對
 *                                        (不落庫、不寫檔,純唯讀的審核輔助)
 *   POST /api/projects/:id/basics        送出裁決後的 9 值 → 寫入 .xlsm + 回寫主檔
 *
 * 硬擋語意(spec §9):9 值只要有任一未裁決/未填就 400,並**一次列出全部缺項**;
 * 未通過前不建立報表檔、不回寫主檔,避免留下半套資料。
 */
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const { query } = require('./db');
const { verifyToken } = require('./auth');
const { readAwardNotice } = require('./award-notice');
const { compareBasics, basicsToOperations, CELL_OF } = require('./project-basics');
const { ensureWorkbook } = require('./report-workbook');
const { fillTemplate } = require('./template-engine');
const { getFirmDefaults } = require('./settings');
const { excelSerialToISO } = require('./parsers/filetypes/xlsx');

// 決標公告只讀不存,走記憶體即可,不落暫存檔。
const upload = multer({ storage: multer.memoryStorage() });

// 9 值全部必填 —— CELL_OF 的鍵就是完整清單,避免兩處各維護一份而漂移。
const REQUIRED = Object.keys(CELL_OF);

// projects.id 是 SERIAL(int4),非此形狀的 :id 永遠比不到任何一列。
// 不先擋掉的話有兩個後果:PostgreSQL 會以型別錯誤(22P02/22003)中斷這句 SQL、
// ensureWorkbook 也會丟「projectId 不合法」——兩者都是用戶端把網址打錯,
// 卻會被 catch 吃成 500,讓承辦人以為系統壞了,也讓真正的伺服器錯誤淹沒在雜訊裡。
const INT4_MAX = 2147483647;
function isProjectIdShape(id) {
  return /^[1-9][0-9]*$/.test(String(id)) && Number(id) <= INT4_MAX;
}

/**
 * 依 :id 取工程。形狀不合法一律視同不存在(見 isProjectIdShape),
 * 呼叫端據此回 404;真正的 DB 故障仍會 throw 上去成為 500。
 * @param {string} id  req.params.id(未經查驗的外部輸入)
 * @param {string} sql 以 $1 收 id 的 SELECT
 * @returns {Promise<object|null>} 存在則回該列,否則 null
 */
async function findProject(id, sql) {
  if (!isProjectIdShape(id)) return null;
  const { rows } = await query(sql, [id]);
  return rows[0] || null;
}

function registerRoutes(app) {
  app.post('/api/projects/:id/award-notice', verifyToken, upload.single('award_notice'),
    async (req, res) => {
      try {
        if (!req.file || !req.file.buffer || !req.file.buffer.length) {
          return res.status(400).json({ error: '請上傳決標公告 PDF' });
        }
        const p = await findProject(req.params.id,
          `SELECT p.id, p.project_no, p.name, p.award_amount,
                  p.supervisor_firm, p.designer_firm,
                  v.name AS vendor_name, s.name AS school_name
             FROM projects p
             LEFT JOIN vendors v ON v.id = p.vendor_id
             LEFT JOIN schools s ON s.id = p.school_id
            WHERE p.id = $1`);
        if (!p) return res.status(404).json({ error: '找不到工程' });

        const parsed = await readAwardNotice(req.file.buffer);
        const project = {
          工程名稱: p.name,
          主辦機關: p.school_name,
          承包廠商: p.vendor_name,
          契約金額: p.award_amount,
          工程編號: p.project_no,
        };
        const defaults = await getFirmDefaults();
        res.json({
          parsed,
          project,
          diffs: compareBasics(parsed, project),
          // 專案層有值就用專案層,否則吊系統預設
          firms: {
            supervisor_firm: p.supervisor_firm || defaults.supervisor_firm,
            designer_firm: p.designer_firm || defaults.designer_firm,
          },
        });
      } catch (err) {
        // 掃描件是「這份檔案不能用」,屬 400;其餘視為伺服器端問題
        const status = err.code === 'SCANNED_PDF' ? 400 : 500;
        res.status(status).json({ error: err.message });
      }
    });

  app.post('/api/projects/:id/basics', verifyToken, async (req, res) => {
    try {
      // 先確認工程存在再談內容:對不存在的工程回報「缺哪些欄位」是誤導,
      // 更要緊的是不能在確認之前 ensureWorkbook —— 那會替一個不存在的工程建出常駐報表檔,
      // 而後面的 UPDATE 影響 0 列,結果是承辦人收到 200、系統裡多一份孤兒報表。
      const p = await findProject(req.params.id, 'SELECT id FROM projects WHERE id = $1');
      if (!p) return res.status(404).json({ error: '找不到工程' });

      const values = (req.body && req.body.values) || {};
      const missing = REQUIRED.filter((k) => values[k] == null || values[k] === '');
      if (missing.length) {
        return res.status(400).json({ error: '以下欄位尚未裁決或未填', fields: missing });
      }

      const dest = ensureWorkbook(req.params.id);
      // 先寫暫存再換掉本尊:COM 中途失敗時原檔完好,不會留下半寫的活頁簿
      const tmp = dest.replace(/\.xlsm$/i, `.tmp-${process.pid}.xlsm`);
      await fillTemplate(dest, tmp, basicsToOperations(values));
      fs.renameSync(tmp, dest);

      // 完工期限由範本公式 =B8+B7-1 算出,讀回來當主檔的 contract_completion_date
      const wb = XLSX.readFile(dest, { sheets: ['工程基本資料'] });
      const b9 = wb.Sheets['工程基本資料'] && wb.Sheets['工程基本資料'].B9;
      const 完工期限 = b9 && b9.v != null ? excelSerialToISO(b9.v) : null;

      await query(
        `UPDATE projects
            SET project_no = $1, name = $2, award_amount = $3, start_date = $4,
                contract_completion_date = $5, supervisor_firm = $6, designer_firm = $7
          WHERE id = $8`,
        [values.工程編號, values.工程名稱, values.契約金額, values.開工日期,
          完工期限, values.監造單位, values.設計單位, req.params.id]
      );

      res.json({ ok: true, workbookPath: dest, 完工期限 });
    } catch (err) {
      // 分流:ensureWorkbook 的 id 驗證屬用戶端輸入問題(上方守門已擋掉,這裡是後備),
      // 回 400 而非 500,免得承辦人以為是系統故障而不去檢查網址。
      // 其餘(範本缺檔、Excel COM 失敗、DB 故障)才是伺服器問題:除了回 message,
      // 另把整個 error 留在 server log —— 只回 message 會丟掉 COM 失敗的現場,事後查不出原因。
      const clientErr = /projectId 不合法/.test(err.message || '');
      if (!clientErr) console.error('[project-basics] 寫入工程基本資料失敗:', err);
      res.status(clientErr ? 400 : 500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes, REQUIRED };
