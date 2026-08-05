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

  // 第二聯有單價與金額,但**沒有項目名稱**,只能靠列序對回而各天列數不一致——
  // 對錯一列整份金額就掛到別的項目上,且看起來完全正常。故一律 null 不硬湊。
  test('契約單價與本日完成金額不從第二聯猜', () => {
    const out = collectRows([
      mk(300, [[118, '施工項目']]),
      mk(290, [[52, '1.A'], [227, '式'], [299, '1.00']]),
    ]);
    expect(out[0].契約單價).toBeNull();
    expect(out[0].本日完成金額).toBeNull();
  });
});

describe('zhanxiang parseAll', () => {
  let all;
  beforeAll(async () => { all = await mod.parseAll(FIXTURE, ctx); });

  // 第二聯的頁面也有明細表格但沒有項目名稱,收進來只會產生一堆無名項目
  test('5 天,只讀施工日誌頁不讀第二聯', () => {
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

  // 廠商只列有施工的項目,故各天的列數不同(首日 3 列、之後 1~2 列)
  test('每天只列有施工的項目,且每列都解析得出單位與契約數量', () => {
    const 缺 = [];
    for (const d of all) {
      expect(d.dailyRows.length).toBeGreaterThan(0);
      for (const r of d.dailyRows) {
        if (r.單位 == null || r.契約數量 == null) 缺.push(`${d.header.填報日期} ${r.項次}`);
      }
    }
    expect(缺).toEqual([]);
  });
});
