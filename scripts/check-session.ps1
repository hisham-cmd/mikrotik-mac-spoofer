param(
    [Parameter(Mandatory = $false)]
    [string]$AdapterName = "Wi-Fi",
    [Parameter(Mandatory = $false)]
    [string]$TestUrl = "http://www.h.net/index.html",
    [Parameter(Mandatory = $false)]
    [string]$TargetMac = ""
)

$ErrorActionPreference = "Stop"
$result = @{ success = $false; error = $null; ourIp = $null; ourMac = $null; gatewayIp = $null; hotspotReachable = $false; sessionActive = $false; targetConflict = $null }

try {
    $adapter = Get-NetAdapter -Name $AdapterName -ErrorAction SilentlyContinue
    if (-not $adapter) { throw "Adapter not found" }

    $result.ourMac = $adapter.MacAddress
    $result.ourIp = (Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1 -ExpandProperty IPAddress)

    $route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue | Where-Object NextHop -ne "0.0.0.0" | Select-Object -First 1
    if ($route) { $result.gatewayIp = $route.NextHop }

    $arpEntry = arp -a | Select-String "\d+\.\d+\.\d+\.\d+" | ForEach-Object {
        $parts = $_ -replace '\s+', ' ' -split ' '
        if ($parts.Count -ge 3) {
            $ip = $parts[0].Trim()
            $mac = $parts[1].Trim().ToUpper()
            $type = $parts[2].Trim()
            [PSCustomObject]@{ IP = $ip; MAC = $mac; Type = $type }
        }
    }

    if ($TargetMac) {
        $targetMacClean = $TargetMac.ToUpper() -replace '-', ':'
        $conflicts = $arpEntry | Where-Object { $_.MAC -eq $targetMacClean -and $_.Type -ne "static" }
        if ($conflicts) {
            $result.targetConflict = @($conflicts | ForEach-Object { @{ ip = $_.IP; mac = $_.MAC; type = $_.Type } })
        }
    }

    try {
        $webClient = New-Object System.Net.WebClient
        $webClient.Timeout = 5000
        $html = $webClient.DownloadString($TestUrl)
        $result.hotspotReachable = $true

        if ($html -match "تم تسجيل" -or $html -match "status\.html" -or $html -match "remain_bytes_total") {
            $result.sessionActive = $true
        }

        if ($html -match "remain_bytes_total" -or $html -match "session_time_left") {
            $bytesPattern = [regex]"id=\"remain_bytes_total\"[^>]*>([^<]*)<"
            $match = $bytesPattern.Match($html)
            if ($match.Success) { $result.remainBytes = $match.Groups[1].Value.Trim() }

            $timePattern = [regex]"id=\"session_time_left\"[^>]*>([^<]*)<"
            $match2 = $timePattern.Match($html)
            if ($match2.Success) { $result.sessionTimeLeft = $match2.Groups[1].Value.Trim() }

            $bytesOut = [regex]"id=\"bytes_out\"[^>]*>([^<]*)<"
            $match3 = $bytesOut.Match($html)
            if ($match3.Success) { $result.usedBytes = $match3.Groups[1].Value.Trim() }
        }
    } catch {
        $result.hotspotReachable = $false
    }

    $result.success = $true
} catch {
    $result.error = $_.Exception.Message
}

$result | ConvertTo-Json -Depth 5 -Compress
