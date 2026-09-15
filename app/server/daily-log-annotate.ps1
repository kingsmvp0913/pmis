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
$missing = [Type]::Missing
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
      $stage = 'excel-find'
      $hits = @()
      if ($job.relevant -and $job.searchText) {
        foreach ($sheet in @($book.Worksheets)) {
          $range = $null; $found = $null; $first = $null
          try {
            $range = $sheet.UsedRange
            $found = $range.Find([string]$job.searchText, $missing, -4163, 2, 1, 1, $false, $false, $false)
            if ($null -ne $found) {
              $first = $found.Address()
              do {
                $hits += $found
                $found = $range.FindNext($found)
              } while ($null -ne $found -and $found.Address() -ne $first -and $hits.Count -lt 20)
            }
          } finally { Release-Com $range; Release-Com $sheet }
        }
      }
      if ($hits.Count -eq 1) {
        $stage = 'excel-border'
        foreach ($edge in 7,8,9,10) {
          $border = $hits[0].Borders.Item($edge)
          $border.LineStyle = 1; $border.Weight = 4; $border.Color = 255
          Release-Com $border
        }
        $statuses += 'marked'
      } else { $statuses += 'unlocated' }
      foreach ($hit in $hits) { Release-Com $hit }
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
      $stage = 'word-find'
      $range = $doc.Content; $hits = @()
      if ($job.relevant -and $job.searchText) {
        $find = $range.Find; $find.ClearFormatting(); $find.Text = [string]$job.searchText
        $find.Forward = $true; $find.Wrap = 0; $find.MatchCase = $false; $find.MatchWholeWord = $false
        while ($find.Execute() -and $hits.Count -lt 20) {
          $hits += $range.Duplicate
          $range.Start = $range.End; $range.End = $doc.Content.End
          $find = $range.Find; $find.Text = [string]$job.searchText; $find.Forward = $true; $find.Wrap = 0
        }
      }
      if ($hits.Count -eq 1) {
        $stage = 'word-border'
        $hits[0].Borders.Enable = 1
        foreach ($border in @($hits[0].Borders)) { $border.Color = 255; $border.LineWidth = 18; Release-Com $border }
        $statuses += 'marked'
      } else { $statuses += 'unlocated' }
      foreach ($hit in $hits) { Release-Com $hit }
      Release-Com $range
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
