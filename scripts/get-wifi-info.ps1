param(
    [Parameter(Mandatory = $false)]
    [string]$AdapterName = ""
)

$ErrorActionPreference = "Stop"
$result = @{ success = $false; error = $null; adapter = $null }

function Find-AnyAdapter {
    param([string]$Name, [string]$Desc)
    $statusFilter = {$_.Status -eq 'Up' -or $_.Status -eq 'Disconnected' -or $_.Status -eq 'LowerLayerDown'}
    try {
        if ($Name) {
            $a = Get-NetAdapter -Name $Name -ErrorAction SilentlyContinue | Where-Object $statusFilter | Select-Object -First 1
            if ($a) { return $a }
        }
        if ($Desc) {
            $a = Get-NetAdapter -InterfaceDescription $Desc -ErrorAction SilentlyContinue | Where-Object $statusFilter | Select-Object -First 1
            if ($a) { return $a }
        }
    } catch {}
    return $null
}

try {
    $adapter = $null

    if ($AdapterName) { $adapter = Find-AnyAdapter -Name $AdapterName }

    foreach ($pattern in @("*Wi-Fi*", "*WiFi*", "*WLAN*")) {
        if (-not $adapter) { $adapter = Find-AnyAdapter -Name $pattern }
    }

    foreach ($pattern in @("*Wireless*", "*WiFi*", "*WLAN*")) {
        if (-not $adapter) { $adapter = Find-AnyAdapter -Desc $pattern }
    }

    if (-not $adapter) {
        $netshOut = netsh wlan show interfaces 2>$null
        if ($netshOut) {
            $nameLine = $netshOut | Select-String "^\s+Name\s+:\s+(.+)$" | Select-Object -First 1
            if ($nameLine) {
                $name = $nameLine.Matches[0].Groups[1].Value.Trim()
                $adapter = Get-NetAdapter -Name $name -ErrorAction SilentlyContinue
            }
        }
    }

    if (-not $adapter) {
        $adapter = Get-NetAdapter | Where-Object {
            $_.Status -eq 'Up' -and
            $_.InterfaceDescription -notmatch 'Virtual|Loopback|Bluetooth|Ethernet'
        } | Select-Object -First 1
    }

    if (-not $adapter) {
        $adapter = Get-NetAdapter | Where-Object {
            $_.Status -eq 'Disconnected' -and
            $_.InterfaceDescription -notmatch 'Virtual|Loopback|Bluetooth|Ethernet'
        } | Select-Object -First 1
    }

    if ($adapter) {
        try {
            $ssid = $null
            $ifaceOut = netsh wlan show interfaces 2>$null
            if ($ifaceOut) {
                $ssidMatch = $ifaceOut | Select-String "^\s+SSID\s+:\s+(.+)$"
                if ($ssidMatch) {
                    $ssid = $ssidMatch.Matches[0].Groups[1].Value.Trim()
                }
            }
        } catch {}

        try {
            $profilesOut = netsh wlan show profiles 2>$null
            $profiles = @()
            if ($profilesOut) {
                $profiles = $profilesOut | Select-String "\s+:\s+" | ForEach-Object {
                    $parts = $_ -split ":\s+"
                    if ($parts.Count -ge 2) { @{ name = $parts[1].Trim() } }
                }
            }
        } catch { $profiles = @() }

        $result.adapter = @{
            name = $adapter.Name
            interfaceDescription = $adapter.InterfaceDescription
            interfaceGuid = $adapter.InterfaceGuid
            macAddress = $adapter.MacAddress
            status = "$($adapter.Status)"
            linkSpeed = $adapter.LinkSpeed
            ssid = $ssid
            availableNetworks = $profiles
        }
        $result.success = $true
    } else {
        $allAdapters = Get-NetAdapter | Select-Object Name, Status, InterfaceDescription | ConvertTo-Json -Compress
        $result.error = "No wireless adapter found. Available: $allAdapters"
    }
} catch {
    $result.error = "Script error: $($_.Exception.Message)"
}

$result | ConvertTo-Json -Depth 5 -Compress
