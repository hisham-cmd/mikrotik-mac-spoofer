param(
    [Parameter(Mandatory = $false)]
    [string]$Subnet = "",
    [Parameter(Mandatory = $false)]
    [int]$TimeoutMs = 150,
    [Parameter(Mandatory = $false)]
    [switch]$SkipArp
)

$ErrorActionPreference = "Stop"
$result = @{ success = $false; error = $null; gateway = $null; ourIp = $null; ourMac = $null; hosts = @(); methods = @() }

try {
    if (-not $Subnet) {
        $route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue | Where-Object NextHop -ne "0.0.0.0" | Select-Object -First 1
        if (-not $route) { throw "No default gateway found" }
        $gatewayIp = $route.NextHop
        $result.gateway = $gatewayIp
        $ifIndex = $route.InterfaceIndex
        $ipObj = Get-NetIPAddress -InterfaceIndex $ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1
        if (-not $ipObj) { throw "No local IP" }
        $result.ourIp = $ipObj.IPAddress
        $adapter = Get-NetAdapter -InterfaceIndex $ifIndex -ErrorAction SilentlyContinue
        if ($adapter) { $result.ourMac = $adapter.MacAddress }
        $parts = $ipObj.IPAddress -split '\.'
        $Subnet = "$($parts[0]).$($parts[1]).$($parts[2])"
    }

    if (-not $SkipArp) {
        $arpHosts = @{}
        arp -a 2>$null | Select-String "\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}" | ForEach-Object {
            $line = ($_ -replace '\s+', ' ').Trim()
            $parts = $line -split ' '
            if ($parts.Count -ge 3 -and $parts[1] -match '^([0-9A-F]{2}[-:]){5}[0-9A-F]{2}$') {
                $ip = $parts[0].Trim()
                $mac = $parts[1].Trim().ToUpper() -replace '-', ':'
                $arpHosts[$ip] = $mac
            }
        }
        $result.methods += "arp"
    }

    $code = @'
using System;
using System.Collections.Concurrent;
using System.Net.NetworkInformation;
using System.Threading.Tasks;
public class FastPing {
    public static string[] Scan(string subnet, int timeoutMs) {
        var results = new ConcurrentBag<string>();
        Parallel.For(1, 255, new ParallelOptions { MaxDegreeOfParallelism = 30 }, i => {
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
'@
    Add-Type -TypeDefinition $code -ErrorAction Stop
    $liveIps = [FastPing]::Scan($Subnet, $TimeoutMs)
    $result.methods += "ping"

    $hostResults = @()
    $resolvedNames = @{}

    foreach ($ip in $liveIps) {
        if ($ip -eq $result.ourIp) { continue }

        $mac = if ($arpHosts.ContainsKey($ip)) { $arpHosts[$ip] } else { "N/A" }
        $hostname = ""
        $namesFrom = @()

        try {
            $nbt = nbtstat -A $ip 2>$null
            if ($nbt -match '^\s+(\S+)\s+<00>\s+UNIQUE') {
                $name = $matches[1].Trim()
                if ($name -and $name -ne "" -and $name -ne "<unknown>") {
                    $hostname = $name
                    $namesFrom += "netbios"
                }
            } elseif ($nbt -match '^\s+(\S+)\s+<03>\s+UNIQUE') {
                $name = $matches[1].Trim()
                if ($name -and $name -ne "" -and $name -ne "<unknown>") {
                    $hostname = $name
                    $namesFrom += "netbios"
                }
            }
        } catch {}

        if (-not $hostname) {
            try {
                $dnsResult = [System.Net.Dns]::GetHostEntry($ip)
                if ($dnsResult.HostName -and $dnsResult.HostName -ne $ip) {
                    $hostname = $dnsResult.HostName
                    $namesFrom += "dns-reverse"
                }
            } catch {}
        }

        if (-not $hostname) {
            try {
                $mdnsQuery = Resolve-DnsName -Name "$([System.Net.IPAddress]::Parse($ip).GetAddressBytes()[3]).$([System.Net.IPAddress]::Parse($ip).GetAddressBytes()[2]).$([System.Net.IPAddress]::Parse($ip).GetAddressBytes()[1]).$([System.Net.IPAddress]::Parse($ip).GetAddressBytes()[0]).in-addr.arpa" -Type PTR -ErrorAction SilentlyContinue
                if ($mdnsQuery -and $mdnsQuery.NameHost) {
                    $hostname = $mdnsQuery.NameHost
                    $namesFrom += "dns-ptr"
                }
            } catch {}
        }

        $isGateway = ($ip -eq $gatewayIp)

        $hostResults += @{
            ip = $ip
            mac = $mac
            hostname = $hostname
            hostnameSource = if ($namesFrom.Count -gt 0) { $namesFrom -join ',' } else { "" }
            isGateway = $isGateway
            isOurs = ($ip -eq $result.ourIp)
            alive = $true
        }
    }

    $hostResults = $hostResults | Sort-Object { [int]($_.ip -split '\.')[3] }
    $result.hosts = @($hostResults)
    $result.success = $true

    $result.methods += "dns-netbios"
    $result.methods = $result.methods | Select-Object -Unique

} catch {
    $result.error = $_.Exception.Message
}

$result | ConvertTo-Json -Depth 5 -Compress
