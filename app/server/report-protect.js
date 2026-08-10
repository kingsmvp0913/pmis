/**
 * report-protect.js — 承辦人上傳既有監造報表後的「已填內容保護」
 *
 * ## 為什麼需要這個
 *
 * 承辦人手上常有一份已經做到一半的監造報表,希望上傳後由系統接著往下填,
 * 而不是從空白公版重做。難處在於:**Excel 檔案本身分不出哪些格是他手動填的、
 * 哪些是系統寫的**,而系統後續仍要能更新自己寫過的東西(「後面才發現前面錯了、
 * 重送一次日誌」是日常)。
 *
 * 使用者裁決(2026-08-10):**以上傳那一刻為界**。上傳時把整份報表掃一遍,
 * 記下當下已經有值的儲存格——那些永遠不碰;上傳之後系統自己寫的,重送時照樣更新。
 *
 * ## 為什麼是「切開範圍」而不是「寫回原值」
 *
 * SP0 的 setRange 是把一塊二維陣列整個 `Value2 =` 進去,沒有「這格不要動」的表示法。
 * 看似可以把保護格的值讀出來再填回去,但**那會把公式壓成死值**(範本的複價、
 * 累計金額都是公式),而且完全看不出來。故改成把每一列切成「不含保護格的連續區段」,
 * 各自送一道 setRange。承辦人已填的部分通常是連續的前段日期,切出來的段數有限。
 *
 * Exports:
 *   scanFilledCells(xlsmPath)        → { '分頁名': ['B1','C3',…] }
 *   protectPath(workbookPath)        保護清單的存放路徑
 *   saveProtected(workbookPath, map) / loadProtected(workbookPath)
 *   filterOperations(ops, protectedMap) → 過濾後的 operations
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

// 只掃這幾個分頁:系統會寫入的就這些,別的分頁(封面、監造內容)本來就不碰,
// 掃了只是讓清單變大、比對變慢。
const SHEETS = ['工程基本資料', '契約詳細價目表', '監造報表', '每日施工紀錄'];

/**
 * 掃出「承辦人已經填過」的儲存格。
 *
 * ⚠️ **公式格一律不算**,即使它有計算結果。這一條試過反過來做,後果很嚴重:
 * 公版範本的「每日施工紀錄」光公式格就有 6074 個(第 1 列的日期公式一路鋪到 ACH、
 * 合計列、第 33 列自己就有 506 個),把它們當成「已填」的話,上傳一份幾乎空白的
 * 報表就會保護掉 6000 多格,SP3 之後**寫不進去而且完全看不出來**——承辦人會看到
 * 「已寫入」的成功訊息,報表上卻什麼都沒變。
 *
 * 代價是承辦人若自己在某格寫了公式,那格仍會被系統覆蓋。兩害相權:
 * 前者讓整個功能靜默失效,後者只影響少數自訂公式,而且承辦人看得出來。
 *
 * 空字串不算有值——那是清過的格,不是填過的。
 *
 * @param {string} xlsmPath
 * @returns {Object<string, string[]>} 分頁名 → 儲存格位址陣列
 */
function scanFilledCells(xlsmPath) {
  const wb = XLSX.readFile(xlsmPath, { sheets: SHEETS });
  const out = {};
  for (const name of SHEETS) {
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    const addrs = [];
    for (const key of Object.keys(ws)) {
      if (key.startsWith('!')) continue;
      const c = ws[key];
      if (c == null || c.f) continue;                       // 公式格不算,見上面
      if (c.v == null) continue;
      if (typeof c.v === 'string' && c.v.trim() === '') continue;
      addrs.push(key);
    }
    if (addrs.length) out[name] = addrs;
  }
  return out;
}

/** 保護清單與報表放在一起:兩者同生命週期,刪報表時不會留下孤兒設定。 */
function protectPath(workbookPath) {
  return path.join(path.dirname(workbookPath), 'protected-cells.json');
}

function saveProtected(workbookPath, map) {
  fs.mkdirSync(path.dirname(workbookPath), { recursive: true });
  fs.writeFileSync(protectPath(workbookPath), JSON.stringify(map), 'utf8');
}

/** 沒有保護清單(沒上傳過既有報表)就回空物件——那是常態,不是錯誤。 */
function loadProtected(workbookPath) {
  const p = protectPath(workbookPath);
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) || {}; }
  catch { return {}; }                                       // 壞掉的清單當成沒有,不讓它擋住寫入
}

const colName = (n) => {
  let s = '';
  let v = n;
  while (v > 0) { const r = (v - 1) % 26; s = String.fromCharCode(65 + r) + s; v = Math.floor((v - 1) / 26); }
  return s;
};

/** 'B7' → {col:2, row:7} */
function parseAddr(addr) {
  const m = /^([A-Z]+)(\d+)$/.exec(String(addr).toUpperCase());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col, row: Number(m[2]) };
}

/**
 * 過濾寫入指令,讓保護的儲存格不被覆蓋。
 *
 * - `setCell` 落在保護格 → 整道丟掉
 * - `setRange` → 逐列切成「不含保護格的連續區段」,每段一道新的 setRange
 * - 其餘型別(copyRowDown / insertRowsBelow)原樣保留:那是版面操作不是填值,
 *   而且擋掉它會讓後續的列位置全部錯開,比覆蓋更糟
 *
 * @param {Array} ops SP0 operations
 * @param {Object<string,string[]>} protectedMap
 * @returns {Array} 過濾後的 operations
 */
function filterOperations(ops, protectedMap) {
  const map = protectedMap || {};
  if (!Object.keys(map).length) return ops || [];
  const sets = {};
  for (const [sheet, addrs] of Object.entries(map)) sets[sheet] = new Set(addrs);

  const out = [];
  for (const op of ops || []) {
    const 保護 = sets[op.sheet];
    if (!保護) { out.push(op); continue; }

    if (op.type === 'setCell') {
      if (!保護.has(String(op.addr).toUpperCase())) out.push(op);
      continue;
    }
    if (op.type !== 'setRange') { out.push(op); continue; }

    const start = parseAddr(op.startAddr);
    if (!start) { out.push(op); continue; }
    const values = op.values || [];
    for (let r = 0; r < values.length; r++) {
      const row = values[r] || [];
      let seg = null;
      for (let c = 0; c < row.length; c++) {
        const addr = `${colName(start.col + c)}${start.row + r}`;
        if (保護.has(addr)) {
          if (seg) { out.push(seg); seg = null; }            // 遇到保護格就收掉目前這段
          continue;
        }
        if (!seg) {
          seg = {
            type: 'setRange', sheet: op.sheet,
            startAddr: `${colName(start.col + c)}${start.row + r}`, values: [[]],
          };
        }
        seg.values[0].push(row[c]);
      }
      if (seg) out.push(seg);
    }
  }
  return out;
}

/**
 * 寫入前套用保護。**每一條寫報表的路徑都要經過這裡**(SP1 基本資料、SP2 價目表、
 * SP3 每日施工紀錄),漏掉一條就等於那一條可以蓋掉承辦人已填的內容。
 *
 * 刻意不做進 template-engine.fillTemplate:那是通用的 Excel 寫入工具,
 * 不該知道「保護清單」這個業務概念。代價是三個呼叫端各要記得套用,
 * 故集中成這一個 helper,讓行為只有一份。
 *
 * @param {string} workbookPath 常駐報表路徑(保護清單放在它旁邊)
 * @param {Array} ops
 * @returns {Array}
 */
function applyProtection(workbookPath, ops) {
  return filterOperations(ops, loadProtected(workbookPath));
}

module.exports = {
  SHEETS, scanFilledCells, protectPath, saveProtected, loadProtected,
  filterOperations, applyProtection,
};
