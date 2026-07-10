@echo off
chcp 65001 >nul
cd /d "%~dp0"
node "app\scripts\start.js"
if errorlevel 1 pause
