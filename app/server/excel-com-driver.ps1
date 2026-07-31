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

    $wb = $xl.Workbooks.Open($job.templatePath)

    foreach ($op in $job.operations) {
        $ws = $wb.Worksheets.Item($op.sheet)
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
