const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const { PDFDocument } = require('pdf-lib');
const filetypes = require('../server/parsers/filetypes');
const { annotateFile } = require('../server/daily-log-annotate');

const cases = [
  ['changze', 'changze.pdf'],
  ['changze', 'changze.xls'],
  ['dexin', 'dexin.xlsx'],
  ['baorong', 'baorong.xlsm'],
  ['yusen', 'yusen-first.docx'],
];

async function run(key, name) {
  const fixture = path.resolve(__dirname, '../tests/fixtures', name);
  const parser = require(path.resolve(__dirname, `../server/parsers/vendors/samples/${key}.pmisparser.js`));
  const days = await parser.parseAll(fixture, { filetypes });
  let day = days.find((candidate) => (candidate.dailyRows || []).some((row) => row.項次 && row.工程項目 && row.單位));
  let problem;
  if (day) {
    const row = day.dailyRows.find((candidate) => candidate.項次 && candidate.工程項目 && candidate.單位);
    problem = { code: 'E4', 日期: day.header.填報日期, 項次: row.項次, 訊息: '單位不一致', 級別: '硬錯' };
  } else {
    day = days.find((candidate) => candidate.header && candidate.header.實際進度 != null);
    problem = { code: 'H1', 日期: day.header.填報日期, 項次: null, 訊息: '實際進度異常', 級別: '警告' };
  }
  const input = fs.readFileSync(fixture); const ext = path.extname(name).toLowerCase();
  const extractedPages = ext === '.pdf' ? await filetypes.extractItems(input) : undefined;
  const marked = await annotateFile({ name, buffer: input }, days, [problem], { parser, extractedPages });
  if (marked.statuses[0] !== '已畫紅框') throw new Error(`${name} 沒有畫框`);
  if (ext === '.pdf') {
    const before = await PDFDocument.load(input); const after = await PDFDocument.load(marked.buffer);
    if (after.getPageCount() !== before.getPageCount() + 1) throw new Error(`${name} 摘要頁不正確`);
  } else if (ext === '.docx') {
    const zip = await JSZip.loadAsync(marked.buffer);
    if (!zip.file('word/document.xml')) throw new Error(`${name} 輸出不是有效 DOCX`);
  } else {
    const before = XLSX.read(input, { type: 'buffer', bookVBA: true });
    const after = XLSX.read(marked.buffer, { type: 'buffer', bookVBA: true });
    if (!after.SheetNames.some((sheet) => /^廠商問題/.test(sheet))) throw new Error(`${name} 缺少摘要分頁`);
    if (ext === '.xlsm' && Boolean(before.vbaraw) !== Boolean(after.vbaraw)) throw new Error(`${name} 巨集未保留`);
  }
  return { vendor: parser.meta.vendorKey, format: ext, fixture: name, status: marked.statuses[0] };
}

(async () => {
  const results = [];
  const selected = process.argv[2] ? cases.filter(([, name]) => name === process.argv[2]) : cases;
  for (const [key, name] of selected) results.push(await run(key, name));
  console.log(JSON.stringify(results, null, 2));
})().catch((err) => { console.error(err); process.exitCode = 1; });
