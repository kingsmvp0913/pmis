const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PMIS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-shengjie-'));

const registry = require('../server/parsers/registry');
const parser = require('../server/parsers/vendors/samples/shengjie.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'shengjie.pdf');
const ctx = { filetypes };

afterAll(() => {
  fs.rmSync(process.env.PMIS_DATA_DIR, { recursive: true, force: true });
});

test('meta 使用決標公告的正式得標廠商，且 selfTest 通過', () => {
  expect(parser.meta.vendorKey).toBe('聖捷土木包工業');
  expect(parser.selfTest()).toBe(true);
});

describe('真實施工日誌 fixture', () => {
  let days;

  beforeAll(async () => {
    days = await parser.parseAll(FIXTURE, ctx);
  });

  test('18 個施工日完整涵蓋 2026-09-01 至 2026-09-18', () => {
    expect(days).toHaveLength(18);
    expect(days[0].header.填報日期).toBe('2026-09-01');
    expect(days[17].header.填報日期).toBe('2026-09-18');
    for (const day of days) expect(day.dailyRows).toHaveLength(18);
  });

  test('第一天表頭、進度與出工人數取自原表', () => {
    expect(days[0].header).toMatchObject({
      工程名稱: '雲林縣麥寮鄉麥寮國小活動中心漏水災後復建工程',
      填報日期: '2026-09-01',
      星期: '星期二',
      天氣_上午: '細雨',
      天氣_下午: '陰',
      預定進度: 1.22,
      實際進度: 3.63,
      出工總人數: 5,
      承包廠商: '聖捷土木包工業',
      開工日期: '2026-09-01',
    });
    expect(days[0].extras.出工明細).toEqual([{ 工別: '普通工', 人數: 5 }]);
    expect(days[17].header).toMatchObject({ 預定進度: 13.79, 實際進度: 100 });
  });

  test('直接工程長名稱不錯接前後項目', () => {
    expect(days[0].dailyRows.find((row) => row.項次 === '1')).toMatchObject({
      工程項目: '工程告示牌、職安告示牌與交通管制設施(租用)',
      單位: '式', 契約數量: 1, 本日完成數量: 1, 累計完成數量: 1,
    });
    expect(days[0].dailyRows.find((row) => row.項次 === '4')).toMatchObject({
      工程項目: '施工動線開闢與損壞復原;妨礙施工介面相關之構造設備拆除、或遷移與復原,管路整理固定與架高',
      本日完成數量: null, 累計完成數量: null,
    });
    expect(days[0].dailyRows.find((row) => row.項次 === '5').工程項目)
      .toBe('吊車、吊裝與清運設備、施工安全索與防墜措施(租用)');
  });

  test('不把壹大類當明細，並收進第二頁的陸營業稅', () => {
    expect(days[0].dailyRows.some((row) => row.項次 === '壹')).toBe(false);
    expect(days[0].dailyRows.find((row) => row.項次 === '陸')).toMatchObject({
      工程項目: '營業稅((壹~伍)*5%)',
      單位: '式', 契約數量: 1, 本日完成數量: 0.06, 累計完成數量: 0.06,
    });
  });

  test('原表未提供單價與金額，維持 null', () => {
    for (const day of days) {
      expect(day.header.本日累計金額).toBeNull();
      for (const row of day.dailyRows) {
        expect(row.契約單價).toBeNull();
        expect(row.本日完成金額).toBeNull();
      }
    }
  });
});

test('parse 回傳第一天', async () => {
  const day = await parser.parse(FIXTURE, ctx);
  expect(day.header.填報日期).toBe('2026-09-01');
});

test('不同版面的 PDF 不得假陽性命中', async () => {
  await expect(parser.parseAll(path.join(__dirname, 'fixtures', 'jinda.pdf'), ctx))
    .rejects.toThrow(/找不到聖捷建築物施工日誌頁面/);
});

test('registry.install 完整安裝路徑通過', () => {
  const source = fs.readFileSync(path.join(
    __dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'shengjie.pmisparser.js'
  ));
  const result = registry.install(source, '聖捷土木包工業');
  expect(result.ok).toBe(true);
  expect(result.status && result.status.installed).toBe(true);
});
