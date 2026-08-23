# Install the mail -> Twenty CRM bridge on Windows.
# ASCII only, no Cyrillic - PowerShell 5.1 misreads such files without a BOM.
#
# Run:  powershell -ExecutionPolicy Bypass -File .\install-bridge.ps1
#
# Asks for the Yandex.Mail app password and the Twenty API key, stores them in
# a local .env (readable only by you), does a dry run, then registers a
# scheduled task that runs every 5 minutes.

$ErrorActionPreference = 'Stop'
$Dir = Join-Path $env:USERPROFILE 'twenty-crm'
$TaskName = 'Geokriolog mail to CRM'

function Say($t) { Write-Host "==> $t" -ForegroundColor Cyan }
function Fail($t) { Write-Host "!!! $t" -ForegroundColor Red; exit 1 }

Say 'Looking for Python'
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }
if (-not $py) { Fail 'Python not found. Install it from python.org or Microsoft Store, then run again.' }
Say "Python: $($py.Source)"

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'leads_bridge.py') $Dir -Force
$script = Join-Path $Dir 'leads_bridge.py'
$envPath = Join-Path $Dir '.env'

if (Test-Path $envPath) {
    Say '.env already exists - kept as is'
} else {
    Say 'Two secrets are needed. They never leave this machine.'
    Write-Host '  1) Yandex.Mail app password for info@geokriolog.ru'
    Write-Host '     id.yandex.ru -> Security -> App passwords -> Mail'
    Write-Host '  2) Twenty API key: http://localhost:3000 -> Settings -> API and Webhooks'
    $mailUser = Read-Host 'Mailbox (default info@geokriolog.ru)'
    if ([string]::IsNullOrWhiteSpace($mailUser)) { $mailUser = 'info@geokriolog.ru' }
    $mailPass = Read-Host 'Yandex.Mail app password' -AsSecureString
    $crmToken = Read-Host 'Twenty API key' -AsSecureString

    function Plain($secure) {
        $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
    }

    @"
IMAP_HOST=imap.yandex.ru
IMAP_USER=$mailUser
IMAP_PASSWORD=$(Plain $mailPass)
TWENTY_URL=http://localhost:3000
TWENTY_TOKEN=$(Plain $crmToken)
"@ | Set-Content -Path $envPath -Encoding utf8

    try {
        $acl = Get-Acl $envPath
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            $env:USERNAME, 'FullControl', 'Allow')))
        Set-Acl -Path $envPath -AclObject $acl
    } catch { Write-Host 'WARN: could not tighten permissions on .env' -ForegroundColor Yellow }
    Say 'Secrets stored in .env'
}

Say 'Dry run - reads the mailbox, creates nothing'
& $py.Source $script --dry-run
if ($LASTEXITCODE -ne 0) {
    Fail 'Dry run failed. Check .env and that Twenty answers on http://localhost:3000'
}

Say 'Registering a scheduled task (every 5 minutes)'
schtasks /Query /TN $TaskName 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) { schtasks /Delete /TN $TaskName /F | Out-Null }

$action = New-ScheduledTaskAction -Execute $py.Source -Argument "`"$script`"" -WorkingDirectory $Dir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Description 'Leads from geokriolog.ru mailbox into Twenty CRM' | Out-Null

Say 'Done. The bridge runs in the background.'
Write-Host "    Log:      $Dir\leads_bridge.log"
Write-Host "    Status:   schtasks /Query /TN `"$TaskName`""
Write-Host "    Run now:  schtasks /Run /TN `"$TaskName`""
Write-Host "    Remove:   schtasks /Delete /TN `"$TaskName`" /F"
