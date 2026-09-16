---
name: sp4-official-doc-findings
description: "SP4 公文的技術結論——docx 套版的 run 切碎坑、兩個只有跨任務視角才看得到的缺陷,以及讀寫 .doc/.docx 的工具坑"
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-06T07:51:46.581Z
---

2026-08-06 完成 SP4(依人工輸入的文號套版產我方公文 `.docx`)。規格與三份樣本的變異事實
寫在 `docs/superpowers/specs/2026-08-06-SP4-公文-design.md`(含「一條被推翻的推論」),
本篇只記 repo 沒記、下次會再犯的東西。

## docx 套版:佔位符必須在產範本時就壓成單一 run

Word 會把一段文字切成很多 `<w:r>`——實測「呂罡銘/建築師事務所/函」是三個 run,
日期被切成 `11`/`5`/`年`/`7`/`月`/`1`/`日`。**佔位符只要跨 run,字串比對就抓不到**,
這是 docx 套版最常見的失敗原因。

解法是在「把已填樣本挖成空白範本」那一步就把每個欄位涵蓋的多個 run 合併成一個
(用第一個 run 的 `rPr` 當模板,其餘刪掉)。套版端因此只需純字串替換,不必處理跨 run 合併。
`app/templates/公文_空白範本.docx` 就是這樣產的。

`.docx` 是 zip+xml,`jszip` 純 JS 就能讀寫,**正式環境不必裝 Word**——與監造報表那條
Excel COM 路線刻意分開,不互相拖累。注意 `jszip` 原本只是 `exceljs` 的傳遞依賴,
要在 `package.json` 宣告成直接依賴,否則 exceljs 哪天升級拿掉它會無聲斷掉。

## 兩個只有「跨任務視角」才看得到的缺陷

七個任務各自通過審查後,最終的整分支審查才抓到這兩個——都不是單一任務內看得出來的:

1. **新端點漏掉「空則吊 settings 預設」的既有慣例**。`projects.supervisor_firm`
   **建立工程時根本不會被寫入**(`project-routes.js` 的 `COLUMNS` 沒這欄),只有承辦人另外進
   基本資料頁存檔才有值。專案慣例是「專案層有值用專案層,空則吊 `getFirmDefaults()`」,
   這條規則散在 `db.js` 註解、`settings.js` 註解、`project-basics-routes.js` 實作、前端四處,
   新端點是唯一漏掉的消費端 → 新建工程產出的公文信頭六格全空,而且靜默回 200。
   **教訓:讀 `projects.supervisor_firm`/`designer_firm` 的任何新程式碼,一律要接 fallback。**
2. **產出檔名沒帶紀錄 id**。`submission_history` 沒有 `(project_id, period)` 唯一約束,
   而上傳端點是無條件 INSERT,所以同一期兩筆很常見(日誌重傳、督導+每月)。
   兩列若寫同一個檔名,覆蓋後會下載到別人文號的公文(畫面與 DB 都顯示自己的文號),
   刪一列還會刪掉共用檔。**凡是「一筆紀錄一個檔」的產出,檔名就要帶那筆的 id。**

## 工具坑(驗證時會撞到,與產品無關)

- **PS 5.1 + 中文路徑**:用 Word COM 讀 `.doc` 時,若腳本是 UTF-8 無 BOM,中文路徑會變亂碼
  而報「找不到檔案」。把檔案複製成 ASCII 檔名再處理最省事(同 [[xlsm-excel-com-findings]] 的 BOM 結論)。
- **Git Bash 的 curl 傳中文 body 會亂碼**,產出的公文上文號變亂碼,看起來像程式 bug。
  改用 Node 的 `fetch` 就正常。驗證 API 時別用 curl 送中文。
- 舊 `.doc`(OLE)沒有純 JS 讀法,開發期用 Word COM 的 `SaveAs2($path, 16)` 轉成 `.docx` 即可,
  正式環境不需要這一步。

相關:[[supervision-report-pipeline]]、[[claude-md-scope]]。
