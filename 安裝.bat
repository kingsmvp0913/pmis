@echo off
cd /d "%~dp0"
echo ============================================
echo    PMIS 安裝(第一次使用執行這個就好)
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [1/6] 安裝 Node.js ...
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
) else (
  echo [1/6] Node.js 已安裝,略過
)

set "PGOK="
where psql >nul 2>nul && set "PGOK=1"
reg query "HKLM\SOFTWARE\PostgreSQL\Installations" >nul 2>nul && set "PGOK=1"
if not defined PGOK (
  echo [2/6] 安裝 PostgreSQL 17 ...
  winget install -e --id PostgreSQL.PostgreSQL.17 --silent --accept-package-agreements --accept-source-agreements
) else (
  echo [2/6] PostgreSQL 已安裝,略過
)

call :resolvegit
if not defined GIT (
  echo [3/6] 安裝 Git(啟動時自動更新讀取器要用) ...
  winget install -e --id Git.Git --silent --accept-package-agreements --accept-source-agreements
) else (
  echo [3/6] Git 已安裝,略過
)

call :refreshpath
call :resolvegit

if not defined GIT echo    (Git 需重新開啟視窗才生效,不影響安裝;下次啟動就會自動更新)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node 已安裝完成,但需要重新開啟視窗才能生效。
  echo 請關閉這個視窗,再雙擊一次「安裝.bat」即可繼續。
  echo.
  pause
  exit /b 1
)

echo [4/6] 確認可以自動更新 ...
if not defined GIT goto :gitfail
if exist ".git" goto :gitok
"%GIT%" remote get-url origin >nul 2>nul || goto :gitbootstrap
"%GIT%" rev-parse --verify HEAD >nul 2>nul || goto :gitbootstrap
:gitbootstrap
echo       這份是直接下載的,缺少自動更新需要的資料,正在補上 ...
if not exist ".git" "%GIT%" init || goto :gitfail
"%GIT%" remote get-url origin >nul 2>nul || "%GIT%" remote add origin https://github.com/kingsmvp0913/pmis.git
"%GIT%" fetch origin main || goto :gitfail
"%GIT%" checkout -f -B main origin/main || goto :gitfail
"%GIT%" rev-parse --verify HEAD >nul 2>nul || goto :gitfail
echo       補好了,以後雙擊「啟動.bat」就會自動更新到最新版
goto :gitdone
:gitfail
echo       沒辦法補上,可能是沒有網路,或 Git 剛裝好還需要重開視窗。
echo       系統仍然可以正常使用,只是不會自動更新;
echo       有網路的時候再執行一次本檔就好。
goto :gitdone
:gitok
"%GIT%" remote get-url origin >nul 2>nul || goto :gitbootstrap
"%GIT%" rev-parse --verify HEAD >nul 2>nul || goto :gitbootstrap
echo       已經可以自動更新,略過
:gitdone

echo [5/6] 安裝相依套件 ...
pushd app
call npm install
popd

echo [6/6] 建立資料庫並初始化 ...
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
rem 重新載入系統/使用者 PATH(winget 裝完當前視窗讀不到新的 PATH)
for /f "skip=2 tokens=2,*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "MPATH=%%B"
for /f "skip=2 tokens=2,*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "UPATH=%%B"
call set "PATH=%MPATH%;%UPATH%"
goto :eof

:resolvegit
set "GIT="
where git >nul 2>nul && set "GIT=git"
if not defined GIT if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT=%ProgramFiles%\Git\cmd\git.exe"
if not defined GIT if exist "%LocalAppData%\Programs\Git\cmd\git.exe" set "GIT=%LocalAppData%\Programs\Git\cmd\git.exe"
goto :eof
