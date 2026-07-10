/**
 * registry.js — 廠商讀取器(plugin parser)registry / dispatcher
 *
 * 讀取檔格式:`<vendorKey>.pmisparser.js`,CommonJS module 匯出:
 *   meta   = { vendorKey: string, version: string, targetFields: string[] }
 *   parse(filePath) -> { header: {}, dailyRows: [] }
 *   selfTest?() -> boolean   (選配;安裝時執行以自我驗證,無則視為通過)
 *
 * 讀取檔落地於 PARSER_DIR(程式碼樹外,app 更新不覆蓋),執行時動態載入。
 *
 * Exports:
 *   PARSER_DIR                              讀取檔根目錄(相對本檔求出,PMIS_DATA_DIR 可覆寫)
 *   loadAll()                               掃 PARSER_DIR 全部讀取檔,建 vendorKey → module map
 *   getParser(vendorKey)                    回對應 module 或 null
 *   validateModule(mod, expectedVendorKey)  驗證 module 結構 + selfTest → { ok, error }
 *   install(buffer, expectedVendorKey)      安裝上傳內容(驗證通過才落地並註冊)→ { ok, status?, error? }
 *   remove(vendorKey)                       移除讀取檔 → { ok, error? }
 *   status(vendorKey)                       回 { installed, version?, targetFields?, installedAt? }
 *
 * 安全:
 *   - 只從受控 PARSER_DIR 載入 / 落地。
 *   - vendorKey 一律為純數字(廠商 id);寫檔前驗證,防路徑逃逸。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// 讀取檔根:相對本檔求出(app/server/parsers → repo/data/vendor-parsers),禁止寫死絕對路徑。
// 與 history-routes 一致:PMIS_DATA_DIR 覆寫 data 根,避免測試污染真 data/。
const DATA_DIR = process.env.PMIS_DATA_DIR
  ? path.resolve(process.env.PMIS_DATA_DIR)
  : path.resolve(__dirname, '../../../data');
const PARSER_DIR = path.join(DATA_DIR, 'vendor-parsers');

// vendorKey 必為純數字(廠商 id),否則拒絕(防路徑逃逸)。
function isValidVendorKey(key) {
  return /^\d+$/.test(String(key));
}

function parserPath(vendorKey) {
  return path.join(PARSER_DIR, `${vendorKey}.pmisparser.js`);
}

// 從檔案載入讀取器 module。
//
// 刻意不用 require():測試(Jest)的 require 是沙箱化的,無法載入不在 module graph 內的
// 動態檔;且 require 有快取,更新覆蓋時可能拿到舊版。改以 Node 真正的 Module._compile
// 每次全新編譯,天然支援「更新覆蓋(拿到最新內容)」且不受 Jest runtime 干擾。
// 讀取檔僅來自受控 PARSER_DIR / 暫存,且安裝限 admin(見 parser-routes)。
function loadModuleFromFile(absPath) {
  const src = fs.readFileSync(absPath, 'utf8');
  const mod = new Module(absPath, module);
  mod.filename = absPath;
  // 讓讀取檔內的 require(若有)以其所在目錄解析(僅共用檔型工具用;本階段 dummy 不需)。
  mod.paths = Module._nodeModulePaths(path.dirname(absPath));
  mod._compile(src, absPath);
  return mod.exports;
}

/**
 * 驗證 module 結構:
 *   - meta.vendorKey 存在且等於 expectedVendorKey
 *   - meta.version 存在
 *   - meta.targetFields 為陣列
 *   - parse 為 function
 *   - 若有 selfTest 則必須回 truthy
 *
 * @returns {{ ok: boolean, error?: string }}
 */
function validateModule(mod, expectedVendorKey) {
  if (!mod || typeof mod !== 'object') {
    return { ok: false, error: '讀取檔未匯出有效內容' };
  }
  const meta = mod.meta;
  if (!meta || typeof meta !== 'object') {
    return { ok: false, error: '讀取檔缺少 meta' };
  }
  if (!meta.vendorKey) {
    return { ok: false, error: '讀取檔 meta 缺少 vendorKey' };
  }
  if (String(meta.vendorKey) !== String(expectedVendorKey)) {
    return { ok: false, error: `讀取檔廠商鍵(${meta.vendorKey})與此廠商(${expectedVendorKey})不符,避免裝錯家` };
  }
  if (!meta.version) {
    return { ok: false, error: '讀取檔 meta 缺少 version' };
  }
  if (!Array.isArray(meta.targetFields)) {
    return { ok: false, error: '讀取檔 meta.targetFields 須為陣列' };
  }
  if (typeof mod.parse !== 'function') {
    return { ok: false, error: '讀取檔缺少 parse function' };
  }
  if (mod.selfTest !== undefined) {
    if (typeof mod.selfTest !== 'function') {
      return { ok: false, error: '讀取檔 selfTest 須為 function' };
    }
    let passed;
    try {
      passed = mod.selfTest();
    } catch (e) {
      return { ok: false, error: `讀取檔 selfTest 執行失敗:${e.message}` };
    }
    if (!passed) {
      return { ok: false, error: '讀取檔 selfTest 未通過(內附驗證失敗)' };
    }
  }
  return { ok: true };
}

/**
 * 掃 PARSER_DIR 下所有 *.pmisparser.js,require 後以 meta.vendorKey 建 map。
 * 載入失敗的單一檔不中斷其餘,靜默略過(壞檔不會註冊)。
 *
 * @returns {Map<string, object>} vendorKey → module
 */
function loadAll() {
  const map = new Map();
  if (!fs.existsSync(PARSER_DIR)) return map;
  const files = fs.readdirSync(PARSER_DIR).filter(f => f.endsWith('.pmisparser.js'));
  for (const f of files) {
    const abs = path.join(PARSER_DIR, f);
    let mod;
    try {
      mod = loadModuleFromFile(abs);
    } catch {
      continue; // 載入失敗 → 略過
    }
    const key = mod && mod.meta && mod.meta.vendorKey;
    if (key) map.set(String(key), mod);
  }
  return map;
}

/**
 * 取某廠商的讀取模組(每次重新載入以反映最新安裝狀態)。
 *
 * @returns {object|null}
 */
function getParser(vendorKey) {
  if (!isValidVendorKey(vendorKey)) return null;
  const abs = parserPath(vendorKey);
  if (!fs.existsSync(abs)) return null;
  let mod;
  try {
    mod = loadModuleFromFile(abs);
  } catch {
    return null;
  }
  if (!mod || !mod.meta || String(mod.meta.vendorKey) !== String(vendorKey)) return null;
  return mod;
}

/**
 * 安裝上傳內容:寫暫存 → require → 驗證;通過才搬到 PARSER_DIR 並重載,失敗刪暫存回錯誤。
 *
 * @param {Buffer} buffer            上傳的讀取檔內容
 * @param {string} expectedVendorKey 期望的廠商鍵(純數字廠商 id)
 * @returns {{ ok: boolean, status?: object, error?: string }}
 */
function install(buffer, expectedVendorKey) {
  if (!isValidVendorKey(expectedVendorKey)) {
    return { ok: false, error: '廠商鍵不合法(須為數字廠商 id)' };
  }
  if (!buffer || !buffer.length) {
    return { ok: false, error: '讀取檔內容為空' };
  }

  fs.mkdirSync(PARSER_DIR, { recursive: true });
  // 暫存檔:亂數檔名避免碰撞;必須以 .pmisparser.js 結尾以貼近實際載入情境。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-parser-'));
  const tmpPath = path.join(tmpDir, `${expectedVendorKey}.pmisparser.js`);
  fs.writeFileSync(tmpPath, buffer);

  let mod;
  try {
    mod = loadModuleFromFile(tmpPath);
  } catch (e) {
    cleanupTmp(tmpDir, tmpPath);
    return { ok: false, error: `讀取檔無法載入:${e.message}` };
  }

  const v = validateModule(mod, expectedVendorKey);
  if (!v.ok) {
    cleanupTmp(tmpDir, tmpPath);
    return { ok: false, error: v.error };
  }

  // 驗證通過 → 搬到正式位置(覆蓋舊版)。loadModuleFromFile 每次全新編譯,天然拿到新版。
  const dest = parserPath(expectedVendorKey);
  fs.copyFileSync(tmpPath, dest);
  cleanupTmp(tmpDir, tmpPath);

  return { ok: true, status: status(expectedVendorKey) };
}

function cleanupTmp(tmpDir, tmpPath) {
  try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* noop */ }
  try { fs.rmdirSync(tmpDir); } catch { /* noop */ }
}

/**
 * 移除某廠商讀取檔。
 *
 * @returns {{ ok: boolean, error?: string }}
 */
function remove(vendorKey) {
  if (!isValidVendorKey(vendorKey)) {
    return { ok: false, error: '廠商鍵不合法' };
  }
  const abs = parserPath(vendorKey);
  if (fs.existsSync(abs)) {
    try {
      fs.unlinkSync(abs);
    } catch (e) {
      return { ok: false, error: `移除讀取檔失敗:${e.message}` };
    }
  }
  return { ok: true };
}

/**
 * 讀取檔狀態。
 *
 * @returns {{ installed: boolean, version?, targetFields?, installedAt? }}
 */
function status(vendorKey) {
  if (!isValidVendorKey(vendorKey)) return { installed: false };
  const abs = parserPath(vendorKey);
  if (!fs.existsSync(abs)) return { installed: false };
  const mod = getParser(vendorKey);
  if (!mod) return { installed: false };
  const stat = fs.statSync(abs);
  return {
    installed: true,
    version: mod.meta.version,
    targetFields: mod.meta.targetFields,
    installedAt: stat.mtime.toISOString(),
  };
}

module.exports = {
  PARSER_DIR,
  loadAll,
  getParser,
  validateModule,
  install,
  remove,
  status,
};
