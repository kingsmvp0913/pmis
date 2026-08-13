/**
 * 一張決標含多個標的的群組與加總檢核。
 *
 * 這條檢核擋的是「少建一個標的」與「某個標的金額打錯」——那兩種錯誤在系統裡
 * **完全看不出來**:每個標的的監造報表都照樣產得出來,金額也都合理,
 * 沒有任何錯誤訊息。只有把各標的加起來跟決標公告上的總額比,才會現形。
 */
const { summarize } = require('../server/award-group');

// 橋頭國小暨許厝分校(決標公告 A1150507):兩個標的,兩份發包後經費總表
const 橋頭 = { id: 1, name: '橋頭國小廁所整修工程', award_amount: 1670374, award_total: 4349520 };
const 許厝 = { id: 2, name: '許厝分校廁所整修工程', award_amount: 2679146, award_total: 4349520 };

test('只有一個標的時不檢核', () => {
  const r = summarize([橋頭]);
  expect(r.狀態).toBe('single');
  expect(r.標的數).toBe(1);
  expect(r.差額).toBeNull();
});

test('兩個標的加起來等於決標總額 → ok', () => {
  const r = summarize([橋頭, 許厝]);
  expect(r.狀態).toBe('ok');
  expect(r.標的數).toBe(2);
  expect(r.決標總額).toBe(4349520);
  expect(r.已分配).toBe(4349520);
  expect(r.差額).toBe(0);
});

// 少建一個標的:這是最危險的那種,因為已建的那個標的一切正常。
test('少建一個標的 → mismatch,差額是短少的金額', () => {
  const r = summarize([橋頭, { ...許厝, award_amount: 1000000 }]);
  expect(r.狀態).toBe('mismatch');
  expect(r.差額).toBe(1670374 + 1000000 - 4349520);
  expect(r.差額).toBeLessThan(0);
});

test('某個標的金額打錯 → mismatch,差額是溢出的金額', () => {
  const r = summarize([橋頭, { ...許厝, award_amount: 3679146 }]);
  expect(r.狀態).toBe('mismatch');
  expect(r.差額).toBe(1000000);
});

// 有標的還沒填金額時把 null 當 0 加進去,會算出一個「短少」的差額,
// 而真正該做的事是去填那一筆——兩者要分開,不能報成同一種問題。
test('有標的沒填金額 → unknown,不當成 0', () => {
  const r = summarize([橋頭, { ...許厝, award_amount: null }]);
  expect(r.狀態).toBe('unknown');
  expect(r.差額).toBeNull();
});

// 舊資料(award_total 這個欄位加上去之前建的工程)沒有決標總額,
// 沒有基準就不能算差額——拿 award_amount 當基準等於自己跟自己比。
test('沒有決標總額 → unknown', () => {
  const r = summarize([
    { ...橋頭, award_total: null },
    { ...許厝, award_total: null },
  ]);
  expect(r.狀態).toBe('unknown');
  expect(r.決標總額).toBeNull();
});

// 群組裡只有後建的那幾筆有 award_total(欄位是後來加的)也要能檢核
test('只有部分列有決標總額時仍取得到基準', () => {
  const r = summarize([{ ...橋頭, award_total: null }, 許厝]);
  expect(r.決標總額).toBe(4349520);
  expect(r.狀態).toBe('ok');
});

// 重興:812,102 + 871,943 = 1,684,045。金額是整數,容差只擋浮點表示誤差。
test('重興兩個標的', () => {
  const r = summarize([
    { id: 3, name: '重興汙水', award_amount: 812102, award_total: 1684045 },
    { id: 4, name: '重興廁所', award_amount: 871943, award_total: 1684045 },
  ]);
  expect(r.狀態).toBe('ok');
});

test('差 1 元也要報出來', () => {
  const r = summarize([橋頭, { ...許厝, award_amount: 2679147 }]);
  expect(r.狀態).toBe('mismatch');
  expect(r.差額).toBe(1);
});

test('空清單不會爆', () => {
  const r = summarize([]);
  expect(r.狀態).toBe('single');
  expect(r.標的數).toBe(0);
});
