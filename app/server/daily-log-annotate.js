/** 施工日誌廠商問題標註：保留原格式產生副本，並回報實際畫框結果。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { extractItems } = require('./parsers/filetypes/pdf');

const DRIVER = path.join(__dirname, 'daily-log-annotate.ps1');
const CODE_LABELS = {
  A1: '填報日期', A2: '天氣', A3: '星期', A4: '項次', A5: '工程項目',
  A6: '單位', A7: '契約數量', A8: '本日完成金額', B2: '累計完成數量',
  B3: '本日完成金額', B4: '本日累計金額', C1: '累計完成數量',
  C2: '累計完成金額', C3: '本日完成數量', C4: '進度', D4: '填報日期',
  D5: '工程項目', E1: '項次', E2: '工程項目', E3: '工程項目', E4: '單位',
  E5: '契約數量', E6: '契約單價', F1: '累計完成數量', F3: '實際進度',
  F4: '累計完成數量', G1: '工程名稱', G2: '承攬廠商', G3: '契約工期',
  G4: '契約金額', H1: '進度', J1: '天氣', J2: '單位', J3: '單位',
  J4: '星期', J5: '工程項目',
};

const norm = (v) => String(v == null ? '' : v).normalize('NFKC').replace(/[\s　]/g, '');
const dateOf = (d) => norm(d && d.header && d.header.填報日期);

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

function locateText(problem, days) {
  const day = problem.日期 ? (days || []).find((d) => dateOf(d) === norm(problem.日期)) : null;
  const rows = day ? day.dailyRows || [] : (days || []).flatMap((d) => d.dailyRows || []);
  const item = problem.項次 == null ? '' : norm(problem.項次);
  if (item) {
    const matches = rows.filter((r) => norm(r.項次) === item);
    const names = [...new Set(matches.map((r) => String(r.工程項目 || '').trim()).filter(Boolean))];
    if (names.length === 1 && norm(names[0]).length >= 3) return names[0];
  }
  return CODE_LABELS[problem.code] || '';
}

function jobsForFile(problems, days) {
  const dates = new Set((days || []).map(dateOf).filter(Boolean));
  return problems.map((problem) => ({
    problem,
    relevant: !problem.日期 || dates.has(norm(problem.日期)),
    searchText: locateText(problem, days),
  }));
}

function dateVariants(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return [];
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  return [iso, `${y}/${mo}/${d}`, `${y - 1911}年${mo}月${d}日`, `${y - 1911}/${mo}/${d}`].map(norm);
}

function textRows(items) {
  const groups = [];
  for (const item of (items || []).filter((it) => norm(it.s)).sort((a, b) => b.y - a.y || a.x - b.x)) {
    let group = groups.find((g) => Math.abs(g.y - item.y) <= 3);
    if (!group) { group = { y: item.y, items: [] }; groups.push(group); }
    group.items.push(item);
  }
  return groups.map((g) => ({
    text: norm(g.items.sort((a, b) => a.x - b.x).map((it) => it.s).join('')),
    x: Math.min(...g.items.map((it) => it.x)),
    y: Math.min(...g.items.map((it) => it.y)),
    right: Math.max(...g.items.map((it) => it.x + Math.max(it.w || 0, 8))),
  }));
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

async function annotatePdf(buffer, jobs, extractedPages) {
  const sourcePages = extractedPages || await extractItems(buffer);
  const doc = await PDFDocument.load(buffer);
  const pages = doc.getPages();
  const status = new Map();
  for (const job of jobs) {
    if (!job.relevant || !norm(job.searchText)) { status.set(job, '未定位'); continue; }
    let candidates = sourcePages;
    const variants = dateVariants(job.problem.日期);
    if (variants.length) {
      const dated = sourcePages.filter((p) => variants.some((v) => norm(p.items.map((it) => it.s).join('')).includes(v)));
      if (dated.length) candidates = dated;
    }
    const target = norm(job.searchText);
    const found = candidates.flatMap((p) => textRows(p.items)
      .filter((row) => row.text.includes(target)).map((row) => ({ page: p.page, row })));
    if (found.length !== 1) { status.set(job, '未定位'); continue; }
    const hit = found[0];
    pages[hit.page - 1].drawRectangle({
      x: Math.max(0, hit.row.x - 3), y: Math.max(0, hit.row.y - 3),
      width: Math.max(12, hit.row.right - hit.row.x + 6), height: 16,
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
  const jobs = jobsForFile(problems, days);
  if (extension === '.pdf') return annotatePdf(file.buffer, jobs, options.extractedPages);
  if (/^\.(xls|xlsx|xlsm|doc|docx)$/.test(extension)) return annotateOffice(file.buffer, extension, jobs);
  throw new Error(`不支援標註 ${extension || '未知'} 格式`);
}

module.exports = {
  annotateFile, findingKey, verifiedProblems, locateText, jobsForFile,
  _internal: { dateVariants, textRows, annotatePdf },
};
