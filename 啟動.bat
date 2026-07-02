@echo off
chcp 65001 >nul
title PMIS 營造廠商報表系統
cd /d "%~dp0"

if not exist ".venv\Scripts\activate.bat" (
    echo [提示] 尚未安裝,將為您執行第一次安裝...
    call "安裝.bat"
    exit /b 0
)

call ".venv\Scripts\activate.bat"

echo PMIS 系統啟動中,瀏覽器會自動開啟...
echo (使用期間請保留此視窗;要結束系統時關閉此視窗即可)

python -m app.main
