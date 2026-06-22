# killport.ps1 - Kill process occupying port 8000 and old Python processes holding DB
$output = netstat -ano
foreach ($line in $output) {
    if ($line -match ':8000' -and $line -match 'LISTENING') {
        $parts = $line -split '\s+' | Where-Object { $_ -ne '' }
        $pidStr = $parts[-1]
        if ($pidStr -match '^\d+$') {
            taskkill.exe /F /PID $pidStr 2>$null
            Write-Host "[PRE] Killed process on port 8000 (PID: $pidStr)"
        }
    }
}

# Also kill any Python processes from the project that might be holding the DB lock
Get-WmiObject Win32_Process | Where-Object {
    $_.CommandLine -and ($_.Name -eq "python.exe" -or $_.Name -eq "pythonw.exe") -and
    ($_.CommandLine -like "*pycharm(project)*WSCW_4*" -or $_.CommandLine -like "*WSCW_4*.venv*")
} | ForEach-Object {
    try {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "[PRE] Killed old Python process holding DB (PID: $($_.ProcessId))"
    } catch {}
}

Start-Sleep -Seconds 1
