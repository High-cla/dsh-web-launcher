@echo off
chcp 65001 >nul
setlocal EnableExtensions
rem deploy.cmd - copy launcher, hooks and tools from this repo to their runtime locations.
rem Every overwritten target is backed up first under %USERPROFILE%\.dsh\launcher-backups\.

set "SRC=%~dp0"
set "DSH=%USERPROFILE%\.dsh"
set "BAK=%DSH%\launcher-backups"
if not exist "%BAK%" mkdir "%BAK%"
set "TS=%DATE%_%TIME%"
set "TS=%TS:/=-%"
set "TS=%TS::=-%"
set "TS=%TS:.=-%"
set "TS=%TS: =_%"

echo [deploy] repo   : %SRC%
echo [deploy] runtime: %DSH%
echo.

call :put "%SRC%launcher\DSH-Web-Launcher.cmd" "%USERPROFILE%\Desktop\DSH-Web-Launcher.cmd"
for %%f in ("%SRC%launcher\*.mts") do call :put "%%~ff" "%DSH%\%%~nxf"
for %%f in ("%SRC%hooks\*.mts") do call :put "%%~ff" "%DSH%\%%~nxf"
for %%f in ("%SRC%tools\*.mts") do call :put "%%~ff" "%DSH%\%%~nxf"

echo.
echo [deploy] done. dry-run self-check (no install, no server start):
echo   node "%DSH%\verify-launcher-channel.mts"
exit /b 0

:put
if not exist "%~1" (echo [skip] missing source: %~1& exit /b 0)
if exist "%~2" copy /Y "%~2" "%BAK%\%~nx2.pre-deploy-%TS%" >nul 2>&1
copy /Y "%~1" "%~2" >nul 2>&1
if errorlevel 1 (echo [fail] %~nx2) else (echo [ok]   %~nx2)
exit /b 0
