@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Update code BEFORE node starts, so the new version takes effect this run.
rem Skipped silently when git is absent or this folder is not a git repo.
where git >nul 2>nul && git pull --ff-only
node "app\scripts\start.js"
if errorlevel 1 pause