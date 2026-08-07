#!/usr/bin/env node
/**
 * check-against-truth.js — 拿舊案的人工監造報表當外部基準,量讀取器的差異
 *
 * 為什麼要這支:讀取器的驗收一直是拿讀取器自己的輸出當基準,所以「讀錯但格式合法」
 * 的錯誤驗不出來。舊案的成品報表是人做的、與讀取器無關,才是外部基準。
 *
 * ⚠️ 那些成品**也是人做的,也可能有錯**。本工具因此:
 *   - 不輸出「準確率」——百分比會暗示分母是對的,而這個前提不成立
 *   - 每筆差異兩邊的值都列出來,不標誰對誰錯
 *   - 「等價差異」(全形半形、千分位)與「實質差異」分開列,免得雜訊淹掉該看的
 *   - 只產報告:不改任何程式、不改任何資料
 *
 * 用法:
 *   node scripts/check-against-truth.js [--root <路徑>] [--case <關鍵字>] [--json <輸出檔>]
 *
 * --root 預設由 USERPROFILE 組出(禁止寫死絕對路徑),亦可用 PMIS_TRUTH_ROOT 覆寫。
 */
const fs = require('fs');
const path = require('path');
const { readTruthKey, readTruthItems } = require('../server/truth-key');
const { readAwardNotice } = require('../server/award-notice');
const { readSheets, findCandidates } = require('../server/budget-sheet');
const { selectSheets } = require('../server/contract-items');
const { normalizeText, normalizeAmount } = require('../server/project-basics');

// 決標公告能提供、且答案卷也有的欄位。與 project-basics.COMPARABLE 同一份清單。
const { COMPARABLE } = require('../server/project-basics');
// 抽出來但不比對的欄位:監造/設計單位來自系統設定,決標公告結構上沒有;
// 契約工期/開工日期由承辦人對照開工報告表輸入(見 award-notice.js 檔頭)。
const OBSERVE = ['監造單位', '設計單位', '契約工期', '開工日期'];

function parseArgs(argv) {
  const a = { root: null, case: null, json: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--root') a.root = argv[++i];
    else if (k === '--case') a.case = argv[++i];
    else if (k === '--json') a.json = argv[++i];
  }
  return a;
}

function defaultRoot() {
  if (process.env.PMIS_TRUTH_ROOT) return process.env.PMIS_TRUTH_ROOT;
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) throw new Error('無法決定預設 root,請用 --root 指定');
  return path.join(home, 'OneDrive', 'Desktop', 'PMIS範例', '模板', '全案範例');
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

const norm = (v, 欄位) => (欄位 === '契約金額' ? normalizeAmount(v) : normalizeText(v));

/**
 * 一欄的比對結果。四態不可壓成布林:
 *   match / equivalent(正規化後才相同) / diff / missing-parser / missing-truth
 * equivalent 要與 match 分開,因為它是「正規化吃掉的差異」——正規化太寬也會製造假一致,
 * 列出來才看得到是否過寬。
 */
function compareField(欄位, truthV, parsedV) {
  if (parsedV == null || String(parsedV).trim() === '') return { 狀態: 'missing-parser' };
  if (truthV == null || String(truthV).trim() === '') return { 狀態: 'missing-truth' };
  if (String(truthV) === String(parsedV)) return { 狀態: 'match' };
  const nt = norm(truthV, 欄位);
  const np = norm(parsedV, 欄位);
  return { 狀態: nt === np ? 'equivalent' : 'diff' };
}

// ── 第二層:契約詳細價目表 ──────────────────────────────────
//
// 挑表要決標金額。刻意用**決標公告解析出來的**金額而非答案卷的 B6:拿答案卷當
// 輸入等於讓被測的一方看答案,挑對了也不知道是讀對還是被餵對的。
// 名稱比對沿用 normalizeText(含 NFKC)——契約表打全形、廠商日誌打半形是常態,
// 這層的判定必須與 production 同一份,否則報告說一致而系統判不一致。
const nameKey = (s) => normalizeText(s);
const numKey = (n) => (n == null || n === '' ? null : Number(n));

// 範圍符號的寫法差異:人工報表打「(壹-伍)」「1-2分AK石」「H17-22cm」,
// 發包經費總表打「(壹~伍)」「1~2分」「H17~22cm」。同一個項目的同一段文字,
// 只是範圍符號用了不同字元。實測 69 對「名稱只在單邊」裡有 57 對是這個原因。
//
// **只用在報告分類,不併進 nameKey**:把它塞進正式的名稱正規化,等於替
// production 決定「- 與 ~ 一律等價」,而那要看 SP3 的 E1 名稱對應願不願意收
// (參照 454ba35 刻意不統一「、」與「,」的理由)。這裡只負責讓真訊號不被淹掉。
const rangeKey = (s) => {
  const k = nameKey(s);
  return k == null ? null : k.replace(/[~〜～–—-]/g, '-');
};

/**
 * 逐項比對答案卷與讀取器的價目表。
 *
 * **以名稱對齊而非項次**:實測發現人工報表寫「壹.1」、系統寫「1」——那是發包經費
 * 總表上的原樣項次(itemsToOperations 不轉換),兩種寫法都不算讀錯。用項次當鍵的話
 * 40 案全部「對不上」,真正的差異一筆都看不到。名稱才是項目的身分(同 E1 在項次
 * 對不上時靠名稱對應)。項次寫法的差異另外統計,不混進欄差異。
 *
 * 讀取器側的名稱欄叫「項目」、答案卷側叫「名稱」——兩邊欄名不同,取錯就永遠是
 * undefined,而 undefined 比 undefined 會相等,報告會安靜地說「全部一致」。
 *
 * @returns {{項數, 只在答案卷, 只在讀取器, 欄差異, 項次寫法不同}}
 */
function compareItems(truthItems, parsedItems) {
  const byName = (arr, nameOf) => {
    const m = new Map();
    for (const it of arr) {
      const k = nameKey(nameOf(it));
      if (k && !m.has(k)) m.set(k, it);
    }
    return m;
  };
  const T = byName(truthItems, (i) => i.名稱);
  const P = byName(parsedItems, (i) => i.項目);

  const 欄差異 = [];
  const 項次寫法不同 = [];
  for (const [name, t] of T) {
    const p = P.get(name);
    if (!p) continue;
    const tNo = nameKey(t.項次);
    const pNo = nameKey(p.項次);
    if (tNo !== pNo) 項次寫法不同.push({ 名稱: t.名稱, 答案卷: t.項次, 讀取器: p.項次 });
    for (const [欄, tv, pv] of [
      ['單位', nameKey(t.單位), nameKey(p.單位)],
      ['數量', numKey(t.數量), numKey(p.數量)],
      ['單價', numKey(t.單價), numKey(p.單價)],
    ]) {
      if (tv == null && pv == null) continue;
      if (tv !== pv) 欄差異.push({ 名稱: t.名稱, 欄, 答案卷: t[欄], 讀取器: p[欄] });
    }
  }
  // 名稱對不上的,先試著只以範圍符號的差異配對。配得起來的不是「讀漏/讀多」,
  // 混在一起會讓真訊號(57 對雜訊 vs 少數真差異)看不見。
  const leftT = [...T.entries()].filter(([k]) => !P.has(k)).map(([, v]) => v.名稱);
  const leftP = [...P.entries()].filter(([k]) => !T.has(k)).map(([, v]) => v.項目);
  const 範圍符號差異 = [];
  const 只在答案卷 = [];
  const restP = [...leftP];
  for (const a of leftT) {
    const i = restP.findIndex((b) => rangeKey(b) === rangeKey(a));
    if (i >= 0) { 範圍符號差異.push({ 答案卷: a, 讀取器: restP[i] }); restP.splice(i, 1); }
    else 只在答案卷.push(a);
  }

  return {
    項數: { 答案卷: truthItems.length, 讀取器: parsedItems.length },
    只在答案卷,
    只在讀取器: restP,
    範圍符號差異,
    欄差異,
    項次寫法不同,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const root = args.root || defaultRoot();
  if (!fs.existsSync(root)) {
    console.error(`找不到案子目錄:${root}`);
    process.exit(1);
  }

  const cases = fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(n => !args.case || n.includes(args.case));

  const results = [];
  const tally = { match: 0, equivalent: 0, diff: 0, 'missing-parser': 0, 'missing-truth': 0 };
  const noTruth = [];
  const noAward = [];
  const failed = [];
  const multi = [];
  const itemSkip = [];
  const itemFail = [];

  for (const c of cases) {
    const files = walk(path.join(root, c));
    const truths = files.filter(f => /監造報表/.test(path.basename(f)) && /\.xlsm$/i.test(f));
    const awards = files.filter(f => /決標/.test(path.basename(f)) && /\.pdf$/i.test(f));

    if (!truths.length) { noTruth.push(c); continue; }
    if (!awards.length) { noAward.push(c); continue; }
    // 靜默取第一份會讓「取錯檔造成的差異」看起來像讀取器的錯,所以要講。
    if (truths.length > 1 || awards.length > 1) {
      multi.push(`${c}  答案卷×${truths.length} 決標公告×${awards.length} → 取用 ` +
        `${path.basename(truths[0])} / ${path.basename(awards[0])}`);
    }

    let truth, parsed;
    try { truth = readTruthKey(truths[0]); }
    catch (e) { failed.push(`${c}  答案卷讀取失敗:${e.message}`); continue; }
    // readAwardNotice 是 async(內部 await extractRows)。漏了 await 的話 parsed 是
    // Promise、每一欄都 undefined,報告會整齊地印出「讀取器全部沒讀到」——格式完全
    // 合法、只是內容全錯,正是這支工具要抓的那種錯。
    try { parsed = await readAwardNotice(awards[0]); }
    catch (e) { failed.push(`${c}  決標公告解析失敗:${e.message}`); continue; }

    const row = { 案: c, 比對: [], 觀察: [] };
    for (const 欄位 of COMPARABLE) {
      const r = compareField(欄位, truth[欄位], parsed[欄位]);
      tally[r.狀態]++;
      row.比對.push({ 欄位, 答案卷: truth[欄位], 讀取器: parsed[欄位], ...r });
    }
    for (const 欄位 of OBSERVE) {
      row.觀察.push({ 欄位, 答案卷: truth[欄位], 決標公告: 欄位 === '契約工期' ? parsed.履約起迄 : null });
    }

    // ── 第二層:契約詳細價目表 ──
    const budgets = files.filter(f => /經費總表|試算表|預算|價目/.test(path.basename(f))
      && /\.(xls|xlsx|xlsm)$/i.test(f));
    if (!budgets.length) {
      itemSkip.push(`${c}  無發包經費總表`);
    } else if (parsed.契約金額 == null) {
      // 挑表的唯一客觀判準是決標金額(見 contract-items.js)。沒有它就不該猜。
      itemSkip.push(`${c}  決標公告沒讀到契約金額,無法挑表`);
    } else {
      try {
        const truthItems = readTruthItems(truths[0]);
        const filesForSelect = budgets.map(f => ({ file: path.basename(f), candidates: findCandidates(readSheets(f)) }));
        const sel = selectSheets(filesForSelect, parsed.契約金額);
        if (!sel.matched) {
          itemSkip.push(`${c}  挑表無唯一解(候選 ${sel.candidates.length} 組),不猜`);
        } else {
          row.價目表 = compareItems(truthItems, sel.items);
        }
      } catch (e) {
        itemFail.push(`${c}  價目表比對失敗:${e.message}`);
      }
    }

    results.push(row);
  }

  // ── 報告 ──────────────────────────────────────────────
  const show = (v) => (v == null ? '(無)' : String(v));
  console.log(`=== ${results.length} 案 × ${COMPARABLE.length} 比對欄 ===`);
  console.log(`一致              ${tally.match}`);
  console.log(`一致(正規化後)    ${tally.equivalent}`);
  console.log(`不一致            ${tally.diff}`);
  console.log(`讀取器沒讀到      ${tally['missing-parser']}`);
  console.log(`答案卷沒填        ${tally['missing-truth']}`);

  if (failed.length) {
    console.log(`\n=== 讀不進來的案 (${failed.length}) ===`);
    failed.forEach(f => console.log(`  ${f}`));
  }
  if (noTruth.length) console.log(`\n無答案卷 (${noTruth.length}): ${noTruth.join('、')}`);
  if (noAward.length) console.log(`無決標公告 (${noAward.length}): ${noAward.join('、')}`);
  if (multi.length) {
    console.log(`\n=== 同類命中多份,取第一份 (${multi.length}) ===`);
    multi.forEach(m => console.log(`  ${m}`));
  }

  const pick = (s) => results.flatMap(r => r.比對.filter(f => f.狀態 === s).map(f => ({ 案: r.案, ...f })));

  const diffs = pick('diff');
  console.log(`\n=== 不一致,逐筆 (${diffs.length}) ===`);
  console.log('※ 答案卷是人做的,也可能有錯。兩邊都列出來,誰對誰錯請人判斷。');
  for (const d of diffs) {
    console.log(`\n${d.案}  【${d.欄位}】`);
    console.log(`  答案卷 : ${show(d.答案卷)}`);
    console.log(`  讀取器 : ${show(d.讀取器)}`);
  }

  const eq = pick('equivalent');
  console.log(`\n=== 正規化後才一致,逐筆 (${eq.length}) ===`);
  console.log('※ 這些是正規化吃掉的差異。列出來是為了確認正規化有沒有太寬。');
  for (const d of eq) {
    console.log(`${d.案}  【${d.欄位}】 答案卷=${show(d.答案卷)}  讀取器=${show(d.讀取器)}`);
  }

  const miss = pick('missing-parser');
  console.log(`\n=== 讀取器沒讀到,逐筆 (${miss.length}) ===`);
  for (const d of miss) console.log(`${d.案}  【${d.欄位}】 答案卷=${show(d.答案卷)}`);

  const mt = pick('missing-truth');
  if (mt.length) {
    console.log(`\n=== 答案卷沒填,逐筆 (${mt.length}) ===`);
    for (const d of mt) console.log(`${d.案}  【${d.欄位}】 讀取器=${show(d.讀取器)}`);
  }

  console.log('\n=== 觀察組(不比對) ===');
  console.log('※ 決標公告結構上給不了這些值。列出來是為了驗證這個假設是否成立。');
  for (const r of results) {
    const o = r.觀察.map(x => `${x.欄位}=${show(x.答案卷)}`).join('  ');
    const 起迄 = r.觀察.find(x => x.欄位 === '契約工期').決標公告;
    console.log(`${r.案}\n  答案卷: ${o}\n  決標公告履約起迄: ${起迄 ? JSON.stringify(起迄) : '(無)'}`);
  }

  // ── 第二層報告:契約詳細價目表 ──
  const withItems = results.filter(r => r.價目表);
  console.log(`\n\n════════ 契約詳細價目表 (${withItems.length}/${results.length} 案比得成) ════════`);
  if (itemSkip.length) {
    console.log(`\n=== 沒比(${itemSkip.length}) ===`);
    itemSkip.forEach(s => console.log(`  ${s}`));
  }
  if (itemFail.length) {
    console.log(`\n=== 比對失敗(${itemFail.length}) ===`);
    itemFail.forEach(s => console.log(`  ${s}`));
  }

  const cntMismatch = withItems.filter(r => r.價目表.項數.答案卷 !== r.價目表.項數.讀取器);
  const totalCols = withItems.reduce((s, r) => s + r.價目表.欄差異.length, 0);
  const totalOnlyT = withItems.reduce((s, r) => s + r.價目表.只在答案卷.length, 0);
  const totalOnlyP = withItems.reduce((s, r) => s + r.價目表.只在讀取器.length, 0);
  const totalNo = withItems.reduce((s, r) => s + r.價目表.項次寫法不同.length, 0);
  const totalItems = withItems.reduce((s, r) => s + r.價目表.項數.答案卷, 0);
  console.log(`\n答案卷總項數   ${totalItems}`);
  console.log(`項數不同的案   ${cntMismatch.length}`);
  console.log(`名稱只在答案卷 ${totalOnlyT}`);
  console.log(`名稱只在讀取器 ${totalOnlyP}`);
  console.log(`名稱只差範圍符號 ${withItems.reduce((s, r) => s + r.價目表.範圍符號差異.length, 0)}(不算讀錯)`);
  console.log(`同名稱但欄不同 ${totalCols}`);
  console.log(`項次寫法不同   ${totalNo}(不算讀錯,見下)`);

  if (cntMismatch.length) {
    console.log(`\n=== 項數不同,逐案 ===`);
    cntMismatch.forEach(r => console.log(
      `  ${r.案}  答案卷 ${r.價目表.項數.答案卷} 項 / 讀取器 ${r.價目表.項數.讀取器} 項` +
      `  (只在答案卷 ${r.價目表.只在答案卷.length}、只在讀取器 ${r.價目表.只在讀取器.length})`));
  }

  console.log(`\n=== 同名稱但欄不同,逐筆 (${totalCols}) ===`);
  console.log('※ 答案卷是人做的,也可能有錯。兩邊都列出來。');
  for (const r of withItems) {
    for (const d of r.價目表.欄差異) {
      console.log(`${r.案}  「${String(d.名稱).slice(0, 22)}」【${d.欄}】 答案卷=${show(d.答案卷)}  讀取器=${show(d.讀取器)}`);
    }
  }

  const rangeAll = withItems.flatMap(r => r.價目表.範圍符號差異.map(d => ({ 案: r.案, ...d })));
  console.log(`\n=== 名稱只差範圍符號 (${rangeAll.length}) ===`);
  console.log('※ 人工報表打「(壹-伍)」「1-2分」,經費總表打「(壹~伍)」「1~2分」。同一段文字、不同字元。');
  console.log('※ 不算讀錯,但 SP3 的 E1 靠名稱對應契約項目,這層差異會讓它對不上——要不要收是規則決定。');
  rangeAll.slice(0, 6).forEach(d => console.log(`  ${d.案}\n    答案卷: ${String(d.答案卷).slice(0, 46)}\n    讀取器: ${String(d.讀取器).slice(0, 46)}`));
  if (rangeAll.length > 6) console.log(`  …另有 ${rangeAll.length - 6} 對(完整內容用 --json)`);

  console.log(`\n=== 名稱只在其中一邊,逐案 ===`);
  console.log('※ 這才是「項目被讀漏/讀多」的訊號。');
  for (const r of withItems) {
    const { 只在答案卷: a, 只在讀取器: b } = r.價目表;
    if (!a.length && !b.length) continue;
    console.log(`${r.案}`);
    a.forEach(n => console.log(`    只在答案卷: ${String(n).slice(0, 40)}`));
    b.forEach(n => console.log(`    只在讀取器: ${String(n).slice(0, 40)}`));
  }

  console.log(`\n=== 項次寫法不同 (${totalNo}) ===`);
  console.log('※ 人工報表寫「壹.1」、系統寫「1」(發包經費總表上的原樣項次)。');
  console.log('※ 兩種寫法都不算讀錯,但系統產出的報表看起來會與人工版不同,要不要跟進是規則決定。');
  const noSample = withItems.flatMap(r => r.價目表.項次寫法不同.map(d => ({ 案: r.案, ...d })));
  noSample.slice(0, 12).forEach(d => console.log(`  ${d.案}  「${String(d.名稱).slice(0, 20)}」 答案卷=${show(d.答案卷)}  讀取器=${show(d.讀取器)}`));
  if (noSample.length > 12) console.log(`  …另有 ${noSample.length - 12} 筆(完整內容用 --json)`);

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify(
      { tally, results, failed, noTruth, noAward, multi, itemSkip, itemFail }, null, 2), 'utf8');
    console.log(`\n完整結果已寫入 ${args.json}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
