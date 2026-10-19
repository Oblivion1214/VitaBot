param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$taskStartup = [Environment]::GetFolderPath('Startup')
$taskLink = Join-Path $taskStartup 'VitaBot Audio.lnk'
if ($Remove) {
    if (Test-Path -LiteralPath $taskLink) { Remove-Item -LiteralPath $taskLink }
    Write-Output 'Arranque automático retirado. El servicio activo no se detiene.'
    exit
}
$taskNode = (Get-Command node.exe).Source
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot '.env.audio'))) { throw 'Configura primero .env.audio' }
$taskRefreshPath = '$env:Path = [Environment]::GetEnvironmentVariable(''Path'', ''Machine'') + '';'' + [Environment]::GetEnvironmentVariable(''Path'', ''User''); '
$taskCommand = $taskRefreshPath + "& '" + $taskNode.Replace("'", "''") + "' '" + (Join-Path $taskRoot 'audio/supervisor.js').Replace("'", "''") + "'"
$taskShell = New-Object -ComObject WScript.Shell
if (Test-Path -LiteralPath $taskLink) {
    $taskBackupDir = Join-Path $taskRoot '.cache\audio-service'
    New-Item -ItemType Directory -Path $taskBackupDir -Force | Out-Null
    $taskPrevious = Join-Path $taskBackupDir 'startup-original.lnk'
    if (-not (Test-Path -LiteralPath $taskPrevious)) { Copy-Item -LiteralPath $taskLink -Destination $taskPrevious }
}
$taskShortcut = $taskShell.CreateShortcut($taskLink)
$taskShortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskShortcut.Arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -Command "' + $taskCommand + '"'
$taskShortcut.WorkingDirectory = $taskRoot
$taskShortcut.WindowStyle = 7
$taskShortcut.Description = 'Audio privado de VitaBot, con recuperación y logs limitados'
$taskShortcut.Save()
Write-Output 'Audio configurado para iniciar oculto al entrar a esta cuenta de Windows.'
