/**
 * 展翔營造(仁德國小)讀取器測試。
 * 對 tests/fixtures/zhanxiang.pdf(21 頁 = 5 天,每天 封面+施工日誌+第二聯×2)跑。
 */
const path = require('path');
const mod = require('../server/parsers/vendors/samples/zhanxiang.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'zhanxiang.pdf');
const ctx = { filetypes };

test('selfTest 以內建座標樣本通過,不需注入', () => {
  expect(mod.selfTest()).toBe(true);
});

describe('zhanxiang 明細收束(純函式)', () => {
  const { collectRows } = mod._internal;
  const mk = (y, arr) => ({ y, items: arr.map(([x, s]) => ({ x, y, s })) });

  // 明細之後緊接「二、工地材料管理概況」,欄位配置一模一樣;不在那裡停,
  // 彈性防水材、水泥漆這些材料會被收成施工項目
  test('讀到下一個段落即停,不把材料收成施工項目', () => {
    const out = collectRows([
      mk(300, [[118, '施工項目'], [222, '單位']]),
      mk(290, [[52, '1.乙種施工圍籬'], [227, '式'], [299, '1.00']]),
      mk(280, [[52, '二、工地材料管理概況']]),
      mk(270, [[52, '彈性防水材'], [226, 'M2'], [250, '199.00']]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].項次).toBe('1');
  });

  // 項次與名稱黏在同一格,費用項目用「伍、」而施工項目用「1.」
  test('項次與名稱分得開,兩種分隔符都認', () => {
    const out = collectRows([
      mk(300, [[118, '施工項目']]),
      mk(290, [[52, '1.乙種施工圍籬'], [227, '式']]),
      mk(280, [[52, '伍、營造綜合保險費'], [227, '式']]),
    ]);
    expect(out.map((r) => r.項次)).toEqual(['1', '伍']);
    expect(out[0].工程項目).toBe('乙種施工圍籬');
  });

});

// ⛔ 原本有一條「契約單價與本日完成金額不從第二聯猜」,理由是「第二聯沒有項目名稱」。
// **那個前提是錯的**:名稱就印在第二聯的 x=52,而且第二聯才是完整清單。
// 那條測試把一個錯誤的診斷釘成了規格,於是這支讀取器整整少讀了每天 36 列。
describe('zhanxiang 第二聯(完整清單)', () => {
  const { parseSecondPage } = mod._internal;
  const mk = (y, arr) => ({ y, items: arr.map(([x, s, w]) => ({ x, y, s, w: w == null ? 12 : w })) });
  const 表頭 = [
    mk(300, [[118, '施工項目', 49], [222, '單位', 16], [516, '備註', 16]]),
    mk(292, [[250, '數量', 16], [289, '單價', 16], [333, '數量', 16],
      [373, '金額', 16], [414, '數量', 16], [458, '金額', 16]]),
  ];

  // 單位是「M2」時裡面有數字。界劃得太左,那個 2 會被當成契約數量而真正的 28.00
  // 因為「先到先得」被丟掉(實測項次 7);太右則單位整格落進數值區、變 null。
  test('單位 M2 裡的數字不可以被當成契約數量', () => {
    const out = parseSecondPage([...表頭,
      mk(280, [[52, '7.砌1/2B磚牆', 49], [226, 'M2', 10], [251, '28.00', 17], [288, '1,200.00', 28]]),
    ]);
    expect(out[0]).toMatchObject({ 項次: '7', 單位: 'M2', 契約數量: 28, 契約單價: 1200 });
  });

  // 一個 item 同時裝著兩個數字,要用 w/s.length 推每個字元的 x 再取 token 中心
  test('一格兩個數字要各自歸欄', () => {
    const out = parseSecondPage([...表頭,
      mk(280, [[52, '4.拆除', 30], [226, '式', 10],
        [255, '1.00    253,106.00', 62], [342, '0.05', 17], [367, '12,655.00', 32],
        [424, '0.25', 17], [453, '63,277.00', 32]]),
    ]);
    expect(out[0]).toMatchObject({
      契約數量: 1, 契約單價: 253106, 本日完成數量: 0.05, 本日完成金額: 12655, 累計完成數量: 0.25,
    });
  });

  // 名稱換行時值自己佔一列,那一列的名稱欄是空的。用「名稱非空」當補值的前提
  // 會讓整列的單位與六個數值全變 null,而名稱看起來完好。
  test('值印在名稱兩行之間時仍要收得到', () => {
    const out = parseSecondPage([...表頭,
      mk(280, [[52, '1.乙種施工圍籬、警示帶、安全警示燈等安全', 120]]),
      mk(274, [[226, '式', 10], [255, '1.00', 17], [288, '2,500.00', 28]]),
      mk(268, [[52, '措施(租用)', 40]]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      項次: '1', 工程項目: '乙種施工圍籬、警示帶、安全警示燈等安全措施(租用)',
      單位: '式', 契約數量: 1, 契約單價: 2500,
    });
  });
});

describe('zhanxiang parseAll', () => {
  let all;
  beforeAll(async () => { all = await mod.parseAll(FIXTURE, ctx); });

  // 明細取自第二聯(完整清單),header 取自第一聯
  test('5 天', () => {
    expect(all).toHaveLength(5);
    expect(all[0].header.填報日期).toBe('2026-06-26');
    expect(all[4].header.填報日期).toBe('2026-06-30');
  });

  test('header 取自施工日誌頁', () => {
    expect(all[0].header).toMatchObject({
      工程名稱: '仁德國小114年度老舊廁所整修工程',
      承包廠商: '展翔營造股份有限公司',
      星期: '星期五', 天氣_上午: '雨', 天氣_下午: '雨',
      預定進度: 0.38, 實際進度: 0.6, 開工日期: '2026-06-26',
    });
  });

  // ⛔ 這條原本叫「每天只列有施工的項目」——那是只讀第一聯造成的假象。
  // 第二聯每天都是完整清單:大類「壹」+ 項次 1~31 + 費用項 貳~陸 = 37 列。
  // 少讀整批列**不會有任何欄位變 null**,所以要斷言列數與項次連續,不能只斷言非 null。
  test('每天都是完整清單(37 列),必要欄位零缺漏', () => {
    const 缺 = [];
    for (const d of all) {
      expect(d.dailyRows).toHaveLength(37);
      for (const r of d.dailyRows) {
        if (r.項次 === '壹') continue;                       // 大類列本來就只有名稱
        if (r.單位 == null || r.契約數量 == null || r.契約單價 == null) {
          缺.push(`${d.header.填報日期} ${r.項次}`);
        }
      }
    }
    expect(缺).toEqual([]);
    const 項次 = all[0].dailyRows.map((r) => r.項次);
    expect(項次.slice(0, 3)).toEqual(['壹', '1', '2']);
    expect(項次.slice(-5)).toEqual(['貳', '參', '肆', '伍', '陸']);
  });

  // 逐格對過紙本:項次 7 是 28 M2(曾被單位裡的 2 蓋掉)、15 是 50 M(單位曾變 null)
  test('契約數量與單位與紙本一致', () => {
    const by = new Map(all[0].dailyRows.map((r) => [r.項次, r]));
    expect(by.get('7')).toMatchObject({ 單位: 'M2', 契約數量: 28, 契約單價: 1200 });
    expect(by.get('9')).toMatchObject({ 單位: 'M2', 契約數量: 346, 契約單價: 550 });
    expect(by.get('15')).toMatchObject({ 單位: 'M', 契約數量: 50, 契約單價: 450 });
  });
});
