@echo off
chcp 65001 >nul
title DSH Web Launcher
cd /d "%~dp0"
setlocal EnableExtensions
set "MARKER=%USERPROFILE%\.dsh-web-version"

rem --- UPDATE CHANNEL (single switch) ------------------------------------------------------------------
rem   alpha  = prerelease channel (newest; may break plugins; dist-tag alpha)
rem   next   = release-candidate channel (steadier than alpha, newer than latest; dist-tag next)
rem   latest = stable channel (default)
rem Change channel by editing this one line, then delete %MARKER% so the next launch re-evaluates (versions can move backwards between channels).
set "DSH_CHANNEL=next"

echo ============================================
echo   DSH Web Launcher - auto-update
echo   core: @deepseek-ai/dsh - global install
echo   channel: %DSH_CHANNEL%
echo ============================================
echo.

rem A non-writable npm cache makes npm fail outright and silently disables the update check, so probe it first and prepare a fallback cache.
set "NPM_CACHE="
for /f "delims=" %%c in ('npm config get cache 2^>nul') do set "NPM_CACHE=%%c"
set "CACHE_OK="
set "CACHE_BROKEN="
set "NPMCACHE_ARG="
if not defined NPM_CACHE goto :cache_ready
set "PROBE=%NPM_CACHE%\_dsh_write_probe.tmp"
(>"%PROBE%" echo probe) 2>nul
if exist "%PROBE%" set "CACHE_OK=1"
if defined CACHE_OK del "%PROBE%" >nul 2>&1
if defined CACHE_OK goto :cache_ready
set "CACHE_BROKEN=1"
set "FALLBACK_CACHE=%LOCALAPPDATA%\dsh-npm-cache"
if not exist "%FALLBACK_CACHE%" mkdir "%FALLBACK_CACHE%" >nul 2>&1
set "NPMCACHE_ARG=--cache "%FALLBACK_CACHE%""
echo [note] npm cache dir is not writable: %NPM_CACHE%
echo        using fallback cache this run: %FALLBACK_CACHE%
echo.
:cache_ready

echo [1/3] checking latest version - channel: %DSH_CHANNEL% ...
set "LATEST="
for /f "delims=" %%v in ('npm view @deepseek-ai/dsh@%DSH_CHANNEL% version %NPMCACHE_ARG% 2^>nul') do set "LATEST=%%v"

if not defined LATEST (
    if defined CACHE_BROKEN (
        echo [warn] npm cache unwritable and the fallback cache failed too - cannot check for updates.
    ) else (
        echo [warn] cannot fetch the latest version - network or npm proxy unavailable? Starting the installed version.
    )
    goto :boot
)

set "LAST="
if exist "%MARKER%" for /f "usebackq delims=" %%v in ("%MARKER%") do set "LAST=%%v"

rem Marker is written as "<channel> <version>": a channel switch re-evaluates even when the version string is unchanged, so a stale marker cannot skip it.
if "%LAST%"=="%DSH_CHANNEL% %LATEST%" (
    echo already on latest %LATEST% ^(channel %DSH_CHANNEL%^), skipping update.
    goto :boot
)

echo [2/3] updating dsh: %LAST% -^> %LATEST% ^(channel %DSH_CHANNEL%^) ...
call npm install  -g @deepseek-ai/dsh@%LATEST% %NPMCACHE_ARG%
if errorlevel 1 goto :upd_err
>"%MARKER%" echo %DSH_CHANNEL% %LATEST%
echo update complete, recorded %DSH_CHANNEL% %LATEST%.
echo.

:boot
rem Patch self-heal - MUST run before every other hook below: "npm install -g" can report success while leaving
rem empty package dirs inside the global dsh tree, so dsh then dies with
rem   Error: Cannot find package "...\@deepseek-ai\cordis\index.js" ... code ERR_MODULE_NOT_FOUND
rem and the DSH-Web window closes at once - a silent flash-exit. This verifies every dsh dependency resolves
rem and reinstalls the same version when one is missing. Order matters: a reinstall replaces the whole tree and
rem would wipe the patches applied by the hooks below, so those must come after.
if exist "%USERPROFILE%\.dsh\patch-dsh-install-heal.mts" (
    echo [patch] check global dsh install tree...
    node "%USERPROFILE%\.dsh\patch-dsh-install-heal.mts"
    if errorlevel 1 echo [warn] dsh install tree is incomplete - the server may fail to start, see messages above.
)
rem Patch self-heal: npm install -g overwrites the whole package and wipes the dsh-llm-pi-ai UA override patch (the ag provider auth depends on it).
rem Re-applied idempotently before every launch (skipped when already applied). Script: %USERPROFILE%\.dsh\dsh-agua-patch.mts
if exist "%USERPROFILE%\.dsh\dsh-agua-patch.mts" (
    echo [patch] check/reapply ag UA patch...
    node "%USERPROFILE%\.dsh\dsh-agua-patch.mts"
    if errorlevel 1 echo [warn] UA patch reapply failed - the ag provider may fail auth.
)

rem Patch self-heal: @sunjuntao/dsh-prompt-library (profile side) still writes the retired V4 message source shape
rem {kind:'plugin',plugin:'prompt-library'} into its internal AI polish/enrich request; DSH 0.1.7's V4 admission (unchanged in 0.2.1-rc.2) rejects it
rem ('format v4 message requires a producer-owned source kind'), the wedged batch fails the NEXT turn, and nothing reaches the log.
rem The patch rewrites it to the producer-owned kind plugin:prompt-library - the same shape billion-context-dsh and
rem dsh-better-sidebar already use. 0.17.2 (installed as of 2026-10-20) still carries no fix - the hook rewrote
rem the deployed file again that same day - so it restores the fix after any overwrite.
rem Escape hatch: DSH_PROMPTLIB_SOURCE_KIND=off. Missing plugin or unknown upstream shape exits 0 and skips.
if exist "%USERPROFILE%\.dsh\patch-prompt-library-source-kind.mts" (
    echo [patch] check prompt-library V4 source kind...
    node "%USERPROFILE%\.dsh\patch-prompt-library-source-kind.mts"
    if errorlevel 1 echo [warn] prompt-library source-kind patch failed - AI polish may wedge the next turn.
)

rem Patch self-heal: @earendil-works/pi-ai collapses the requested output budget toward 1 (raised to 16 by the
rem Responses floor) whenever its LOCAL history estimate exceeds the model context window - it cannot see that a
rem compression proxy (billion-context) already shrank the same request on the wire. Symptom: replies cut off
rem mid-answer with incomplete_details {"reason":"max_output_tokens"} while bili reports ~13% input usage and
rem logs "output budget restored 16 -> 380 (#546: client shrank it from its raw-history estimate)".
rem   pi-ai/dist/api/simple-options.js : clampMaxTokensToContext() -> Math.max(MIN_MAX_TOKENS, room)
rem   (0.2.2-rc.2 renamed available->room and added a CONTEXT_SAFETY_RATIO branch that still floors to 1)
rem The hook adds an output floor - 16384 by default, pi's own "high" thinking budget - which blocks only the
rem collapse: Math.max(...) stays inside Math.min(maxTokens, ...), so a smaller caller cap (e.g. title
rem generation) is never raised and a larger one is never truncated harder than before.
rem npm install -g replaces the whole tree, so this re-applies before every launch.
rem Escape hatches: DSH_PI_OUTPUT_CLAMP=upstream (skip the patch entirely)
rem                  DSH_PI_OUTPUT_CLAMP_FLOOR=<n> to override the floor
if exist "%USERPROFILE%\.dsh\patch-pi-ai-output-clamp.mts" (
    echo [patch] check pi-ai output-budget clamp...
    node "%USERPROFILE%\.dsh\patch-pi-ai-output-clamp.mts"
    if errorlevel 1 echo [warn] pi-ai output-clamp patch failed - a reply may be cut off after ~16 output tokens.
)
rem Patch self-heal: node-pty 1.2.0-beta.15 publishes its pid asynchronously (lib/windowsTerminal.js:62 sets 0
rem at construction, :69 refreshes it on ready_datapipe), while dsh-subprocess-local captures pid once in its
rem Terminal constructor (src/terminal.ts:96 -> lib/index.js:967). pid stays 0 => rootIdentity undefined, so
rem every terminal_close throws "terminal cleanup failed; surviving pid: 0", the Windows close path only reaches
rem its bare-kill tier (src/terminal.ts:367-396) and the session row lingers as exited. The patch re-reads
rem terminal.pid for <=1s after construction and re-derives rootIdentity. Idempotent; exits 0 when patched.
if exist "%USERPROFILE%\.dsh\patch-subprocess-terminal-pid.mts" (
    echo [patch] check subprocess terminal pid patch...
    node "%USERPROFILE%\.dsh\patch-subprocess-terminal-pid.mts"
    if errorlevel 1 echo [warn] terminal pid patch failed - terminal_close may report "surviving pid: 0".
)
rem Patch self-heal: dsh-live-compact hard-codes PRESET_IDS in gate.js (standard/ptc/minimal/cordis), and any
rem reinstall of the profile package (pnpm add / dsh plugin add) restores the upstream file, dropping the
rem locally added mcp-opt / preset-mcp-opt rows. Preset mcp-opt is this profile's default (cordis.patch.yml
rem selectedDefault) and the spine then silently stops taking it over - native compaction runs instead.
rem Guarded by the target file: without dsh-live-compact installed the script exits 1 by design, and a missing
rem package must not print a warn on every boot.
if exist "%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-live-compact\gate.js" (
    echo [patch] check live-compact preset gate...
    node "%USERPROFILE%\.dsh\patch-live-compact-gate.mts"
    if errorlevel 1 echo [warn] live-compact gate patch failed - preset mcp-opt may fall back to native compaction.
)

echo [3/3] starting DSH Web - http://127.0.0.1:3080 ...
rem dsh prints a single token-bearing login URL and only that URL passes auth; opening the bare http://127.0.0.1:3080 always 401s.
rem dsh-web-boot.mts starts with --no-open, captures that URL and opens it in the default browser (single opener, avoids wrong/duplicate tabs).
if exist "%USERPROFILE%\.dsh\dsh-web-boot.mts" (
    start "DSH-Web" node "%USERPROFILE%\.dsh\dsh-web-boot.mts"
) else (
    start "DSH-Web" "C:\Program Files\Git\bin\bash.exe" -lc "dsh --profile web"
)
echo.
echo Started. The DSH-Web window shows server logs and the login URL; closing it stops the server.
echo If the browser did not open, copy the whole "dsh web: http://..." line from that window into it.
echo.
pause
exit /b 0

:upd_err
echo.
echo [error] dsh update failed. Check network, npm proxy and npm cache-dir permissions.
echo.
pause
exit /b 1
