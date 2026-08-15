/**
 * variants.js — 簡體字形吸回繁體的白名單。
 *
 * 這張表的價值全在「收什麼、不收什麼」的紀律上,所以測試釘的是那條紀律:
 *   ① 一對一無歧義的才收(收了歧義字會製造一個看起來合理的錯字,比不轉更糟)
 *   ② 簡繁同形的不收(收了只會讓表變髒,讓後人以為那是需要轉換的字)
 *   ③ 沒在實測樣本裡出現過的不收(表由實測長出來,不憑空擴充)
 */
const { S2T, toTraditional } = require('../server/ocr/variants');

test('查不到的字原樣通過,非字串回空字串', () => {
  expect(toTraditional('繁體字不動')).toBe('繁體字不動');
  expect(toTraditional('ABC123')).toBe('ABC123');
  expect(toTraditional(null)).toBe('');
  expect(toTraditional(undefined)).toBe('');
});

// 大勇那份的工程名稱就是被這兩個字判成 WRONG 的:OCR 讀出
// 「114學年度南棟教室西侧厕所整修工程」,與決標公告逐字比對只差 侧/厕 兩字。
test('侧→側、厕→廁(大勇的工程名稱靠這兩個字才對得上)', () => {
  expect(toTraditional('114學年度南棟教室西侧厕所整修工程'))
    .toBe('114學年度南棟教室西側廁所整修工程');
});

// ② 簡繁同形:這些字繁體本來就長這樣,收進表裡是錯的
test.each([['阻'], ['污'], ['隔'], ['冷'], ['疏'], ['泵'], ['砌']])(
  '簡繁同形的 %s 不在表裡', (ch) => {
    expect(S2T[ch]).toBeUndefined();
  });

// ① 歧義字:一個簡體字對到多個繁體字,猜錯會製造看起來合理的錯字。
// 「复」在工程文件裡複價與復建都會出現,「表」有報表與錶,「里」有裡與里。
test.each([['复'], ['表'], ['里'], ['面'], ['干'], ['后'], ['发'], ['松'],
  ['只'], ['准'], ['范'], ['涂'], ['历'], ['钟'], ['志'], ['台']])(
  '歧義字 %s 不可收', (ch) => {
    expect(S2T[ch]).toBeUndefined();
  });

test('對應值一律是單一繁體字,不可是多字或空值', () => {
  for (const [s, t] of Object.entries(S2T)) {
    expect(typeof t).toBe('string');
    expect([...t]).toHaveLength(1);
    expect(t).not.toBe(s);          // 同形字混進來就會在這裡被抓到
  }
});
