#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

$configPath = Join-Path $Root "data\config.json"
if (-not (Test-Path $configPath)) {
    Write-Host "找不到 data\config.json,請先執行 .\install.ps1" -ForegroundColor Red
    exit 1
}

try {
    $config = Get-Content $configPath -Raw | ConvertFrom-Json
} catch {
    Write-Host "data\config.json 損毀,請重跑 .\install.ps1" -ForegroundColor Red
    exit 1
}

if (-not $config.JWT_SECRET) {
    Write-Host "config.json 缺少 JWT_SECRET" -ForegroundColor Red
    exit 1
}

$env:JWT_SECRET = $config.JWT_SECRET
$env:PORT       = if ($config.PORT) { $config.PORT } else { 4141 }
if ($config.DATABASE_URL) { $env:DATABASE_URL = $config.DATABASE_URL }

$port = if ($config.PORT) { $config.PORT } else { 4141 }
Start-Process "http://localhost:$port"
node (Join-Path $Root "app\server\index.js")
