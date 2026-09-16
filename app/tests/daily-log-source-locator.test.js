const fs = require('fs');
const path = require('path');
const filetypes = require('../server/parsers/filetypes');
const { traceSource, PROFILES } = require('../server/daily-log-source-locator');

const PARSER_DIR = path.join(__dirname, '../server/parsers/vendors/samples');
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const parserKeys = fs.readdirSync(PARSER_DIR).filter((f) => f.endsWith('.pmisparser.js')).map((f) => f.split('.')[0]).sort();
const fixtureNames = fs.readdirSync(FIXTURE_DIR)
  .filter((name) => ['.pdf', '.xls', '.xlsx', '.xlsm', '.docx'].includes(path.extname(name).toLowerCase()));
const fixtureCases = fixtureNames.map((name) => {
  const key = parserKeys.find((candidate) => name.toLowerCase().startsWith(candidate));
  return [key, name];
}).filter(([key]) => key);

test('42 間廠商讀取器都有來源定位設定與真實 fixture', () => {
  expect(Object.keys(PROFILES).sort()).toEqual(parserKeys);
  for (const key of parserKeys) expect(fixtureCases.some(([fixtureKey]) => fixtureKey === key)).toBe(true);
});

test.each(fixtureCases)('%s 來源定位：%s', async (key, name) => {
    const parser = require(path.join(PARSER_DIR, `${key}.pmisparser.js`));
    const ext = path.extname(name).toLowerCase(); const file = path.join(FIXTURE_DIR, name);
    const days = await parser.parseAll(file, { filetypes });
    const usableUnit = (r) => r.單位 != null && r.單位 !== '' && !Number.isFinite(Number(r.單位));
    const day = days.find((d) => (d.dailyRows || []).some((r) => r.項次 != null && r.工程項目 && usableUnit(r)))
      || days.find((d) => (d.dailyRows || []).some((r) => r.項次 != null && r.工程項目));
    const headerOnlyDay = !day && days.find((d) => d.header && d.header.實際進度 != null);
    expect(day || headerOnlyDay).toBeTruthy();
    if (headerOnlyDay) {
      const problem = { code: 'H1', 日期: headerOnlyDay.header.填報日期, 項次: null, 訊息: '實際進度異常' };
      const buffer = fs.readFileSync(file);
      const source = await traceSource({ parser, name, buffer, problem, days });
      expect(source).toEqual(expect.objectContaining({ field: '實際進度' }));
      return;
    }
    const row = day.dailyRows.find((r) => r.項次 != null && r.工程項目 && usableUnit(r))
      || day.dailyRows.find((r) => r.項次 != null && r.工程項目);
    const field = usableUnit(row) ? '單位' : '工程項目';
    const problem = { code: usableUnit(row) ? 'E4' : 'E3', 日期: day.header.填報日期, 項次: row.項次, 訊息: `${field}不一致` };
    const buffer = fs.readFileSync(file);
    const source = await traceSource({
      parser, name, buffer, problem, days,
      extractedPages: ext === '.pdf' ? await filetypes.extractItems(buffer) : undefined,
    });
    expect(source).toEqual(expect.objectContaining({ field }));
}, 120000);

test.each([['changze', 'changze.pdf'], ['dexin', 'dexin.xlsx']])('%s 可定位日期欄：%s', async (key, name) => {
  const parser = require(path.join(PARSER_DIR, `${key}.pmisparser.js`));
  const file = path.join(FIXTURE_DIR, name); const buffer = fs.readFileSync(file);
  const days = await parser.parseAll(file, { filetypes }); const day = days.find((d) => d.header.填報日期);
  const problem = { code: 'D3', 日期: day.header.填報日期, 項次: null, 訊息: '填報日期晚於竣工日' };
  const source = await traceSource({
    parser, name, buffer, problem, days,
    extractedPages: path.extname(name) === '.pdf' ? await filetypes.extractItems(buffer) : undefined,
  });
  expect(source).toEqual(expect.objectContaining({ field: '填報日期' }));
}, 120000);
