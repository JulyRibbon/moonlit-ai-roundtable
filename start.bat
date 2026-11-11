@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title ai-room live
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
    if not "%AIROOM_NODE%"=="" echo [ai-room] AIROOM_NODE=%AIROOM_NODE%
    exit /b 1
  )
)

rem ---- Require Node.js >= 22.13 ----
"%NODE_EXE%" -e "const v=process.versions.node.split('.').map(Number);if(v[0]<22||(v[0]===22&&v[1]<13)){console.error('[ai-room] ERROR: Node.js 22.13 or newer is required, found '+process.versions.node);process.exit(1)}"
if errorlevel 1 (
  echo [ai-room] ERROR: Node.js is too old to start the room.
  echo [ai-room] Interpreter: "%NODE_EXE%"
  echo [ai-room] Set AIROOM_NODE to Node.js 22.13+, or use the Node 24 bundled with DSH.
  exit /b 1
)

rem ---- Pass through --config and --port to server\live.mjs ----

rem ---- Config: default config\members.local.json ----
set "DEFAULT_CONFIG=config\members.local.json"
set "HAS_CONFIG="
for %%A in (%*) do (
  if /I "%%~A"=="--config" set "HAS_CONFIG=1"
)
echo(%*| "%SystemRoot%\System32\findstr.exe" /i /c:"--config=" >nul && set "HAS_CONFIG=1"

if not defined HAS_CONFIG (
  if not exist "%DEFAULT_CONFIG%" (
    echo [ai-room] ERROR: missing default config %DEFAULT_CONFIG%.
    echo [ai-room] Copy the example and fill in member sessions first:
    echo [ai-room]   copy config\members.example.json config\members.local.json
    echo [ai-room] Or pass another file with --config ^<path^>.
    exit /b 1
  )
  echo [ai-room] using config: %DEFAULT_CONFIG%
  "%NODE_EXE%" "%~dp0server\live.mjs" --config "%DEFAULT_CONFIG%" %*
) else (
  "%NODE_EXE%" "%~dp0server\live.mjs" %*
)

set "AIROOM_RC=%errorlevel%"
if not "%AIROOM_RC%"=="0" (
  echo.
  echo [ai-room] live room failed with exit code %AIROOM_RC%.
  echo [ai-room] 窗口先别关，把上面这行错误抄下来；按任意键退出。
  pause >nul
)
exit /b %AIROOM_RC%
