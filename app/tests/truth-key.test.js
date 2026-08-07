const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { readTruthKey, LABELS } = require('../server/truth-key');

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
