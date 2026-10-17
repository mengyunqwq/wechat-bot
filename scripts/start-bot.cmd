@echo off
rem WeChat bot launcher (ASCII wrapper only).
rem Real logic lives in start-bot.ps1: batch files are parsed with the console codepage,
rem so Chinese paths break depending on how the script is invoked. PowerShell is codepage-safe.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-bot.ps1"
