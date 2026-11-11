@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title ai-room halt
cd /d "%~dp0"

rem ---- Pick Node: AIROOM_NODE > DSH bundled Node 24 > PATH node ----
set "NODE_EXE="
if defined AIROOM_NODE set "NODE_EXE=%AIROOM_NODE%"
if not defined NODE_EXE set "DSH_NODE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if exist "%DSH_NODE%" set "NODE_EXE=%DSH_NODE%"
if not defined NODE_EXE set "NODE_EXE=node"

if not exist "%NODE_EXE%" (
  "%SystemRoot%\System32\where.exe" "%NODE_EXE%" >nul 2>&1
  if errorlevel 1 (
    echo [ai-room] ERROR: no usable Node.js interpreter found.
    echo [ai-room] Set AIROOM_NODE to the full path of node.exe, or add Node.js to PATH.
    goto :done
  )
)

rem ---- Require Node.js >= 22.13 ----
"%NODE_EXE%" -e "const v=process.versions.node.split('.').map(Number);if(v[0]<22||(v[0]===22&&v[1]<13)){console.error('[ai-room] ERROR: Node.js 22.13 or newer is required, found '+process.versions.node);process.exit(1)}"
if errorlevel 1 (
  echo [ai-room] ERROR: Node.js is too old to halt the room.
  echo [ai-room] Interpreter: "%NODE_EXE%"
  echo [ai-room] Set AIROOM_NODE to Node.js 22.13+, or use the Node 24 bundled with DSH.
  goto :done
)

rem ---- Default --all; pass --room <safeRoomId> for a single room ----
if "%~1"=="" (
  "%NODE_EXE%" "%~dp0scripts\halt.mjs" --all
) else (
  "%NODE_EXE%" "%~dp0scripts\halt.mjs" %*
)

:done
set "HALT_EXIT=%errorlevel%"
rem Keep the window open when the batch is double-clicked.
set "AIROOM_DOUBLE_CLICK="
echo %CMDCMDLINE%| "%SystemRoot%\System32\findstr.exe" /i /c:"%~nx0" >nul && set "AIROOM_DOUBLE_CLICK=1"
if defined AIROOM_DOUBLE_CLICK if not defined AIROOM_NO_PAUSE pause
exit /b %HALT_EXIT%
