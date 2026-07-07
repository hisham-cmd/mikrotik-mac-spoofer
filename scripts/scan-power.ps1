param(
    [string]$Gateway = "",
    [string]$Subnet = "",
    [int]$TimeoutMs = 500,
    [string]$OurIp = "",
    [string]$OurMac = ""
)

$ErrorActionPreference = "Stop"
$result = @{
    success = $false; error = $null
    gateway = $Gateway; ourIp = $OurIp; ourMac = $OurMac
    gatewayPorts = @(); snmpDevices = @(); restDevices = @()
    webDevices = @(); mdnsNames = @{}; netbiosNames = @{}
    pingIps = @(); dnsNames = @{}; banners = @()
    hosts = @(); hotspot = @{ detected = $false }
}

try {
    # ----- DETECT GATEWAY / SUBNET -----
    if (-not $Gateway -or -not $OurIp) {
        $route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue | Where-Object NextHop -ne "0.0.0.0" | Select-Object -First 1
        if ($route) {
            $Gateway = $route.NextHop; $result.gateway = $Gateway
            $ifIndex = $route.InterfaceIndex
            $ipObj = Get-NetIPAddress -InterfaceIndex $ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -match '^\d+\.\d+\.\d+\.\d+$' } | Select-Object -First 1
            if ($ipObj) { $OurIp = $ipObj.IPAddress; $result.ourIp = $OurIp }
            $adapter = Get-NetAdapter -InterfaceIndex $ifIndex -ErrorAction SilentlyContinue
            if ($adapter -and -not $OurMac) { $OurMac = $adapter.MacAddress; $result.ourMac = $OurMac }
        }
    }
    if (-not $Gateway) { throw "No gateway found" }
    $prefix = ($Gateway -split '\.')[0..2] -join '.'
    if (-not $Subnet) { $Subnet = $prefix }
    $result.gateway = $Gateway
    $gwClean = $Gateway.Trim()

    # ----- BUILD C# HELPERS -----
    $csharp = @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

public class Scanner {
    public static string[] TcpBatch(string[] ips, int port, int timeoutMs) {
        var results = new ConcurrentBag<string>();
        Parallel.For(0, ips.Length, new ParallelOptions { MaxDegreeOfParallelism = 200 }, i => {
            try {
                using (var c = new TcpClient()) {
                    c.LingerState = new LingerOption(false, 0); c.NoDelay = true;
                    if (c.ConnectAsync(ips[i], port).Wait(timeoutMs) && c.Connected) results.Add(ips[i]);
                }
            } catch { }
        });
        return results.ToArray();
    }

    public static string[] TcpSweepPorts(string ip, int[] ports, int timeoutMs) {
        var results = new ConcurrentBag<int>();
        Parallel.For(0, ports.Length, new ParallelOptions { MaxDegreeOfParallelism = 50 }, i => {
            try {
                using (var c = new TcpClient()) {
                    c.LingerState = new LingerOption(false, 0); c.NoDelay = true;
                    if (c.ConnectAsync(ip, ports[i]).Wait(timeoutMs) && c.Connected) results.Add(ports[i]);
                }
            } catch { }
        });
        var arr = results.ToArray(); Array.Sort(arr);
        return arr.Select(p => p.ToString()).ToArray();
    }

    public static string GetTtl(string ip, int timeoutMs) {
        try { using (var p = new Ping()) {
            var opts = new PingOptions(128, true);
            var r = p.Send(ip, timeoutMs, new byte[32], opts);
            if (r.Status == IPStatus.Success) return r.Options.Ttl.ToString();
        }} catch {} return "?";
    }

    public static string GrabBanner(string ip, int port, int timeoutMs) {
        try {
            using (var c = new TcpClient()) {
                c.LingerState = new LingerOption(false, 0); c.NoDelay = true;
                if (!c.ConnectAsync(ip, port).Wait(timeoutMs) || !c.Connected) return "";
                using (var ns = c.GetStream()) {
                    ns.ReadTimeout = timeoutMs;
                    byte[] buf = new byte[4096];
                    int read = 0;
                    try { read = ns.Read(buf, 0, buf.Length); } catch { }
                    if (read > 0) {
                        string text = Encoding.ASCII.GetString(buf, 0, read);
                        return Regex.Replace(text, @"[^\u0020-\u007E\r\n]", " ").Trim();
                    }
                }
            }
        } catch { }
        return "";
    }
}

public class SnmpClient {
    private static byte[] EncodeLength(int len) {
        if (len < 0x80) return new byte[] { (byte)len };
        var bytes = new List<byte>();
        int tmp = len;
        while (tmp > 0) { bytes.Insert(0, (byte)(tmp & 0xFF)); tmp >>= 8; }
        bytes.Insert(0, (byte)(0x80 | bytes.Count));
        return bytes.ToArray();
    }

    private static byte[] EncodeInteger(int val) {
        var bytes = new List<byte>();
        int v = val;
        bool neg = v < 0;
        if (neg) v = -v - 1;
        while (v > 0) { bytes.Insert(0, (byte)(v & 0xFF)); v >>= 8; }
        if (bytes.Count == 0 || (bytes[0] & 0x80) != 0) bytes.Insert(0, 0);
        if (neg) for (int i=0;i<bytes.Count;i++) bytes[i] = (byte)~bytes[i];
        return bytes.ToArray();
    }

    private static byte[] EncodeOid(int[] oid) {
        var bytes = new List<byte>();
        bytes.Add((byte)(oid[0] * 40 + oid[1]));
        for (int i = 2; i < oid.Length; i++) {
            int v = oid[i];
            if (v < 0x80) { bytes.Add((byte)v); continue; }
            var parts = new List<byte>();
            parts.Add((byte)(v & 0x7F)); v >>= 7;
            while (v > 0) { parts.Insert(0, (byte)((v & 0x7F) | 0x80)); v >>= 7; }
            bytes.AddRange(parts);
        }
        return bytes.ToArray();
    }

    private static byte[] EncodeOctetString(string s) {
        var b = Encoding.ASCII.GetBytes(s);
        var result = new List<byte>(); result.Add(0x04); result.AddRange(EncodeLength(b.Length)); result.AddRange(b);
        return result.ToArray();
    }

    private static byte[] MakeTlv(byte tag, byte[] content) {
        var result = new List<byte>(); result.Add(tag); result.AddRange(EncodeLength(content.Length)); result.AddRange(content);
        return result.ToArray();
    }

    private static byte[] EncodeVarbind(int[] oid) {
        var oidBytes = EncodeOid(oid);
        var oidTlv = MakeTlv(0x06, oidBytes);
        var nullTlv = new byte[] { 0x05, 0x00 };
        var vbContent = new List<byte>(); vbContent.AddRange(oidTlv); vbContent.AddRange(nullTlv);
        return MakeTlv(0x30, vbContent.ToArray());
    }

    private static byte[] BuildGetNextRequest(int[] oid, string community, int reqId) {
        var vbContent = EncodeVarbind(oid);
        var vbl = MakeTlv(0x30, vbContent);
        var pduContent = new List<byte>();
        pduContent.AddRange(MakeTlv(0x02, EncodeInteger(reqId)));
        pduContent.AddRange(MakeTlv(0x02, EncodeInteger(0)));
        pduContent.AddRange(MakeTlv(0x02, EncodeInteger(0)));
        pduContent.AddRange(vbl);
        var pdu = MakeTlv(0xA1, pduContent.ToArray()); // GetNextRequest
        var seqContent = new List<byte>();
        seqContent.AddRange(MakeTlv(0x02, EncodeInteger(1)));
        seqContent.AddRange(EncodeOctetString(community));
        seqContent.AddRange(pdu);
        return MakeTlv(0x30, seqContent.ToArray());
    }

    private static int ParseBerLength(byte[] data, ref int pos) {
        if (data[pos] < 0x80) return data[pos++];
        int count = data[pos++] & 0x7F; int len = 0;
        for (int i=0;i<count;i++) { len = (len << 8) | data[pos++]; }
        return len;
    }

    // Returns the OID from a varbind, and optionally the value
    public static string WalkNext(string ip, int port, string community, string oidStr, int timeoutMs, out string valueStr) {
        valueStr = "";
        var oidParts = oidStr.TrimStart('.').Split('.').Select(int.Parse).ToArray();
        var req = BuildGetNextRequest(oidParts, community, new Random().Next(1, 100000));
        try {
            using (var udp = new UdpClient()) {
                udp.Client.ReceiveTimeout = timeoutMs; udp.Connect(ip, port);
                udp.Send(req, req.Length);
                var ep = new IPEndPoint(IPAddress.Any, 0);
                byte[] resp = udp.Receive(ref ep);

                // Parse response: skip outer SEQUENCE, version, community
                int pos = 0;
                if (resp[pos++] != 0x30) return null; // SEQUENCE
                int seqLen = ParseBerLength(resp, ref pos);
                int endPos = pos + seqLen;

                if (resp[pos++] != 0x02) return null; // version INT
                int vLen = ParseBerLength(resp, ref pos); pos += vLen;

                if (resp[pos++] != 0x04) return null; // community STR
                int cLen = ParseBerLength(resp, ref pos); pos += cLen;

                // PDU (0xA2 = Response, 0xA1 = GetNext)
                if (resp[pos++] != 0xA2) return null;
                int pduLen = ParseBerLength(resp, ref pos);
                int pduEnd = pos + pduLen;

                // request-id
                if (resp[pos++] != 0x02) return null;
                int riLen = ParseBerLength(resp, ref pos); pos += riLen;

                // error-status
                if (resp[pos++] != 0x02) return null;
                int esLen = ParseBerLength(resp, ref pos); pos += esLen;

                // error-index
                if (resp[pos++] != 0x02) return null;
                int eiLen = ParseBerLength(resp, ref pos); pos += eiLen;

                // varbind list SEQUENCE
                if (resp[pos++] != 0x30) return null;
                int vblLen = ParseBerLength(resp, ref pos);
                int vblEnd = pos + vblLen;

                // varbind SEQUENCE
                if (resp[pos++] != 0x30) return null;
                int vbLen = ParseBerLength(resp, ref pos);
                int vbEnd = pos + vbLen;

                // OID
                if (resp[pos++] != 0x06) return null;
                int oLen = ParseBerLength(resp, ref pos);
                int oidStart = pos;
                // Parse OID bytes back to string
                var decodedOid = new List<int>();
                if (oLen > 0) {
                    decodedOid.Add(resp[pos] / 40); decodedOid.Add(resp[pos] % 40); pos++;
                    for (int i = 1; i < oLen; i++) {
                        int val = 0;
                        while (i < oLen) {
                            int b = resp[pos++]; i++;
                            val = (val << 7) | (b & 0x7F);
                            if ((b & 0x80) == 0) break;
                        }
                        decodedOid.Add(val);
                    }
                }
                pos = oidStart + oLen;

                // Value - could be various types
                byte valTag = resp[pos++];
                int valLen = ParseBerLength(resp, ref pos);
                if (valTag == 0x40 && valLen == 4) { // IPAddress
                    valueStr = string.Format("{0}.{1}.{2}.{3}", resp[pos], resp[pos+1], resp[pos+2], resp[pos+3]);
                } else if (valTag == 0x06) { // OID
                    var vOid = new List<string>();
                    if (valLen > 0) {
                        int p = pos;
                        vOid.Add((resp[p] / 40).ToString()); vOid.Add((resp[p] % 40).ToString()); p++;
                        for (int i = 1; i < valLen; i++) {
                            int v = 0;
                            while (i < valLen) {
                                int b = resp[p++]; i++;
                                v = (v << 7) | (b & 0x7F);
                                if ((b & 0x80) == 0) break;
                            }
                            vOid.Add(v.ToString());
                        }
                    }
                    valueStr = string.Join(".", vOid);
                } else if (valTag == 0x02) { // INTEGER
                    int val = 0;
                    for (int i = 0; i < valLen; i++) val = (val << 8) | resp[pos + i];
                    valueStr = val.ToString();
                } else if (valTag == 0x04) { // OCTETSTRING
                    valueStr = Encoding.ASCII.GetString(resp, pos, valLen);
                } else if (valTag == 0x05) { // NULL
                    valueStr = "";
                } else {
                    valueStr = BitConverter.ToString(resp, pos, valLen).Replace("-", " ");
                }

                pos = Math.Min(pos + valLen, vbEnd);
                return string.Join(".", decodedOid);
            }
        } catch { return null; }
    }

    public static Dictionary<string, string> WalkSubtree(string ip, int port, string community, string rootOid, int timeoutMs, int maxEntries = 200) {
        var dict = new Dictionary<string, string>();
        string current = rootOid;
        for (int i = 0; i < maxEntries; i++) {
            string val;
            string next = WalkNext(ip, port, community, current, timeoutMs, out val);
            if (next == null) break;
            if (!next.StartsWith(rootOid)) break;
            if (dict.ContainsKey(next)) break;
            dict[next] = val ?? "";
            current = next;
        }
        return dict;
    }
}
'@
    Add-Type -TypeDefinition $csharp -ErrorAction Stop

    # ====== 1. GATEWAY FULL PORT SCAN ======
    $allGatewayPorts = @(21,22,23,53,69,80,123,135,139,161,162,389,443,445,514,636,993,995,1433,1701,1723,1900,3306,3389,5353,5355,5432,5900,6379,8080,8291,8443,8728,8729,9090,10000,20000)
    $openGwPorts = [Scanner]::TcpSweepPorts($gateway, $allGatewayPorts, 400)
    $result.gatewayPorts = $openGwPorts

    # ====== 2. BANNER GRAB on gateway ======
    $bannerPorts = @(21,22,23,80,443,554,8080,8443,8291,8728,8729,9090)
    $bannerResults = @{}
    foreach ($p in $bannerPorts) {
        if ($openGwPorts -contains "$p") {
            $b = [Scanner]::GrabBanner($gateway, $p, 1500)
            if ($b -and $b.Length -gt 3) { $bannerResults["$p"] = $b.Substring(0,[Math]::Min(200,$b.Length)) }
        }
    }
    $result.banners = $bannerResults

    # ====== 3. SNMP QUERY ======
    $snmpFmt = @{}
    $snmpDev = @()
    try {
        $snmpTimeout = [Math]::Min(800, $TimeoutMs)
        $snmpCommunities = @("public", "read", "readonly", "private", "default", "mikrotik", "snmp", "")

        foreach ($community in $snmpCommunities) {
            try {
                # Try ARP table: 1.3.6.1.2.1.4.22.1.2 (ipNetToMediaPhysAddress)
                $arpWalk = [SnmpClient]::WalkSubtree($gateway, 161, $community, ".1.3.6.1.2.1.4.22.1.2", $snmpTimeout, 300)
                if ($arpWalk.Count -gt 0) {
                    $snmpFmt.community = $community
                    # Also get the IP table for each entry: 1.3.6.1.2.1.4.22.1.3
                    $ipWalk = [SnmpClient]::WalkSubtree($gateway, 161, $community, ".1.3.6.1.2.1.4.22.1.3", $snmpTimeout, 300)
                    # Also try bridge MAC table: 1.3.6.1.2.1.17.4.3.1.2
                    $bridgeWalk = [SnmpClient]::WalkSubtree($gateway, 161, $community, ".1.3.6.1.2.1.17.4.3.1.2", $snmpTimeout, 300)

                    # Parse ARP entries
                    $arpMap = @{}
                    foreach ($kv in $arpWalk.GetEnumerator()) {
                        $parts = $kv.Key -split '\.'
                        $idx = $parts[-1]
                        $mac = $kv.Value

                        # Normalize MAC
                        $mac = $mac.ToUpper()
                        if ($mac.Length -eq 12 -and $mac -notmatch '-') {
                            $mac = ($mac -replace '(.{2})(.{2})(.{2})(.{2})(.{2})(.{2})', '$1:$2:$3:$4:$5:$6')
                        }

                        # Get corresponding IP from ipNetToMediaNetAddress
                        $ipKey = $kv.Key -replace '\.2$', '.3'
                        $ip = if ($ipWalk.ContainsKey($ipKey)) { $ipWalk[$ipKey] } else { "" }

                        if ($ip -and $ip -ne "" -and $ip -ne $OurIp -and $ip -ne $Gateway -and $mac -match '^([0-9A-F]{2}:){5}[0-9A-F]{2}$') {
                            if (-not $arpMap.ContainsKey($ip)) {
                                $arpMap[$ip] = $mac
                                $snmpDev += @{ ip = $ip; mac = $mac; source = "snmp-arp" }
                            }
                        }
                    }

                    # Parse bridge table (MAC addresses, no IP - need to infer)
                    foreach ($kv in $bridgeWalk.GetEnumerator()) {
                        $mac = $kv.Value.ToUpper()
                        if ($mac.Length -eq 12 -and $mac -notmatch '-') {
                            $mac = ($mac -replace '(.{2})(.{2})(.{2})(.{2})(.{2})(.{2})', '$1:$2:$3:$4:$5:$6')
                        }
                        if ($mac -match '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' -and $mac -ne ($OurMac -replace '-',':' -replace ' ','').ToUpper() -and $mac -ne ($result.gatewayMac -replace '-',':' -replace ' ','').ToUpper()) {
                            $snmpDev += @{ ip = ""; mac = $mac; source = "snmp-bridge" }
                        }
                    }

                    if ($arpMap.Count -gt 0) { break }
                }

                # Try MikroTik specific OIDs if ARP didn't work
                if ($arpWalk.Count -eq 0) {
                    # MikroTik wireless registration table: 1.3.6.1.4.1.14988.1.1.1.2.1.1
                    $mtikWalk = [SnmpClient]::WalkSubtree($gateway, 161, $community, ".1.3.6.1.4.1.14988.1.1.1.2.1.1", $snmpTimeout, 100)
                    if ($mtikWalk.Count -gt 0) {
                        $snmpFmt.community = $community
                        foreach ($kv in $mtikWalk.GetEnumerator()) {
                            $mac = $kv.Value.ToUpper()
                            if ($mac.Length -eq 12 -and $mac -notmatch '-') {
                                $mac = ($mac -replace '(.{2})(.{2})(.{2})(.{2})(.{2})(.{2})', '$1:$2:$3:$4:$5:$6')
                            }
                            if ($mac -match '^([0-9A-F]{2}:){5}[0-9A-F]{2}$') {
                                $snmpDev += @{ ip = ""; mac = $mac; source = "snmp-wireless" }
                            }
                        }
                        break
                    }
                }
            } catch { continue }
        }
    } catch { $result.error += " SNMP:$($_.Exception.Message)" }

    # Deduplicate SNMP devices
    $seenSnmpMacs = @{}
    $result.snmpDevices = @()
    foreach ($d in $snmpDev) {
        if ($d.mac -and $d.mac -ne "N/A" -and -not $seenSnmpMacs.ContainsKey($d.mac)) {
            $seenSnmpMacs[$d.mac] = $true
            $result.snmpDevices += $d
        }
    }

    # ====== 4. REST API ======
    $restDev = @()
    $restEndpoints = @(
        "/rest/ip/dhcp-server/lease",
        "/rest/ip/dhcp-server/lease/print",
        "/rest/arp",
        "/rest/ip/arp",
        "/rest/interface/wireless/registration-table",
        "/rest/interface/wireless/registration-table/print",
        "/rest/ip/hotspot/user",
        "/rest/ip/hotspot/active",
        "/rest/ip/neighbor",
        "/rest/interface/bridge/host"
    )

    foreach ($proto in @("https", "http")) {
        $url = "$proto`://$gateway"
        $userAgents = @("MikroTik/7.x REST API Client", "Mozilla/5.0", "curl/8.0")
        foreach ($ua in $userAgents) {
            foreach ($ep in $restEndpoints) {
                try {
                    $fullUrl = "$url$ep"
                    $restResult = Invoke-RestMethod -Uri $fullUrl -Method Get -UserAgent $ua -TimeoutSec 3 -SkipCertificateCheck -ErrorAction SilentlyContinue
                    if ($restResult) {
                        $jsonStr = $restResult | ConvertTo-Json -Depth 5 -Compress
                        if ($jsonStr.Length -gt 5) {
                            # Try to extract IP + MAC pairs from result
                            if ($restResult -is [System.Array]) {
                                foreach ($item in $restResult) {
                                    $rip = @($item.address, $item.ip, $item."active-address") | Where-Object { $_ } | Select-Object -First 1
                                    $rmac = @($item."mac-address", $item.mac) | Where-Object { $_ } | Select-Object -First 1
                                    $rhost = @($item."host-name", $item.comment, $item.user) | Where-Object { $_ } | Select-Object -First 1
                                    if ($rip -and $rmac) {
                                        $restDev += @{ ip = "$rip"; mac = "$rmac".ToUpper(); hostname = "$rhost"; source = "rest-$ep" }
                                    } elseif ($rmac) {
                                        $restDev += @{ ip = ""; mac = "$rmac".ToUpper(); hostname = "$rhost"; source = "rest-$ep" }
                                    }
                                }
                            } elseif ($restResult -is [PSCustomObject]) {
                                $props = $restResult.PSObject.Properties
                                $rip = @($restResult.address, $restResult.ip, $restResult."active-address") | Where-Object { $_ } | Select-Object -First 1
                                $rmac = @($restResult."mac-address", $restResult.mac) | Where-Object { $_ } | Select-Object -First 1
                                $rhost = @($restResult."host-name", $restResult.comment, $restResult.user) | Where-Object { $_ } | Select-Object -First 1
                                if ($rip -and $rmac) {
                                    $restDev += @{ ip = "$rip"; mac = "$rmac".ToUpper(); hostname = "$rhost"; source = "rest-$ep" }
                                }
                            }
                        }
                        if ($restDev.Count -gt 0) { break }
                    }
                } catch {}
            }
            if ($restDev.Count -gt 0) { break }
        }
        if ($restDev.Count -gt 0) { break }
    }

    $seenRest = @{}
    $result.restDevices = @()
    foreach ($d in $restDev) {
        $key = if ($d.mac) { $d.mac } else { $d.ip }
        if ($key -and -not $seenRest.ContainsKey($key)) {
            $seenRest[$key] = $true
            $result.restDevices += $d
        }
    }

    # ====== 5. WEB SCRAPING ======
    $webDev = @()
    $webPaths = @(
        "/", "/status", "/hotspot/status", "/hotspotlog", "/log", "/hotspot/users",
        "/cgibin", "/cgi-bin/status", "/graph", "/snmpinfo",
        "/webfig", "/webfig/#ARP", "/webfig/#DHCP"
    )
    foreach ($spath in $webPaths) {
        try {
            $url = "http://$gateway$spath"
            $wc = New-Object System.Net.WebClient; $wc.Timeout = 3000
            $html = $wc.DownloadString($url)
            if ($html -and $html.Length -gt 30) {
                # Extract IP:MAC pairs
                $ipMacRx = [Regex]::new('(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s*[-:]\s*([0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2}[-:][0-9A-Fa-f]{2})')
                $m = $ipMacRx.Matches($html)
                foreach ($match in $m) {
                    $wip = $match.Groups[1].Value
                    $wmac = $match.Groups[2].Value.ToUpper() -replace '-', ':'
                    if ($wmac -match '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' -and $wip -ne $Gateway -and $wip -ne $OurIp) {
                        $webDev += @{ ip = $wip; mac = $wmac; source = "web-$spath" }
                    }
                }
                # Also try to extract MAC-only patterns (like bridge tables)
                $macOnlyRx = [Regex]::new('([0-9A-Fa-f]{2}[:-][0-9A-Fa-f]{2}[:-][0-9A-Fa-f]{2}[:-][0-9A-Fa-f]{2}[:-][0-9A-Fa-f]{2}[:-][0-9A-Fa-f]{2})')
                $macMatches = $macOnlyRx.Matches($html)
                foreach ($mm in $macMatches) {
                    $wmac = $mm.Groups[1].Value.ToUpper() -replace '-', ':'
                    if ($wmac -match '^([0-9A-F]{2}:){5}[0-9A-F]{2}$' -and $wmac -ne ($OurMac -replace '-',':' -replace ' ','').ToUpper()) {
                        $exists = $false
                        foreach ($d in $webDev) { if ($d.mac -eq $wmac) { $exists = $true; break } }
                        if (-not $exists) { $webDev += @{ ip = ""; mac = $wmac; source = "web-mac" } }
                    }
                }
            }
        } catch {}
    }

    $seenWeb = @{}
    $result.webDevices = @()
    foreach ($d in $webDev) {
        $key = $d.mac
        if ($key -and -not $seenWeb.ContainsKey($key)) { $seenWeb[$key] = $true; $result.webDevices += $d }
    }

    # ====== 6. mDNS / LLMNR DISCOVERY ======
    $mdnsNames = @{}
    try {
        if ($Subnet) {
            $ipList = 1..254 | ForEach-Object { "$Subnet.$_" }
            $batchSize = 20
            for ($b = 0; $b -lt $ipList.Count; $b += $batchSize) {
                $batch = $ipList[$b..([Math]::Min($b + $batchSize - 1, $ipList.Count - 1))]
                $tasks = $batch | ForEach-Object {
                    $ip = $_
                    Start-Job -ScriptBlock {
                        param($i)
                        # mDNS reverse lookup
                        try {
                            $parts = $i -split '\.'
                            $arpa = "$($parts[3]).$($parts[2]).$($parts[1]).$($parts[0]).in-addr.arpa"
                            $r = Resolve-DnsName -Name $arpa -Type PTR -Server 224.0.0.251 -DnsOnly -ErrorAction SilentlyContinue
                            if ($r -and $r.NameHost) { return @{ ip = $i; name = $r.NameHost; type = "mdns" } }
                        } catch {}
                        # LLMNR reverse lookup
                        try {
                            $parts = $i -split '\.'
                            $arpa = "$($parts[3]).$($parts[2]).$($parts[1]).$($parts[0]).in-addr.arpa"
                            $r = Resolve-DnsName -Name $arpa -Type PTR -Server 224.0.0.252 -DnsOnly -ErrorAction SilentlyContinue
                            if ($r -and $r.NameHost) { return @{ ip = $i; name = $r.NameHost; type = "llmnr" } }
                        } catch {}
                        # NetBIOS via nbtstat
                        try {
                            $nbt = nbtstat -A $i 2>$null
                            if ($nbt -match '^\s+(\S+)\s+<00>\s+UNIQUE') {
                                $name = $matches[1].Trim()
                                if ($name -and $name -ne "" -and $name -ne "<unknown>") {
                                    return @{ ip = $i; name = $name; type = "netbios" }
                                }
                            }
                        } catch {}
                        return $null
                    } -ArgumentList $ip
                }
                $tasks | ForEach-Object {
                    $jb = $_; $res = $jb | Receive-Job -Wait -Timeout 3 2>$null
                    if ($res) {
                        $hasExisting = $mdnsNames.ContainsKey($res.ip)
                        if (-not $hasExisting) { $mdnsNames[$res.ip] = $res.name }
                    }
                    $jb | Remove-Job -Force -ErrorAction SilentlyContinue
                }
            }
        }
    } catch {}
    $result.mdnsNames = $mdnsNames

    # ====== 7. NETBIOS BROADCAST SCAN ======
    $netbiosNames = @{}
    try {
        if ($Subnet) {
            $ipList = 1..254 | ForEach-Object { "$Subnet.$_" }
            $batchSize = 20
            for ($b = 0; $b -lt $ipList.Count; $b += $batchSize) {
                $batch = $ipList[$b..([Math]::Min($b + $batchSize - 1, $ipList.Count - 1))]
                foreach ($ip in $batch) {
                    try {
                        $nbt = nbtstat -A $ip 2>$null
                        if ($nbt -match '^\s+(\S+)\s+<00>\s+UNIQUE') {
                            $name = $matches[1].Trim()
                            if ($name -and $name -ne "" -and $name -ne "<unknown>" -and -not $netbiosNames.ContainsKey($ip)) {
                                # Get MAC from nbtstat output
                                $nbtMac = ""
                                if ($nbt -match 'MAC Address = ([0-9A-F]{2}[-:][0-9A-F]{2}[-:][0-9A-F]{2}[-:][0-9A-F]{2}[-:][0-9A-F]{2}[-:][0-9A-F]{2})') {
                                    $nbtMac = $matches[1].ToUpper() -replace '-', ':'
                                }
                                $netbiosNames[$ip] = @{ name = $name; mac = $nbtMac }
                            }
                        }
                    } catch {}
                }
            }
        }
    } catch {}
    $result.netbiosNames = $netbiosNames

    # ====== 8. DNS REVERSE LOOKUP ======
    $dnsNames = @{}
    try {
        if ($Subnet) {
            $ipList = 1..254 | ForEach-Object { "$Subnet.$_" }
            $batchSize = 20
            for ($b = 0; $b -lt $ipList.Count; $b += $batchSize) {
                $batch = $ipList[$b..([Math]::Min($b + $batchSize - 1, $ipList.Count - 1))]
                foreach ($ip in $batch) {
                    try {
                        $r = [System.Net.Dns]::GetHostEntry($ip)
                        if ($r.HostName -and $r.HostName -ne $ip -and -not $dnsNames.ContainsKey($ip)) { $dnsNames[$ip] = $r.HostName }
                    } catch {}
                }
            }
        }
    } catch {}
    $result.dnsNames = $dnsNames

    # ====== 9. ICMP PING SWEEP (C# Parallel) ======
    $pingIps = @()
    try {
        if ($Subnet) {
            $pingIps = [Scanner]::TcpBatch(($ipList = 1..254 | ForEach-Object { "$Subnet.$_" }), 7, 200)
            if ($pingIps.Count -eq 0) { $pingIps = [Scanner]::TcpBatch($ipList, 80, 300) }
        }
    } catch {}
    $result.pingIps = $pingIps

    # ====== 10. HOTSPOT DETECTION ======
    try {
        $hotspotUrl = "http://$gateway/login"
        $wc = New-Object System.Net.WebClient; $wc.Timeout = 3000
        $hHtml = $wc.DownloadString($hotspotUrl)
        if ($hHtml -and $hHtml.Length -gt 30) {
            $result.hotspot.detected = $true
            $result.hotspot.url = $hotspotUrl
            if ($hHtml -match '<title[^>]*>([^<]+)<') { $result.hotspot.title = $matches[1].Trim() }
            if ($hHtml -match 'name="username"') { $result.hotspot.loginField = "username" }
        }
    } catch {}

    # ====== 11. BUILD COMBINED HOST LIST ======
    $allHosts = @{} # key = ip or mac to deduplicate

    # SNMP devices with IPs first (most reliable)
    foreach ($d in $result.snmpDevices) {
        if ($d.ip -and $d.ip -ne "" -and $d.mac -and $d.mac -ne "") {
            $allHosts["$($d.ip)|$($d.mac)"] = @{ ip=$d.ip; mac=$d.mac; source=$d.source }
        }
    }
    # SNMP devices MAC-only
    foreach ($d in $result.snmpDevices) {
        if ((-not $d.ip -or $d.ip -eq "") -and $d.mac -and $d.mac -ne "") {
            $allHosts["mac:$($d.mac)"] = @{ ip=""; mac=$d.mac; source=$d.source }
        }
    }

    # REST API devices
    foreach ($d in $result.restDevices) {
        if ($d.ip -and $d.ip -ne "" -and $d.mac -and $d.mac -ne "") {
            $allHosts["$($d.ip)|$($d.mac)"] = @{ ip=$d.ip; mac=$d.mac; hostname=$d.hostname; source=$d.source }
        } elseif ($d.mac -and $d.mac -ne "") {
            $allHosts["mac:$($d.mac)"] = @{ ip=""; mac=$d.mac; hostname=$d.hostname; source=$d.source }
        }
    }

    # Web scraping devices
    foreach ($d in $result.webDevices) {
        if ($d.ip -and $d.ip -ne "" -and $d.mac -and $d.mac -ne "") {
            $allHosts["$($d.ip)|$($d.mac)"] = @{ ip=$d.ip; mac=$d.mac; source=$d.source; isPotentialHostpot=$true }
        } elseif ($d.mac -and $d.mac -ne "") {
            $allHosts["mac:$($d.mac)"] = @{ ip=""; mac=$d.mac; source=$d.source; isPotentialHostpot=$true }
        }
    }

    # NetBIOS devices
    foreach ($kv in $netbiosNames.GetEnumerator()) {
        $ip = $kv.Key; $info = $kv.Value
        if ($info.mac -and $info.mac -ne "") {
            $allHosts["$ip|$($info.mac)"] = @{ ip=$ip; mac=$info.mac; hostname=$info.name; source="netbios" }
        } else {
            $allHosts["ip:$ip"] = @{ ip=$ip; mac="N/A"; hostname=$info.name; source="netbios" }
        }
    }

    # mDNS/LLMNR names
    foreach ($kv in $mdnsNames.GetEnumerator()) {
        if (-not $allHosts.ContainsKey("ip:$($kv.Key)")) {
            $allHosts["ip:$($kv.Key)"] = @{ ip=$kv.Key; mac="N/A"; hostname=$kv.Value; source="mdns" }
        }
    }

    # DNS names
    foreach ($kv in $dnsNames.GetEnumerator()) {
        if (-not $allHosts.ContainsKey("ip:$($kv.Key)")) {
            $allHosts["ip:$($kv.Key)"] = @{ ip=$kv.Key; mac="N/A"; hostname=$kv.Value; source="dns-reverse" }
        }
    }

    # ICMP ping IPs (lowest confidence - add if not already found)
    foreach ($ip in $pingIps) {
        if ($ip -eq $OurIp -or $ip -eq $Gateway) { continue }
        $found = $false
        foreach ($k in $allHosts.Keys) { if ($allHosts[$k].ip -eq $ip) { $found = $true; break } }
        if (-not $found) { $allHosts["ip:$ip"] = @{ ip=$ip; mac="N/A"; source="icmp-sweep" } }
    }

    $result.hosts = @($allHosts.Values | Sort-Object { $_.ip })
    $result.success = $true

} catch {
    $result.error = $_.Exception.Message
}

$result | ConvertTo-Json -Depth 10 -Compress
