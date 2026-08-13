/**
 * award-group.js — 一張決標含多個標的時的群組與加總檢核(純函式 + 一支查詢)
 *
 * ## 為什麼需要這一層
 *
 * 一張決標公告底下有兩個以上標的是既有慣例,不是新需求:
 *
 *     重興汙水 812,102 + 重興廁所   871,943 = 1,684,045 = 決標金額
 *     橋頭國小 1,670,374 + 許厝分校 2,679,146 = 4,349,520 = 決標金額
 *     古坑國小/國中、東榮國小/國中 同一個模式
 *
 * 事務所的實務是**一個標的一整套**——各自的發包後經費總表、施工日誌、監造報表
 * (檔名慣例就寫著標的:`(橋頭國小)…_監造報表.xlsm`／`(許厝分校)…_監造報表.xlsm`)。
 * 系統照這個實務走:**一個標的一個工程**,承辦人把該工程的決標金額改成標的金額。
 *
 * 但那一改,決標總額就沒有任何地方留著了,於是「各標的加起來對不對」這條檢核
 * 無從做起——**少建一個標的、或某個標的金額打錯,系統完全看不出來**,
 * 而金額都合理、沒有任何錯誤訊息。故建案時另存 `projects.award_total`
 * (伺服器重新解析決標公告取得,不吃前端的值),用它當加總的基準。
 *
 * ## 群組鍵為什麼是契約編號,而不是新開一個群組欄
 *
 * 同一張決標的工程本來就共用契約編號——建案的重複判定早就寫著
 * 「一次決標含多個標的…只看案號會把合法的第二個工程擋在門外」,
 * 所以案號相同、名稱不同的那幾筆,定義上就是同一張決標的不同標的。
 * 再開一個欄位要多一套維護(建案時填、編輯時不能改、舊資料要回填),
 * 而它能表達的資訊契約編號已經表達了。
 *
 * ⚠️ **代價要知道**:機關的編號規則若讓兩張不同的決標撞號,這兩案會被歸成
 * 同一群。故加總不符時的訊息只說「請確認」,**不自動判定誰對誰錯**;
 * 而且只在群組裡真的有兩筆以上時才檢核(單一標的沒有加總問題)。
 *
 * Exports:
 *   summarize(rows)            純函式:同群組的工程列 → 檢核結果
 *   loadGroup(query, no, id)   查同契約編號的工程並回 summarize 的結果
 */

// 金額以元為單位。各標的金額是承辦人逐案輸入的整數,決標總額來自公告,
// 兩邊都不該有小數;容差取 0.5 元只為了擋浮點表示誤差,不是為了容忍填錯。
const TOLERANCE = 0.5;

/**
 * 同群組工程列 → 加總檢核結果。
 *
 * @param {Array<{id:number,name:string,award_amount:*,award_total:*}>} rows
 *   同一個契約編號底下的全部工程
 * @returns {{標的數:number, 標的:Array, 決標總額:number|null, 已分配:number|null,
 *            差額:number|null, 狀態:'single'|'ok'|'mismatch'|'unknown'}}
 *   狀態 single = 只有一個標的(不檢核);unknown = 缺決標總額或有標的沒填金額;
 *   ok = 加起來等於決標總額;mismatch = 兜不起來
 */
function summarize(rows) {
  const list = (rows || []).map((r) => ({
    id: r.id,
    name: r.name,
    金額: r.award_amount == null ? null : Number(r.award_amount),
  }));
  // 決標總額取群組裡任何一筆有值的(同一張決標,每筆存的都是同一個數)。
  // 取第一筆而不是相信全部一致:舊資料可能只有後建的那幾筆有值。
  const totals = (rows || []).map((r) => (r.award_total == null ? null : Number(r.award_total)))
    .filter((v) => v != null && Number.isFinite(v));
  const 決標總額 = totals.length ? totals[0] : null;

  if (list.length < 2) {
    return { 標的數: list.length, 標的: list, 決標總額, 已分配: null, 差額: null, 狀態: 'single' };
  }
  // 有標的沒填金額就不能下判斷:把 null 當 0 加進去會算出一個「短少」的差額,
  // 而真正的問題是那一筆還沒填,兩者該做的事完全不同。
  if (決標總額 == null || list.some((x) => x.金額 == null)) {
    return { 標的數: list.length, 標的: list, 決標總額, 已分配: null, 差額: null, 狀態: 'unknown' };
  }
  const 已分配 = list.reduce((s, x) => s + x.金額, 0);
  const 差額 = 已分配 - 決標總額;
  return {
    標的數: list.length,
    標的: list,
    決標總額,
    已分配,
    差額,
    狀態: Math.abs(差額) < TOLERANCE ? 'ok' : 'mismatch',
  };
}

/**
 * 查同契約編號的工程並檢核。
 *
 * @param {(sql:string, params:Array)=>Promise<{rows:Array}>} query
 * @param {string} projectNo 契約編號
 * @returns {Promise<object|null>} summarize 的結果;契約編號是空的則 null
 */
async function loadGroup(query, projectNo) {
  const no = projectNo == null ? '' : String(projectNo).trim();
  if (!no) return null;
  const { rows } = await query(
    'SELECT id, name, award_amount, award_total FROM projects WHERE project_no = $1 ORDER BY id',
    [no]
  );
  return summarize(rows);
}

module.exports = { summarize, loadGroup, TOLERANCE };
