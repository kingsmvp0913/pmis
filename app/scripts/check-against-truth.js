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
const { readTruthKey } = require('../server/truth-key');
const { readAwardNotice } = require('../server/award-notice');
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

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({ tally, results, failed, noTruth, noAward, multi }, null, 2), 'utf8');
    console.log(`\n完整結果已寫入 ${args.json}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
