param(
    [Parameter(Mandatory = $true)]
    [string]$NewMac,
    [Parameter(Mandatory = $false)]
    [string]$AdapterName = "",
    [Parameter(Mandatory = $false)]
    [string]$Ssid = "",
    [Parameter(Mandatory = $false)]
    [switch]$NoLaaFix = $false
)

$ErrorActionPreference = "Stop"
$result = @{ success = $false; error = $null; oldMac = $null; newMac = $null }

function Find-WirelessAdapter {
    param([string]$Name, [string]$Desc)
    $statusFilter = {$_.Status -eq 'Up' -or $_.Status -eq 'Disconnected' -or $_.Status -eq 'LowerLayerDown'}
    if ($Name) {
        $a = Get-NetAdapter -Name $Name -ErrorAction SilentlyContinue | Where-Object $statusFilter | Select-Object -First 1
        if ($a) { return $a }
    }
    if ($Desc) {
        $a = Get-NetAdapter -InterfaceDescription $Desc -ErrorAction SilentlyContinue | Where-Object $statusFilter | Select-Object -First 1
        if ($a) { return $a }
    }
    return $null
}

try {
    $adapter = $null
    if ($AdapterName) { $adapter = Find-WirelessAdapter -Name $AdapterName }
    if (-not $adapter) { $adapter = Find-WirelessAdapter -Name "*Wi-Fi*" }
    if (-not $adapter) { $adapter = Find-WirelessAdapter -Name "*WiFi*" }
    if (-not $adapter) { $adapter = Find-WirelessAdapter -Name "*WLAN*" }
    if (-not $adapter) { $adapter = Find-WirelessAdapter -Desc "*Wireless*" }
    if (-not $adapter) { $adapter = Find-WirelessAdapter -Desc "*WiFi*" }
    if (-not $adapter) { $adapter = Find-WirelessAdapter -Desc "*WLAN*" }
    if (-not $adapter) {
        $iface = netsh wlan show interfaces 2>$null | Select-String "Name" | Select-Object -First 1
        if ($iface) {
            $name = ($iface -replace '.*:\s*', '').Trim()
            $adapter = Get-NetAdapter -Name $name -ErrorAction SilentlyContinue
        }
    }
    if (-not $adapter) {
        $adapter = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Virtual|Loopback|Bluetooth|Ethernet' } |
                   Select-Object -First 1
    }
    if (-not $adapter) {
        $adapter = Get-NetAdapter | Where-Object { $_.Status -eq 'Disconnected' -and $_.InterfaceDescription -notmatch 'Virtual|Loopback|Bluetooth|Ethernet' } |
                   Select-Object -First 1
    }
    if (-not $adapter) {
        throw "No wireless adapter found"
    }
    $AdapterName = $adapter.Name
    $result.oldMac = $adapter.MacAddress

    if (-not $Ssid) {
        try {
            $iface = netsh wlan show interfaces 2>$null | Select-String "SSID\s+:\s+(.+)$"
            if ($iface) { $Ssid = $iface.Matches[0].Groups[1].Value }
        } catch {}
    }

    $cleanMac = $NewMac -replace '[-:]', ''
    if ($cleanMac -notmatch '^[0-9A-Fa-f]{12}$') {
        throw "Invalid MAC format: $NewMac"
    }

    $firstByte = [Convert]::ToByte($cleanMac.Substring(0, 2), 16)
    if (-not $NoLaaFix) {
        $laaBit = $firstByte -band 0x02
        if ($laaBit -eq 0) {
            $modifiedFirst = $firstByte -bor 0x02
            $cleanMac = $modifiedFirst.ToString('X2') + $cleanMac.Substring(2)
            $result.warning = "LAA bit was not set. Modified MAC: $($cleanMac -replace '..', '$&:' -replace '.$')"
        }
    }

    if ($adapter.MacAddress -replace '-', '' -eq $cleanMac) {
        $result.newMac = $adapter.MacAddress
        $result.success = $true
        $result | ConvertTo-Json -Compress
        exit 0
    }

    $changed = $false

    $targetKey = $null
    $adaptersKey = "HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e972-e325-11ce-bfc1-08002be10318}"
    foreach ($key in (Get-ChildItem -Path $adaptersKey -ErrorAction SilentlyContinue)) {
        try {
            $prop = Get-ItemProperty -Path $key.PSPath -Name "DriverDesc" -ErrorAction SilentlyContinue
            if ($prop.DriverDesc -and $prop.DriverDesc -eq $adapter.DriverDescription) {
                $netCfgInstance = Get-ItemProperty -Path $key.PSPath -Name "NetCfgInstanceId" -ErrorAction SilentlyContinue
                if ($netCfgInstance.NetCfgInstanceId -eq $adapter.InterfaceGuid) {
                    $targetKey = $key.PSPath
                    break
                }
            }
        } catch {}
    }

    if (-not $targetKey) {
        throw "Registry key not found"
    }

    Remove-ItemProperty -Path $targetKey -Name "NetworkAddress" -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $targetKey -Name "NetworkAddress" -Value $cleanMac

    Disable-NetAdapter -Name $AdapterName -Confirm:$false *>&1 | Out-Null
    Start-Sleep -Seconds 2
    Enable-NetAdapter -Name $AdapterName -Confirm:$false *>&1 | Out-Null

    $timeout = 15
    $elapsed = 0
    while ($elapsed -lt $timeout) {
        Start-Sleep -Seconds 2
        $elapsed += 2
        $check = Get-NetAdapter -Name $AdapterName -ErrorAction SilentlyContinue
        if ($check -and ($check.Status -eq 'Up' -or $check.Status -eq 'Disconnected')) {
            $result.newMac = $check.MacAddress
            $changed = $true
            break
        }
    }
    if (-not $changed) {
        $check = Get-NetAdapter | Where-Object { $_.InterfaceDescription -eq $adapter.InterfaceDescription } |
                 Select-Object -First 1
        if ($check) {
            $result.newMac = $check.MacAddress
            $changed = $true
        }
    }

    if (-not $changed) {
        try {
            Set-NetAdapter -Name $AdapterName -MacAddress $cleanMac -NoRestart -Confirm:$false -ErrorAction Stop *>&1 | Out-Null
            Restart-NetAdapter -Name $AdapterName -Confirm:$false -ErrorAction Stop *>&1 | Out-Null
            Start-Sleep -Seconds 6
            $check = Get-NetAdapter -Name $AdapterName -ErrorAction SilentlyContinue
            if ($check -and $check.Status -eq 'Up' -and ($check.MacAddress -replace '-', '') -eq $cleanMac) {
                $result.newMac = $check.MacAddress
                $changed = $true
            }
        } catch {}
    }

    if (-not $changed) {
        throw "MAC address did not change"
    }

    $reconnectTimeout = 15
    while ($reconnectTimeout -gt 0) {
        Start-Sleep -Seconds 2
        $reconnectTimeout -= 2
        try {
            $testIface = netsh wlan show interfaces 2>$null
            if ($testIface -match "SSID\s+:\s+.+") { break }
        } catch {}
    }

    $check = Get-NetAdapter -Name $AdapterName -ErrorAction SilentlyContinue
    if (-not $check) {
        $check = Get-NetAdapter | Where-Object { $_.InterfaceDescription -eq $adapter.InterfaceDescription } |
                 Select-Object -First 1
    }
    if (-not $check) {
        throw "Adapter not found after reconnect"
    }

    $result.newMac = $check.MacAddress
    if ($result.oldMac -and $result.newMac -and $result.newMac -ne $result.oldMac) {
        $result.success = $true
    } elseif ($result.newMac -eq $result.oldMac) {
        throw "MAC address did not change"
    } else {
        $result.success = $true
    }
} catch {
    $result.error = $_.Exception.Message
}

$result | ConvertTo-Json -Compress
