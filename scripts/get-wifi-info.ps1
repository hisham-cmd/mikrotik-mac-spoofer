$adapter = Get-NetAdapter | Where-Object { $_.InterfaceDescription -match 'Wireless|WiFi|WLAN|802\.11' } | Select-Object -First 1
if (-not $adapter) {
  Write-Output '{"success":false,"error":"No WiFi adapter found"}'
  return
}
$ip = Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 | Select-Object -First 1
$route = Get-NetRoute -InterfaceIndex $adapter.ifIndex -DestinationPrefix '0.0.0.0/0' | Select-Object -First 1
$ssid = ''
try { $ssid = (netsh wlan show interfaces | Select-String '^\s+SSID\s+:\s(.+)' | ForEach-Object { $_.Matches.Groups[1].Value }) -join '' } catch {}
$info = @{
  success = $true
  adapter = @{
    name = $adapter.Name
    macAddress = $adapter.MacAddress
    ssid = $ssid
    status = $adapter.Status
    gateway = if ($route) { $route.NextHop } else { '' }
    ipAddress = if ($ip) { $ip.IPAddress } else { '' }
    interfaceIndex = $adapter.ifIndex
    interfaceDescription = $adapter.InterfaceDescription
    linkSpeed = $null
    availableNetworks = @()
  }
}
Write-Output ($info | ConvertTo-Json -Compress)
