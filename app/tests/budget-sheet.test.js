const fs = require('fs');
const path = require('path');
const { parseItems, findCandidates } = require('../server/budget-sheet');

const fx = (key) => JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'budget', `${key}.json`), 'utf8'));

// 手寫矩陣測「規則的意圖」;真實樣態另以 fixture 端到端釘住(見本檔下半)。
// 兩者缺一不可:只有手寫矩陣會寫出與現實不符的資料(SP1B 手打 fixture 的教訓),
// 只有 fixture 則看不出每條規則各自在管什麼。
const HEAD = ['項 次', '項  目  及  說  明', '單位', '數 量', '單 價', '複 價'];

test('阿拉伯項次且有單價的列是施工項目', () => {
  const items = parseItems([HEAD, ['1', '施工圍籬', '式', '1', '3,000', '3,000']]);
  expect(items).toEqual([
    { 項次: '1', 項目: '施工圍籬', 單位: '式', 數量: 1, 單價: 3000, 複價: 3000 },
  ]);
});

// 承辦人選了「施工項目 + 五個費用項目」,因為只有這樣合計才等於決標金額
test('中文大寫費用項目也收錄', () => {
  const items = parseItems([HEAD, ['貳', '職業安全衛生管理費(壹*1%)', '式', '1', '9,024', '9,024']]);
  expect(items).toHaveLength(1);
  expect(items[0].項次).toBe('貳');
});

// 「壹 直接工程費」是大類標題,沒有數量單價;收下它會在每日施工紀錄多出
// 一列要承辦人填「本日完成幾成」的空殼
test('大類列「壹」不收錄', () => {
  expect(parseItems([HEAD, ['壹', '直接工程費', '', '', '', '']])).toEqual([]);
});

// 小計/合計是公式結果。收下它們,累計金額與完成百分比會整份重複計算一次
test.each([
  ['小計在 A 欄', ['小計(壹)', '', '', '', '', '902,363']],
  ['合計在 A 欄', ['發包工程費合計(壹~陸)', '', '', '', '', '1,036,370']],
  ['小計在 B 欄', ['', '合計(壹)', '', '', '', '902,363']],
])('%s 不收錄', (_, row) => {
  expect(parseItems([HEAD, row])).toEqual([]);
});

// 項次是 SP3 拿施工日誌回頭核對契約表的鍵。施工日誌解出來的就是 '1'/'伍'
// 這種原樣字串(parser-jinda.test.js:56,88),重新編號會讓核對全部對不到。
test('項次照原樣保留,不重新編號', () => {
  const items = parseItems([
    HEAD,
    ['1', 'A', '式', '1', '100', '100'],
    ['2', 'B', '式', '1', '100', '100'],
    ['貳', 'C', '式', '1', '100', '100'],
    ['陸', 'D', '式', '1', '100', '100'],
  ]);
  expect(items.map((i) => i.項次)).toEqual(['1', '2', '貳', '陸']);
});

// 異體字「参」與全形波浪號在 31 份樣本裡混用,不認就會漏掉整個費用項目
test('異體字「参」視同「參」', () => {
  const items = parseItems([HEAD, ['参', '公共工程品質管制作業費', '式', '1', '9,024', '9,024']]);
  expect(items).toHaveLength(1);
});

test('千分位與尾隨空白的數字要轉成數值', () => {
  const items = parseItems([HEAD, ['1', 'A', 'M2', '1,033 ', '494 ', '510,302 ']]);
  expect(items[0]).toMatchObject({ 數量: 1033, 單價: 494, 複價: 510302 });
});

// ── 候選分頁判定 ───────────────────────────────────────────
// 不靠分頁名稱:實測命名有 6 種變體(詳細價目表/詳細預算表/詳細表/(標單)詳細價目表/
// 尾端帶空白/(2))。改用結構特徵,再由「合計是否等於決標金額」當最後防線。

test('經費總表不是候選:它的阿拉伯項次列恆為 2(學校與縣府工程管理費)', () => {
  const { sheets } = fx('damei');
  const names = findCandidates(sheets).map((c) => c.name.trim());
  expect(names).not.toContain('經費總表');
  expect(names).toContain('詳細價目表');
});

// 重興汙水那份的分頁叫「詳細表」,靠名稱比對的規則會整份漏掉
test('分頁名不叫「詳細價目表」也認得出來', () => {
  const names = findCandidates(fx('chongxing-sewage').sheets).map((c) => c.name.trim());
  expect(names).toContain('詳細表');
});

// 5 個檔案的第一張表施工小計全都是 1,185,308(南陽的數字,複製底稿沒改乾淨)。
// 兩張都要當候選交給金額比對去挑,只取第一張就是 100% 挑到錯的那張。
test('雙表案例兩張都列為候選,合計各自算出', () => {
  const cands = findCandidates(fx('nanyang').sheets);
  expect(cands.map((c) => c.合計).sort((a, b) => a - b)).toEqual([1587660, 3122168]);
});

test('沒有明細的檔案回空候選', () => {
  expect(findCandidates(fx('taichung-nodetail').sheets)).toEqual([]);
});

// 四湖跳遠多了柒、捌、玖三個費用項目,規則不能寫死「五個」
test('費用項目不限五個', () => {
  const [c] = findCandidates(fx('sihu-longjump').sheets);
  const 中文項次 = c.items.filter((i) => !/^\d+$/.test(i.項次)).map((i) => i.項次);
  expect(中文項次).toHaveLength(8);
});

// 合計 = 各項複價和。這個數字之後要拿去跟決標金額比,算錯就會挑錯表。
test('候選的合計等於逐項複價相加', () => {
  const [c] = findCandidates(fx('damei').sheets);
  expect(c.合計).toBe(c.items.reduce((s, i) => s + i.複價, 0));
  expect(c.合計).toBe(1036370); // 大美的決標金額
});
