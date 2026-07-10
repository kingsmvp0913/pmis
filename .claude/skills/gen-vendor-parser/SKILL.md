---
name: gen-vendor-parser
description: 產生單一廠商的施工日誌讀取器(.pmisparser.js)。輸入該廠商施工日誌樣本 + 目標 schema,輸出 deterministic 讀取模組 + fixture 測試。產線不接 AI(產出的是純程式)。觸發:/gen-vendor-parser
---

# gen-vendor-parser — 產生廠商施工日誌讀取器

把「一份格式獨特的施工日誌」轉成「符合 PMIS 統一 schema 的 deterministic 讀取器」。**AI(本 skill)在開發階段產出純程式碼讀取器;產線執行時不呼叫 AI。**

## 何時用
- Onboard 新廠商、或廠商換了施工日誌格式時。
- 每呼叫一次只做**一家**。

## 輸入(呼叫時要備妥)
1. **廠商識別**:`meta.vendorKey` = **廠商名稱**(中文字串,如 `'金大營造有限公司'`)。安裝時 registry 依此名稱自動歸位到**同名廠商**(查 vendors 表);對不到任何廠商名稱者會被標記為 unmatched(孤兒)、不安裝。`isValidVendorKey` 收「非空、含中文、無檔名危險字元(`\ / : * ? " < > |`、控制字元、單獨 `.`/`..`、首尾空白)、長度 ≤100」的字串。落地檔名對名稱做檔名安全化,但 registry 權威 key 一律以**檔內 `meta.vendorKey`** 為準(不靠檔名)。
2. **施工日誌樣本檔**路徑(xls/xlsx/docx/pdf)。
3. **目標 schema**:見下方「統一輸出 schema」。

## 統一輸出 schema(所有讀取器一致;該家沒有的欄位回 null,不硬湊)

```js
parse(filePath, ctx)    // async,回傳「該檔第一天」;ctx.filetypes = 檔型工具(注入)
parseAll(filePath, ctx) // async,回傳 [每天…](逐日彙總,報表月報要用)
// 兩者回傳單日結構:
{
  header: {
    工程名稱, 填報日期,      // 填報日期一律正規化為西元 'YYYY-MM-DD'
    星期, 天氣_上午, 天氣_下午,
    預定進度, 實際進度,      // 數字或 null
    出工總人數,              // 數字或 null
    本日累計金額             // 該日累計金額(有才填)
  },
  dailyRows: [ {
    項次, 工程項目, 單位, 契約單價, 契約數量,
    本日完成數量, 本日完成金額, 累計完成數量
  } ],
  extras: {                  // 有才填,無則 {}
    出工明細: [{工別, 人數}],
    主要材料: [{名稱, 單位, 數量}],
    主要機具: [{名稱, 數量}]
  }
}
```

## 讀取器模組介面(registry 要求;參 `app/server/parsers/registry.js` 檔頭與 `validateModule`)

```js
module.exports = {
  meta: { vendorKey, version, targetFields },  // vendorKey = 廠商名稱(中文字串);targetFields 列出輸出欄位
  parse,        // async(filePath, ctx) => 單日結構
  parseAll,     // async(filePath, ctx) => [單日結構…]
  selfTest,     // (ft?) => boolean;用「內建小樣本」自檢,不依賴外部檔(安裝時會跑)
};
```

### 檔型工具「注入」(硬規則:讀取器不得自己摸路徑)
讀取器**絕不** `require` 檔型檔或用 `process.cwd()`/寫死 app 路徑取檔型工具——那在裝到
`data/vendor-parsers/`(app 原始碼樹外)時會斷。改由 **registry 注入**:
- registry 自己 `require('./filetypes')`(正常相對路徑),於 `getParser` 包裝時把它當
  `ctx.filetypes` 傳給 `parse(filePath, ctx)` / `parseAll(filePath, ctx)`。
- 讀取器一律經 `ctx.filetypes.<fn>` 取用:`ctx.filetypes.extractPages(...)`(PDF)、
  `ctx.filetypes.readWorkbook(...)` / `colToIndex` / `excelSerialToISO` / `gridFromWorksheet`(Excel)。
- `selfTest`:文字型(PDF)以內建小樣本呼叫內部 `parsePage`,**不需 ft**;檔型型(Excel)因需以
  檔型工具建 grid,registry 於驗證時把同一份 filetypes 當參數傳入(`selfTest(ft)`),讀取器據此
  用 `ft.gridFromWorksheet` / `ft.colToIndex` 等(仍不 require 檔型檔)。

`getParser(vendorKey)` 回傳的是**包裝物件**:
```js
{ meta, parse:(f)=>mod.parse(f,{filetypes}), parseAll:(f)=>mod.parseAll(f,{filetypes}), selfTest:mod.selfTest }
```

## 分層架構(務必沿用,勿把檔型邏輯塞進廠商 reader)
- **`app/server/parsers/filetypes/`**:檔型共用讀取器,回傳**原始結構**,可跨廠商重用。**讀取器經 `ctx.filetypes` 注入取用,不直接 require**(見上「檔型工具注入」)。`filetypes/index.js` re-export 各檔型工具(pdf 的 `extractPages` + xlsx 的公開函式),即注入的 `ctx.filetypes`。
  - `pdf.js`(已存在):pdf-parse@1 + 自訂 `pagerender`(依 `transform[5]` y 座標換行)逐頁抽文字;**對每頁文字做 NFKC 正規化**(關鍵:CID 字型會把「年」等字映到 CJK 相容區 U+F9xx,不正規化則 regex 抓不到)。
  - Excel(`xlsx.js`,已存在):用 `xlsx` 套件;把 `!merges` 合併區起點值**填滿整個合併區**,reader 用固定起點欄字母即可取值。提供 `excelSerialToISO`(日期常存 1900 曆制序號,非文字)、`gridFromWorksheet`。**Excel 路徑特有坑**:①日期多為序號要轉,別當字串 regex(仍保留文字雙制辨識)②進度欄常是小數 0.477=47.7%,**保留原值**、是否 ×100 交下游 ③**務必用 sheet 真表頭列校正欄位落點**——來源分析文件的座標僅供起點,曾有標錯(摯東 doc 標錯本日完成/單價欄,以 R9 真表頭為準)④分析時先 dump `!merges` 看數字欄真正落在哪個合併起點欄,別被覆蓋格誤導 ⑤`selfTest` 用真 worksheet(含 `!merges`)經 `gridFromWorksheet` 建 grid,連合併填充一起自檢。⑥**error cell 陷阱**:SheetJS 對 `#REF!`/`#VALUE!` 格的 `.v` 是「錯誤代碼數字」(#REF!→23、#VALUE!→15),會偽裝成正常數字。**已在 `gridFromWorksheet` 於 grid 端把 `t==='e'` 轉 null**(所有 Excel 讀取器自動受保護),但仍要警覺:別去讀那些整片 `#REF!` 的 snapshot sheet(見上「多視圖選乾淨來源」)。
  - Word(`docx.js`):`mammoth` 或解 `word/document.xml`;回傳段落/表格。
- **`app/server/parsers/vendors/samples/<key>.pmisparser.js`**:只放**該家版面規則**(從原始結構取值 → 統一 schema)。
- **純函式 `parsePage(rawText 或 rawGrid)`**:單頁/單日解析,供 `selfTest` 內建樣本呼叫(不碰檔案系統)。

## 每家要「參數化/客製」的四點
1. **單位字典**:各家單位集合不同(式/面/M/M2/M3/組/間/處/式…)。列邊界切「工程項目 vs 數字欄」時靠它;每家獨立一份 `KNOWN_UNITS`。
2. **列邊界 / 欄序規則**:
   - PDF/逐列型(金大):以「行首 token 是否為**項次 id**(中文大寫壹貳參… 或 1–2 位阿拉伯整數)」為列界;續行(名稱片段/單位/數字/`-`)併入當前列;再以「第一個單位 token」切「名稱 | 數字欄」。
   - Excel 座標型(摯東:一天一 sheet;承昇:固定欄):直接依固定 row/col 座標取值。
   - 矩陣型(晉林:235 欄監造版):依表頭列定位欄索引,逐日在橫向或縱向展開——**最棘手,需個別處理**。實測晉林教訓:①item 欄可能分成**多個平行區塊**(如 Block1=完成數量、Block2=完成金額,欄名一字不差),先偵測區塊、確認欄序對齊再取值;②天可能佔**多列**(本日列 + 累計列);③**同一檔多視圖時,優先選 error-free 的乾淨來源**(晉林逐日底稿 `so` 零 error,而 `60項監工日報`/`施工日報表` 等 snapshot sheet 才是 `#REF!`/`#VALUE!` 集中地),別盲從來源分析文件先提到的座標表;殘留舊範本 sheet 直接不讀。
3. **vendorKey(廠商名稱)**:`meta.vendorKey` = **該廠商正式名稱**(中文字串,如 `'金大營造有限公司'`)。安裝時 registry 依此名稱查 vendors 表自動歸位到同名廠商;**名稱必須與 vendors 表一字不差**,否則單家安裝被 `install()` 擋下、批次安裝標記 unmatched。名稱須通過 `isValidVendorKey`(無檔名危險字元/首尾空白、≤100 字)。
4. **日期正規化**:支援**民國⇄西元雙制**自動辨識(民國 `115 年` → +1911=2026;西元 `2025/6/7`、`5/29/26` 等)。統一輸出 `YYYY-MM-DD`。

## 產生流程(步驟)
1. **來源分析**:偵測檔型 → 用對應 filetype 讀取器 dump 原始結構 → 對照 `docs/superpowers/specs/2026-07-11-施工日誌來源分析.md` 該家那節,確認欄位落點、逐日列位置。
2. **對應**:把統一 schema 每個欄位對到來源具體位置;該家沒有的欄位輸出 null。
3. **產生 reader**:寫 `<key>.pmisparser.js`(沿用分層;檔型工具經 `ctx.filetypes` 注入取用,**不 require 檔型檔**;版面規則本地化;含 `parsePage`/`parseGrid` 純函式)。
4. **fixture 測試**:複製樣本檔到 `app/tests/fixtures/<key>.<ext>`;寫 `app/tests/parser-<key>.test.js`,呼叫 `parse`/`parseAll` 時傳入 `ctx`(`const ctx = { filetypes: require('../server/parsers/filetypes') }`),Excel 讀取器的 `selfTest(filetypes)` 也帶入同一份;**斷言來源的具體已知值**(工程名稱、某日日期、某項次各欄數字、當日累計金額、「-」轉 null 的語意、天數)。**金額/數量解析錯時測試必須失敗(Rule 9)。**
5. **驗證**:`cd app && npx jest` 全綠;`selfTest(ft)` 回 true;回報**對不到的欄位**(標紅,不靜默略過)。
6. **交付**:讀取器進 repo `parsers/vendors/samples/`,`meta.vendorKey` = **廠商正式名稱**(中文)。安裝方式二擇一:①廠商詳細頁「安裝讀取檔」單家上傳(vendorKey 須等於該廠商名稱);②`POST /api/parsers/bulk` 多檔批次上傳,registry 依 `meta.vendorKey` 名稱自動歸位到同名廠商(對不到者標 unmatched)。兩者安裝時都會自動跑 selfTest 驗證。

## 護欄(硬規則)
- **金額類欄位一律追溯到來源具體位置;找不到就留 null + 警告,絕不編造數字。**
- 無資料標記(`-`/`－`/空白)→ 統一 null(數量/金額),測試明確驗證。
- 禁寫死絕對路徑;**檔型工具只經 `ctx.filetypes` 注入取用(禁 `process.cwd()`/寫死 app 路徑/require 檔型檔)**;fixture 用 `path.join(__dirname,'fixtures',...)`。
- 產出純 deterministic 程式,**不得在讀取器內呼叫任何 AI/網路**。
- 一次只做一家;不改其他階段的檔。

## 正典範例(注入式)
`app/server/parsers/vendors/samples/jinda.pmisparser.js`(金大竹崎 PDF)+ `app/tests/parser-jinda.test.js` —— 第一支通過驗證的讀取器,`parse(filePath, ctx)` 用 `ctx.filetypes.extractPages`(不 require pdf.js)、PDF 逐列重組 + NFKC + 民國轉西元 + 80 天 parseAll、`meta.vendorKey='金大營造有限公司'` 皆已驗證。Excel 注入式範例參 `zhidong.pmisparser.js`(`ctx.filetypes.readWorkbook`/`selfTest(ft)`,`meta.vendorKey='摯東營造有限公司'`)。新家以此為樣板。
