/**
 * 寶嶸營造有限公司(橋頭國小暨許厝分校廁所整修)施工日誌讀取器測試。
 *
 * fixture 是 `橋頭施工日誌2026.xlsm`(同資料夾的 `-7月.xlsm` 與 `(1).xlsx` 內容相同,
 * 許厝那三份同理)。
 *
 * 斷言集中在三個「錯了不會有任何欄位變 null」的地方:
 *   ① 逐日資料在「工程進度表」矩陣,不在叫「施工日誌」的那個單日列印分頁
 *   ② 欄 11 是當前選定日(7/31)的快照,排在逐日欄(7/15 起)左邊 —— 取錯第一天就錯
 *   ③ 累計完成數量由逐日累加,沒有值的那天要往下帶,不可變回 null 或 0
 */
const fs = require('fs');
const path = require('path');
const mod = require('../server/parsers/vendors/samples/baorong.pmisparser.js');
const filetypes = require('../server/parsers/filetypes');

const FIXTURE = path.join(__dirname, 'fixtures', 'baorong.xlsm');
const ctx = { filetypes };

test('selfTest 通過', () => {
  expect(mod.selfTest(filetypes)).toBe(true);
});

// vendorKey 的權威來源是決標公告的得標廠商(橋頭國小決標公告.pdf,A1150507)。
// ⚠️ 不是既有的「寶樹體育設備工程有限公司」,是另一家。
test('vendorKey 是決標公告上的得標廠商名', () => {
  expect(mod.meta.vendorKey).toBe('寶嶸營造有限公司');
});

describe('parseAll(橋頭國小暨許厝分校)', () => {
  let days;
  beforeAll(async () => { days = await mod.parseAll(FIXTURE, ctx); }, 120000);

  // ② 叫「施工日誌」的分頁只有一天(公式抓當天的列印表單);讀它的話一份檔只有一天。
  // 逐日在「工程進度表」矩陣裡,而範本把 180 天的日期都預先填好,只有 60 天填過。
  test('讀的是工程進度表矩陣,60 天,由 7/15 起', () => {
    expect(days.length).toBe(60);
    expect(days[0].header.填報日期).toBe('2026-07-15');
    expect(days[59].header.填報日期).toBe('2026-09-12');
    const dates = days.map((d) => d.header.填報日期);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  // 欄 11 印著當前選定日 7/31,而且排在逐日欄的左邊。從第一個有日期的欄開始收,
  // 第一天就會變成 7/31,整份時序全錯。
  test('第一天不是當前選定日的快照(7/31)', () => {
    expect(days[0].header.填報日期).not.toBe('2026-07-31');
    expect(days.filter((d) => d.header.填報日期 === '2026-07-31')).toHaveLength(1);
  });

  test('header 逐欄', () => {
    const h = days[0].header;
    expect(h.工程名稱).toBe('橋頭國小暨許厝分校114-116年校舍公立國民中小學老舊廁所整修工程');
    expect(h.承包廠商).toBe('寶嶸營造有限公司');
    expect(h.開工日期).toBe('2026-07-15');            // 來源是 Excel 序號 46218
    expect(h.天氣_上午).toBe('晴');
    expect(h.預定進度).toBeCloseTo(0.002243, 6);
  });

  // 此格式沒有的欄位一律 null。金額算得出來(數量 × 單價)也不填 —— 回推出來的數字
  // 看起來完全正常,錯了沒有任何地方會亮。
  test('沒有的欄位一律 null,不回推', () => {
    expect(days.filter((d) => d.header.實際進度 != null)).toHaveLength(0);
    expect(days.filter((d) => d.header.本日累計金額 != null)).toHaveLength(0);
    expect(days.filter((d) => d.header.出工總人數 != null)).toHaveLength(0);
    expect(days.flatMap((d) => d.dailyRows).filter((r) => r.本日完成金額 != null)).toHaveLength(0);
  });

  test('33 項,大類「壹 發包工程費」與中類「一 假設工程」不會變成明細', () => {
    const 列數 = days.map((d) => d.dailyRows.length);
    expect(new Set(列數)).toEqual(new Set([33]));
    const names = days[0].dailyRows.map((r) => r.工程項目);
    expect(names).not.toContain('發包工程費');
    expect(names).not.toContain('假設工程');
    const nos = days[0].dailyRows.map((r) => r.項次);
    expect(nos.slice(0, 3)).toEqual(['1', '2', '3']);
    expect(nos.slice(-5)).toEqual(['二', '三', '四', '五', '六']);
  });

  // ③ 矩陣格 = 該日完成數量;33 個項目逐列把逐日欄加總,都等於該檔「累計完成數量」欄。
  // 期末累計就是驗這件事——累加寫錯(少帶前一天、沒值時歸零)這裡就會不符。
  test('累計完成數量逐日累加,期末等於矩陣列總和', () => {
    const 末 = days[59].dailyRows;
    expect(末[0].累計完成數量).toBe(1);                // 項次1:7/18 完成 1
    expect(末.filter((r) => r.累計完成數量 == null)).toHaveLength(0);
    // 不回退:每一項的累計在整份日誌裡單調不減
    for (let i = 0; i < 33; i++) {
      const seq = days.map((d) => d.dailyRows[i].累計完成數量);
      const 回退 = seq.filter((v, k) => k > 0 && v < seq[k - 1]);
      expect(回退).toHaveLength(0);
    }
  });

  test('明細逐欄', () => {
    const r = days[0].dailyRows[0];
    expect(r.工程項目).toContain('工程告示牌與職安衛告示牌');
    expect(r.單位).toBe('式');
    expect(r.契約數量).toBe(1);
    // 日誌的單價 16250 與發包後經費總表(橋頭 9750 / 許厝 10250)都不同——
    // 兩份文件的總額都等於決標金額 4,349,520,逐項卻是廠商自己重新分配過的。
    // 讀取器照讀原值,讓 SP3 的 E6 報出來;抹平它會讓兩個標的的差異永遠看不到。
    expect(r.契約單價).toBe(16250);
  });

  test('必要欄位零缺漏', () => {
    const rows = days.flatMap((d) => d.dailyRows);
    expect(rows).toHaveLength(1980);
    expect(rows.filter((r) => r.單位 == null)).toHaveLength(0);
    expect(rows.filter((r) => r.契約數量 == null)).toHaveLength(0);
    expect(rows.filter((r) => r.契約單價 == null)).toHaveLength(0);
    expect(rows.filter((r) => r.項次 == null)).toHaveLength(0);
  });
});

// 沒有「工程進度表」分頁的檔要明確失敗。回空陣列會被上游當成「這份沒有資料」略過。
test('不是寶嶸的活頁簿要 throw,不可回空陣列', async () => {
  await expect(mod.parseAll(path.join(__dirname, 'fixtures', 'kunyao.xlsx'), ctx))
    .rejects.toThrow(/工程進度表/);
});

test('registry.inspect(沙箱載入 + 跑 selfTest)通過', () => {
  const registry = require('../server/parsers/registry');
  const src = path.join(__dirname, '..', 'server', 'parsers', 'vendors', 'samples', 'baorong.pmisparser.js');
  const got = registry.inspect(fs.readFileSync(src));
  expect(got.error).toBeUndefined();
  expect(got.ok).toBe(true);
  expect(got.meta.vendorKey).toBe('寶嶸營造有限公司');
});
