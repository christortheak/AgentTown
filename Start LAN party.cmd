@echo off
rem Double-click to run AgentTown for a party on one network: npm run lan, in this
rem folder. It finds this PC's address, makes a director key and opens the
rem director's view. See "On the day" in docs\HOST.md.
cd /d "%~dp0"
where node >nul 2>nul || (echo AgentTown needs Node.js 22 or later: https://nodejs.org& pause& exit /b 1)
if not exist node_modules (call npm install || (echo npm install did not work. See docs\TRY-IT.md, steps 1 and 2.& pause& exit /b 1))
call npm run lan
echo AgentTown has stopped.
pause
