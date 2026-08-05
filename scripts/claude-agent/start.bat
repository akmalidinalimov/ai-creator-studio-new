@echo off
REM Convenience launcher for the Claude Code laptop helper (Windows).
REM Runs the helper and appends output to agent.log next to this file.
REM Used both for manual runs and by the auto-start scheduled task (see README).
cd /d "%~dp0..\.."
node "%~dp0agent.mjs" >> "%~dp0agent.log" 2>&1
