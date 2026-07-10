/**
 * registry.js — 廠商讀取器(plugin parser)registry / dispatcher
 *
 * 讀取檔格式:`<safe(vendorKey)>.pmisparser.js`,CommonJS module 匯出:
 *   meta   = { vendorKey: string, version: string, targetFields: string[] }
 *   parse(filePath, ctx)    -> { header: {}, dailyRows: [] }
 *   parseAll(filePath, ctx) -> [單日結構…]
 *   selfTest?() -> boolean   (選配;安裝時執行以自我驗證,無則視為通過)
 *
 * vendorKey 為「廠商名稱」(中文字串)。檔案落地名對名稱做檔名安全化,但 registry
 * 的權威 key 一律以**檔案內 meta.vendorKey** 為準(loadAll 讀每檔 meta 建 map),
 * 不靠檔名。
 *
 * 讀取檔落地於 PARSER_DIR(程式碼樹外,app 更新不覆蓋),執行時動態載入。
 *
 * ── filetypes 注入 ──
 *   讀取器不得自己 require 檔型檔或摸路徑。registry require('./filetypes')
 *   取得檔型工具,並於 getParser 包裝時注入為 ctx.filetypes,讀取器以
 *   ctx.filetypes.extractPages(...) 等取用。
 *
 * Exports:
 *   PARSER_DIR                              讀取檔根目錄(相對本檔求出,PMIS_DATA_DIR 可覆寫)
 *   isValidVendorKey(key)                   驗證廠商名稱鍵(非空字串、無檔名危險字元、長度上限)
 *   loadAll()                               掃 PARSER_DIR 全部讀取檔,建 meta.vendorKey → 包裝物件 map
 *   getParser(vendorKey)                    回對應包裝物件 { meta, parse, parseAll, selfTest } 或 null
 *   validateModule(mod, expectedVendorKey)  驗證 module 結構 + selfTest → { ok, error }
 *   install(buffer, expectedVendorKey)      安裝上傳內容(驗證通過才落地並註冊)→ { ok, status?, error? }
 *   remove(vendorKey)                       移除讀取檔 → { ok, error? }
 *   status(vendorKey)                       回 { installed, version?, targetFields?, installedAt? }
 *
 * 安全:
 *   - 只從受控 PARSER_DIR 載入 / 落地。
 *   - vendorKey 為廠商名稱;寫檔前做檔名安全化並驗證,防路徑逃逸。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// 檔型工具(注入用):正常相對 require,注入給讀取器的 ctx.filetypes。
const filetypes = require('./filetypes');

// 讀取檔根:相對本檔求出(app/server/parsers → repo/data/vendor-parsers),禁止寫死絕對路徑。
// 與 history-routes 一致:PMIS_DATA_DIR 覆寫 data 根,避免測試污染真 data/。
const DATA_DIR = process.env.PMIS_DATA_DIR
  ? path.resolve(process.env.PMIS_DATA_DIR)
  : path.resolve(__dirname, '../../../data');
const PARSER_DIR = path.join(DATA_DIR, 'vendor-parsers');

// 檔名危險字元:路徑分隔與 Windows 保留字元、控制字元。
const UNSAFE_CHARS = /[\\/:*?"<>|\x00-\x1f]/;
const MAX_KEY_LEN = 100;

// vendorKey = 廠商名稱(中文字串)。規則:
//   - 必為非空字串(去頭尾空白後仍非空,且原字串首尾不得有空白)
//   - 不含檔名危險字元(\ / : * ? " < > | 與控制字元)
//   - 非單獨 '.' 或 '..'
//   - 長度上限 MAX_KEY_LEN
function isValidVendorKey(key) {
  if (typeof key !== 'string') return false;
  if (key.length === 0 || key.length > MAX_KEY_LEN) return false;
  if (key !== key.trim()) return false; // 開頭/結尾空白
  if (key === '.' || key === '..') return false;
  if (UNSAFE_CHARS.test(key)) return false;
  return true;
}

// 廠商名稱 → 檔名安全片段。已通過 isValidVendorKey 者僅需再擋單獨點號情境;
// 這裡不改動合法中文字元,只把危險字元(理論上已被 isValidVendorKey 擋掉)替換為 '_'。
function safeFileName(vendorKey) {
  return String(vendorKey).replace(new RegExp(UNSAFE_CHARS.source, 'g'), '_');
}

function parserPath(vendorKey) {
  return path.join(PARSER_DIR, `${safeFileName(vendorKey)}.pmisparser.js`);
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
  // 讓讀取檔內的 require 解析:先看自身目錄,再**接上 registry 自己的 node_modules 路徑**。
  // 關鍵:讀取器安裝到 data/vendor-parsers/ 後,該目錄沒有 node_modules;若讀取器(或其
  // selfTest)require 了 xlsx/pdf-parse 等,沒有這段就會在安裝時 selfTest 靜默失敗。
  mod.paths = Module._nodeModulePaths(path.dirname(absPath)).concat(module.paths);
  mod._compile(src, absPath);
  return mod.exports;
}

// 把原始 module 包成注入式物件:parse/parseAll 自動帶入 ctx.filetypes;
// selfTest 維持純函式(不需 ctx)。meta 原樣透出。
function wrap(mod) {
  return {
    meta: mod.meta,
    parse: (filePath, ctx) =>
      mod.parse(filePath, Object.assign({ filetypes }, ctx)),
    parseAll: typeof mod.parseAll === 'function'
      ? (filePath, ctx) => mod.parseAll(filePath, Object.assign({ filetypes }, ctx))
      : undefined,
    selfTest: mod.selfTest,
  };
}

/**
 * 驗證 module 結構:
 *   - meta.vendorKey 存在、為合法廠商名稱鍵,且等於 expectedVendorKey
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
  if (!isValidVendorKey(String(meta.vendorKey))) {
    return { ok: false, error: '讀取檔 meta.vendorKey 不是合法廠商名稱(空白/含危險字元/過長)' };
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
      // 純函式;檔型型讀取器(如 Excel)的 selfTest 需要檔型工具建 grid,
      // 一併注入 filetypes(文字型如 PDF 讀取器可忽略此參數)。
      passed = mod.selfTest(filetypes);
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
 * 掃 PARSER_DIR 下所有 *.pmisparser.js,載入後以 meta.vendorKey(廠商名稱)建 map。
 * 權威 key 一律以檔案內 meta.vendorKey 為準,不靠檔名。
 * 載入失敗的單一檔不中斷其餘,靜默略過(壞檔不會註冊)。
 *
 * @returns {Map<string, object>} meta.vendorKey → 包裝物件
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
    if (key) map.set(String(key), wrap(mod));
  }
  return map;
}

/**
 * 取某廠商(名稱)的讀取包裝物件(每次重新載入以反映最新安裝狀態)。
 * 以 meta.vendorKey 為權威 key 比對,不靠檔名。
 *
 * @returns {object|null} { meta, parse, parseAll, selfTest }
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
  return wrap(mod);
}

/**
 * 檢視上傳內容:寫暫存 → 載入 → 以其自身 meta.vendorKey 驗證結構 + selfTest,
 * 不落地。供批次安裝先讀 meta.vendorKey(廠商名稱)以決定歸位。
 *
 * @param {Buffer} buffer 上傳的讀取檔內容
 * @returns {{ ok: boolean, meta?: object, error?: string }}
 */
function inspect(buffer) {
  if (!buffer || !buffer.length) {
    return { ok: false, error: '讀取檔內容為空' };
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-parser-'));
  const tmpPath = path.join(tmpDir, 'inspect.pmisparser.js');
  fs.writeFileSync(tmpPath, buffer);
  let mod;
  try {
    mod = loadModuleFromFile(tmpPath);
  } catch (e) {
    cleanupTmp(tmpDir, tmpPath);
    return { ok: false, error: `讀取檔無法載入:${e.message}` };
  }
  const selfKey = mod && mod.meta && mod.meta.vendorKey;
  const v = validateModule(mod, selfKey);
  cleanupTmp(tmpDir, tmpPath);
  if (!v.ok) return { ok: false, error: v.error };
  return { ok: true, meta: mod.meta };
}

/**
 * 安裝上傳內容:寫暫存 → 載入 → 驗證;通過才搬到 PARSER_DIR 並重載,失敗刪暫存回錯誤。
 *
 * @param {Buffer} buffer            上傳的讀取檔內容
 * @param {string} expectedVendorKey 期望的廠商鍵(廠商名稱)
 * @returns {{ ok: boolean, status?: object, error?: string }}
 */
function install(buffer, expectedVendorKey) {
  if (!isValidVendorKey(expectedVendorKey)) {
    return { ok: false, error: '廠商鍵不合法(須為非空廠商名稱,不含檔名危險字元)' };
  }
  if (!buffer || !buffer.length) {
    return { ok: false, error: '讀取檔內容為空' };
  }

  fs.mkdirSync(PARSER_DIR, { recursive: true });
  // 暫存檔:亂數目錄避免碰撞;必須以 .pmisparser.js 結尾以貼近實際載入情境。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-parser-'));
  const tmpPath = path.join(tmpDir, `${safeFileName(expectedVendorKey)}.pmisparser.js`);
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
 * 移除某廠商(名稱)讀取檔。
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
 * 讀取檔狀態(以廠商名稱查)。
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
  isValidVendorKey,
  loadAll,
  getParser,
  validateModule,
  inspect,
  install,
  remove,
  status,
};
