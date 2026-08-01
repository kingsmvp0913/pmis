# ocr-driver.ps1 - SP1B kickoff report OCR (ASCII-only on purpose).
# Renders each PDF page to a bitmap at a given width and runs the Windows
# built-in OCR engine over it, then prints a one-line JSON result.
#
# MUST be run under Windows PowerShell 5.1: pwsh 7 cannot load WinRT types
# ("Unable to find type"). Same constraint as excel-com-driver.ps1.
#
# No third-party dependency and no network access: Windows.Data.Pdf and
# Windows.Media.Ocr ship with Windows 10/11.
param(
    [Parameter(Mandatory = $true)][string]$PdfPath,
    [Parameter(Mandatory = $true)][int]$Width
)
$ErrorActionPreference = 'Stop'

# Console's default output encoding follows the active codepage (Big5/950 on
# zh-TW Windows), not UTF-8. Node reads child_process stdout as UTF-8, so
# without this line CJK text comes back as mojibake / invalid JSON.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit($obj) { $obj | ConvertTo-Json -Compress -Depth 6 | Write-Output }

try {
    # Load WinRT projections. Assign to $null so the type literal does not
    # print to stdout, which would corrupt the single-line JSON contract.
    $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
    $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

    # WinRT async needs a hand-rolled awaiter under PS 5.1. AsTask has two
    # relevant overloads: a generic one for IAsyncOperation<T> and a plain one
    # for IAsyncAction. Both are fetched by reflection.
    #
    # System.WindowsRuntimeSystemExtensions is NOT auto-loaded just by
    # referencing WinRT namespace types above: without this line PowerShell
    # throws "Unable to find type [System.WindowsRuntimeSystemExtensions]".
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    $asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
    })[0]

    function Await($op, $type) {
        $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
        $t.Wait(-1) | Out-Null
        $t.Result
    }
    function AwaitAction($act) {
        $t = $asTaskAction.Invoke($null, @($act))
        $t.Wait(-1) | Out-Null
    }

    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $engine) {
        Emit @{ ok = $false; error = 'No OCR language pack available' }
        exit 0
    }

    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($PdfPath)) ([Windows.Storage.StorageFile])
    $pdf = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])

    $pages = @()
    $failedPages = @()
    for ($i = 0; $i -lt $pdf.PageCount; $i++) {
        $page = $pdf.GetPage($i)
        $stream = $null
        $bitmap = $null
        try {
            $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
            $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
            $opts.DestinationWidth = $Width
            AwaitAction ($page.RenderToStreamAsync($stream, $opts))

            $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
            $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

            $lines = @()
            foreach ($ln in $result.Lines) { $lines += $ln.Text }
            $pages += @{ page = ($i + 1); width = $Width; lines = $lines }
        }
        catch {
            # A single page failing (e.g. a corrupt embedded image) must not
            # abort the whole document: record it and move on to the next
            # page, so the other pages -- which the two-resolution union
            # design depends on -- still come through.
            $failedPages += @{ page = ($i + 1); width = $Width; error = $_.Exception.Message }
        }
        finally {
            # $stream/$bitmap may be $null if the exception happened before
            # they were created; PdfPage has Dispose(), NOT Close().
            if ($null -ne $bitmap) { $bitmap.Dispose() }
            if ($null -ne $stream) { $stream.Dispose() }
            $page.Dispose()
        }
    }

    if ($pages.Count -eq 0 -and $failedPages.Count -gt 0) {
        # Every page failed: nothing usable came out of this resolution.
        Emit @{ ok = $false; error = 'All pages failed OCR'; failedPages = $failedPages }
    }
    else {
        Emit @{ ok = $true; pages = $pages; failedPages = $failedPages }
    }
}
catch {
    Emit @{ ok = $false; error = $_.Exception.Message }
}
