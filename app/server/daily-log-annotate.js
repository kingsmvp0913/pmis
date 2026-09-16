/** 施工日誌廠商問題標註：保留原格式產生副本，並回報實際畫框結果。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { traceSource } = require('./daily-log-source-locator');

const DRIVER = path.join(__dirname, 'daily-log-annotate.ps1');

function findingKey(p) {
  return JSON.stringify([p.級別 || '', p.code || '', p.日期 || '', p.項次 || '', p.訊息 || '']);
}

function verifiedProblems(selected, result) {
  const valid = new Map([
    ...(result.errors || []).map((p) => [{ ...p, 級別: '硬錯' }, '硬錯']),
    ...(result.warnings || []).map((p) => [{ ...p, 級別: '警告' }, '警告']),
  ].map(([p]) => [findingKey(p), p]));
  return (selected || []).map((p) => valid.get(findingKey(p))).filter(Boolean);
}

function wrapLine(text, size = 44) {
  const chars = [...String(text || '')];
  const out = [];
  while (chars.length) out.push(chars.splice(0, size).join(''));
  return out.length ? out : [''];
}

function chineseFontPath() {
  const root = process.env.SystemRoot || process.env.WINDIR;
  if (!root) return null;
  return ['kaiu.ttf', 'NotoSansTC-VF.ttf'].map((n) => path.join(root, 'Fonts', n))
    .find((p) => fs.existsSync(p)) || null;
}

async function annotatePdf(buffer, jobs) {
  const doc = await PDFDocument.load(buffer);
  const pages = doc.getPages();
  const status = new Map();
  for (const job of jobs) {
    const hit = job.source;
    if (!hit) { status.set(job, '未定位'); continue; }
    pages[hit.page - 1].drawRectangle({
      x: Math.max(0, hit.x), y: Math.max(0, hit.y),
      width: Math.max(10, hit.width), height: Math.max(10, hit.height),
      borderColor: rgb(0.9, 0, 0), borderWidth: 2,
    });
    status.set(job, '已畫紅框');
  }

  const fontPath = chineseFontPath();
  if (!fontPath) throw new Error('伺服器缺少可輸出繁體中文的字型');
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(fontPath), { subset: true });
  let page = doc.addPage([595, 842]);
  let y = 800;
  page.drawText('廠商問題摘要', { x: 42, y, size: 18, font, color: rgb(0.75, 0, 0) });
  y -= 30;
  for (const job of jobs) {
    const p = job.problem;
    const line = `${p.級別 || ''} ${p.code || ''} ${p.日期 || '全案'} 項次:${p.項次 || '—'} [${status.get(job) || '未定位'}] ${p.訊息 || ''}`;
    for (const part of wrapLine(line)) {
      if (y < 45) { page = doc.addPage([595, 842]); y = 800; }
      page.drawText(part, { x: 42, y, size: 10, font, color: rgb(0.15, 0.15, 0.15) });
      y -= 16;
    }
    y -= 5;
  }
  return { buffer: Buffer.from(await doc.save()), statuses: jobs.map((j) => status.get(j) || '未定位') };
}

function powershell51() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function execOffice(driver, args) {
  return new Promise((resolve, reject) => {
    execFile(powershell51(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver, ...args],
      { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || stdout || err.message).trim()));
        resolve(String(stdout || '').trim());
      });
  });
}

async function annotateOffice(buffer, extension, jobs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp3-mark-'));
  const input = path.join(dir, `input${extension}`);
  const output = path.join(dir, `output${extension}`);
  const json = path.join(dir, 'problems.json');
  const driver = path.join(dir, 'daily-log-annotate.ps1');
  try {
    fs.writeFileSync(input, buffer);
    fs.writeFileSync(json, JSON.stringify(jobs), 'utf8');
    // Windows PowerShell 5.1 會把沒有 BOM 的 UTF-8 腳本當成本機 ANSI，中文屬性名稱會直接變成語法錯誤。
    fs.writeFileSync(driver, `\uFEFF${fs.readFileSync(DRIVER, 'utf8')}`, 'utf8');
    const kind = /^\.docx?$/i.test(extension) ? 'Word' : 'Excel';
    const raw = await execOffice(driver, ['-InputPath', input, '-OutputPath', output, '-ProblemsPath', json, '-Kind', kind]);
    const statuses = JSON.parse(raw || '[]').map((s) => s === 'marked' ? '已畫紅框' : '未定位');
    return { buffer: fs.readFileSync(output), statuses };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function annotateFile(file, days, problems, options = {}) {
  const extension = path.extname(file.name).toLowerCase();
  const jobs = problems.map((problem) => ({ problem, days }));
  for (const job of jobs) job.source = await traceSource({
    parser: options.parser,
    name: file.name,
    buffer: file.buffer,
    problem: job.problem,
    days,
    extractedPages: options.extractedPages,
  });
  if (extension === '.pdf') return annotatePdf(file.buffer, jobs);
  if (/^\.(xls|xlsx|xlsm|doc|docx)$/.test(extension)) return annotateOffice(file.buffer, extension, jobs);
  throw new Error(`不支援標註 ${extension || '未知'} 格式`);
}

module.exports = {
  annotateFile, findingKey, verifiedProblems,
  _internal: { annotatePdf },
};
