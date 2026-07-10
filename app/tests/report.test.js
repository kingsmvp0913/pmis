/**
 * report.test.js — 監造報表(附表五)產生器測試
 *
 * 驗證 buildSupervisionReport 產出的 workbook「關鍵儲存格值正確」:
 * 表頭(工程名稱/填報日期)、細目表某項次的欄位、以及金額 ROUND_HALF_UP 計算。
 * 用 exceljs 讀回產出的 workbook 斷言(Rule 9:測試驗證產生邏輯的意圖 —
 * 若金額改用銀行家捨入或欄位錯位,這些斷言會失敗)。
 */
const ExcelJS = require('exceljs');
const { buildSupervisionReport, buildMonthlyReport, roundHalfUp } = require('../server/report');

// 找出某欄第一個 value === target 的列號(掃整表)。
function findRow(ws, target) {
  let found = null;
  ws.eachRow((row, rowNumber) => {
    if (found) return;
    row.eachCell((cellObj) => {
      if (found) return;
      if (cellObj.value === target) found = rowNumber;
    });
  });
  return found;
}

// 取某列各欄的值(1-based col)。
function rowValues(ws, rowNumber) {
  const row = ws.getRow(rowNumber);
  const out = [];
  for (let c = 1; c <= 8; c++) out.push(row.getCell(c).value);
  return out;
}

const SAMPLE = {
  工程: {
    工程名稱: '嘉義縣立竹崎高中教育部補助圍牆重建工程',
    工程編號: 'SAMPLE-2026-001',
    契約工期: 90,
    開工日期: '2026-04-08',
    契約竣工日: '2026-07-06',
    契約金額: 10400248,
    決標金額: 10400248,
    預定進度: 5,
  },
  日報: {
    填報日期: '2026-04-08',
    星期: '星期三',
    天氣_上午: '晴',
    天氣_下午: '晴',
    實際進度: 3,
    dailyRows: [
      { 項次: '1', 工程項目: '工程告示牌(租用)', 單位: '面', 契約單價: 2250, 契約數量: 1, 本日完成數量: 1, 本日完成金額: 2250, 累計完成數量: 1 },
      // 本日完成金額缺 → 應由 契約單價 × 本日完成數量 用 ROUND_HALF_UP 補算。
      { 項次: 'X', 工程項目: '測試補算項', 單位: '式', 契約單價: 33.335, 契約數量: 2, 本日完成數量: 2, 本日完成金額: null, 累計完成數量: 2 },
      // 缺欄留空(無資料 → 不編造)。
      { 項次: '3', 工程項目: '三角錐連桿(租用)', 單位: 'M', 契約單價: 135, 契約數量: 72, 本日完成數量: null, 本日完成金額: null, 累計完成數量: null },
    ],
  },
  監造: {},
};

async function buildAndReload() {
  const wb = await buildSupervisionReport(SAMPLE);
  const buf = await wb.xlsx.writeBuffer();
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(buf);
  return wb2.getWorksheet('監造報表');
}

describe('roundHalfUp(台灣四捨五入,非銀行家捨入)', () => {
  test('0 位:30.5→31、31.5→32(銀行家會給 30、32)', () => {
    expect(roundHalfUp(30.5, 0)).toBe(31);
    expect(roundHalfUp(31.5, 0)).toBe(32);
  });
  test('2 位:2250.005→2250.01、33.335×2=66.67', () => {
    expect(roundHalfUp(2250.005, 2)).toBe(2250.01);
    expect(roundHalfUp(33.335 * 2, 2)).toBe(66.67);
  });
  test('null/空 → null(無資料不編造)', () => {
    expect(roundHalfUp(null, 2)).toBeNull();
    expect(roundHalfUp('', 2)).toBeNull();
  });
});

describe('buildSupervisionReport 產出 workbook', () => {
  let ws;
  beforeAll(async () => {
    ws = await buildAndReload();
  });

  test('回傳可讀回的「監造報表」工作表', () => {
    expect(ws).toBeTruthy();
  });

  test('表頭:工程名稱值正確', () => {
    const rowNo = findRow(ws, '工程名稱');
    expect(rowNo).toBeTruthy();
    // 同列右側(合併起始格)即工程名稱值。
    const vals = rowValues(ws, rowNo);
    expect(vals).toContain('嘉義縣立竹崎高中教育部補助圍牆重建工程');
  });

  test('表頭:填報日期含日期與星期', () => {
    const rowNo = findRow(ws, '填報日期');
    expect(rowNo).toBeTruthy();
    const joined = rowValues(ws, rowNo).map((v) => (v == null ? '' : String(v))).join(' ');
    expect(joined).toContain('2026-04-08');
    expect(joined).toContain('星期三');
  });

  test('細目表標題列含 8 欄標準欄名', () => {
    const rowNo = findRow(ws, '項次');
    expect(rowNo).toBeTruthy();
    expect(rowValues(ws, rowNo)).toEqual([
      '項次', '工程項目', '單位', '契約單價', '契約數量',
      '本日完成數量', '本日完成金額', '累計完成數量',
    ]);
  });

  test('項次1 細目各欄值精確(工程項目/契約數量/本日完成數量/金額)', () => {
    // 項次1 資料列在標題「項次」列之後。
    const headerRow = findRow(ws, '項次');
    const rowNo = findRow(ws, '工程告示牌(租用)');
    expect(rowNo).toBeGreaterThan(headerRow);
    const v = rowValues(ws, rowNo);
    expect(v[0]).toBe('1');            // 項次
    expect(v[1]).toBe('工程告示牌(租用)'); // 工程項目
    expect(v[2]).toBe('面');           // 單位
    expect(v[3]).toBe(2250);           // 契約單價
    expect(v[4]).toBe(1);              // 契約數量
    expect(v[5]).toBe(1);              // 本日完成數量
    expect(v[6]).toBe(2250);           // 本日完成金額
    expect(v[7]).toBe(1);              // 累計完成數量
  });

  test('金額缺欄以 契約單價×本日完成數量 ROUND_HALF_UP 補算(33.335×2→66.67)', () => {
    const rowNo = findRow(ws, '測試補算項');
    const v = rowValues(ws, rowNo);
    expect(v[6]).toBe(66.67); // 本日完成金額 = 33.335 × 2 = 66.67(half-up 至 2 位)
  });

  test('缺資料欄留空(不編造 0):項次3 本日完成數量/金額為空', () => {
    const rowNo = findRow(ws, '三角錐連桿(租用)');
    const v = rowValues(ws, rowNo);
    expect(v[5] === '' || v[5] == null).toBe(true); // 本日完成數量
    expect(v[6] === '' || v[6] == null).toBe(true); // 本日完成金額
    expect(v[7] === '' || v[7] == null).toBe(true); // 累計完成數量
  });

  test('五大監造查核項標題齊全(留空填寫區)', () => {
    for (const key of ['一、工程進行情況', '二、監督依照設計圖說', '三、查核材料規格', '四、督導工地職業安全衛生', '五、其他約定監造事項']) {
      let hit = false;
      ws.eachRow((row) => {
        row.eachCell((c) => {
          if (typeof c.value === 'string' && c.value.includes(key)) hit = true;
        });
      });
      expect(hit).toBe(true);
    }
  });

  test('監造單位簽章列存在', () => {
    let hit = false;
    ws.eachRow((row) => {
      row.eachCell((c) => {
        if (typeof c.value === 'string' && c.value.includes('監造單位簽章')) hit = true;
      });
    });
    expect(hit).toBe(true);
  });
});

// ── buildMonthlyReport:多日 → 一個 workbook,每天一 sheet ──
describe('buildMonthlyReport 多日每天一 sheet', () => {
  // 兩天:各一列細目,金額需 ROUND_HALF_UP 補算。
  const DAYS = [
    {
      header: { 工程名稱: '嘉義縣立竹崎高中教育部補助圍牆重建工程', 填報日期: '2026-04-08', 星期: '星期三' },
      dailyRows: [
        { 項次: '1', 工程項目: '工程告示牌(租用)', 單位: '面', 契約單價: 2250, 契約數量: 1, 本日完成數量: 1, 本日完成金額: 2250, 累計完成數量: 1 },
      ],
    },
    {
      header: { 工程名稱: '嘉義縣立竹崎高中教育部補助圍牆重建工程', 填報日期: '2026-04-09', 星期: '星期四' },
      dailyRows: [
        // 本日完成金額缺 → 由 33.335 × 2 = 66.67(half-up)補算。
        { 項次: 'X', 工程項目: '測試補算項', 單位: '式', 契約單價: 33.335, 契約數量: 2, 本日完成數量: 2, 本日完成金額: null, 累計完成數量: 2 },
      ],
    },
  ];
  const 工程 = { 工程名稱: '嘉義縣立竹崎高中教育部補助圍牆重建工程', 工程編號: 'SAMPLE-2026-001' };

  let wb2;
  beforeAll(async () => {
    const wb = await buildMonthlyReport({ 工程, days: DAYS });
    const buf = await wb.xlsx.writeBuffer();
    wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(buf);
  });

  test('每天一 worksheet,sheet 名為填報日期 MM-DD', () => {
    const names = wb2.worksheets.map(w => w.name);
    expect(names).toEqual(['04-08', '04-09']);
  });

  test('第一天 sheet:工程名稱、填報日期、項次1 數量/金額正確', () => {
    const ws = wb2.getWorksheet('04-08');
    const nameRow = findRow(ws, '工程名稱');
    expect(rowValues(ws, nameRow)).toContain('嘉義縣立竹崎高中教育部補助圍牆重建工程');
    const dateRow = findRow(ws, '填報日期');
    const joined = rowValues(ws, dateRow).map(v => (v == null ? '' : String(v))).join(' ');
    expect(joined).toContain('2026-04-08');
    const itemRow = findRow(ws, '工程告示牌(租用)');
    const v = rowValues(ws, itemRow);
    expect(v[5]).toBe(1);      // 本日完成數量
    expect(v[6]).toBe(2250);   // 本日完成金額
  });

  test('第二天 sheet:金額缺欄以 33.335×2 ROUND_HALF_UP → 66.67', () => {
    const ws = wb2.getWorksheet('04-09');
    const dateRow = findRow(ws, '填報日期');
    const joined = rowValues(ws, dateRow).map(v => (v == null ? '' : String(v))).join(' ');
    expect(joined).toContain('2026-04-09');
    const itemRow = findRow(ws, '測試補算項');
    expect(rowValues(ws, itemRow)[6]).toBe(66.67);
  });

  test('督導(單天)也走同函式 → 一張 sheet', async () => {
    const wb = await buildMonthlyReport({ 工程, days: [DAYS[0]] });
    expect(wb.worksheets.map(w => w.name)).toEqual(['04-08']);
  });
});
