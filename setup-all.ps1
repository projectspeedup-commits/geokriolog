# Geokriolog workstation setup: fix dead config, install Twenty CRM.
#
# ASCII only, no Cyrillic - PowerShell 5.1 misreads such files without a BOM.
#
# Run:  powershell -ExecutionPolicy Bypass -File .\setup-all.ps1
#
# Steps:
#   1. Remove the dead "hermes" MCP server from .claude.json (the Mac is gone,
#      every start tried to ssh into mac-mini-ip and hung on the timeout).
#   2. Fill in git user.name / user.email if they are missing.
#   3. Install and start Twenty CRM in Docker (secrets generated on this machine).
#   4. Print a short diagnosis of Docker and the desktop app.

$ErrorActionPreference = 'Continue'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $env:USERPROFILE "geokriolog-setup-$stamp.log"

function Say($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    Write-Host $line -ForegroundColor Cyan
    Add-Content -Path $log -Value $line -Encoding UTF8
}
function Warn($msg) {
    $line = "[{0}] WARN: {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    Write-Host $line -ForegroundColor Yellow
    Add-Content -Path $log -Value $line -Encoding UTF8
}

Say "=== Geokriolog setup ==="
Say "log: $log"

# ---------------------------------------------------------------- 1. MCP fix
$cfgPath = Join-Path $env:USERPROFILE '.claude.json'
if (Test-Path $cfgPath) {
    try {
        $raw = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8
        $cfg = $raw | ConvertFrom-Json
        if ($cfg.mcpServers -and $cfg.mcpServers.PSObject.Properties.Name -contains 'hermes') {
            Copy-Item $cfgPath "$cfgPath.bak-$stamp" -Force
            Say "backup of .claude.json: .claude.json.bak-$stamp"
            $cfg.mcpServers.PSObject.Properties.Remove('hermes')
            $cfg | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $cfgPath -Encoding UTF8
            Say "removed dead MCP server 'hermes' (ssh to mac-mini-ip)"
        } else {
            Say "MCP config: nothing to clean"
        }
    } catch {
        Warn "could not edit .claude.json: $($_.Exception.Message)"
    }
} else {
    Warn ".claude.json not found at $cfgPath"
}

# ---------------------------------------------------------------- 2. git ids
try {
    $gitName = (git config --global user.name) 2>$null
    $gitMail = (git config --global user.email) 2>$null
    if (-not $gitName) { git config --global user.name 'Aleksandr'; Say "git user.name set" }
    if (-not $gitMail) { git config --global user.email 'project.speedup@gmail.com'; Say "git user.email set" }
    if ($gitName -and $gitMail) { Say "git identity already set: $gitName <$gitMail>" }
} catch {
    Warn "git not available in PATH - skipped"
}

# ---------------------------------------------------------------- 3. CRM
$InstallDir = Join-Path $env:USERPROFILE 'twenty-crm'
$composeSrc = Join-Path $PSScriptRoot 'docker-compose.yml'

Say "checking Docker"
$dockerOk = $false
try {
    $v = docker version --format '{{.Server.Version}}' 2>$null
    if ($LASTEXITCODE -eq 0 -and $v) { $dockerOk = $true; Say "Docker engine $v" }
} catch { }

if (-not $dockerOk) {
    Warn "Docker is not responding. Start Docker Desktop and run this script again."
} else {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    if (Test-Path $composeSrc) {
        Copy-Item $composeSrc $InstallDir -Force
    } else {
        Say "docker-compose.yml not next to the script - downloading the official one"
        Invoke-WebRequest -UseBasicParsing `
            -Uri 'https://raw.githubusercontent.com/twentyhq/twenty/main/packages/twenty-docker/docker-compose.yml' `
            -OutFile (Join-Path $InstallDir 'docker-compose.yml')
    }

    $envPath = Join-Path $InstallDir '.env'
    if (Test-Path $envPath) {
        Say ".env already exists - kept as is"
    } else {
        Say "generating database password and encryption key on this machine"
        $bytes = New-Object byte[] 24
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $pgPass = ([Convert]::ToBase64String($bytes) -replace '[^a-zA-Z0-9]', '')
        $keyBytes = New-Object byte[] 32
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($keyBytes)
        $encKey = [Convert]::ToBase64String($keyBytes)

        @"
TAG=latest
SERVER_URL=http://localhost:3000
PG_DATABASE_PASSWORD=$pgPass
ENCRYPTION_KEY=$encKey
STORAGE_TYPE=local
"@ | Set-Content -Path $envPath -Encoding utf8

        try {
            $acl = Get-Acl $envPath
            $acl.SetAccessRuleProtection($true, $false)
            $acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
                $env:USERNAME, 'FullControl', 'Allow')))
            Set-Acl -Path $envPath -AclObject $acl
        } catch { Warn "could not tighten permissions on .env" }
        Say "secrets written to .env (not printed anywhere)"
    }

    Say "pulling images and starting containers - first run takes a few minutes"
    Push-Location $InstallDir
    docker compose pull    2>&1 | ForEach-Object { Add-Content -Path $log -Value "    $_" -Encoding UTF8 }
    docker compose up -d   2>&1 | ForEach-Object { Add-Content -Path $log -Value "    $_" -Encoding UTF8 }
    Pop-Location

    Say "waiting for the server to become healthy"
    $ok = $false
    foreach ($i in 1..60) {
        Start-Sleep -Seconds 5
        try {
            $r = Invoke-WebRequest -Uri 'http://localhost:3000/healthz' -UseBasicParsing -TimeoutSec 5
            if ($r.StatusCode -eq 200) { $ok = $true; break }
        } catch { }
        if ($i % 4 -eq 0) { Write-Host ("    ...{0} s" -f ($i * 5)) }
    }

    if ($ok) {
        Say "Twenty CRM is up: http://localhost:3000"
        Start-Process 'http://localhost:3000'
    } else {
        Warn "server did not become healthy within 5 minutes - last log lines:"
        Push-Location $InstallDir
        docker compose logs --tail 40 server 2>&1 |
            ForEach-Object { Write-Host "    $_"; Add-Content -Path $log -Value "    $_" -Encoding UTF8 }
        Pop-Location
    }
}

# ---------------------------------------------------------------- 4. verdict
Say ""
Say "=== summary ==="
$desktop = @(Get-Process -Name claude -ErrorAction SilentlyContinue).Count
Say "Claude desktop processes: $desktop"
if ($dockerOk) {
    Push-Location $InstallDir
    docker compose ps 2>&1 | ForEach-Object { Write-Host "    $_"; Add-Content -Path $log -Value "    $_" -Encoding UTF8 }
    Pop-Location
}
Write-Host ""
Write-Host "-------------------------------------------------------------"
Write-Host " Next steps:"
Write-Host "  1. Open http://localhost:3000 and create the workspace and user."
Write-Host "  2. Settings -> API & Webhooks -> create an API key."
Write-Host "  3. Run install-bridge.ps1 to connect the mailbox to the CRM."
Write-Host "  4. Full log of this run: $log"
Write-Host "-------------------------------------------------------------"
