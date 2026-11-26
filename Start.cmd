@echo off
setlocal
cd /d "%~dp0"
if not exist "GraphToProtein\GraphToProtein.html" (
  python prepare.py --studio-only
  if errorlevel 1 goto failed
)
set "GTP_PY=python"
if exist "GraphToProtein\local\envs\dsh-gpu\Scripts\python.exe" set "GTP_PY=%CD%\GraphToProtein\local\envs\dsh-gpu\Scripts\python.exe"
"%GTP_PY%" -B -X utf8 "GraphToProtein\demo\run.py" %*
if not errorlevel 1 exit /b 0
:failed
echo Setup: py -3.12 prepare.py
pause
exit /b 1
