@echo off
setlocal
cd /d "%~dp0" || exit /b 1
set "PYTHONHOME="
set "PYTHONPATH="
set "PYTHONNOUSERSITE=1"
set "PYTHONDONTWRITEBYTECODE=1"
if not exist "runtime\python\python.exe" (
  echo Please fully extract the Windows release ZIP, including the runtime folder.
  pause
  exit /b 1
)
"runtime\python\python.exe" -B -s -X utf8 "GraphToProtein\demo\run.py" %*
if not errorlevel 1 exit /b 0
echo The studio could not start. See the message above.
pause
exit /b 1
