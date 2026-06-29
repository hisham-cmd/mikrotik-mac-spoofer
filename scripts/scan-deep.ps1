param(
    [Parameter(Mandatory = $false)]
    [string]$Subnet = "",
    [Parameter(Mandatory = $false)]
    [int]$TimeoutMs = 50,
    [Parameter(Mandatory = $false)]
    [int]$SubnetStart = -1,
    [Parameter(Mandatory = $false)]
    [int]$SubnetEnd = -1
)

$ErrorActionPreference = "Stop"
$result = @{ success = $false; error = $null; gateway = $null; ourIp = $null; ourMac = $null; hosts = @(); hotspot = @{}; subnetInfo = @{} }

# Helper: fast ARP table read (raw capture + regex, NO Select-String pipeline)
function Read-ArpTable {
    $table = @{}
    $raw = arp -a 2>$null
    foreach ($line in $raw) {
        if ($line -match '(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s+([0-9A-F]{2}[-:][0-9A-F]{2}[-:][0-9A-F]{2}[-:][0-9A-F]{2}[-:][0-9A-F]{2}[-:][0-9A-F]{2})') {
            $ip = $matches[1]
            $mac = $matches[2].ToUpper() -replace '-', ':'
            if (-not $table.ContainsKey($ip)) { $table[$ip] = $mac }
        }
    }
    return $table
}

function Is-GatewayMac { param($mac) return $mac -eq '00:00:00:00:00:0E' }
function Is-MulticastMac { param($mac) return $mac -match '^01:00:5E' -or $mac -eq 'FF:FF:FF:FF:FF:FF' }

try {
    # Detect network info
    $route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue | Where-Object NextHop -ne "0.0.0.0" | Select-Object -First 1
    if (-not $route) { throw "No default gateway" }
    $gatewayIp = $route.NextHop; $result.gateway = $gatewayIp
    $ifIndex = $route.InterfaceIndex
    $ipObj = Get-NetIPAddress -InterfaceIndex $ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1
    if (-not $ipObj) { throw "No local IP" }
    $result.ourIp = $ipObj.IPAddress
    $adapter = Get-NetAdapter -InterfaceIndex $ifIndex -ErrorAction SilentlyContinue
    if ($adapter) { $result.ourMac = $adapter.MacAddress }
    $baseNet = ($ipObj.IPAddress -split '\.')[0..1] -join '.'
    $ourOctet = [int]($ipObj.IPAddress -split '\.')[2]
    $gwParts = $gatewayIp -split '\.'; $gwOctet = [int]$gwParts[2]

    # Determine which third octets to scan
    if ($Subnet) {
        $thirdOctets = @([int]($Subnet -split '\.')[2])
    } else {
        if ($SubnetStart -lt 0) { $SubnetStart = 0 }
        if ($SubnetEnd -lt 0) { $SubnetEnd = 5 }
        $thirdOctets = @()
        for ($i = $SubnetStart; $i -le $SubnetEnd; $i++) { $thirdOctets += $i }
    }

    # Phase 0: Read initial ARP (fast)
    $arpBefore = Read-ArpTable
    $gwMac = if ($arpBefore.ContainsKey($gatewayIp)) { $arpBefore[$gatewayIp] } else { "N/A" }

    $result.subnetInfo = @{
        scanRange = "$SubnetStart-$SubnetEnd"
        arpBeforeScan = $arpBefore.Count
    }

    # Build C# engine
    $csharp = @'
using System;
using System.Collections.Concurrent;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Threading.Tasks;
public class DeepScan {
    public static string[] TcpSweep(string[] subnets, int port, int timeoutMs) {
        int total = subnets.Length * 254;
        var results = new ConcurrentBag<string>();
        Parallel.For(0, total, new ParallelOptions { MaxDegreeOfParallelism = 500 }, idx => {
            try {
                int si = idx / 254; int last = (idx % 254) + 1;
                string ip = subnets[si] + "." + last;
                using (var c = new TcpClient()) {
                    c.LingerState = new LingerOption(false, 0);
                    c.NoDelay = true;
                    if (c.ConnectAsync(ip, port).Wait(timeoutMs) && c.Connected) results.Add(ip);
                }
            } catch {}
        });
        return results.ToArray();
    }
    public static string GetTtl(string ip, int timeoutMs) {
        try { using (var p = new Ping()) {
            var opts = new PingOptions(128, true);
            var r = p.Send(ip, timeoutMs, new byte[32], opts);
            if (r.Status == IPStatus.Success) return r.Options.Ttl.ToString();
        }} catch {} return "?";
    }
    public static bool CheckPort(string ip, int port, int timeoutMs) {
        try { using (var c = new TcpClient()) {
            c.LingerState = new LingerOption(false, 0);
            c.NoDelay = true;
            if (c.ConnectAsync(ip, port).Wait(timeoutMs) && c.Connected) return true;
        }} catch {} return false;
    }
    public static string HttpGet(string url, int timeoutMs) {
        try { var req = System.Net.HttpWebRequest.Create(url); req.Timeout = timeoutMs;
            using (var resp = req.GetResponse())
            using (var r = new System.IO.StreamReader(resp.GetResponseStream())) { return r.ReadToEnd(); }
        } catch { return ""; }
    }
}
'@
    Add-Type -TypeDefinition $csharp -ErrorAction Stop

    # Phase 1: TCP port 80 scan (populates ARP cache with proxy entries)
    $candidateSubnets = $thirdOctets | ForEach-Object { "$baseNet.$_" }
    $tcpFoundIps = [DeepScan]::TcpSweep($candidateSubnets, 80, $TimeoutMs)

    # Phase 2: Read ARP again (fast) - captures new entries from TCP scan + existing
    $arpAfter = Read-ArpTable

    # Merge ARP + TCP results
    $mergedArp = $arpBefore.Clone()
    foreach ($kv in $arpAfter.GetEnumerator()) {
        if (-not $mergedArp.ContainsKey($kv.Key)) { $mergedArp[$kv.Key] = $kv.Value }
    }

    # Classify IPs by MAC type
    $uniqueClients = @{}  # IPs with real (non-gateway, non-multicast) MACs
    $proxyIps = @{}       # IPs behind proxy-ARP (gateway MAC)
    $otherIps = @{}       # multicast, broadcast, etc.

    foreach ($kv in $mergedArp.GetEnumerator()) {
        $ip = $kv.Key; $mac = $kv.Value
        if ($ip -eq $result.ourIp) { continue }
        if ($mac -eq $gwMac) { $proxyIps[$ip] = $mac; continue }
        if (Is-MulticastMac $mac) { $otherIps[$ip] = $mac; continue }
        $uniqueClients[$ip] = $mac
    }

    # Also add TCP-found IPs not already in ARP
    foreach ($ip in $tcpFoundIps) {
        if (-not $mergedArp.ContainsKey($ip) -and $ip -ne $result.ourIp) {
            $uniqueClients[$ip] = "N/A"
        }
    }

    $result.subnetInfo.uniqueMacClients = $uniqueClients.Count
    $result.subnetInfo.proxyArpIps = $proxyIps.Count
    $result.subnetInfo.otherIps = $otherIps.Count
    $result.subnetInfo.totalArp = $mergedArp.Count
    $result.subnetInfo.note = "Found $($uniqueClients.Count) real clients behind proxy-ARP"

    # Hotspot detection
    $hotspotUrl = "http://$gatewayIp/login"
    $hotspotHtml = [DeepScan]::HttpGet($hotspotUrl, 3000)
    if ($hotspotHtml.Length -gt 10) {
        $result.hotspot.detected = $true
        $result.hotspot.url = $hotspotUrl
        if ($hotspotHtml -match '<title[^>]*>([^<]+)<') { $result.hotspot.title = $matches[1].Trim() }
        if ($hotspotHtml -match 'name="username"') { $result.hotspot.loginField = "username" }
        $result.hotspot.size = $hotspotHtml.Length
    } else { $result.hotspot.detected = $false }

    $portProbePorts = @(80, 443, 8080, 8291, 22, 21, 23, 53, 2000, 3000, 5000, 7547, 9090)
    $hostResults = @{}
    $uniqueMacSet = @{}

    # Process unique clients (real MACs) with full probing
    foreach ($kv in $uniqueClients.GetEnumerator()) {
        $ip = $kv.Key; $mac = $kv.Value
        $ttl = if ($mac -ne "N/A") { [DeepScan]::GetTtl($ip, 80) } else { "?" }

        $openPorts = @()
        foreach ($port in $portProbePorts) {
            if ([DeepScan]::CheckPort($ip, $port, 40)) { $openPorts += $port }
        }

        $deviceType = if ($ttl -eq '128') { 'Windows/ MikroTik' } elseif ($ttl -eq '64') { 'Linux/ macOS/ iOS/ Android' } elseif ($ttl -eq '255') { 'Cisco/ Unix' } elseif ($ttl -eq '?') { 'Unknown' } else { "TTL=$ttl" }

        $sp = $ip -split '\.'; $ipSubnet = "$($sp[0]).$($sp[1]).$($sp[2])"

        if ($mac -ne "N/A") {
            if (-not $uniqueMacSet.ContainsKey($mac)) { $uniqueMacSet[$mac] = @() }
            $uniqueMacSet[$mac] += $ip
        }

        $hostResults[$ip] = @{
            ip = $ip; mac = $mac; macUnique = ($mac -ne "N/A")
            ttl = $ttl; deviceType = $deviceType; vendor = "Unknown"
            isGateway = $false; openPorts = $openPorts -join ','; openPortCount = $openPorts.Count
            source = "arp-client"; subnet = $ipSubnet
        }
    }

    # Add gateway with full probing
    $gwTtl = [DeepScan]::GetTtl($gatewayIp, 80)
    $gwPorts = @()
    foreach ($port in $portProbePorts) {
        if ([DeepScan]::CheckPort($gatewayIp, $port, 40)) { $gwPorts += $port }
    }
    $hostResults[$gatewayIp] = @{
        ip = $gatewayIp; mac = $gwMac; macUnique = $false
        ttl = $gwTtl; deviceType = "MikroTik Router"; vendor = "MikroTik"
        isGateway = $true; openPorts = $gwPorts -join ','; openPortCount = $gwPorts.Count
        source = "gateway"; subnet = "$($gwParts[0]).$($gwParts[1]).$gwOctet"
    }

    # Add proxy-ARP summary (not individual IPs - too many)
    $result.subnetInfo.proxySummary = "Proxy-ARP: $($proxyIps.Count) IPs behind gateway MAC"

    $hostResults = $hostResults.Values | Sort-Object { [int]($_ -split '\.')[3] }
    $result.hosts = @($hostResults)
    $result.subnetInfo.uniqueMacs = $uniqueMacSet.Count

    $result.success = $true
} catch {
    $result.error = $_.Exception.Message
}

$result | ConvertTo-Json -Depth 10 -Compress
