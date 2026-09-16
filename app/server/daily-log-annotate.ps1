param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [Parameter(Mandatory=$true)][string]$ProblemsPath,
  [Parameter(Mandatory=$true)][ValidateSet('Excel','Word')][string]$Kind
)

$ErrorActionPreference = 'Stop'
$stage = 'load-json'
trap { Write-Error "$stage | line $($_.InvocationInfo.ScriptLineNumber) | hresult $($_.Exception.HResult)"; exit 1 }
$jobs = @(Get-Content -Raw -Encoding UTF8 -LiteralPath $ProblemsPath | ConvertFrom-Json)
Copy-Item -LiteralPath $InputPath -Destination $OutputPath -Force

function Release-Com($obj) {
  if ($null -ne $obj) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($obj) }
}

if ($Kind -eq 'Excel') {
  $app = $null; $book = $null; $summary = $null
  try {
    $stage = 'excel-open'
    $app = New-Object -ComObject Excel.Application
    $app.Visible = $false; $app.DisplayAlerts = $false
    $book = $app.Workbooks.Open($OutputPath, 0, $false)
    $statuses = @()
    foreach ($job in $jobs) {
      $cell = $null; $sheet = $null
      if ($null -ne $job.source -and $job.source.kind -eq 'excel') {
        $stage = 'excel-border'
        $sheet = $book.Worksheets.Item([string]$job.source.sheet)
        $cell = $sheet.Range([string]$job.source.address)
        foreach ($edge in 7,8,9,10) {
          $border = $cell.Borders.Item($edge)
          $border.LineStyle = 1; $border.Weight = 4; $border.Color = 255
          Release-Com $border
        }
        $statuses += 'marked'
      } else { $statuses += 'unlocated' }
      Release-Com $cell; Release-Com $sheet
    }

    $stage = 'excel-summary'
    $summary = $book.Worksheets.Add()
    $baseName = '廠商問題'; $name = $baseName; $n = 2
    while (@($book.Worksheets | ForEach-Object { $_.Name }) -contains $name) { $name = "$baseName($n)"; $n++ }
    $summary.Name = $name
    $summary.Cells.Item(1,1) = '級別'; $summary.Cells.Item(1,2) = '代碼'; $summary.Cells.Item(1,3) = '日期'
    $summary.Cells.Item(1,4) = '項次'; $summary.Cells.Item(1,5) = '標註結果'; $summary.Cells.Item(1,6) = '說明'
    for ($i = 0; $i -lt $jobs.Count; $i++) {
      $p = $jobs[$i].problem; $row = $i + 2
      $summary.Cells.Item($row,1) = [string]$p.級別; $summary.Cells.Item($row,2) = [string]$p.code
      $summary.Cells.Item($row,3) = [string]$p.日期; $summary.Cells.Item($row,4) = [string]$p.項次
      $summary.Cells.Item($row,5) = $(if ($statuses[$i] -eq 'marked') { '已畫紅框' } else { '未定位' })
      $summary.Cells.Item($row,6) = [string]$p.訊息
    }
    $summary.Rows.Item(1).Font.Bold = $true; $summary.Rows.Item(1).Font.Color = 255
    $summary.Columns.AutoFit() | Out-Null
    $stage = 'excel-save'
    $book.Save(); $book.Close($true); $book = $null
    ConvertTo-Json -Compress -InputObject @($statuses)
  } finally {
    if ($null -ne $book) { try { $book.Close($false) } catch {} }
    if ($null -ne $app) { try { $app.Quit() } catch {} }
    Release-Com $summary; Release-Com $book; Release-Com $app
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  }
} else {
  $app = $null; $doc = $null
  try {
    $stage = 'word-open'
    $app = New-Object -ComObject Word.Application
    $app.Visible = $false; $app.DisplayAlerts = 0
    $doc = $app.Documents.Open($OutputPath, $false, $false)
    $statuses = @()
    foreach ($job in $jobs) {
      $range = $null; $table = $null; $cell = $null
      if ($null -ne $job.source -and $job.source.kind -eq 'word') {
        $stage = 'word-border'
        $table = $doc.Tables.Item([int]$job.source.table)
        $cell = $table.Range.Cells.Item([int]$job.source.cell)
        $range = $cell.Range; $range.Borders.Enable = 1
        $range.Borders.OutsideLineStyle = 1
        $range.Borders.OutsideLineWidth = 18
        $range.Borders.OutsideColor = 255
        $statuses += 'marked'
      } else { $statuses += 'unlocated' }
      Release-Com $range; Release-Com $cell; Release-Com $table
    }
    $stage = 'word-summary'
    $end = $doc.Content; $end.Collapse(0); $end.InsertBreak(7); $end.InsertAfter("廠商問題摘要`r")
    for ($i = 0; $i -lt $jobs.Count; $i++) {
      $p = $jobs[$i].problem
      $displayStatus = $(if ($statuses[$i] -eq 'marked') { '已畫紅框' } else { '未定位' })
      $end.InsertAfter("$($p.級別) $($p.code) $($p.日期) 項次:$($p.項次) [$displayStatus] $($p.訊息)`r")
    }
    $stage = 'word-save'
    $doc.Save(); $doc.Close($true); $doc = $null
    ConvertTo-Json -Compress -InputObject @($statuses)
  } finally {
    if ($null -ne $doc) { try { $doc.Close($false) } catch {} }
    if ($null -ne $app) { try { $app.Quit() } catch {} }
    Release-Com $doc; Release-Com $app
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  }
}
