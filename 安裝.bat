@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo    PMIS 安裝(第一次使用執行這個就好)
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [1/4] 安裝 Node.js ...
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
) else (
  echo [1/4] Node.js 已安裝,略過
)

where psql >nul 2>nul
if errorlevel 1 (
  echo [2/4] 安裝 PostgreSQL 17 ...
  winget install -e --id PostgreSQL.PostgreSQL.17 --silent --accept-package-agreements --accept-source-agreements
) else (
  echo [2/4] PostgreSQL 已安裝,略過
)

call :refreshpath

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node 已安裝完成,但需要重新開啟視窗才會生效。
  echo 請關閉這個視窗,再雙擊一次「安裝.bat」即可繼續。
  echo.
  pause
  exit /b 1
)

echo [3/4] 安裝相依套件 ...
pushd app
call npm install
popd

echo [4/4] 建立資料庫並初始化 ...
node "app\scripts\setup.js"
if errorlevel 1 (
  echo.
  echo 資料庫初始化失敗。若你電腦已有 PostgreSQL 且密碼不是 postgres,
  echo 請開啟 data\config.json 修改 DATABASE_URL 成正確帳密後,再執行一次本檔。
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================
echo    安裝完成!請雙擊「啟動.bat」開始使用。
echo ============================================
pause
exit /b 0

:refreshpath
rem 重新載入系統/使用者 PATH(winget 裝完當前視窗讀不到新路徑)
for /f "skip=2 tokens=2,*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "MPATH=%%B"
for /f "skip=2 tokens=2,*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "UPATH=%%B"
set "PATH=%MPATH%;%UPATH%"
goto :eof
