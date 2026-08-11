/**
 * free-port.js — 啟動前把還占著埠的舊 PMIS 關掉
 *
 * 重複雙擊「啟動.bat」時舊 server 還在 listen,新的一啟動就 EADDRINUSE。
 * 問題不只是啟動失敗:瀏覽器在 listen 之前就開了,連到的是**舊進程**,
 * 剛 git pull 下來的新版沒生效、畫面上卻完全看不出來。
 *
 * 只殺「正在 listen 該埠且映像檔是 node.exe」的進程——埠被別的程式占用時
 * 寧可啟動失敗並說清楚,也不亂殺使用者的其他程式。
 */
const { execFileSync } = require('child_process');

// netstat -ano 的 LISTENING 列取 PID。只認第 2 欄(本地位址),
// 第 3 欄(遠端位址)也帶埠號,一起比會誤殺連到該埠的 client。
function parseListenerPids(stdout, port) {
  const pids = new Set();
  for (const line of String(stdout).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[3] !== 'LISTENING') continue;
    if (!new RegExp(`:${port}$`).test(cols[1])) continue;
    const pid = Number(cols[4]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

// tasklist CSV 首欄即映像檔名;查不到(進程剛結束)回 null。
function imageName(pid, run) {
  try {
    const out = run('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV']);
    const m = String(out).match(/^"([^"]+)"/m);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 釋放埠:關掉占用該埠的舊 node 進程,並等到埠真的空出來。
 * @param {number} port
 * @param {{run?:function, sleep?:function, retries?:number}} [opts] 測試可注入
 * @returns {{killed:number[], blockedBy:string[]}} blockedBy 非空代表埠仍被別的程式占著
 */
function freePort(port, opts = {}) {
  const run = opts.run || ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }));
  const sleep = opts.sleep || sleepSync;
  const retries = opts.retries == null ? 10 : opts.retries;
  const killed = [];
  const blockedBy = [];

  let pids;
  try {
    pids = parseListenerPids(run('netstat', ['-ano']), port);
  } catch {
    return { killed, blockedBy };   // 查不到就當埠是空的,讓 listen 自己去報錯
  }

  for (const pid of pids) {
    if (pid === process.pid) continue;
    const name = imageName(pid, run);
    if (name && name !== 'node.exe') { blockedBy.push(`${name}(PID ${pid})`); continue; }
    try {
      run('taskkill', ['/PID', String(pid), '/F', '/T']);
      killed.push(pid);
    } catch {
      blockedBy.push(`PID ${pid}(關不掉,可能權限不足)`);
    }
  }

  // 進程沒了不代表 socket 立刻釋放,等到 netstat 查不到才回。
  for (let i = 0; killed.length && i < retries; i++) {
    sleep(200);
    try {
      if (parseListenerPids(run('netstat', ['-ano']), port).length === 0) break;
    } catch { break; }
  }
  return { killed, blockedBy };
}

module.exports = { parseListenerPids, imageName, freePort };
