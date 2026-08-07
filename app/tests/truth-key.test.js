const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { readTruthKey, readTruthItems, LABELS, ITEM_HEADERS } = require('../server/truth-key');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-truth-'));
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

// 造一份「工程基本資料」分頁。labels 可覆寫 A 欄標籤以測防線;values 為 B 欄。
function makeBook({ labels = LABELS, values = [], extraSheet = true } = {}) {
  const aoa = labels.map((l, i) => [l, values[i] === undefined ? null : values[i]]);
  const wb = XLSX.utils.book_new();
  if (extraSheet) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['封面']]), '封面');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), '工程基本資料');
  const p = path.join(TMP, `b${Math.floor(process.hrtime()[1])}.xlsx`);
  XLSX.writeFile(wb, p);
  return p;
}

const FULL = [
  '竹崎圍牆工程', '呂罡銘建築師事務所', '嘉義縣竹崎國小', '呂罡銘建築師事務所',
  '金大營造有限公司', 1070000, 34, 45338, '', 'zxes1130101',
];

test('標籤與預期相符時抽出 9 欄', () => {
  const k = readTruthKey(makeBook({ values: FULL }));
  expect(k.工程名稱).toBe('竹崎圍牆工程');
  expect(k.監造單位).toBe('呂罡銘建築師事務所');
  expect(k.主辦機關).toBe('嘉義縣竹崎國小');
  expect(k.承包廠商).toBe('金大營造有限公司');
  expect(k.契約金額).toBe(1070000);
  expect(k.契約工期).toBe(34);
  expect(k.工程編號).toBe('zxes1130101');
});

// 這條是整份差異報告正確性的唯一防線。版面若哪天改了而這裡不擋,抽到的就是錯格的值,
// 報告卻看起來完全正常——所有「不一致」都會被誤讀成讀取器的錯。
test('A 欄標籤與預期不符時 throw,不猜', () => {
  const bad = [...LABELS];
  bad[4] = '施工廠商'; // 原為「承包廠商」
  expect(() => readTruthKey(makeBook({ labels: bad, values: FULL })))
    .toThrow(/A5.*承包廠商.*施工廠商/);
});

test('缺少「工程基本資料」分頁時 throw', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), '封面');
  const p = path.join(TMP, 'nosheet.xlsx');
  XLSX.writeFile(wb, p);
  expect(() => readTruthKey(p)).toThrow(/工程基本資料/);
});

// 成品裡開工日期存的是 Excel 序號(實測 49/49 皆然)。不轉的話比對層拿到 45338,
// 與決標公告側的 '2024-02-01' 永遠判不一致,而那是格式問題不是讀取器問題。
test('開工日期由 Excel 序號轉成 ISO 字串', () => {
  const k = readTruthKey(makeBook({ values: FULL }));
  expect(k.開工日期).toBe('2024-02-16'); // 序號 45338
});

test('開工日期已是字串時原樣保留', () => {
  const v = [...FULL]; v[7] = '2024-02-16';
  expect(readTruthKey(makeBook({ values: v })).開工日期).toBe('2024-02-16');
});

// 空白要回 null 而非 ''。比對層把 null 當「缺值」、'' 會被當成「有值但空」,
// 兩者在報告裡是不同的一格(「答案卷沒填」vs「不一致」)。
test('空白儲存格回 null 而非空字串', () => {
  const v = [...FULL]; v[6] = ''; v[9] = '   ';
  const k = readTruthKey(makeBook({ values: v }));
  expect(k.契約工期).toBeNull();
  expect(k.工程編號).toBeNull();
});

// ── 契約詳細價目表 ────────────────────────────────────────
// 49 案實測:表頭固定在第 1 列,欄序 項次/工程項目/單位/契約數量/契約單價/契約複價,
// 資料 10~47 列,無空案。
describe('readTruthItems — 契約詳細價目表', () => {
  // 成品的表頭帶換行與字間空白(「工 程 項 目」「契約\n數量」),驗證時要吃得下
  const HDR = ['項次', '工 程 項 目', '單位', '契約\n數量', '契約\n單價', '契約\n複價'];

  function makeItemBook({ header = HDR, rows = [] } = {}) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['封面']]), '封面');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), '契約詳細價目表');
    const p = path.join(TMP, `i${Math.floor(process.hrtime()[1])}.xlsx`);
    XLSX.writeFile(wb, p);
    return p;
  }

  const ROWS = [
    ['壹.1', '工程告示牌與交通管制設施(租用)', '式', 1, 25664, 25664],
    ['壹.2', '施工動線開闢與損害復原', '式', 1, 3952, 3952],
  ];

  test('抽出逐項的六個欄位', () => {
    const items = readTruthItems(makeItemBook({ rows: ROWS }));
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      項次: '壹.1', 名稱: '工程告示牌與交通管制設施(租用)', 單位: '式',
      數量: 1, 單價: 25664, 複價: 25664,
    });
  });

  // 同 readTruthKey:表頭驗證是報告正確性的唯一防線。欄序若變了而靜默照抽,
  // 單價與數量會對調,報告會列出一整片「不一致」而全是抽錯造成的。
  test('欄序與預期不符時 throw,不猜', () => {
    const bad = [...HDR];
    [bad[3], bad[4]] = [bad[4], bad[3]]; // 數量與單價對調
    expect(() => readTruthItems(makeItemBook({ header: bad, rows: ROWS })))
      .toThrow(/契約數量/);
  });

  test('工程項目為空的列不算資料列(表尾空白列)', () => {
    const items = readTruthItems(makeItemBook({ rows: [...ROWS, ['', '', '', null, null, null], ['貳.1', 'X', '式', 2, 5, 10]] }));
    expect(items.map(i => i.項次)).toEqual(['壹.1', '壹.2', '貳.1']);
  });

  // 49 案的表尾都有一列「(合計)」:名稱有值但項次/單位/數量/單價全空,複價是總額。
  // 那是總計不是項目。收進來的話每案的項數都會比讀取器多 1,報告會列出 40 個
  // 「項數不同」而全是這一列造成的——真正的差異會被淹掉。
  test('表尾的合計列不算項目', () => {
    const items = readTruthItems(makeItemBook({
      rows: [...ROWS, [null, '(合計)', null, null, null, 29616]],
    }));
    expect(items).toHaveLength(2);
    expect(items.map(i => i.名稱)).not.toContain('(合計)');
  });

  // 但「有項次、只是某幾欄沒填」的列仍是項目,不得一起濾掉
  test('有項次但數量/單價空白的列仍算項目', () => {
    const items = readTruthItems(makeItemBook({ rows: [...ROWS, ['貳', '假設工程小計', null, null, null, 999]] }));
    expect(items.map(i => i.項次)).toEqual(['壹.1', '壹.2', '貳']);
  });

  test('缺分頁時 throw', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), '封面');
    const p = path.join(TMP, 'noitems.xlsx');
    XLSX.writeFile(wb, p);
    expect(() => readTruthItems(p)).toThrow(/契約詳細價目表/);
  });

  test('ITEM_HEADERS 是對外的欄序契約,供比對層對齊', () => {
    expect(ITEM_HEADERS).toEqual(['項次', '工程項目', '單位', '契約數量', '契約單價', '契約複價']);
  });
});
