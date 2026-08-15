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
const { applyProtection } = require('./report-protect');
const { getFirmDefaults } = require('./settings');
const { excelSerialToISO, isoToExcelSerial } = require('./parsers/filetypes/xlsx');

// 決標公告只讀不存,走記憶體即可,不落暫存檔。
const upload = multer({ storage: multer.memoryStorage() });

// 9 值全部必填 —— CELL_OF 的鍵就是完整清單,避免兩處各維護一份而漂移。
const REQUIRED = Object.keys(CELL_OF);

// 這三欄會被送進型別化的目的地(Excel 日期序號 / PostgreSQL DATE、NUMERIC),格式必須在
// 落檔前驗:renameSync 一旦成功 .xlsm 就已定案,若之後 UPDATE 才因型別錯誤(22P02)失敗,
// 就會留下「報表已改、主檔沒改」的半套狀態,而且沒有補償機制。
// 驗證結果併進硬擋的同一份 fields ——「這欄要回頭改」對承辦人是同一件事,
// 分成兩種回應形狀只會讓前端各寫一套。
// 純量守門必須排在格式判斷之前:格式判斷看的是「值轉成數字/字串之後是什麼」,
// 非純量會整個穿透過去 —— String(['3057698']) 是 '3057698'、Number(true) 是 1,
// 但 pg 的 prepareValue 送出的是 '{3057698}' / 'true',numeric/date 欄位丟 22P02;
// true 更陰險:寫進 B7 後 B9 算出「開工日 + 1 - 1」剛好通過下界檢查而回 200,
// 主檔的完工期限卻是錯的。兩者都發作在 renameSync 之後,即「報表已改、主檔沒改」。
const isScalar = (v) => typeof v === 'number' || typeof v === 'string';

const FORMAT_OK = {
  契約工期: (v) => isScalar(v) && Number.isInteger(Number(v)) && Number(v) >= 1,
  // 已含日曆合法性(2/30 這種不放行)
  開工日期: (v) => isScalar(v) && isoToExcelSerial(v) != null,
  // '3,057,698' 這類千分位會被擋下。先 trim 再判空是必要的:Number(' ')、Number([]) 都是 0
  // (有限數)會被放行,但 pg 的 prepareValue 送出的是 ' ' / '{}',PostgreSQL 對 numeric
  // 欄位丟 22P02 —— 而那發生在 renameSync 之後,又是一次「報表已改、主檔沒改」。
  契約金額: (v) => {
    if (!isScalar(v)) return false;
    const s = String(v).trim();
    return s !== '' && Number.isFinite(Number(s));
  },
};

// tmp 檔名必須每個請求唯一。finally 裡的 rmSync 是**跨請求可見的副作用**:成功路徑的
// finally 在 await query(UPDATE) 之後才跑,若共用檔名,A 的清除會刪掉 B 已寫完、還沒
// rename 的 tmp,讓 B 的 renameSync ENOENT。用單調遞增計數器而非亂數,同 process 內保證不撞。
let tmpSeq = 0;

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
        // 掃描件是「這份檔案不能用」,屬 400,訊息本來就是寫給承辦人看的,原樣回。
        if (err.code === 'SCANNED_PDF') return res.status(400).json({ error: err.message });
        // 其餘視為伺服器端問題:內部訊息(路徑、解析器細節)只留 log,不回給前端。
        console.error('[project-basics] 決標公告解析失敗:', err);
        res.status(500).json({ error: '決標公告解析失敗,請稍後重試;若持續失敗請聯絡系統管理員' });
      }
    });

  app.post('/api/projects/:id/basics', verifyToken, async (req, res) => {
    let tmp = null;
    try {
      // 先確認工程存在再談內容:對不存在的工程回報「缺哪些欄位」是誤導,
      // 更要緊的是不能在確認之前 ensureWorkbook —— 那會替一個不存在的工程建出常駐報表檔,
      // 而後面的 UPDATE 影響 0 列,結果是承辦人收到 200、系統裡多一份孤兒報表。
      const p = await findProject(req.params.id, 'SELECT id FROM projects WHERE id = $1');
      if (!p) return res.status(404).json({ error: '找不到工程' });

      const values = (req.body && req.body.values) || {};
      // 未填與格式不合法一次列全,不在第一個問題就中斷 —— 只報第一個會讓承辦人來回送好幾次。
      const fields = REQUIRED.filter((k) => {
        const v = values[k];
        if (v == null || v === '') return true;
        return FORMAT_OK[k] ? !FORMAT_OK[k](v) : false;
      });
      if (fields.length) {
        return res.status(400).json({ error: '以下欄位尚未裁決、未填或格式不正確', fields });
      }

      const dest = ensureWorkbook(req.params.id);
      // 先寫暫存再換掉本尊:COM 中途失敗時原檔完好,不會留下半寫的活頁簿
      tmp = dest.replace(/\.xlsm$/i, `.tmp-${process.pid}-${++tmpSeq}.xlsm`);
      await fillTemplate(dest, tmp, applyProtection(dest, basicsToOperations(values)));
      // ⚠️ fillTemplate 與 renameSync 之間不得插入任何 await:並行安全靠 fillTemplate 內部的
      // _chain 全域序列化,加上 renameSync 在同一個 microtask 續行中同步跑完 —— 這是隱性不變量。
      // 中間一 await,另一個請求的 COM job 就會插隊,把還沒寫完的 tmp rename 成本尊。
      fs.renameSync(tmp, dest);

      // 完工期限由範本公式 =B8+B7-1 算出,讀回來當主檔的 contract_completion_date。
      // 只認「數值格且不早於開工日期」:SheetJS 對公式錯誤格回 t:'e',v 是錯誤碼小整數
      // (#VALUE!=15、#REF!=23),只看 v != null 的話 excelSerialToISO(15) 會回 '1900-01-15'
      // 照寫進主檔 —— 承辦人收到 200,主檔卻是假日期。=B8+B7-1 且工期至少 1 天,
      // 故正常結果必然 >= 開工日期序號,拿它當下界比寫死一個年份區間更貼合語意。
      const wb = XLSX.readFile(dest, { sheets: ['工程基本資料'] });
      const b9 = wb.Sheets['工程基本資料'] && wb.Sheets['工程基本資料'].B9;
      const startSerial = isoToExcelSerial(values.開工日期); // 上面已驗過,必非 null
      const 完工期限 = (b9 && b9.t === 'n' && Number.isFinite(b9.v) && b9.v >= startSerial)
        ? excelSerialToISO(b9.v)
        : null;
      if (完工期限 == null) {
        console.error('[project-basics] B9 完工期限非日期值,已中止回寫主檔:', b9);
        return res.status(500).json({
          error: '監造報表已更新,但完工期限未算出;為免寫入錯誤日期,已中止回寫工程主檔,請檢查報表後重送',
        });
      }

      // 契約工期基準只存主檔,不進報表:範本的「工程基本資料」沒有這個欄位,
      // 而 A7 的標籤是中性的「契約工期」。與費用項目同一個決定——版面不動,
      // 標示放系統畫面。不在 REQUIRED 裡:判不出來時本來就該留空讓承辦人補,
      // 硬性必填會把一份本來寫得進去的報表整份卡住。
      const 基準 = ['日曆天', '工作天'].includes(values.契約工期基準)
        ? values.契約工期基準 : null;

      // 工作天的案子**不用 B9 覆蓋主檔的竣工日**。
      //
      // B9 的公式是 =B8+B7-1(開工日 + 工期 - 1),那是日曆天的算法:把週末與
      // 國定假日都算成工期,對工作天的案子會算出偏早的日期。而開工報告表上本來
      // 就印著契約規定竣工日,那是廠商/機關已經算好的——以那個為準,系統只做
      // 驗算(見 kickoff-compare 的工期自洽性檢查:工作天必然 ≤ 同期間的日曆天)。
      //
      // 用 CASE 併進同一句 UPDATE 而不是先查再決定:兩次往返之間有 race。
      const 覆蓋竣工日 = 基準 !== '工作天';
      // 天數與基準同樣要存得住:基準當初加欄位的理由是「選了不存,每次進畫面又變回
      // 未知」,天數完全一樣——承辦人在這裡改了工期,值只進了報表 B7,下次進畫面
      // 又被主檔的舊值(或空白)蓋回去。只收有限正數,其餘存 null。
      const 天數raw = Number(values.契約工期);
      const 天數 = Number.isFinite(天數raw) && 天數raw > 0 ? 天數raw : null;
      await query(
        `UPDATE projects
            SET project_no = $1, name = $2, award_amount = $3, start_date = $4,
                contract_completion_date = CASE WHEN $5 THEN $6 ELSE contract_completion_date END,
                supervisor_firm = $7, designer_firm = $8, duration_basis = $9,
                duration_days = $10
          WHERE id = $11`,
        [values.工程編號, values.工程名稱, values.契約金額, values.開工日期,
          覆蓋竣工日, 完工期限, values.監造單位, values.設計單位, 基準, 天數, req.params.id]
      );

      res.json({
        ok: true,
        workbookPath: dest,
        完工期限,
        契約工期基準: 基準,
        // 前端拿它決定要不要把畫面上的契約竣工日同步成 B9 的值——工作天時那個值
        // 是日曆天算法算的,同步過去會把開工報告表讀到的正確日期蓋掉。
        已寫入竣工日: 覆蓋竣工日,
      });
    } catch (err) {
      // 分流:ensureWorkbook 的 id 驗證屬用戶端輸入問題(上方守門已擋掉,這裡是後備),
      // 回 400 而非 500,免得承辦人以為是系統故障而不去檢查網址。
      if (/projectId 不合法/.test(err.message || '')) {
        return res.status(400).json({ error: '網址中的工程 id 不合法' });
      }
      // 其餘(範本缺檔、Excel COM 失敗、DB 故障)是伺服器問題。細節只留 server log:
      // err.message 可能含「公版範本不存在:<絕對路徑>」這類伺服器結構,不該回給前端;
      // 但也不能只回一句話就把現場丟掉,故整個 error(含 stack)照原樣寫進 log。
      console.error('[project-basics] 寫入工程基本資料失敗:', err);
      res.status(500).json({ error: '寫入監造報表失敗,請稍後重試;若持續失敗請聯絡系統管理員' });
    } finally {
      // rename 成功後 tmp 已不存在;失敗時則會留下半寫的活頁簿在專案報表目錄裡,清掉。
      // 清除本身失敗不得覆蓋原始錯誤(回應此時已送出),故整段吞掉。
      if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } }
    }
  });
}

module.exports = { registerRoutes, REQUIRED };
