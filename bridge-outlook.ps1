#Requires -Version 5.1
<#
    Мост «Outlook → Twenty CRM» для НПО ГЕОКРИОЛОГ.

    Почта info@geokriolog.ru уже подключена к Outlook на этой машине, поэтому
    письма берутся прямо из Outlook через COM — пароль приложения Яндекса
    не нужен вовсе. Единственный секрет — API-ключ Twenty, он хранится в
    локальном файле .env и в лог не попадает.

    Файл сохранён в UTF-8 С BOM: без BOM PowerShell 5.1 читает кириллицу как
    кракозябры, и фильтр по теме письма перестаёт работать.

    Использование:
        .\bridge-outlook.ps1 -Install     настроить и поставить в Планировщик
        .\bridge-outlook.ps1 -DryRun      прогон без записи в CRM
        .\bridge-outlook.ps1              обычный прогон (так его запускает задание)
#>

[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Dir      = Join-Path $env:USERPROFILE 'twenty-crm'
$EnvPath  = Join-Path $Dir '.env.outlook'
$LogPath  = Join-Path $Dir 'bridge-outlook.log'
$TaskName = 'Geokriolog Outlook to CRM'
$DoneName = 'CRM'          # куда убирать обработанные письма
$Days     = 14             # насколько глубоко смотреть

function Log($msg) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Host $line
    try { Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8 } catch { }
}

# ─────────────────────────────────────────────────────────── настройки

function Read-Settings {
    if (-not (Test-Path $EnvPath)) {
        Log "нет файла .env.outlook — запустите скрипт с ключом -Install"
        exit 1
    }
    $cfg = @{}
    foreach ($line in Get-Content -LiteralPath $EnvPath -Encoding UTF8) {
        $line = $line.Trim()
        if (-not $line -or $line.StartsWith('#') -or ($line -notmatch '=')) { continue }
        $k, $v = $line.Split('=', 2)
        $cfg[$k.Trim()] = $v.Trim()
    }
    foreach ($need in 'TWENTY_URL', 'TWENTY_TOKEN') {
        if (-not $cfg[$need]) { Log "в .env.outlook не заполнено: $need"; exit 1 }
    }
    return $cfg
}

function Save-Settings {
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    if (Test-Path $EnvPath) {
        Write-Host '.env.outlook уже есть — оставляю как есть'
        return
    }
    Write-Host 'Нужен один секрет: API-ключ Twenty.'
    Write-Host 'Взять его: http://localhost:3000 -> Settings -> API & Webhooks -> создать ключ.'
    $url = Read-Host 'Адрес CRM (Enter — http://localhost:3000)'
    if ([string]::IsNullOrWhiteSpace($url)) { $url = 'http://localhost:3000' }
    $tokenSecure = Read-Host 'API-ключ Twenty' -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($tokenSecure)
    try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }

    "TWENTY_URL=$url`r`nTWENTY_TOKEN=$token" |
        Set-Content -LiteralPath $EnvPath -Encoding UTF8

    try {
        $acl = Get-Acl $EnvPath
        $acl.SetAccessRuleProtection($true, $false)
        $acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            $env:USERNAME, 'FullControl', 'Allow')))
        Set-Acl -Path $EnvPath -AclObject $acl
    } catch { Write-Host 'Не удалось ограничить доступ к .env.outlook' -ForegroundColor Yellow }
    Write-Host 'Ключ сохранён в .env.outlook, доступ только вашей учётной записи.'
}

# ─────────────────────────────────────────────────────────── Twenty REST

function Invoke-Crm {
    param($Cfg, [string]$Method, [string]$Path, $Body)
    if ($DryRun) { Log "[прогон] $Method $Path"; return @{ data = @{ dryRun = @{ id = 'dry-run' } } } }
    $headers = @{ Authorization = 'Bearer ' + $Cfg['TWENTY_TOKEN'] }
    $json = if ($null -ne $Body) { $Body | ConvertTo-Json -Depth 10 -Compress } else { $null }
    return Invoke-RestMethod -Uri ($Cfg['TWENTY_URL'].TrimEnd('/') + $Path) -Method $Method `
        -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $json -TimeoutSec 30
}

function Get-Id($res) {
    if (-not $res) { return $null }
    $node = $res.data
    if (-not $node) { return $null }
    foreach ($p in $node.PSObject.Properties) {
        if ($p.Value -and $p.Value.id) { return $p.Value.id }
    }
    return $null
}

# ─────────────────────────────────────────────────────────── разбор письма

$FieldMap = @{
    'имя'         = 'name'
    'телефон'     = 'phone'
    'тип объекта' = 'type'
    'тип'         = 'type'
    'регион'      = 'region'
    'задача'      = 'message'
    'сообщение'   = 'message'
    'комментарий' = 'message'
    'страница'    = 'page'
    'источник'    = 'page'
}

function ConvertFrom-LeadBody([string]$text) {
    $lead = @{}
    foreach ($raw in ($text -split "`r?`n")) {
        $line = $raw.Trim()
        if ($line -notmatch ':') { continue }
        $label, $value = $line.Split(':', 2)
        $label = $label.Trim().ToLower()
        $value = $value.Trim()
        if (-not $value) { continue }
        $key = $FieldMap[$label]
        if ($key -and -not $lead.ContainsKey($key)) { $lead[$key] = $value }
    }
    return $lead
}

# ─────────────────────────────────────────────────────────── Outlook

function Get-DoneFolder($inbox) {
    foreach ($f in $inbox.Folders) { if ($f.Name -eq $DoneName) { return $f } }
    return $inbox.Folders.Add($DoneName)
}

function Invoke-Bridge {
    $cfg = Read-Settings

    if (-not $DryRun) {
        try {
            Invoke-WebRequest -Uri ($cfg['TWENTY_URL'].TrimEnd('/') + '/healthz') `
                -UseBasicParsing -TimeoutSec 10 | Out-Null
        } catch {
            Log "CRM не отвечает — выхожу, письма не трогаю"
            return
        }
    }

    try { $outlook = New-Object -ComObject Outlook.Application }
    catch { Log "Outlook не запускается через COM: $($_.Exception.Message)"; return }
    $ns = $outlook.GetNamespace('MAPI')

    $mark = [string]::Join('', [char[]](0x0437, 0x0430, 0x044F, 0x0432, 0x043A, 0x0430))  # «заявка»
    $test = [string]::Join('', [char[]](0x0442, 0x0435, 0x0441, 0x0442))                  # «тест»
    $since = (Get-Date).AddDays(-$Days)
    $made = 0
    $seen = 0

    foreach ($store in $ns.Stores) {
        $inbox = $null
        try { $inbox = $store.GetDefaultFolder(6) } catch { continue }   # 6 = «Входящие»
        if (-not $inbox) { continue }

        $items = $inbox.Items
        $items.Sort('[ReceivedTime]', $true)
        $done = $null

        # копия ссылок: коллекция меняется при перемещении письма
        $batch = @()
        foreach ($item in $items) {
            if ($item.ReceivedTime -lt $since) { break }
            if ($item.Class -ne 43) { continue }                          # 43 = почтовое письмо
            if ($item.Subject -and $item.Subject.ToLower().Contains($mark)) { $batch += $item }
        }

        foreach ($mail in $batch) {
            $seen++
            $lead = ConvertFrom-LeadBody $mail.Body
            if (-not $lead['name'] -and -not $lead['phone']) {
                Log "письмо «$($mail.Subject)» не похоже на заявку — пропускаю"
                continue
            }

            $flat = ($lead.Values -join ' ').ToLower()
            if ($flat.Contains($test)) {
                Log "тестовая заявка — в CRM не завожу, убираю в «$DoneName»"
                if (-not $DryRun) { if (-not $done) { $done = Get-DoneFolder $inbox }; $mail.Move($done) | Out-Null }
                continue
            }

            try {
                # контакт
                $personId = $null
                $first, $last = ($lead['name'] -split ' ', 2)
                $personBody = @{ name = @{ firstName = $first; lastName = ($last -as [string]) } }
                $digits = ($lead['phone'] -replace '[^\d]', '')
                if ($digits.Length -ge 10) {
                    $personBody['phones'] = @{
                        primaryPhoneNumber      = $digits.Substring($digits.Length - 10)
                        primaryPhoneCallingCode = '+7'
                        primaryPhoneCountryCode = 'RU'
                    }
                }
                try { $personId = Get-Id (Invoke-Crm $cfg 'POST' '/rest/people' $personBody) }
                catch { Log "контакт не создан ($($_.Exception.Message)) — сделку заведу без него" }

                # сделка
                $title = '{0} - {1} - {2}' -f `
                    ($lead['name']),
                    ($(if ($lead['region']) { $lead['region'] } else { 'регион не указан' })),
                    (Get-Date -Format 'dd.MM')
                $oppBody = @{
                    name      = $title
                    stage     = 'NEW'
                    closeDate = (Get-Date).AddDays(14).ToString('yyyy-MM-ddTHH:mm:ss.000Z')
                }
                if ($personId) { $oppBody['pointOfContactId'] = $personId }
                $oppId = Get-Id (Invoke-Crm $cfg 'POST' '/rest/opportunities' $oppBody)

                # заметка с текстом заявки
                $noteText = ($lead.GetEnumerator() | ForEach-Object { "$($_.Key): $($_.Value)" }) -join "`n"
                $noteId = Get-Id (Invoke-Crm $cfg 'POST' '/rest/notes' `
                    @{ title = 'Заявка с сайта'; bodyV2 = @{ markdown = $noteText } })
                if ($noteId -and $oppId -and -not $DryRun) {
                    Invoke-Crm $cfg 'POST' '/rest/noteTargets' @{ noteId = $noteId; opportunityId = $oppId } | Out-Null
                }
            } catch {
                Log "сделка не создана: $($_.Exception.Message) — письмо оставляю во «Входящих»"
                continue
            }

            $made++
            Log "создана сделка по заявке от «$($lead['name'])»"
            if (-not $DryRun) {
                if (-not $done) { $done = Get-DoneFolder $inbox }
                $mail.Move($done) | Out-Null
            }
        }
    }

    Log "просмотрено писем-заявок: $seen, новых сделок: $made"
}

# ─────────────────────────────────────────────────────────── установка

function Install-Task {
    Save-Settings
    $script = Join-Path $Dir 'bridge-outlook.ps1'
    if ($PSCommandPath -and ($PSCommandPath -ne $script)) {
        Copy-Item -LiteralPath $PSCommandPath -Destination $script -Force
    }
    if (-not (Test-Path $script)) {
        Write-Host 'Не нашёл bridge-outlook.ps1 для копирования в рабочую папку' -ForegroundColor Red
        exit 1
    }

    Write-Host 'Пробный прогон без записи в CRM:'
    & powershell -ExecutionPolicy Bypass -File $script -DryRun

    schtasks /Query /TN $TaskName 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { schtasks /Delete /TN $TaskName /F | Out-Null }

    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory $Dir
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 5)
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
        -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
        -Settings $settings -Description 'Заявки из Outlook в Twenty CRM' | Out-Null

    Write-Host ''
    Write-Host 'Готово. Мост работает в фоне, раз в 5 минут.'
    Write-Host "    Лог:        $LogPath"
    Write-Host "    Состояние:  schtasks /Query /TN `"$TaskName`""
    Write-Host "    Запустить:  schtasks /Run /TN `"$TaskName`""
    Write-Host "    Отключить:  schtasks /Delete /TN `"$TaskName`" /F"
}

# ─────────────────────────────────────────────────────────── точка входа

New-Item -ItemType Directory -Force -Path $Dir | Out-Null
if ($Install) { Install-Task } else { Invoke-Bridge }
