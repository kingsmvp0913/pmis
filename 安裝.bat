@echo off
chcp 65001 >nul
title PMIS 營造廠商報表系統 - 安裝
cd /d "%~dp0"

echo ============================================================
echo    PMIS 營造廠商報表系統 - 第一次安裝
echo ============================================================
echo.
echo 這個視窗會顯示安裝進度,請稍候不要關閉。
echo.

echo [1/5] 檢查 Python 是否已安裝...
python --version >nul 2>&1
if errorlevel 1 (
    echo.
    echo [錯誤] 找不到 Python!
    echo 請先到 https://www.python.org/downloads/ 下載並安裝 Python,
    echo 安裝時記得勾選「Add Python to PATH」,然後再點兩下這個安裝檔。
    echo.
    pause
    exit /b 1
)
python --version
echo     Python 已就緒。
echo.

echo [2/5] 建立獨立虛擬環境(不會影響您電腦其他程式)...
if not exist ".venv" (
    python -m venv .venv
    if errorlevel 1 (
        echo [錯誤] 建立虛擬環境失敗,請聯絡技術人員。
        pause
        exit /b 1
    )
)
echo     虛擬環境已建立。
echo.

echo [3/5] 安裝所需套件(第一次會下載,請耐心等候)...
call ".venv\Scripts\activate.bat"
python -m pip install --upgrade pip >nul
python -m pip install -r requirements.txt
if errorlevel 1 (
    echo [錯誤] 套件安裝失敗,請檢查網路連線後重試。
    pause
    exit /b 1
)
echo     套件安裝完成。
echo.

echo [4/5] 初始化資料庫與管理者帳號...
python -c "from app.base_paths import ensure_dirs; from app.db import init_db; from app.auth import ensure_default_admin; ensure_dirs(); init_db(); r=ensure_default_admin(); print('     資料庫已建立於 data\\pmis.db'); print('     預設管理者帳號 admin / admin(登入後請盡快改密碼)') if r else print('     已存在帳號,略過建立管理者')"
if errorlevel 1 (
    echo [錯誤] 資料庫初始化失敗。
    pause
    exit /b 1
)
echo.

echo [5/5] 安裝完成!正在開啟系統設定頁...
echo.
echo ============================================================
echo    安裝成功!以後每天只要點兩下「啟動.bat」即可使用。
echo ============================================================
echo.
start "" cmd /c "啟動.bat"
timeout /t 2 >nul
exit /b 0
