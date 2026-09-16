---
name: ocr-engine-ppocrv5
description: OCR 引擎從 Windows 內建換成 PP-OCRv5(純 Node/ONNX)的實測數字、四個必修的下游缺口與選型理由——要再動 OCR 引擎或解析度前必讀
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-08T11:44:52.843Z
---

2026-08-08。使用者要求「研究主流 OCR 想辦法提升辨識率」。結論:**換引擎**,
量測基座與數字如下。**這篇取代 [[kickoff-report-ocr-findings]] 與
[[ocr-daily-log-findings]] 裡的引擎層數字**(那兩篇的版面事實與決策原則仍成立)。

## 選型:PP-OCRv5 mobile,走純 Node

`ppu-paddle-ocr` + `onnxruntime-node` + `@hyzyla/pdfium` + `@napi-rs/canvas`
(後者隨 ppu-ocv 自動進來)。**不引 Python**。模型 20MB 放 `data/ocr-models/`
(gitignore 內,與本專案「大二進位不版控」慣例一致),`app/scripts/fetch-ocr-models.js`
取得並掛在 `setup.js`;抓不到就退回 Windows 引擎,不擋安裝。

Python 的 `rapidocr` 路線也驗證過、分數一樣(181),留作對照,不採用。

## 實測(24 份開工報告表 × 9 欄,真值取決標公告)

| 引擎 | 對 | 錯 | 漏 | 每頁 |
|---|---|---|---|---|
| Windows 內建(2200+3400 聯集) | 160 | 13 | 25 | 16.3s |
| **PP-OCRv5 mobile(單跑 3400)** | **181** | **6** | **20** | **7.4s** |

施工日誌數字格(饒平 `0711A-0711A.pdf`,同檔文字層當答案卷,167 格):
**51.5% → 86.8%,且讀成別的數字 0/167**(Windows 在同一份是 0,記憶舊記的 0.6%
來自別的量法)。⚠️ 0/167 **不等於錯誤率 0**,樣本太小,別當成保證。

## 解析度:兩種文件的最佳點不同,而且聯集沒有用

- **開工報告表**:3400 最好(2200=175、3400=181、4400=179 且多花 34% 時間)。
- **施工日誌密集表格**:2200 最好(1800=86.2%、**2200=86.8%**、2800=85.0%、
  3400=84.4%),而且 2800 以上開始出現讀成別的數字。
  `extractItemsOcr` 預設本來就是 2200,不必改。
- **聯集在 PP-OCRv5 下增益為 0**:3400 單跑 181、3400+2200 181、三個都跑 181。
  而且順序有害——`extractFields` 是「先命中者保留」,把較差的 2200 排前面會蓋掉
  正確答案(181→179)。聯集原本只是在補 Windows OCR「每份文件最佳解析度不同」的
  不穩定,換引擎後就沒東西可補了。
- 附帶推翻:Windows 自己的聯集也沒那麼值。單跑 3400 是 159/10/29、聯集 160/13/25
  ——**只多對 1 格卻多錯 3 格**。當初量的是「命中率」不是「正確率」。

## 四個下游缺口(不修的話換引擎是負收益)

全部已修並有測試。**這些是 value/比對層的洞,不是引擎的錯**,Windows 引擎也受惠。

1. **全形千分位**:OCR 讀出「3，122，168」,`parseMoney` 的 `[\d,]+` 只吃到 `3`。
   修法:`stripSpace` 加 NFKC。⚠️ NFKC **只能放在 value 層**(金額/日期/工期),
   不可上移到 items 層——NFKC 會把「㎡」拆成「m2」,打壞施工日誌讀取器的單位比對。
2. **千分位被讀成句點**:「3.122,168」同樣回 3。修法:`THOUSANDS` 正則,
   **每個分隔符後面都剛好三位數**才視為千分位(「2590.00」「1.5」不受影響)。
3. **簡體字形**:PP-OCR 中文模型簡繁共用字典,對繁體文件會零星吐簡體
   (24 份實測 `编` 11、`额` 9、`国` 4、`贰` 1;**Python 與 Node 兩條路線都會**,
   是模型性質;Windows 引擎 0 次)。一個字就讓「契約金额」對不上標籤 → 整欄抽不到。
   修法:`app/server/ocr/variants.js` 白名單,在 `ocrPdf` 統一吸附。
   ⚠️ **只收一對一無歧義的字**;`复/表/里/面/干/后/发/松/只/谷/历/钟/志/板/台`
   一律不收——這些字在工程文件裡真的會出現(複價、報表、公里),猜錯會製造
   看起來合理的錯字,比不轉換更糟。
4. **偵測框會把標籤與值併在一起**(大勇紅磚:`契約金额新台幣3,080,000元整 契約编號115-4`)
   與**值跨框換行**(豐榮國字大寫金額被切兩塊)。**尚未修**,是剩下 20 個漏的主因之一。

## 踩過的坑

- `ppu-paddle-ocr` 的 `V5_MOBILE_MODEL` preset 自己會下載/快取/字典對齊,**直接用**。
  自己從 rapidocr 的 ONNX metadata 抽字典會**整份差一個索引**(CTC blank 佔 index 0,
  要自己補一行 `blank` 在最前面)——症狀是字數對但字全錯,而且 confidence 還 0.97。
- pdfium 給 **BGRA**,canvas 的 ImageData 是 **RGBA**,不換通道辨識率直接掉到地板。
- pdfium 的 `page.render({width})` **只設寬、不等比縮放**(3400×842),要用 `scale`。
- `render` 是 callback 不是字串;`render: async (o) => o.data` 拿原始點陣,不必編碼 PNG。
- ppu 的 `maxSideLength` 預設 `"auto"` = `clamp(0.75×長邊, 960, 1920)`,會把大圖壓到
  1920 才偵測。本專案實測**沒有影響**(同樣 85 個框),但掃描件可能不同,有問題先查這個。
- Python 那條路(`rapidocr`)在 Windows 下 stdout 走 cp950,**一定要
  `sys.stdout.reconfigure(encoding='utf-8')`**,否則 Node 端 JSON 解析失敗。
- server 版模型大 10 倍、慢 20 倍(每頁 2 分鐘),施工日誌上與 mobile **同分**。不要用。

## 量測基座在哪

**`data/parser-tools/ocr-ab/`(已搬離 scratchpad,含 README 與 4.4MB 快取)。**
`compare.js` 逐欄計分、`daily-log-ab.js` 數字格計分、`cache/` 各引擎原始輸出。
有快取就能秒級離線迭代抽取規則;重跑一次 OCR 要 40 分鐘以上。**不要重寫這套。**

⚠️ 三個會讓量測失真的坑(README 有詳述):比對前要重現 `ocrPdf` 的正規化
(`collapseCjkSpaces` + `toTraditional`);真值配對用明確對照表不用檔名模糊配對;
決標公告的日期是民國、名稱包在「」裡、機關名要過 `normalizeOrgName`。

⚠️ **一律量「對/錯/漏」,不要量「命中率」**——聯集用命中率看是 72%→77% 的改善,
用正確率看其實是拿「漏」換「錯」,而錯值才是假硬錯的來源。舊記憶那個 77%
就是這樣來的。

相關:[[kickoff-report-ocr-findings]]、[[ocr-daily-log-findings]]、
[[sp1b-ocr-geometry-findings]](座標配對規則,仍是抽取層的核心)。
