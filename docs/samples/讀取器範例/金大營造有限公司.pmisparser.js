/**
 * jinda.pmisparser.js — 金大營造(竹崎高中)施工日誌 PDF 讀取器【原始碼範例】
 *
 * 這支是「範例讀取器」的原始碼,放 repo 供版控 / 測試 / 當日後 skill 產其他家
 * 讀取器的樣板。正式安裝的讀取器落在 data/vendor-parsers/,由 registry 動態載入;
 * 兩者不衝突(此檔不被 registry 掃到,靠其 targetFields/介面示範樣板)。
 *
 * 來源:金大竹崎「第二聯」估驗表 PDF,每頁 1 天(共 80 頁);純文字可抽。
 *
 * ── 介面(對齊 registry.js 檔頭定義)──
 *   meta       = { vendorKey:'金大營造有限公司', version, targetFields }
 *   parse(filePath, ctx)     -> Promise<單一天(第一頁)結構>
 *   parseAll(filePath, ctx)  -> Promise<[每天結構…]>
 *   selfTest()               -> boolean  (以內建小樣本頁文字驗證重組邏輯,不依賴檔案)
 *
 * ── 檔型工具「注入」──
 *   讀取器不自己 require 檔型檔或摸路徑;由 registry 於 parse/parseAll 時注入
 *   ctx.filetypes(= app/server/parsers/filetypes 的 exports),本檔以
 *   ctx.filetypes.extractPages(...) 取用。
 *
 * ── 逐列重組策略(PDF 換行錯位)──
 *   pdf-parse 抽出的頁文字以 \n 分行、\t/空白 分欄。單一「項次」可能:
 *     - 名稱換行拆成多行(項次4/6/9/10/11)
 *     - 單位與數字欄落在後續行
 *   規則:以「行首 token 是否為項次 id」為列邊界。
 *     項次 id = 中文大寫(壹貳參肆伍陸柒捌玖拾) 或 純 1~2 位阿拉伯整數。
 *     續行(名稱/單位/數字/『-』)行首永不是裸整數,故不會誤判。
 *   一列收齊所有 token 後:找「單位 token」(面/式/M/M2/組/間/處/式…,以字典+樣式判定);
 *   單位前(去掉 id)為工程項目名稱;單位後依序為
 *     契約單價 / 契約數量 / 本日完成數量 / 本日完成金額 / 累計完成數量。
 *   「-」「－」等無資料 token 一律解析為 null(語意:無資料,非 0)。
 *
 * 檔內漢字碼位:金大 PDF 的 CID 字型把部分漢字(如「年」)映到 CJK 相容區,
 * 已於 filetypes/pdf.js 統一做 NFKC 正規化,本檔拿到的都是標準漢字。
 */
// 中文大寫項次(類別/管理費列)。
const CJK_ITEM_IDS = ['壹', '貳', '參', '肆', '伍', '陸', '柒', '捌', '玖', '拾'];

// 已知單位字典(金大第二聯出現的);另補「以數字/大寫拉丁+可選數字」的樣式判定,
// 涵蓋 M / M2 / M3 等。
const KNOWN_UNITS = new Set(['面', '式', '組', '間', '處', '座', '個', '支', '片', '公尺', '公斤', '噸']);
function isUnitToken(tok) {
  if (KNOWN_UNITS.has(tok)) return true;
  // M / M2 / M3 / CM / MM…(大寫拉丁字母 + 可選數字),排除純數字。
  return /^[A-Z]+\d*$/.test(tok);
}

// 無資料標記(『-』全形/半形、空白)→ null。
function isDash(tok) {
  return tok === '-' || tok === '–' || tok === '—' || tok === '－' || tok === '';
}

// 項次 id 判定(行首 token)。
function isItemId(tok) {
  return CJK_ITEM_IDS.includes(tok) || /^\d{1,2}$/.test(tok);
}

// 把 '2,250' / '1.00' / '-' → number 或 null。
function toNum(tok) {
  if (tok == null || isDash(tok)) return null;
  const cleaned = String(tok).replace(/,/g, '').trim();
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// 民國年 → 西元,回 'YYYY-MM-DD'。
function rocToISO(y, m, d) {
  const year = Number(y) + 1911;
  const mm = String(Number(m)).padStart(2, '0');
  const dd = String(Number(d)).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * 解析單頁(單一天)文字 → { header, dailyRows, extras }。
 * 純函式,不碰檔案;selfTest 亦重用之。
 */
function parsePage(rawText) {
  const text = String(rawText).normalize('NFKC');
  const lines = text.split(/\r?\n/);

  // ── header ──
  const nameMatch = text.match(/工程名稱[:：]\s*([^\t\n]+?)\s*(?:\t|日期[:：]|\n)/);
  const 工程名稱 = nameMatch ? nameMatch[1].trim() : null;

  const dateMatch = text.match(/日期[:：]\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日\s*(星期.)?/);
  const 填報日期 = dateMatch ? rocToISO(dateMatch[1], dateMatch[2], dateMatch[3]) : null;
  const 星期 = dateMatch && dateMatch[4] ? dateMatch[4] : null;

  // 當日累計(本日完成金額):頁尾 `累 計 (本日完成金額) ( 10400.248 )` 或 `本案累計金額 10400.248`
  let 本日累計金額 = null;
  const cumMatch = text.match(/本案累計金額\s*\t?\s*([\d,]+\.?\d*)/)
    || text.match(/累\s*計\s*\(本日完成金額\)[\s\S]*?\(\s*([\d,]+\.?\d*)\s*\)/);
  if (cumMatch) 本日累計金額 = toNum(cumMatch[1]);

  const header = {
    工程名稱,
    填報日期,
    星期,
    天氣_上午: null,   // 金大第二聯無天氣欄
    天氣_下午: null,
    預定進度: null,    // 第二聯無進度%
    實際進度: null,
    出工總人數: null,  // 第二聯無出工明細
    本日累計金額,
  };

  // ── dailyRows:以行首項次 id 為列邊界重組 ──
  // 先定位資料起點(表頭列後),終點(頁尾彙總前)。
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    // 表頭最後一行含「備註」;資料由其後第一個項次 id 行開始。
    if (/完成數量\s*備註|備\s*註/.test(lines[i])) { start = i + 1; break; }
  }

  const rows = [];
  let current = null; // { id, tokens: [] }

  function firstToken(line) {
    const t = line.trim().split(/[\t\s]+/)[0];
    return t;
  }

  function flush() {
    if (current) {
      rows.push(buildRow(current.id, current.tokens));
      current = null;
    }
  }

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '') continue;

    // 頁尾彙總 → 結束
    if (/累\s*計\s*\(本日完成金額\)|本案累計金額|^備\s*註[:：]/.test(trimmed)) {
      flush();
      break;
    }

    const ft = firstToken(line);
    if (isItemId(ft)) {
      // 新項次列開始
      flush();
      // 該行第一 token 是 id,其餘 token 併入
      const rest = trimmed.split(/[\t\s]+/).slice(1);
      current = { id: ft, tokens: rest };
    } else if (current) {
      // 續行:全部 token 併入當前項次
      current.tokens.push(...trimmed.split(/[\t\s]+/));
    }
  }
  flush();

  return { header, dailyRows: rows, extras: {} };
}

/**
 * 由「項次 id + 其後 token 序列」組出一列。
 * token 序列 = 名稱片段… + 單位 + [契約單價, 契約數量, 本日完成數量, 本日完成金額, 累計完成數量]
 * 單位為分界;單位前為名稱,單位後最多 5 個數值欄。
 */
function buildRow(id, tokens) {
  // 找第一個單位 token 位置。
  let unitIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (isUnitToken(tokens[i])) { unitIdx = i; break; }
  }

  let 工程項目 = null;
  let 單位 = null;
  let nums = [];

  if (unitIdx === -1) {
    // 無單位(純類別列,如「壹 直接工程費」):全部 token 皆名稱。
    工程項目 = tokens.join('') || null;
  } else {
    工程項目 = tokens.slice(0, unitIdx).join('') || null;
    單位 = tokens[unitIdx];
    nums = tokens.slice(unitIdx + 1);
  }

  // 名稱清掉殘留空白(pdf 換行不含空白,join('') 即原字)。
  if (工程項目 != null) 工程項目 = 工程項目.replace(/\s+/g, '');

  return {
    項次: id,
    工程項目,
    單位: 單位 || null,
    契約單價: toNum(nums[0]),
    契約數量: toNum(nums[1]),
    本日完成數量: toNum(nums[2]),
    本日完成金額: toNum(nums[3]),
    累計完成數量: toNum(nums[4]),
  };
}

/**
 * parse(filePath, ctx) — 回該檔第一天(第一頁)結構。
 * @param {object} ctx registry 注入;ctx.filetypes.extractPages 抽 PDF 頁文字。
 * @returns {Promise<{header, dailyRows, extras}>}
 */
async function parse(filePath, ctx) {
  const pages = await ctx.filetypes.extractPages(filePath);
  if (!pages.length) return { header: {}, dailyRows: [], extras: {} };
  return parsePage(pages[0].text);
}

/**
 * parseAll(filePath, ctx) — 逐頁(逐日)解析,回每天結構陣列。
 * @returns {Promise<Array<{header, dailyRows, extras}>>}
 */
async function parseAll(filePath, ctx) {
  const pages = await ctx.filetypes.extractPages(filePath);
  return pages.map(p => parsePage(p.text));
}

// selfTest:以內建小樣本頁文字驗證重組邏輯(不依賴檔案,安裝時可執行)。
// 樣本模擬 pdf-parse 對金大頁的輸出(含換行拆散名稱、『-』無資料、中文大寫項次)。
function selfTest() {
  const sample = [
    '公 共 工 程 施 工 日 誌',
    '第二聯',
    '工程名稱：測試工程 \t日期：115 年 04 月 08 日星期三',
    '項次 \t工 程 項 目 \t單位 契約單價 契約數量 本日',
    '完成數量',
    '完成金額',
    '完成數量 備註',
    '壹 \t直接工程費',
    '1 \t工程告示牌(租用) \t面 \t2,250 \t1.0 \t1.00 \t2250.00 \t1.0',
    '3 \t三角錐連桿(租用) \tM \t135 \t72.0 \t- \t- \t-',
    '4 施工動線開闢，整備與復',
    '原工程 式 \t25,200 \t1.0 - \t- \t-',
    '伍 \t營造綜合保險費 \t式 \t5,000 \t1.0 \t1.0 \t5000.0 \t1.0',
    '累 計 (本日完成金額) \t( \t10400.248 )',
    '本案累計金額 \t10400.248',
  ].join('\n');

  try {
    const out = parsePage(sample);
    if (out.header.填報日期 !== '2026-04-08') return false;
    if (out.header.星期 !== '星期三') return false;
    if (out.header.本日累計金額 !== 10400.248) return false;

    const r1 = out.dailyRows.find(r => r.項次 === '1');
    if (!r1 || r1.單位 !== '面' || r1.契約單價 !== 2250 || r1.本日完成金額 !== 2250) return false;

    const r3 = out.dailyRows.find(r => r.項次 === '3');
    if (!r3 || r3.本日完成數量 !== null || r3.本日完成金額 !== null) return false;

    const r4 = out.dailyRows.find(r => r.項次 === '4');
    if (!r4 || r4.單位 !== '式' || r4.契約單價 !== 25200) return false;
    if (!/施工動線開闢/.test(r4.工程項目) || !/原工程/.test(r4.工程項目)) return false;

    const rWu = out.dailyRows.find(r => r.項次 === '伍');
    if (!rWu || rWu.本日完成金額 !== 5000) return false;

    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  meta: {
    vendorKey: '金大營造有限公司',
    version: '1.0.0',
    targetFields: [
      '工程名稱', '填報日期', '星期', '本日累計金額',
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '本日完成金額', '累計完成數量',
    ],
  },
  parse,
  parseAll,
  parsePage,   // 匯出純函式供測試/自檢
  selfTest,
};
