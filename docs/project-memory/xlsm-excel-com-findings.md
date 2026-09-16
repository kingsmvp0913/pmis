---
name: xlsm-excel-com-findings
description: 保留巨集/公式地把值寫進 .xlsm 的技術結論(Excel COM 實測踩到的坑)
metadata: 
  node_type: memory
  type: reference
  modified: 2026-08-08T04:10:09.076Z
---

2026-07-25 為 [[supervision-report-pipeline]] SP0 做 COM spike,實測把值寫進含巨集的監造報表 .xlsm、保留公式/格式,結論:

- **必用 Windows PowerShell 5.1(`%WINDIR%\System32\WindowsPowerShell\v1.0\powershell.exe`),不要用 pwsh 7**。pwsh 7 以 .ps1 檔跑 Excel COM 時,`$wb.Worksheets.Item(...)` 物件模型走訪會間歇回 null。5.1 的 COM interop 才穩。(Bash/PowerShell 工具預設是 pwsh 7。)
- **驅動 COM 的 .ps1 若含中文字面(分頁名等),必須存成 UTF-8 with BOM**。5.1 讀無 BOM 的 .ps1 當 ANSI(cp950)→中文變 mojibake→`Worksheets.Item('工程基本資料')` 找不到分頁。用 `[System.IO.File]::WriteAllText($p,$c,(New-Object System.Text.UTF8Encoding($true)))` 補 BOM。(Write/Edit 工具寫出的是無 BOM,每次改完要重補。)
- **合併儲存格**:對部分合併範圍 `ClearContents()` 會丟「無法對合併儲存格執行該動作」。要 `cell.MergeArea.UnMerge()`→`ClearContents()`→`Merge()`(或直接對 MergeArea 操作)。
- **清「原始輸入值」但保留公式**:用 `Range.SpecialCells(2, 23)`(xlCellTypeConstants, 值型別 all)只選非公式實值再 `ClearContents`;跳過第 1 列標題。key-value 型分頁(工程基本資料)要逐格指定 B 欄,別用 SpecialCells(會連 A 欄標題一起清)。
- **存檔保巨集**:`.Save()`/SaveAs FileFormat=52 保 .xlsm;讀回 `XLSX.readFile(f,{bookVBA:true}).vbaraw` 仍在。
- **殘留程序**:COM 崩潰/鎖檔會留 `EXCEL.EXE`,下次 Open 回 null。跑前 `Get-Process EXCEL | Stop-Process -Force`,腳本 finally 一定 `Quit()`+`ReleaseComObject`。
- 設 `Visible=$false`、`DisplayAlerts=$false`;完成 `CalculateFull()` 再存,確保公式重算值落地(下游 SheetJS 讀得到真值)。

**從 Node 驅動 COM(2026-07-25 實作 SP0 `app/server/template-engine.js` + `excel-com-driver.ps1` 踩到)**:
- **不可用 `windowsHide:true`/CREATE_NO_WINDOW**:Node `execFile` 隱藏視窗跑 powershell 時,Excel COM 沒有 window station,`$wb.Worksheets` 回 null。拿掉 windowsHide 即正常。
- **含巨集範本必關事件+降安全性**:開檔前 `$xl.EnableEvents=$false` + `$xl.AutomationSecurity=1`(msoAutomationSecurityLow)。否則 `Workbook_Open` 巨集在自動化下觸發對話框/卡住(症狀:Open 卡 ~65s 後 null)。
- **偶發 65 秒卡頓→null**:即使上述都做,Excel COM 在密集重複啟動時仍會間歇卡 ~65s 後 null。
  driver 收尾用 `GetWindowThreadProcessId($xl.Hwnd)` 抓自己 PID,Quit 後 `WaitForExit(8000)`
  不退才 Kill(只殺自己這顆,不動使用者其他 Excel)。
- **⚠️ 2026-08-08 量到真正的根因,上一條「疑似殘留 EXCEL.EXE」是錯的**(commit `58e84e1`)。
  連續跑 44 案時 20 案失敗、單獨重跑 100% 成功、失敗當下**沒有殘留 EXCEL.EXE**。
  分步診斷後量到的是**兩種 COM 競態**:
  1. `Workbooks.Open` 回傳了 workbook 物件,但 **`.Worksheets` 是 null**(ReadOnly=False)
  2. `Workbooks.Open` 直接拋 **RPC_E_CALL_REJECTED**(0x80010001,Excel 忙碌)

  **解法是在同一個 Excel 實例內重開**(4 次遞增退避),不是靠 Node 端外層重試——
  外層每次重試都要付整個 Excel 啟動的代價,卻沒解決競態,實測 3 次全撞的機率有 4 成。
  ⚠️ RPC_E_CALL_REJECTED **必須在迴圈內 catch**:`$ErrorActionPreference` 是 `Stop`,
  不接住第一次就逃出迴圈,重試等於沒寫。

- **要診斷 COM 錯誤,先做這兩件事,否則什麼都看不到**:
  1. `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false`——
     不設的話 COM 的中文錯誤傳回 Node 是亂碼(`���i�b�Ȭ� Null`)。
     (注意這與第 24 行「腳本全 ASCII」不衝突:那是**腳本原始碼**的編碼,
     這是**輸出串流**的編碼,錯誤訊息是 Excel/PowerShell 自己產的中文。)
  2. 對 `$wb`、`$wb.Worksheets`、`$ws`、`$cell` 各給一句**分步命名**的錯誤訊息——
     否則全部都是同一句「不可在值為 Null 的運算式上呼叫方法」,無從判斷斷在哪。
- 驅動腳本刻意**全 ASCII**;分頁名/值等中文從 job JSON 以 `Get-Content -Encoding UTF8` 讀入,故腳本本身不需 BOM(避開前述 BOM 坑)。
- SaveAs FileFormat=52 存回 .xlsm 保巨集(已驗證)。

驗證用 node + `xlsx`(app/node_modules 有):讀 `cell.f` 判公式、`cell.v` 判值、`wb.vbaraw` 判巨集。
