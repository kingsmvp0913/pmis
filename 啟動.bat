@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Update code BEFORE node starts, so the new version takes effect this run.
rem The rev-parse guard is required, not cosmetic: a folder downloaded as a ZIP
rem has no .git, and "git pull" there prints a raw fatal error and never updates.
rem start.js reports that case in Chinese; this line only has to stay quiet.
where git >nul 2>nul && git rev-parse --git-dir >nul 2>nul && git pull --ff-only
node "app\scripts\start.js"
if errorlevel 1 pause