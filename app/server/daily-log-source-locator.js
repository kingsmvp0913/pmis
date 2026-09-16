/**
 * 將讀取器的標準欄位反查到原始檔位置。每家讀取器都必須列在 PROFILES，
 * 並由 fixtures/桌面真實檔驗證；共用演算法只處理同一種表格幾何，不猜欄位語意。
 */
const XLSX = require('xlsx');
const JSZip = require('jszip');
const fs = require('fs');
const os = require('os');
const path = require('path');
const filetypes = require('./parsers/filetypes');

const PROFILES = Object.fromEntries(
  'akui baorong baoshu changze chengsheng chenhongjun cilifa dexin dongzhen fusen guoqian hejie hewen hongen huisheng jiayuan jinda jingwei jinlin jiumu kunyao licheng lilong mingde mingyou qiquan shangren shenglong xianghe xincheng yiding yile yiqian youhe youqian yuanfang yuanlong yusen zhanxiang zhendian zhengyu zhidong'
    .split(' ').map((key) => [key, {}]),
);

const CODE_FIELDS = {
  A1: ['填報日期'], A2: ['天氣_上午', '天氣_下午'], A3: ['星期'], A4: ['項次'],
  A5: ['工程項目'], A6: ['單位'], A7: ['契約數量'], A8: ['本日完成金額'],
  B2: ['累計完成數量'], B3: ['本日完成金額'], B4: ['本日累計金額'],
  C1: ['累計完成數量'], C2: ['本日累計金額'], C3: ['本日完成數量', '本日完成金額', '累計完成數量'],
  C4: ['預定進度', '實際進度'], D1: ['填報日期'], D3: ['填報日期'], D4: [], D5: [], E1: ['項次'], E2: [], E3: ['工程項目'],
  E4: ['單位'], E5: ['契約數量'], E6: ['契約單價'], F1: ['累計完成數量'],
  F3: ['實際進度'], F4: ['累計完成數量'], G1: ['工程名稱'], G2: ['承攬廠商', '承包廠商'],
  G3: ['開工日期'], G4: ['契約金額'], H1: ['實際進度'], J1: ['天氣_上午', '天氣_下午'],
  J2: ['單位'], J3: ['單位'], J4: ['星期'], J5: ['工程項目'],
};
const LABELS = {
  填報日期: ['填報日期', '填表日期', '日期'], 星期: ['星期'],
  天氣_上午: ['上午'], 天氣_下午: ['下午'], 工程名稱: ['工程名稱'],
  承攬廠商: ['承攬廠商', '承攬商名稱', '承包廠商'], 承包廠商: ['承包廠商', '承攬廠商', '承攬商名稱'],
  契約工期: ['契約工期', '核定工期'], 核定工期: ['核定工期', '契約工期'], 契約金額: ['契約金額'],
  預定進度: ['預定進度'], 實際進度: ['實際進度'], 本日累計金額: ['本日累計金額', '本案累計金額'],
  項次: ['項次', '項號'], 工程項目: ['工程項目', '施工項目', '項目名稱'], 單位: ['單位'],
  契約單價: ['契約單價', '單價'], 契約數量: ['契約數量', '設計數量'],
  本日完成數量: ['本日完成數量', '本日數量'], 本日完成金額: ['本日完成金額', '完成金額'],
  累計完成數量: ['累計完成數量', '完成累計數量', '累計數量'],
};
const norm = (v) => String(v == null ? '' : v).normalize('NFKC').replace(/[\s　,，%％()（）:：]/g, '');

function targetField(problem) {
  const fields = CODE_FIELDS[problem.code] || [];
  if (fields.length < 2) return fields[0] || null;
  return fields.find((f) => norm(problem.訊息).includes(norm(f.replace(/^天氣_/, '')))) || fields[0];
}

function parsedValue(problem, days, field, referenceRow = null) {
  const day = problem.日期 ? (days || []).find((d) => norm(d.header && d.header.填報日期) === norm(problem.日期)) : null;
  if (!day) return { day: null, row: null, value: null };
  const matchingRows = problem.項次 == null ? []
    : (day.dailyRows || []).filter((r) => norm(r.項次) === norm(problem.項次));
  const row = referenceRow
    ? matchingRows.find((r) => norm(r.工程項目) === norm(referenceRow.工程項目)) || null
    : matchingRows[0] || null;
  return { day, row, value: row && Object.hasOwn(row, field) ? row[field] : (day.header || {})[field] };
}

function dateVariants(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return [];
  const y = +m[1]; const mo = +m[2]; const d = +m[3];
  const mm = String(mo).padStart(2, '0'); const dd = String(d).padStart(2, '0'); const roc = y - 1911;
  return [iso, `${y}/${mo}/${d}`, `${y}/${mm}/${dd}`, `${y}年${mo}月${d}日`, `${y}年${mm}月${dd}日`, `${roc}年${mo}月${d}日`,
    `${roc}年${mm}月${dd}日`, `${roc}/${mo}/${d}`, `${roc}/${mm}/${dd}`].map(norm);
}

function excelDateSerial(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000) : null;
}

function sameValue(raw, value) {
  if (value == null || raw == null || raw === '') return false;
  const a = Number(String(raw).replace(/[,，%％]/g, '')); const b = Number(value);
  if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) < 1e-8 || Math.abs(a / 100 - b) < 1e-8;
  const x = norm(raw); const y = norm(value);
  if (x === y || (y.length >= 4 && x.includes(y))) return true;
  const tokens = String(raw).normalize('NFKC').trim().split(/[\s　,，;；:：()（）]+/).map(norm).filter(Boolean);
  return y.length < 4 && tokens.includes(y);
}

function fieldValueMatches(raw, value, field) {
  if (/日期$/.test(field) && value) {
    const variants = dateVariants(value); const serial = excelDateSerial(value);
    return variants.some((variant) => norm(raw).includes(variant))
      || (serial != null && Number(raw) === serial);
  }
  return sameValue(raw, value);
}

function choose(candidates) {
  const best = candidates.sort((a, b) => b.score - a.score);
  if (!best.length || best[0].score < 40) return null;
  if (best[1] && best[1].score === best[0].score && best[1].key !== best[0].key) return null;
  return best[0].source;
}

function workbookCells(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellFormula: true });
  const out = [];
  for (const sheet of wb.SheetNames) {
    const ws = wb.Sheets[sheet];
    if (!ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let r = range.s.r; r <= range.e.r; r++) for (let c = range.s.c; c <= range.e.c; c++) {
      const address = XLSX.utils.encode_cell({ r, c }); const cell = ws[address];
      if (cell && cell.t !== 'e') out.push({ sheet, r, c, address, raw: cell.v, text: cell.w == null ? cell.v : cell.w });
    }
  }
  return out;
}

function excelAddress(ws, cell) {
  const merge = (ws['!merges'] || []).find((m) => cell.r >= m.s.r && cell.r <= m.e.r
    && cell.c >= m.s.c && cell.c <= m.e.c);
  return merge ? XLSX.utils.encode_range(merge) : cell.address;
}

function locateExcel(buffer, problem, days) {
  const field = targetField(problem); if (!field) return null;
  const { row, value } = parsedValue(problem, days, field);
  const cells = workbookCells(buffer); const dates = dateVariants(problem.日期);
  const serial = excelDateSerial(problem.日期);
  const dateCells = cells.filter((c) => dates.some((d) => norm(c.text).includes(d))
    || (serial != null && Number(c.raw) === serial));
  const sheets = new Set(dateCells.map((c) => c.sheet));
  const pool = sheets.size ? cells.filter((c) => sheets.has(c.sheet)) : cells;
  let anchors = row ? pool.filter((c) => sameValue(c.text, row.工程項目)) : [];
  if (!anchors.length && row) anchors = pool.filter((c) => norm(c.text) === norm(row.項次));
  const labels = pool.filter((c) => (LABELS[field] || []).some((x) => norm(c.text).includes(norm(x))));
  const values = value == null ? [] : pool.filter((c) => sameValue(c.text, value));
  const candidates = [];
  for (const c of values) {
    let score = 40;
    const anchorScore = anchors.filter((a) => a.sheet === c.sheet).map((a) =>
      45 + (a.r === c.r ? 80 : 0) + (a.c === c.c ? 60 : 0)
      - (Math.abs(a.r - c.r) + Math.abs(a.c - c.c)) / 20);
    if (anchorScore.length) score = Math.max(score, ...anchorScore);
    const labelScore = labels.filter((l) => l.sheet === c.sheet).map((l) =>
      (l.c === c.c ? 35 : 0) + (l.r === c.r ? 30 : 0) - (Math.abs(l.r - c.r) + Math.abs(l.c - c.c)) / 50);
    if (labelScore.length) score += Math.max(0, ...labelScore);
    const dateScore = dateCells.filter((d) => d.sheet === c.sheet).map((d) =>
      30 - (Math.abs(d.r - c.r) + Math.abs(d.c - c.c)) / 10);
    if (dateScore.length) score += Math.max(0, ...dateScore);
    candidates.push({ score, key: `${c.sheet}!${c.address}`, source: { kind: 'excel', sheet: c.sheet, address: c.address, field } });
  }
  if (!candidates.length && anchors.length && labels.length) {
    for (const a of anchors) for (const l of labels) if (a.sheet === l.sheet) {
      for (const [r, c] of [[a.r, l.c], [l.r, a.c]]) {
        const address = XLSX.utils.encode_cell({ r, c });
        candidates.push({ score: 70 - Math.abs(a.r - l.r) / 20, key: `${a.sheet}!${address}`,
          source: { kind: 'excel', sheet: a.sheet, address, field } });
      }
    }
  }
  return choose(candidates);
}

function pdfRows(items) {
  const groups = [];
  for (const it of (items || []).filter((x) => norm(x.s)).sort((a, b) => b.y - a.y || a.x - b.x)) {
    let g = groups.find((x) => Math.abs(x.y - it.y) <= 4);
    if (!g) { g = { y: it.y, items: [] }; groups.push(g); }
    g.items.push(it);
  }
  return groups;
}

function tokenRect(item, value) {
  const raw = String(item.s || ''); const needle = norm(value);
  if (!needle) return null;
  const compact = [...raw].map((ch, i) => ({ ch, i })).filter((x) => norm(x.ch));
  const joined = compact.map((x) => norm(x.ch)).join(''); const at = joined.indexOf(needle);
  if (at < 0) return null;
  const start = compact[at].i; const end = compact[Math.min(compact.length - 1, at + [...needle].length - 1)].i + 1;
  const unit = raw.length ? (item.w || 10) / raw.length : 10;
  return { x: item.x + start * unit - 2, y: item.y - 3, width: Math.max(10, (end - start) * unit + 4), height: 16 };
}

function locatePdf(pages, problem, days) {
  const field = targetField(problem); if (!field) return null;
  const { row, value } = parsedValue(problem, days, field);
  const variants = dateVariants(problem.日期);
  let pool = pages || [];
  const dated = pool.filter((p) => variants.some((d) => norm(p.items.map((x) => x.s).join('')).includes(d)));
  if (dated.length) pool = dated;
  const candidates = [];
  for (const page of pool) {
    const rows = pdfRows(page.items);
    let anchors = row ? rows.filter((r) => {
      const t = norm(r.items.map((x) => x.s).join(''));
      return t.includes(norm(row.工程項目));
    }) : [];
    if (!anchors.length && row) anchors = rows.filter((r) => r.items.some((x) => norm(x.s) === norm(row.項次)));
    const searchRows = anchors.length ? anchors : rows;
    for (const r of searchRows) for (const item of r.items) {
      if (!sameValue(item.s, value)) continue;
      const rect = tokenRect(item, value) || { x: item.x - 2, y: item.y - 3, width: Math.max(10, item.w + 4), height: 16 };
      candidates.push({ score: 100, key: `${page.page}:${rect.x}:${rect.y}`,
        source: { kind: 'pdf', page: page.page, ...rect, field } });
    }
  }
  return choose(candidates);
}

async function docxCells(buffer) {
  const zip = await JSZip.loadAsync(buffer); const entry = zip.file('word/document.xml');
  if (!entry) return [];
  const xml = await entry.async('string'); const tables = [...xml.matchAll(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g)];
  return tables.flatMap((tm, ti) => [...tm[0].matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)].flatMap((rm, ri) =>
    [...rm[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)].map((cm, ci) => ({
      table: ti + 1, row: ri + 1, column: ci + 1,
      text: [...cm[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join(''),
    }))));
}

async function docxSourceCells(buffer) {
  const zip = await JSZip.loadAsync(buffer); const entry = zip.file('word/document.xml');
  if (!entry) return [];
  const xml = await entry.async('string'); const out = [];
  const decode = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  for (const [ti, tm] of [...xml.matchAll(/<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>/g)].entries()) {
    let cellIndex = 0;
    for (const [ri, rm] of [...tm[0].matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g)].entries()) {
      let column = 0;
      for (const cm of rm[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)) {
        cellIndex++;
        const span = Number(/<w:gridSpan[^>]*w:val="(\d+)"/.exec(cm[0])?.[1] || 1);
        const text = [...cm[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => decode(m[1])).join('');
        out.push({ table: ti, row: ri, column, span, cellIndex, text });
        column += span;
      }
    }
  }
  return out;
}

async function locateDocx(buffer, problem, days) {
  const field = targetField(problem); if (!field) return null;
  const { row, value } = parsedValue(problem, days, field); const cells = await docxCells(buffer);
  const values = cells.filter((c) => sameValue(c.text, value));
  const anchors = row ? cells.filter((c) => sameValue(c.text, row.工程項目) || sameValue(c.text, row.項次)) : [];
  const labels = cells.filter((c) => (LABELS[field] || []).some((x) => norm(c.text).includes(norm(x))));
  return choose(values.map((c) => {
    let score = 40;
    for (const a of anchors) if (a.table === c.table) score += (a.row === c.row ? 80 : 0) + (a.column === c.column ? 50 : 0);
    for (const l of labels) if (l.table === c.table) score += (l.column === c.column ? 35 : 0) + (l.row === c.row ? 30 : 0);
    return { score, key: `${c.table}:${c.row}:${c.column}`, source: { kind: 'word', ...c, text: undefined, field } };
  }));
}

const outputValue = (days, problem, field, referenceRow) => parsedValue(problem, days, field, referenceRow).value;
const changed = (before, after) => {
  if (before == null && after == null) return false;
  if (typeof before === 'number' && typeof after === 'number') return Math.abs(before - after) > 1e-9;
  return norm(before) !== norm(after);
};

async function replay(parser, filePath, overrides) {
  return parser.parseAll(filePath, { filetypes: { ...filetypes, ...overrides } });
}

async function traceExcel(parser, filePath, buffer, problem, days, field) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellFormula: true });
  const before = parsedValue(problem, days, field); const value = before.value;
  const cells = workbookCells(buffer);
  const allCandidates = cells.filter((c) => fieldValueMatches(c.text, value, field));
  let candidates = allCandidates;
  const { row } = before;
  if (row) {
    let anchors = cells.filter((c) => sameValue(c.text, row.工程項目));
    if (!anchors.length) anchors = cells.filter((c) => sameValue(c.text, row.項次));
    let aligned = candidates.filter((c) => anchors.some((a) => a.sheet === c.sheet && a.r === c.r));
    if (!aligned.length) aligned = candidates.filter((c) => anchors.some((a) => a.sheet === c.sheet && a.c === c.c));
    if (aligned.length) candidates = aligned;
  }
  const variants = dateVariants(problem.日期); const serial = excelDateSerial(problem.日期);
  const markers = cells.filter((cell) => variants.some((v) => norm(cell.text).includes(v))
    || (serial != null && Number(cell.raw) === serial));
  const distances = candidates.map((candidate) => ({ candidate, distance: Math.min(...markers
    .filter((m) => m.sheet === candidate.sheet)
    .map((m) => Math.abs(m.r - candidate.r) + Math.abs(m.c - candidate.c)))}))
    .filter((x) => Number.isFinite(x.distance));
  if (distances.length) {
    const nearest = Math.min(...distances.map((x) => x.distance));
    const dated = distances.filter((x) => x.distance === nearest).map((x) => x.candidate);
    if (dated.length) candidates = dated;
  }
  const baseGrids = Object.fromEntries(wb.SheetNames.map((name) => [name, filetypes.gridFromWorksheet(wb.Sheets[name])]));
  const causal = [];
  const tryCandidates = async (pending, rebuildMerges = false) => { for (const candidate of pending) {
    const grids = { ...baseGrids };
    if (rebuildMerges) {
      const ws = { ...wb.Sheets[candidate.sheet] };
      ws[candidate.address] = { ...(ws[candidate.address] || {}), t: 's', v: '__PMIS_SOURCE_TRACE__', w: undefined };
      grids[candidate.sheet] = filetypes.gridFromWorksheet(ws);
    } else {
      grids[candidate.sheet] = baseGrids[candidate.sheet].map((rowValues) => rowValues.slice());
      grids[candidate.sheet][candidate.r][candidate.c] = '__PMIS_SOURCE_TRACE__';
    }
    let out;
    try {
      out = await replay(parser, filePath, {
        readWorkbook: () => ({ sheetNames: wb.SheetNames.slice(), sheets: grids }),
        readSheet: (_p, name) => grids[name] || null,
      });
    } catch { out = []; }
    const after = outputValue(out, problem, field, row);
    if (changed(value, after)) causal.push(candidate);
  } };
  await tryCandidates(candidates);
  if (!causal.length && candidates.length < allCandidates.length) {
    const tried = new Set(candidates.map((c) => `${c.sheet}!${c.address}`));
    await tryCandidates(allCandidates.filter((c) => !tried.has(`${c.sheet}!${c.address}`)));
  }
  if (!causal.length) await tryCandidates(allCandidates, true);
  if (causal.length !== 1) return null;
  const c = causal[0];
  return { kind: 'excel', sheet: c.sheet, address: excelAddress(wb.Sheets[c.sheet], c), field };
}

async function tracePdf(parser, filePath, pages, problem, days, field) {
  const before = parsedValue(problem, days, field); const value = before.value; const allCandidates = [];
  const variants = dateVariants(problem.日期);
  let pagePool = pages;
  const dated = pages.filter((p) => variants.some((d) => norm(p.items.map((x) => x.s).join('')).includes(d)));
  if (dated.length) pagePool = dated;
  for (const p of pagePool) for (let i = 0; i < p.items.length; i++) {
    if (fieldValueMatches(p.items[i].s, value, field)) allCandidates.push({ page: p.page, index: i, item: p.items[i] });
  }
  let candidates = allCandidates;
  const { row } = before;
  if (row) {
    let anchors = [];
    for (const p of pagePool) for (const group of pdfRows(p.items)) {
      if (norm(group.items.map((item) => item.s).join(' ')).includes(norm(row.工程項目))) {
        anchors.push({ page: p.page, item: { y: group.y } });
      }
    }
    if (!anchors.length) for (const p of pagePool) for (const item of p.items) {
      if (sameValue(item.s, row.項次)) anchors.push({ page: p.page, item });
    }
    const aligned = candidates.filter((c) => anchors.some((a) => a.page === c.page && Math.abs(a.item.y - c.item.y) <= 25));
    if (aligned.length) candidates = aligned;
  }
  const causal = [];
  const tryCandidates = async (pending) => { for (const candidate of pending) {
    const changedPages = pages.map((p) => ({ ...p, items: p.items.map((it, i) =>
      p.page === candidate.page && i === candidate.index ? { ...it, s: '__PMIS_SOURCE_TRACE__' } : it) }));
    let out;
    try {
      out = await replay(parser, filePath, {
        extractItems: async () => changedPages,
        extractItemsOcr: async () => changedPages,
      });
    } catch { out = []; }
    if (changed(value, outputValue(out, problem, field, row))) causal.push(candidate);
  } };
  await tryCandidates(candidates);
  if (!causal.length && candidates.length < allCandidates.length) {
    const tried = new Set(candidates.map((c) => `${c.page}:${c.index}`));
    await tryCandidates(allCandidates.filter((c) => !tried.has(`${c.page}:${c.index}`)));
  }
  if (causal.length !== 1) return null;
  const c = causal[0]; const rect = tokenRect(c.item, value)
    || { x: c.item.x - 2, y: c.item.y - 3, width: Math.max(10, (c.item.w || 8) + 4), height: 16 };
  return { kind: 'pdf', page: c.page, ...rect, field };
}

async function traceDocx(parser, filePath, buffer, problem, days, field) {
  const parsed = await filetypes.readDocx(filePath); const before = parsedValue(problem, days, field); const value = before.value;
  const candidates = (await docxSourceCells(buffer)).filter((cell) => fieldValueMatches(cell.text, value, field));
  const causal = [];
  for (const c of candidates) {
    const clone = JSON.parse(JSON.stringify(parsed));
    for (let column = c.column; column < c.column + c.span; column++) {
      clone.tables[c.table][c.row][column] = '__PMIS_SOURCE_TRACE__';
    }
    let seen = 0;
    for (const block of clone.blocks) if (block.type === 'tbl') {
      if (seen++ === c.table) for (let column = c.column; column < c.column + c.span; column++) {
        block.rows[c.row][column] = '__PMIS_SOURCE_TRACE__';
      }
    }
    let out;
    try { out = await replay(parser, filePath, { readDocx: async () => clone }); } catch { out = []; }
    if (changed(value, outputValue(out, problem, field, before.row))) causal.push(c);
  }
  if (causal.length !== 1) return null;
  const c = causal[0]; return { kind: 'word', table: c.table + 1, cell: c.cellIndex, field };
}

async function traceSource({ parser, name, buffer, problem, days, extractedPages }) {
  if (!parser || typeof parser.parseAll !== 'function') throw new Error('來源定位缺少施工日誌讀取器');
  const field = targetField(problem); if (!field) return null;
  const ext = path.extname(name).toLowerCase();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp3-trace-')); const filePath = path.join(dir, `input${ext}`);
  try {
    fs.writeFileSync(filePath, buffer);
    if (/^\.(xls|xlsx|xlsm)$/.test(ext)) return traceExcel(parser, filePath, buffer, problem, days, field);
    if (ext === '.pdf') return tracePdf(parser, filePath, extractedPages || await filetypes.extractItems(buffer), problem, days, field);
    if (ext === '.docx') return traceDocx(parser, filePath, buffer, problem, days, field);
    return null;
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

module.exports = {
  PROFILES, CODE_FIELDS, targetField, parsedValue, locateExcel, locatePdf, locateDocx, traceSource,
  _internal: { sameValue, workbookCells, pdfRows },
};
