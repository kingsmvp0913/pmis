/**
 * kickoff-compare.js — 開工報告表 vs 決標公告的逐欄比對(純函式)
 *
 * 級別二分(spec §5.2):
 *   hard 硬錯 — 兩份文件對同一事實記載不同,必須發文請廠商更正
 *   hint 提示 — 決標公告的履約起迄明載「(預估)」,機關實際通知開工較晚屬正常,
 *               判硬錯會逼承辦人去請廠商修正一份正確的文件(古坑案)
 *
 * 契約工期比對是**開工報告表的內部自洽性檢查**(表上明載工期 vs 表上開工/竣工日
 * 推導工期),不是跨文件比對,但級別仍是 hard(spec §5.2 明訂):表上兩個數字互相
 * 矛盾就是這份文件自己填錯,不像開工/竣工日兩欄有「決標公告寫的是預估值」這種
 * 正常解釋可以開脫。這是唯一能抓出「文件自己填錯」的檢查,降成 hint 等於让這種
 * 錯誤被當成可忽略的提示放行、照常歸檔(見 task-6-report.md 修正記錄)。
 *
 * 狀態四態,不可壓成布林:
 *   match / diff / missing(有一邊沒值,沒得比) / no_award(該工程未歸檔決標公告)
 *
 * Exports:
 *   compareKickoff(kickoff, award) → rows
 *   hardErrors(rows)               → 篩出硬錯
 */
const { normalizeOrgName } = require('./org-match');
const { deriveDuration, rocToISO } = require('./kickoff-values');

// 名稱與地名一律走 org-match 的正規化(全形轉半形 + 臺→台 + 去空白)。
// 不得另寫一份:同一份文件內即混用臺/台,兩套規則遲早漂走。
const eqText = (a, b) => {
  const na = normalizeOrgName(a);
  const nb = normalizeOrgName(b);
  if (na == null || nb == null) return null; // 沒得比
  return na === nb;
};

const MS_PER_DAY = 86400000;
function daysBetween(aISO, bISO) {
  const a = Date.parse(`${aISO}T00:00:00Z`);
  const b = Date.parse(`${bISO}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(Math.round((b - a) / MS_PER_DAY));
}

function row(欄位, 開工報告表值, 決標公告值, 狀態, 級別, 差異天數) {
  const r = { 欄位, 開工報告表值, 決標公告值, 狀態, 級別 };
  if (差異天數 != null) r.差異天數 = 差異天數;
  return r;
}

// 一般欄位:兩值皆有才比,任一缺即 missing。
function cmp(欄位, kv, av, hasAward, eq) {
  if (!hasAward) return row(欄位, kv, null, 'no_award', 'hard');
  if (kv == null || av == null) return row(欄位, kv, av, 'missing', 'hard');
  return row(欄位, kv, av, eq ? 'match' : 'diff', 'hard');
}

/**
 * 逐欄比對。
 * @param {object} kickoff extractFields 的輸出
 * @param {object|null} award parseAwardNotice 的輸出;該工程未歸檔決標公告時傳 null
 * @returns {Array<object>}
 */
function compareKickoff(kickoff, award) {
  const k = kickoff || {};
  const a = award || {};
  const hasAward = !!award;
  const rows = [];

  // ── 硬錯欄位 ────────────────────────────────────────────
  rows.push(cmp('工程名稱', k.工程名稱, a.工程名稱, hasAward, eqText(k.工程名稱, a.工程名稱) === true));

  // 契約編號**不做數值正規化**:格式各機關自訂,數值化會把 '0123' 誤判等於 '123'
  rows.push(cmp('契約編號', k.契約編號, a.工程編號, hasAward,
    normalizeOrgName(k.契約編號) === normalizeOrgName(a.工程編號)));

  rows.push(cmp('契約金額', k.契約金額, a.契約金額, hasAward,
    Number(k.契約金額) === Number(a.契約金額)));

  // 決標公告是民國字串,開工報告表已轉 ISO,比對前把公告側也轉過去
  const awardAwardDate = hasAward ? rocToISO(a.決標日期) : null;
  rows.push(cmp('決標日', k.決標日期, awardAwardDate, hasAward, k.決標日期 === awardAwardDate));

  rows.push(cmp('學校', k.主辦機關, a.主辦機關, hasAward, eqText(k.主辦機關, a.主辦機關) === true));
  rows.push(cmp('縣市', k.縣市, a.履約地點, hasAward, eqText(k.縣市, a.履約地點) === true));

  // ── 契約工期:開工報告表的**內部自洽性檢查**,不與決標公告比,但仍是硬錯 ──
  // 表上明載的工期 vs 表上開工日→竣工日推導值。SP1 §4.3 已用 27 組全量驗證
  // 推翻「以履約起迄推導契約工期」(僅 14 組相符),故不拿決標公告當比對基準;
  // 但表上兩個數字互相矛盾就是這份文件自己填錯,沒有「預估值」這種正常解釋
  // 可以開脫,級別維持 hard(spec §5.2)。
  const dur = k.契約工期 || { 天數: null, 基準: null };
  if (dur.基準 === '工作天') {
    // 由日期推導出的是日曆天,工作天案例必然對不上(明禮)。只取表上數字、不推導。
    rows.push(row('契約工期', `${dur.天數} 工作天`, '（工作天不推導）', 'missing', 'hard'));
  } else {
    const derived = deriveDuration(k.契約規定開工日, k.契約規定竣工日);
    if (dur.天數 == null || derived == null) {
      rows.push(row('契約工期', dur.天數, derived == null ? null : `（表內推導）${derived}`, 'missing', 'hard'));
    } else {
      rows.push(row('契約工期', dur.天數, `（表內推導）${derived}`,
        dur.天數 === derived ? 'match' : 'diff', 'hard'));
    }
  }

  // ── 提示欄位:履約起迄明載「(預估)」,只顯示差幾天,不阻擋 ──
  for (const [欄位, kv, av] of [
    ['契約規定開工日', k.契約規定開工日, hasAward ? rocToISO(a.履約起迄 && a.履約起迄.起) : null],
    ['契約規定竣工日', k.契約規定竣工日, hasAward ? rocToISO(a.履約起迄 && a.履約起迄.迄) : null],
  ]) {
    if (!hasAward) { rows.push(row(欄位, kv, null, 'no_award', 'hint')); continue; }
    if (kv == null || av == null) { rows.push(row(欄位, kv, av, 'missing', 'hint')); continue; }
    const d = daysBetween(kv, av);
    rows.push(row(欄位, kv, av, kv === av ? 'match' : 'diff', 'hint', d));
  }

  return rows;
}

/**
 * 硬錯清單。**一次列全**——逐條修正會讓承辦人來回發文好幾次。
 * missing 不算硬錯:那是「沒讀到、沒得比」,要承辦人補值,不是要廠商改文件。
 */
function hardErrors(rows) {
  return (rows || []).filter((r) => r && r.級別 === 'hard' && r.狀態 === 'diff');
}

module.exports = { compareKickoff, hardErrors };
