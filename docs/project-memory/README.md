# PMIS 專案記憶：換機還原指南

此目錄是 PMIS 的 Claude 專案記憶備份。內容已移除 Claude 對話追蹤 ID，並將舊電腦的
使用者路徑改成可攜式寫法。這些文件是歷史工作脈絡，不取代目前的 `AGENTS.md`、Git
狀態或測試結果。

## 新電腦還原

1. Clone PMIS，並在 PowerShell 進入 repository 根目錄。
2. 關閉正在此專案執行的 Claude session。
3. 執行以下 PowerShell。若目的地已有記憶，指令會先建立時間戳備份，再還原本目錄內
   除 `README.md` 外的所有 Markdown 檔。

```powershell
$repoRoot = (Resolve-Path .).Path
$projectKey = $repoRoot -replace '[:\\/]', '-'
$source = Join-Path $repoRoot 'docs\project-memory'
$destination = Join-Path $env:USERPROFILE ".claude\projects\$projectKey\memory"

if (Test-Path -LiteralPath $destination) {
    $backup = "$destination.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $destination -Destination $backup -Recurse
}

New-Item -ItemType Directory -Path $destination -Force | Out-Null
Get-ChildItem -LiteralPath $source -File -Filter '*.md' |
    Where-Object Name -ne 'README.md' |
    Copy-Item -Destination $destination -Force
```

4. 確認 `$destination\MEMORY.md` 存在，再從 repository 根目錄啟動新的 Claude session。

若 Claude 使用的專案目錄命名方式日後改變，先在專案內啟動一次 Claude，再到
`$env:USERPROFILE\.claude\projects\` 找出新建立的專案資料夾，將其中的 `memory` 路徑
代入 `$destination` 後重跑複製步驟。

## Codex 使用方式

Codex 不保證自動載入 Claude 的 `memory` 目錄。需要沿用歷史脈絡時，請先要求 Codex
閱讀 `docs/project-memory/MEMORY.md`，再依索引開啟相關主題檔。

## 安全與維護

- 此 GitHub repository 是公開的。同步新記憶前，必須移除密碼、Token、私鑰、連線字串、
  個資、Claude `originSessionId`，並將個人電腦的絕對路徑改成環境變數或 placeholder。
- `<PMIS_ROOT>` 代表 PMIS repository 根目錄；`%USERPROFILE%` 代表目前 Windows 使用者目錄。
- 還原後，`MEMORY.md` 內的舊 commit、測試數字與接手點仍是歷史快照，不可直接當作
  目前狀態。
