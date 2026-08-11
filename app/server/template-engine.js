/**
 * template-engine.js — 監造報表範本填寫引擎(SP0)
 *
 * 把值寫進監造報表 .xlsm 範本,保留巨集/公式/格式,重算後另存。
 * 純基礎設施,不懂業務:呼叫端(SP1–SP3)自行組出 operations。
 *
 * 因為要保留 VBA 巨集與公式,寫入走 Excel COM(見 excel-com-driver.ps1);
 * COM 只在 Windows PowerShell 5.1 下穩定,故由 Node spawn 5.1 驅動。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DRIVER = path.join(__dirname, 'excel-com-driver.ps1');

// Windows PowerShell 5.1(非 pwsh 7)——COM 物件走訪只在 5.1 穩定。
function powershell51() {
  return path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * 驗證並正規化一份填寫工作(純函式,不碰檔案系統/Excel)。
 * @param {string} templatePath 範本 .xlsm 絕對/相對路徑
 * @param {string} outPath      輸出 .xlsm 路徑
 * @param {Array}  operations   低階操作陣列(setCell/setRange/copyRowDown)
 * @returns {{ templatePath: string, outPath: string, operations: Array }}
 * @throws {Error} 格式不符時
 */
function buildJob(templatePath, outPath, operations) {
  if (typeof templatePath !== 'string' || !/\.xlsm$/i.test(templatePath)) {
    throw new Error('範本必須是 .xlsm 檔');
  }
  if (typeof outPath !== 'string' || !/\.xlsm$/i.test(outPath)) {
    throw new Error('輸出必須是 .xlsm 檔');
  }
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error('operations 需為非空陣列');
  }

  const KNOWN = new Set([
    'setCell', 'setRange', 'copyRowDown', 'insertRowsBelow', 'deleteRows', 'autoFitColumns',
  ]);
  const isPosInt = (n) => Number.isInteger(n) && n >= 1;
  for (const op of operations) {
    if (!op || !KNOWN.has(op.type)) {
      throw new Error(`未知 operation type: ${op && op.type}`);
    }
    if (!op.sheet) throw new Error(`${op.type} 缺 sheet`);
    if (op.type === 'setCell') {
      if (!op.addr) throw new Error('setCell 缺 addr');
    } else if (op.type === 'setRange') {
      if (!op.startAddr) throw new Error('setRange 缺 startAddr');
      if (!Array.isArray(op.values) || op.values.length === 0 || !op.values.every(Array.isArray)) {
        throw new Error('setRange 的 values 須為非空二維陣列');
      }
    } else if (op.type === 'copyRowDown' || op.type === 'insertRowsBelow') {
      if (!isPosInt(op.srcRow)) throw new Error(`${op.type} 的 srcRow 須為正整數`);
      if (!isPosInt(op.count)) throw new Error(`${op.type} 的 count 須為正整數`);
    } else if (op.type === 'deleteRows') {
      // 整列刪除不可逆(公式一起消失),startRow 少驗一次就可能刪掉報表正文
      if (!isPosInt(op.startRow)) throw new Error('deleteRows 的 startRow 須為正整數');
      if (!isPosInt(op.count)) throw new Error('deleteRows 的 count 須為正整數');
    } else if (op.type === 'autoFitColumns') {
      if (!Array.isArray(op.cols) || !op.cols.length
        || !op.cols.every((c) => typeof c === 'string' && /^[A-Z]{1,3}$/.test(c))) {
        throw new Error('autoFitColumns 的 cols 須為欄名陣列(如 ["H","I"])');
      }
    }
  }

  return { templatePath, outPath, operations };
}

const ATTEMPT_TIMEOUT_MS = 45000; // 單次嘗試上限(正常 <15s;超過視為卡頓)
const MAX_ATTEMPTS = 3;           // Excel COM 偶發卡頓→null,重試即可
const RETRY_DELAY_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 單次 spawn PS 5.1 driver 執行 job。逾時/失敗一律 reject,由上層決定是否重試。
function spawnDriver(job) {
  const jobPath = path.join(os.tmpdir(), `sp0-job-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(jobPath, JSON.stringify(job), 'utf8');

  return new Promise((resolve, reject) => {
    execFile(
      powershell51(),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DRIVER, '-JobPath', jobPath],
      // 不可用 windowsHide/CREATE_NO_WINDOW:Excel COM 需要 window station,
      // 隱藏視窗會讓 $wb.Worksheets 回 null。
      { timeout: ATTEMPT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(jobPath); } catch { /* ignore */ }

        const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean);
        if (err && lines.length === 0) {
          return reject(new Error(`Excel 驅動失敗: ${stderr || err.message}`));
        }
        let result;
        try { result = JSON.parse(lines[lines.length - 1]); }
        catch { return reject(new Error(`無法解析驅動輸出:${stdout}\n${stderr}`)); }

        if (!result.ok) return reject(new Error(result.error || 'Excel 驅動未知錯誤'));
        resolve({ ok: true, outPath: result.outPath });
      }
    );
  });
}

// 全域序列化:同時只跑一個 Excel COM job,避免多個 Excel 實例互相卡住。
let _chain = Promise.resolve();

/**
 * 依 operations 填寫範本,保留巨集/公式,重算後另存到 outPath。
 * Excel COM 偶發卡頓,內建序列化 + 重試以確保穩定。
 * @param {string} templatePath 範本 .xlsm(須存在)
 * @param {string} outPath      輸出 .xlsm
 * @param {Array}  operations   setCell/setRange/copyRowDown
 * @returns {Promise<{ ok: true, outPath: string }>}
 */
function fillTemplate(templatePath, outPath, operations) {
  const absTemplate = path.resolve(templatePath);
  const absOut = path.resolve(outPath);
  const job = buildJob(absTemplate, absOut, operations);
  if (!fs.existsSync(absTemplate)) {
    return Promise.reject(new Error(`範本不存在: ${absTemplate}`));
  }

  const run = async () => {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await spawnDriver(job);
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
      }
    }
    throw new Error(`Excel 驅動重試 ${MAX_ATTEMPTS} 次仍失敗:${lastErr && lastErr.message}`);
  };

  const result = _chain.then(run, run);
  // 串起序列,但不讓單次失敗汙染整條鏈。
  _chain = result.then(() => {}, () => {});
  return result;
}

module.exports = { buildJob, fillTemplate };
