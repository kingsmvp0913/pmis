# excel-com-driver.ps1 — SP0 Excel COM writer (ASCII-only on purpose).
# Reads a job JSON (UTF-8) describing a template, an output path and a list of
# operations, applies them via Excel COM, recalculates and saves as .xlsm
# (preserving macros/formulas/formatting), then prints a one-line JSON result.
#
# MUST be run under Windows PowerShell 5.1 (pwsh 7 COM traversal is unstable).
# All Chinese text (sheet names, cell values) arrives via the UTF-8 job JSON,
# so this script itself stays ASCII and needs no BOM.
param([Parameter(Mandatory = $true)][string]$JobPath)
$ErrorActionPreference = 'Stop'

# Without this, Chinese in a COM error message comes back to Node as mojibake
# (the shell's OEM codepage bytes decoded as UTF-8), e.g. the null-reference
# error arrives as "???i?b?Ȭ? Null" and is useless for diagnosis.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

function Emit($obj) { $obj | ConvertTo-Json -Compress -Depth 6 | Write-Output }

# PInvoke: map an Excel window handle to its owning process id, so on teardown
# we can wait for / kill exactly the instance we started (never the user's other
# Excel windows). Lingering EXCEL.EXE holds the template file open and makes the
# next COM Open return a workbook whose .Worksheets is null.
if (-not ('Win32Api' -as [type])) {
    Add-Type -Namespace Native -Name Win32Api -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern int GetWindowThreadProcessId(int hWnd, out int lpdwProcessId);
'@
}

$xl = $null
$wb = $null
$excelPid = 0
try {
    $job = Get-Content -Raw -Encoding UTF8 $JobPath | ConvertFrom-Json

    $xl = New-Object -ComObject Excel.Application
    $xl.Visible = $false
    $xl.DisplayAlerts = $false
    # Template is macro-enabled; under automation a Workbook_Open macro or the
    # enable-macros prompt can block indefinitely. Suppress both: don't fire
    # events on Open, and lower automation security so no macro dialog appears.
    $xl.EnableEvents = $false
    $xl.AutomationSecurity = 1   # msoAutomationSecurityLow
    [void][Native.Win32Api]::GetWindowThreadProcessId($xl.Hwnd, [ref]$excelPid)

    # Back-to-back runs hit a COM race: Open succeeds and hands back a workbook
    # object, but its .Worksheets is still null (measured — the failure is
    # "workbook opened but .Worksheets is null, ReadOnly=False", not a null Open
    # and not a missing sheet name). Reopening inside the same Excel instance
    # clears it, and is far cheaper than failing the whole job so the Node layer
    # can respawn PowerShell + Excel — which was landing ~40% of back-to-back
    # runs in "retried 3 times and still failed".
    # Two distinct races were measured here, so both have to be absorbed:
    #   1. Open succeeds but .Worksheets is null
    #   2. Open throws RPC_E_CALL_REJECTED (0x80010001) — Excel busy
    # $ErrorActionPreference is Stop, so (2) must be caught inside the loop or it
    # escapes on the first try.
    $wb = $null
    $openErr = ''
    for ($open = 1; $open -le 4; $open++) {
        try {
            $wb = $xl.Workbooks.Open($job.templatePath)
            if ($null -ne $wb -and $null -ne $wb.Worksheets) { break }
        }
        catch { $openErr = $_.Exception.Message }
        if ($null -ne $wb) { try { $wb.Close($false) } catch {} }
        $wb = $null
        Start-Sleep -Milliseconds (400 * $open)
    }
    # Keep naming the failing step: the generic "cannot call a method on a
    # null-valued expression" says nothing about which call broke.
    if ($null -eq $wb) { throw "Workbooks.Open failed after 4 attempts: $openErr" }
    if ($null -eq $wb.Worksheets) { throw "workbook opened but .Worksheets stayed null after 4 attempts (ReadOnly=$($wb.ReadOnly))" }

    $i = 0
    foreach ($op in $job.operations) {
        $ws = $wb.Worksheets.Item($op.sheet)
        if ($null -eq $ws) { throw "Worksheets.Item returned null at operation #$i (sheet count=$($wb.Worksheets.Count))" }
        $i++
        switch ($op.type) {
            'setCell' {
                $cell = $ws.Range($op.addr)
                if ($null -eq $op.value) { $cell.ClearContents() | Out-Null }
                # `$cell.Value2 = $op.value` cannot be used here: PowerShell 5.1 caches the
                # COM property-setter binding per call site keyed on the first value's type,
                # so a job that writes a string cell before a numeric one dies with
                # "Unable to cast object of type 'System.Int32' to type 'System.String'".
                # Going through IDispatch directly keeps the value's own type each time.
                else { [void]$cell.GetType().InvokeMember('Value2', 'SetProperty', $null, $cell, @($op.value)) }
            }
            'setRange' {
                $rows = $op.values.Count
                $cols = $op.values[0].Count
                $arr = New-Object 'object[,]' $rows, $cols
                for ($r = 0; $r -lt $rows; $r++) {
                    for ($c = 0; $c -lt $cols; $c++) { $arr[$r, $c] = $op.values[$r][$c] }
                }
                $ws.Range($op.startAddr).Resize($rows, $cols).Value2 = $arr
            }
            'copyRowDown' {
                $top = [int]$op.srcRow
                $bottom = $top + [int]$op.count
                $ws.Range($ws.Rows.Item($top), $ws.Rows.Item($bottom)).FillDown() | Out-Null
            }
            # Like copyRowDown, but pushes everything below down first instead of
            # overwriting it. Needed where the formula block is followed by other
            # content (the 監造報表 sheet has report body text right under the item
            # rows); FillDown alone would silently destroy it.
            'insertRowsBelow' {
                $top = [int]$op.srcRow
                $count = [int]$op.count
                $ws.Range($ws.Rows.Item($top + 1), $ws.Rows.Item($top + $count)).Insert(-4121) | Out-Null
                $ws.Range($ws.Rows.Item($top), $ws.Rows.Item($top + $count)).FillDown() | Out-Null
            }
            # Whole-row delete (xlShiftUp), the inverse of insertRowsBelow. The manual
            # reports delete the unused item rows outright rather than blanking them, so
            # the report body sits directly under the last real item; leaving them in
            # pushes the body down and prints trailing empty rows.
            'deleteRows' {
                $top = [int]$op.startRow
                $count = [int]$op.count
                $ws.Range($ws.Rows.Item($top), $ws.Rows.Item($top + $count - 1)).Delete(-4162) | Out-Null
            }
            # Widen-only AutoFit. The contract-quantity column is a fixed width in
            # the template but the numbers are not: 2,600.00 does not fit and Excel
            # prints ######## — the value is right, so a cell-by-cell diff never sees
            # it. The caseworkers widen that column by hand (measured 9.67-13.00
            # across 49 filled reports). Never narrow: the template widths were
            # matched to theirs on purpose, and AutoFit on a near-empty column
            # would shrink it to the header.
            'autoFitColumns' {
                foreach ($c in $op.cols) {
                    $col = $ws.Columns.Item($c)
                    $before = [double]$col.ColumnWidth
                    $col.AutoFit() | Out-Null
                    if ([double]$col.ColumnWidth -lt $before) { $col.ColumnWidth = $before }
                }
            }
            # Row background fill, applied by row number over a fixed column span.
            #
            # Why this is needed: the template paints the fee rows (the last five item
            # rows) light green, but that colour lives at FIXED row numbers. The number
            # of real items differs per project, so after deleteRows/insertRowsBelow the
            # green sits on whatever row happens to be there — measured on 元長: fee items
            # landed on rows 30-34 while the green stayed on 33-34. Half the block is
            # coloured and half is not, and no cell-by-cell diff can see it because the
            # VALUES are all correct.
            #
# One rectangle per operation, not a list of rows: the daily-log sheet is 604
            # columns wide and a project can have 200 item rows, so per-row calls would be
            # 200 COM round-trips for what Excel does in one. The fee items are always the
            # last rows (see 費用項目全在尾端), so the block is contiguous either way.
            #
            # `fill` is an RGB string like 'E2F0D9'; $null clears the fill. Excel's
            # Interior.Color is BGR, hence the byte swap.
            'setRowFill' {
                $rng = $ws.Range(
                    $ws.Cells([int]$op.firstRow, [int]$op.firstCol),
                    $ws.Cells([int]$op.lastRow, [int]$op.lastCol))
                if ($null -eq $op.fill -or '' -eq $op.fill) {
                    $rng.Interior.ColorIndex = -4142   # xlColorIndexNone
                }
                else {
                    $rgb = [Convert]::ToInt32([string]$op.fill, 16)
                    $bgr = (($rgb -band 0xFF) -shl 16) -bor ($rgb -band 0xFF00) -bor (($rgb -shr 16) -band 0xFF)
                    $rng.Interior.Color = $bgr
                }
            }
        }
    }

    $xl.CalculateFull()
    $wb.SaveAs($job.outPath, 52)   # 52 = xlOpenXMLWorkbookMacroEnabled (.xlsm)
    Emit @{ ok = $true; outPath = $job.outPath }
}
catch {
    Emit @{ ok = $false; error = $_.Exception.Message }
}
finally {
    if ($wb) {
        try { $wb.Close($false) } catch {}
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($wb)
    }
    if ($xl) {
        try { $xl.Quit() } catch {}
        [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
    }
    $wb = $null
    $xl = $null
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()

    # Wait for our Excel instance to exit gracefully before returning, so the
    # next COM Open starts clean. Force-killing too early leaves a "not properly
    # closed" flag that makes the next Open pop a recovery dialog and hang, so we
    # give it a generous grace period and only kill as a last resort.
    if ($excelPid -gt 0) {
        try {
            $p = Get-Process -Id $excelPid -ErrorAction SilentlyContinue
            if ($p) { if (-not $p.WaitForExit(8000)) { $p.Kill() } }
        } catch {}
    }
}
