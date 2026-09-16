const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const { PDFDocument } = require('pdf-lib');
const filetypes = require('../server/parsers/filetypes');
const { annotateFile, _internal: { workbookSheetPaths } } = require('../server/daily-log-annotate');
const { traceSource } = require('../server/daily-log-source-locator');

const APP_DIR = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(APP_DIR, 'tests', 'fixtures');
const PARSER_DIR = path.join(APP_DIR, 'server', 'parsers', 'vendors', 'samples');
const DESKTOP = path.join(process.env.USERPROFILE, 'OneDrive', 'Desktop');
const DESKTOP_ROOTS = [path.join(DESKTOP, 'PMIS範例'), path.join(DESKTOP, '0825修正項目')];
const SUPPORTED = new Set(['.pdf', '.xls', '.xlsx', '.xlsm', '.docx']);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function desktopFixtureMap() {
  const byHash = new Map();
  for (const file of DESKTOP_ROOTS.flatMap(walk).filter((name) => SUPPORTED.has(path.extname(name).toLowerCase()))) {
    const hash = sha256(file);
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(file);
  }
  return byHash;
}

function chooseProblem(days) {
  const usableUnit = (row) => row.單位 != null && row.單位 !== '' && !Number.isFinite(Number(row.單位));
  const day = days.find((candidate) => (candidate.dailyRows || [])
    .some((row) => row.項次 != null && row.工程項目 && usableUnit(row)))
    || days.find((candidate) => (candidate.dailyRows || [])
      .some((row) => row.項次 != null && row.工程項目));
  if (day) {
    const row = day.dailyRows.find((candidate) => candidate.項次 != null
      && candidate.工程項目 && usableUnit(candidate))
      || day.dailyRows.find((candidate) => candidate.項次 != null && candidate.工程項目);
    const unit = usableUnit(row);
    return {
      級別: '硬錯', code: unit ? 'E4' : 'E3', 日期: day.header.填報日期,
      項次: row.項次, 訊息: `${unit ? '單位' : '工程項目'}不一致`,
    };
  }
  const headerDay = days.find((candidate) => candidate.header && candidate.header.實際進度 != null);
  if (!headerDay) throw new Error('找不到可用的測試問題');
  return {
    級別: '警告', code: 'H1', 日期: headerDay.header.填報日期,
    項次: null, 訊息: '實際進度異常',
  };
}

async function verifyOutput(input, output, ext, source) {
  if (ext === '.pdf') {
    const before = await PDFDocument.load(input);
    const after = await PDFDocument.load(output);
    if (source.kind !== 'pdf' || source.page < 1 || source.page > before.getPageCount()) {
      throw new Error('PDF 來源頁碼無效');
    }
    if (after.getPageCount() !== before.getPageCount() + 1) throw new Error('PDF 摘要頁未加入');
    return;
  }
  if (ext === '.docx') {
    if (source.kind !== 'word') throw new Error('Word 來源位置無效');
    const zip = await JSZip.loadAsync(output);
    const xml = await zip.file('word/document.xml')?.async('string');
    if (!xml || !xml.includes('廠商問題摘要')) throw new Error('DOCX 無法重新開啟或缺少摘要');
    return;
  }
  if (source.kind !== 'excel') throw new Error('Excel 來源位置無效');
  if (ext === '.xlsx' || ext === '.xlsm') {
    const protectionTags = async (buffer) => {
      const zip = await JSZip.loadAsync(buffer); const tags = [];
      const sheets = await workbookSheetPaths(zip);
      for (const [sheet, name] of [...sheets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const xml = await zip.file(name).async('string');
        tags.push(...[...xml.matchAll(/<sheetProtection\b[^>]*(?:\/>|>[\s\S]*?<\/sheetProtection>)/g)]
          .map((match) => `${sheet}:${match[0]}`));
      }
      return tags;
    };
    const beforeProtection = await protectionTags(input);
    const afterProtection = await protectionTags(output);
    if (JSON.stringify(afterProtection) !== JSON.stringify(beforeProtection)) {
      throw new Error(`Excel 工作表保護設定改變\nBEFORE ${JSON.stringify(beforeProtection)}\nAFTER ${JSON.stringify(afterProtection)}`);
    }
  }
  const before = XLSX.read(input, { type: 'buffer', bookVBA: true });
  const after = XLSX.read(output, { type: 'buffer', bookVBA: true });
  if (!after.SheetNames.includes(source.sheet)) throw new Error('Excel 原工作表遺失');
  if (!after.SheetNames.some((sheet) => /^廠商問題/.test(sheet))) throw new Error('Excel 缺少摘要工作表');
  if (ext === '.xlsm' && Boolean(before.vbaraw) !== Boolean(after.vbaraw)) throw new Error('XLSM 巨集資訊改變');
}

async function auditCase(key, fixture, desktopByHash) {
  const parser = require(path.join(PARSER_DIR, `${key}.pmisparser.js`));
  const fixturePath = path.join(FIXTURE_DIR, fixture);
  const matches = desktopByHash.get(sha256(fixturePath)) || [];
  const inputPath = matches[0] || fixturePath;
  const origin = matches.length
    ? path.relative(DESKTOP, inputPath)
    : '由桌面 PMIS範例原始 .doc 轉換的 hongen.pdf fixture';
  const name = path.basename(inputPath);
  const ext = path.extname(name).toLowerCase();
  const input = fs.readFileSync(inputPath);
  const days = await parser.parseAll(inputPath, { filetypes });
  const problem = chooseProblem(days);
  const extractedPages = ext === '.pdf' ? await filetypes.extractItems(input) : undefined;
  const source = await traceSource({ parser, name, buffer: input, problem, days, extractedPages });
  if (!source) throw new Error('未唯一定位來源');
  process.stderr.write(`SOURCE ${key} ${JSON.stringify(source)}\n`);
  const marked = await annotateFile({ name, buffer: input }, days, [problem], { parser, extractedPages });
  if (marked.statuses[0] !== '已畫紅框') throw new Error('未回報已畫紅框');
  await verifyOutput(input, marked.buffer, ext, source);
  return {
    vendorKey: parser.meta.vendorKey, parser: key, format: ext,
    input: origin, field: source.field, source, status: marked.statuses[0], reopened: true,
  };
}

(async () => {
  const desktopByHash = desktopFixtureMap();
  const parserKeys = fs.readdirSync(PARSER_DIR).filter((name) => name.endsWith('.pmisparser.js'))
    .map((name) => name.split('.')[0]).sort();
  const fixtures = fs.readdirSync(FIXTURE_DIR).filter((name) => SUPPORTED.has(path.extname(name).toLowerCase()));
  const selected = parserKeys.map((key) => {
    const choices = fixtures.filter((name) => name.toLowerCase().startsWith(key));
    const exact = choices.find((name) => desktopByHash.has(sha256(path.join(FIXTURE_DIR, name))));
    const fixture = exact || choices[0];
    if (!fixture) throw new Error(`${key} 沒有可用 fixture`);
    return [key, fixture];
  }).filter(([key]) => {
    const requested = process.argv[2];
    if (!requested) return true;
    return requested.startsWith('from:') ? key >= requested.slice(5) : key === requested;
  });
  const results = [];
  for (const [key, fixture] of selected) {
    process.stderr.write(`RUN ${key} ${fixture}\n`);
    const result = await auditCase(key, fixture, desktopByHash);
    results.push(result);
    process.stderr.write(`PASS ${key} ${result.format} ${result.field}\n`);
  }
  const report = {
    vendors: results.length,
    directDesktopFiles: results.filter((result) => !result.input.startsWith('由桌面')).length,
    convertedDesktopFiles: results.filter((result) => result.input.startsWith('由桌面')).length,
    results,
  };
  const reportPath = path.join(os.tmpdir(), 'pmis-daily-log-all-vendors-audit.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, results: undefined, reportPath }, null, 2));
})().catch((err) => { console.error(err); process.exitCode = 1; });
