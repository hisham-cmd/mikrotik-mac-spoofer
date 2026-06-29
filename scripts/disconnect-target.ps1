param(
    [Parameter(Mandatory = $true)]
    [string]$TargetIp,
    [Parameter(Mandatory = $true)]
    [string]$TargetMac,
    [Parameter(Mandatory = $false)]
    [string]$AdapterName = "Wi-Fi",
    [Parameter(Mandatory = $false)]
    [string]$GatewayIp = "",
    [Parameter(Mandatory = $false)]
    [int]$DurationSeconds = 30,
    [Parameter(Mandatory = $false)]
    [int]$IntervalMs = 100
)

$ErrorActionPreference = "Stop"

$result = @{ success = $false; error = $null; gatewayIp = $null; methods = @() }

if (-not $GatewayIp) {
    $route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction SilentlyContinue | Where-Object NextHop -ne "0.0.0.0" | Select-Object -First 1
    if ($route) { $GatewayIp = $route.NextHop }
}

$result.gatewayIp = $GatewayIp

try {
    $methodsUsed = @()
    $fakeMac = "00:00:00:00:00:01"
    $endTime = [DateTime]::Now.AddSeconds($DurationSeconds)
    $aggressiveEnd = [DateTime]::Now.AddSeconds(3)

    $cSharpCode = @'
using System;
using System.Net;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;
public class ArpPoison {
    [DllImport("iphlpapi.dll", SetLastError = true)]
    public static extern int SetIpNetEntry(IntPtr pArpEntry);

    [DllImport("iphlpapi.dll", SetLastError = true)]
    public static extern int DeleteIpNetEntry(IntPtr pArpEntry);

    [DllImport("iphlpapi.dll", SetLastError = true)]
    public static extern int FlushIpNetTable(int ifIndex);

    [DllImport("iphlpapi.dll", SetLastError = true)]
    public static extern int CreateIpNetEntry(IntPtr pArpEntry);

    [StructLayout(LayoutKind.Sequential)]
    public struct MIB_IPNETROW {
        public int dwIndex;
        public int dwPhysAddrLen;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 6)]
        public byte[] bPhysAddr;
        public uint dwAddr;
        public int dwType;
    }

    public static int AddArpEntry(int ifIndex, string ip, string mac) {
        var entry = new MIB_IPNETROW {
            dwIndex = ifIndex,
            dwPhysAddrLen = 6,
            bPhysAddr = ParseMac(mac),
            dwAddr = BitConverter.ToUInt32(IPAddress.Parse(ip).GetAddressBytes(), 0),
            dwType = 4
        };
        IntPtr ptr = Marshal.AllocHGlobal(Marshal.SizeOf(entry));
        try {
            Marshal.StructureToPtr(entry, ptr, false);
            return CreateIpNetEntry(ptr);
        } finally {
            Marshal.FreeHGlobal(ptr);
        }
    }

    public static int DeleteArpEntry(int ifIndex, string ip) {
        var entry = new MIB_IPNETROW {
            dwIndex = ifIndex,
            dwPhysAddrLen = 6,
            bPhysAddr = new byte[6],
            dwAddr = BitConverter.ToUInt32(IPAddress.Parse(ip).GetAddressBytes(), 0),
            dwType = 4
        };
        IntPtr ptr = Marshal.AllocHGlobal(Marshal.SizeOf(entry));
        try {
            Marshal.StructureToPtr(entry, ptr, false);
            return DeleteIpNetEntry(ptr);
        } finally {
            Marshal.FreeHGlobal(ptr);
        }
    }

    private static byte[] ParseMac(string mac) {
        return mac.Split(':', '-').Select(b => Convert.ToByte(b, 16)).ToArray();
    }

    public static bool PingTarget(string ip, int timeoutMs = 500) {
        try {
            using (var ping = new Ping()) {
                var reply = ping.Send(ip, timeoutMs);
                return reply.Status == IPStatus.Success;
            }
        } catch { return false; }
    }
}
'@
    Add-Type -TypeDefinition $cSharpCode -ErrorAction SilentlyContinue

    if ([System.Management.Automation.PSTypeName]'ArpPoison').Type) {
        $adapter = Get-NetAdapter -Name $AdapterName -ErrorAction SilentlyContinue
        $ifIndex = if ($adapter) { $adapter.ifIndex } else { 0 }

        Write-Output "METHOD: Win32 API ARP poisoning (stealth mode)"

        while ([DateTime]::Now -lt $endTime) {
            [ArpPoison]::AddArpEntry($ifIndex, $TargetIp, $fakeMac) | Out-Null
            if ($GatewayIp) {
                [ArpPoison]::AddArpEntry($ifIndex, $GatewayIp, $fakeMac) | Out-Null
            }

            $currentInterval = if ([DateTime]::Now -lt $aggressiveEnd) { $IntervalMs } else { 1000 }
            Start-Sleep -Milliseconds $currentInterval
            [ArpPoison]::DeleteArpEntry($ifIndex, $TargetIp) | Out-Null
        }

        $methodsUsed += "Win32_API_ARP"
        Write-Output "Win32 ARP poisoning completed for $DurationSeconds seconds"
    } else {
        Write-Output "METHOD: netsh neighbor manipulation (fallback)"

        $fakeMacByte = $fakeMac -replace ':', '-'

        while ([DateTime]::Now -lt $endTime) {
            try {
                $null = netsh interface ip set neighbors "$AdapterName" "$TargetIp" "$fakeMacByte" 2>&1
                if ($GatewayIp) {
                    $null = netsh interface ip set neighbors "$AdapterName" "$GatewayIp" "$fakeMacByte" 2>&1
                }
            } catch {}

            $currentInterval = if ([DateTime]::Now -lt $aggressiveEnd) { $IntervalMs } else { 1000 }
            Start-Sleep -Milliseconds $currentInterval
        }

        $methodsUsed += "netsh_neighbor"
        Write-Output "netsh poisoning completed for $DurationSeconds seconds"
    }

    $result.methods = $methodsUsed
    $result.success = $true

} catch {
    $result.error = $_.Exception.Message
}

$result | ConvertTo-Json -Compress
