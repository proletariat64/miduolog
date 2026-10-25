@echo off
cd /d "%~dp0"
powershell -NoProfile -Command "Start-Process -FilePath 'node.exe' -ArgumentList @('app/server.mjs') -WorkingDirectory (Get-Location).Path -WindowStyle Hidden; Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:4318/'"
