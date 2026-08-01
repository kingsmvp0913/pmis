const { extractFields, LABELS } = require('../server/kickoff-report');

// 造 ocrPdf 輸出形狀的 fixture。測試中不真的跑 OCR(spec §8)。
const mk = (lines, width = 2200) => ({ pages: [{ page: 1, width, lines }] });

test('標籤與值同列時直接取', () => {
  const r = extractFields(mk([
    '工程名稱 114年南陽國小北棟教室廁所整修工程',
    '契約編號 1150113',
    '契約金額 3,122,168元',
  ]));
  expect(r.工程名稱).toBe('114年南陽國小北棟教室廁所整修工程');
  expect(r.契約編號).toBe('1150113');
  expect(r.契約金額).toBe(3122168);
});

// OCR 按視覺行掃描,表格的標籤欄與值欄常被打散成兩行。
// 只認同列會讓大半欄位抓不到。
test('標籤獨佔一列時取下一列', () => {
  const r = extractFields(mk(['契約編號', 'ywjh11504']));
  expect(r.契約編號).toBe('ywjh11504');
});

// 元長廁所是 24 份中唯一使用變體標籤的。不納入則該份整份抓不到工期與開工日。
test('標籤變體可命中', () => {
  const r = extractFields(mk(['契約約定工期 120日曆天', '開工日期 115/6/3']));
  expect(r.契約工期).toEqual({ 天數: 120, 基準: '日曆天' });
  expect(r.契約規定開工日).toBe('2026-06-03');
});

// 幾乎每份都有這句,是標籤抓不到時的唯一退路
test('敘述句 fallback 可命中開工日', () => {
  const r = extractFields(mk(['本工程定於中華民國115年6月16日正式開工']));
  expect(r.契約規定開工日).toBe('2026-06-16');
});

// 標籤命中時不得被 fallback 蓋掉
test('標籤優先於敘述句 fallback', () => {
  const r = extractFields(mk([
    '契約規定開工日 115/3/18',
    '本工程定於中華民國115年6月16日正式開工',
  ]));
  expect(r.契約規定開工日).toBe('2026-03-18');
});

// 21/24 份的署名欄有完整校名,且與決標公告機關名稱逐字一致。
// 工程地點只能抽縣市(spec §5.2)。
test('主辦機關取署名欄,工程地點只抽縣市', () => {
  const r = extractFields(mk([
    '工程地點 雲林縣北港鎮光明路59號',
    '主辦機關 雲林縣北港鎮南陽國民小學',
  ]));
  expect(r.主辦機關).toBe('雲林縣北港鎮南陽國民小學');
  expect(r.縣市).toBe('雲林縣');
});

// 工程地點寫校名而非街道的形態(24 份中兩種寫法都有)
test('工程地點是校名時仍抽得到縣市', () => {
  expect(extractFields(mk(['工程地點 雲林縣台西國中'])).縣市).toBe('雲林縣');
});

// 台西/鹿場用國字大寫,決標公告一律阿拉伯數字
test('國字大寫金額', () => {
  expect(extractFields(mk(['契約金額 貳佰肆拾伍萬陸仟元整'])).契約金額).toBe(2456000);
});

// 兩解析度逐欄取聯集:任一讀到即採用。只跑單一解析度會少 5 個百分點。
test('兩解析度逐欄取聯集', () => {
  const r = extractFields({ pages: [
    { page: 1, width: 2200, lines: ['工程名稱 南陽廁所整修', '契約編號'] },
    { page: 1, width: 3400, lines: ['契約編號 1150113'] },
  ] });
  expect(r.工程名稱).toBe('南陽廁所整修');
  expect(r.契約編號).toBe('1150113');
});

// 先命中者優先,後面的解析度不得覆蓋已有值
test('聯集不覆蓋已命中的值', () => {
  const r = extractFields({ pages: [
    { page: 1, width: 2200, lines: ['契約編號 1150113'] },
    { page: 1, width: 3400, lines: ['契約編號 _J50_'] },
  ] });
  expect(r.契約編號).toBe('1150113');
});

// 3/24 份不是開工報告表(公文體、臺中市格式)。硬湊欄位會讓承辦人
// 以為系統看懂了,實際上比對的是別份文件的內容。
test('非開工報告表明確報錯不硬湊', () => {
  expect(() => extractFields(mk(['主旨:檢送本校老舊廁所整修工程開工資料乙份,請查照。'])))
    .toThrow(/無法辨識為開工報告表/);
});

// 讀不到就是 null,不得編造
test('讀不到的欄位留 null', () => {
  const r = extractFields(mk(['工程名稱 測試工程', '契約規定工期']));
  expect(r.契約工期).toEqual({ 天數: null, 基準: null });
  expect(r.契約金額).toBeNull();
});
