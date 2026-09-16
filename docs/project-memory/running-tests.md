---
name: running-tests
description: app/ 跑測試的必帶旗標、已知 flaky、以及那個「繞過 Jest 沙箱」的隔離陷阱
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-07T17:22:23.859Z
---

專案 CLAUDE.md §6 規定：**測試的實測結論一律寫這裡，不寫進 CLAUDE.md**
（會隨 commit 漂移，寫進規則檔遲早變成錯的指令）。這則就是那個「去哪裡看」的目的地。
**測試數字（幾支、幾秒）刻意不記——要基線就當場跑。**

## 必帶旗標

`SP0_SKIP_EXCEL=1`。**此旗標只存在於測試碼裡，`package.json` 查不到。**
它讓 `tests/template-engine.integration.test.js` 與
`tests/project-basics.integration.test.js` 整檔 `describe.skip`——
**skipped 是預期的，不是漏跑**。這兩檔會真的開 Excel，佔掉全跑絕大部分時間。
碰 `template-engine.js` / `excel-com-driver.ps1` / 範本寫入時才拿掉旗標。

## 已知 flaky

`tests/template-engine.integration.test.js` — Excel COM 間歇回 null，
連跑兩次紅的是不同子集（見 [[xlsm-excel-com-findings]]）。
**紅了先重跑一次；換一支紅就是 flaky，不要追。**

## 隔離陷阱：繞過 Jest 沙箱的那條路（2026-08-08 已修，但要知道為什麼）

`registry.install` / `registry.inspect` 用 `Module._compile` 載入讀取器，
**刻意繞過 Jest 沙箱**（否則讀取器 require 不到 xlsx/pdf-parse）。代價是那些模組
會殘留在 worker 的全域 require cache 裡。

當 `parser-onboarding.test.js` 掃整個 `samples/` 目錄做 install 時，
等於一支測試裡做「讀取器支數 × 2」次繞過沙箱的編譯。支數隨每次補讀取器成長，
到 19 支時該檔從 1.7 秒變 10.9 秒，並且**間歇性地毒到同一個 worker 的鄰居測試**：
後續 pg 的 lazy `require('pgpass')` 會拿到壞掉的 cache entry，噴出
`TypeError: pgPass is not a function` 這種與測試內容完全無關的 Unhandled error。
症狀是**四次全跑會中一次，每次陪葬的鄰居還不一樣**（daily-log-routes、vendor…），
單獨跑那兩支卻都過——很容易誤判成「某某功能壞了」。

**修法**（已 commit）：那支測試改掃「只放三支複本的暫存目錄」——它要驗的是 upsert 的
行為，不是「repo 裡目前有幾支讀取器」。「有人 commit 了裝不起來的讀取器」改由同檔的
`bundled 讀取器健康檢查` 守：用 Jest 自己的 require + `validateModule` 逐支驗
（不走 `Module._compile`、不寫檔、不碰 DB），守得比原本更嚴。

**教訓**：任何測試只要會呼叫 `registry.install`/`inspect`，就不要對「整個目錄」做，
規模會隨專案成長而變成 race。

## 兩支「本來就逼近 5 秒」的測試(2026-08-12 量的)

`contract-items-routes` 的 **`確認後寫入報表並落庫`(單獨跑 2.7 秒)** 與
`parser.test.js` 的 **`列出 jinda/zhidong/jinlin`(2.5 秒)**。前者要複製 694KB
的公版範本再用 SheetJS 讀兩次,後者要掃描並載入全部 bundled 讀取器(成本隨補
讀取器成長)。Jest 預設 5 秒只剩不到兩倍餘裕,**全套並行時會被 CPU 爭用推過去**。

已各自標 15000ms 並在測試碼裡寫明理由。⚠️ 若日後又看到這兩支紅:
**先確認是不是逾時**(訊息是 "Exceeded timeout of ...ms"),那不是功能壞掉。
2026-08-12 踩過:加了 13 支新測試之後連三次全套都紅在這兩支,一度懷疑是自己
改慢了——實測 `itemsToOperations` 每次 0.058 ms,根本不是。
**要判斷是不是自己改慢的,就 `git stash` 跑一次基準**,那比猜快得多。

## 判斷「有沒有真的紅」

先重跑一次（見上面的 flaky）。仍紅再看是不是隔離問題：
`npx jest --runInBand` 全綠而並行紅 = 沿著上面那條線索找，不是程式壞了。
