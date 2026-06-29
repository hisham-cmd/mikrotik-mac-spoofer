param(
    [Parameter(Mandatory = $false)]
    [string]$Subnet = "",
    [Parameter(Mandatory = $false)]
    [int]$TimeoutMs = 100
)

$ErrorActionPreference = "Stop"
$result = @{ success = $false; error = $null; gateway = $null; ourIp = $null; ourMac = $null; hosts = @() }

try {
    if (-not $Subnet) {
        $route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue | Where-Object NextHop -ne "0.0.0.0" | Select-Object -First 1
        if (-not $route) { throw "No default gateway found" }
        $gatewayIp = $route.NextHop
        $result.gateway = $gatewayIp

        $ifIndex = $route.InterfaceIndex
        $ipObj = Get-NetIPAddress -InterfaceIndex $ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1
        if (-not $ipObj) { throw "No local IP found" }
        $result.ourIp = $ipObj.IPAddress

        $adapter = Get-NetAdapter -InterfaceIndex $ifIndex -ErrorAction SilentlyContinue
        if ($adapter) { $result.ourMac = $adapter.MacAddress }

        $ipParts = $ipObj.IPAddress -split '\.'
        $Subnet = "$($ipParts[0]).$($ipParts[1]).$($ipParts[2])"
    }

    $code = @"
using System;
using System.Collections.Concurrent;
using System.Net.NetworkInformation;
using System.Threading.Tasks;
public class FastPing {
    public static string[] Scan(string subnet, int timeoutMs) {
        var results = new ConcurrentBag<string>();
        Parallel.For(1, 255, new ParallelOptions { MaxDegreeOfParallelism = 20 }, i => {
            string ip = subnet + "." + i;
            try {
                using (var p = new Ping()) {
                    var reply = p.Send(ip, timeoutMs);
                    if (reply.Status == IPStatus.Success) results.Add(ip);
                }
            } catch {}
        });
        return results.ToArray();
    }
}
"@
    Add-Type -TypeDefinition $code -ErrorAction Stop

    $liveIps = [FastPing]::Scan($Subnet, $TimeoutMs)

    Start-Sleep -Milliseconds 200

    $arpLines = arp -a 2>$null | Select-String "\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}"
    $arpTable = $arpLines | ForEach-Object {
        $line = ($_ -replace '\s+', ' ').Trim()
        $parts = $line -split ' '
        if ($parts.Count -ge 3) {
            $ip = $parts[0].Trim()
            $mac = $parts[1].Trim().ToUpper()
            $type = $parts[2].Trim()
            if ($mac -match '^([0-9A-F]{2}[-:]){5}[0-9A-F]{2}$') {
                $mac = $mac -replace '-', ':'
                $oui = ($mac -split ':')[0..2] -join ':'
                [PSCustomObject]@{ ip = $ip; mac = $mac; oui_prefix = $oui; type = $type }
            }
        }
    }

    $seen = @{}
    $result.hosts = @($arpTable | Where-Object {
        $key = "$($_.ip)|$($_.mac)"
        if (-not $seen.ContainsKey($key) -and $_.ip -ne $result.ourIp) {
            $seen[$key] = $true
            return $true
        }
        $false
    })

    if ($result.hosts.Count -eq 0 -and $liveIps.Count -gt 0) {
        $result.hosts = $liveIps | ForEach-Object {
            @{ ip = $_; mac = "N/A"; oui_prefix = "N/A"; type = "ping" }
        }
    }

    $result.success = $true
} catch {
    $result.error = $_.Exception.Message
}

$result | ConvertTo-Json -Depth 5 -Compress
