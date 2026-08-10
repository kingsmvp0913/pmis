# doc-convert.ps1 — Word (.doc/.docx) -> PDF via Word COM.
# (ASCII-only on purpose; caller passes ASCII temp paths — Chinese paths make
#  Word COM report "file not found" under PS 5.1, see doc-convert.js.)
#
# MUST run under Windows PowerShell 5.1 (same reason as excel-com-driver.ps1:
# the COM type library only loads there).
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'

$word = $null
$doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  # Open(path, ConfirmConversions=false, ReadOnly=true): ReadOnly avoids Word
  # locking the temp file if a previous run left a stale lock.
  $doc = $word.Documents.Open($In, $false, $true)
  $doc.SaveAs2($Out, 17)   # 17 = wdFormatPDF
  Write-Output "ok"
}
finally {
  if ($doc) { try { $doc.Close(0) } catch {} }
  if ($word) {
    try { $word.Quit() } catch {}
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
