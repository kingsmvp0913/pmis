#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location $Root

Write-Host "=== PMIS 系統套件安裝 (Windows) ===" -ForegroundColor Cyan

function Install-WingetPackage($id, $displayName) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host "找不到 winget,請手動安裝 $displayName" -ForegroundColor Red
        exit 1
    }
    Write-Host "安裝 $displayName..." -ForegroundColor Yellow
    winget install -e --id $id --silent --accept-package-agreements --accept-source-agreements
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Install-WingetPackage "OpenJS.NodeJS.LTS" "Node.js LTS" }
if (-not (Get-Command psql -ErrorAction SilentlyContinue)) { Install-WingetPackage "PostgreSQL.PostgreSQL.17" "PostgreSQL 17" }

# 重新整理 PATH(winget 裝完當前 session 讀不到新 PATH)
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path","User")

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js 安裝失敗,請手動安裝後重跑:https://nodejs.org" -ForegroundColor Red
    exit 1
}
Write-Host "Node.js $(node --version)" -ForegroundColor Green

Write-Host "安裝 npm 依賴..." -ForegroundColor Yellow
Push-Location (Join-Path $Root "app")
npm install
Pop-Location

Write-Host "建立資料庫並執行 migration..." -ForegroundColor Yellow
node (Join-Path $Root "app\scripts\setup.js") @args

Write-Host "=== 安裝完成,執行 .\start.ps1 啟動 ===" -ForegroundColor Green
