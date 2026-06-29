const axios = require('axios');
const { execFileSync } = require('child_process');
const path = require('path');

async function testUrl(label, url) {
  console.log(`\n[${label}] Testing: ${url}`);
  try {
    const start = Date.now();
    const resp = await axios.get(url, {
      timeout: 5000, maxRedirects: 3, validateStatus: () => true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    const elapsed = Date.now() - start;
    const html = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    console.log(`  Status: ${resp.status} ${resp.statusText}`);
    console.log(`  Time: ${elapsed}ms`);
    console.log(`  Size: ${html.length}b`);
    console.log(`  Content-Type: ${resp.headers['content-type'] || 'N/A'}`);
    console.log(`  Session: ${html.includes('remain_bytes_total') || html.includes('تم تسجيل')}`);
    console.log(`  Preview: ${html.substring(0, 200).replace(/\n/g, '\\n')}`);
  } catch (err) {
    console.log(`  ERROR: ${err.message} (${err.code || 'N/A'})`);
  }
}

async function main() {
  console.log('=== HOTSPOT URL TEST ===\n');

  let gatewayIp = null;
  try {
    const ipOut = execFileSync('powershell.exe', ['-NoProfile', '-Command', '$r=Get-NetRoute -DestinationPrefix "0.0.0.0/0"|Where-Object NextHop -ne "0.0.0.0"|Select-Object -First 1; if($r){$r.NextHop}else{$null}'], { timeout: 3000, encoding: 'utf-8' });
    gatewayIp = (ipOut || '').trim();
  } catch {}
  if (!gatewayIp) {
    try {
      const arpOut = execFileSync('arp', ['-a'], { timeout: 2000, encoding: 'utf-8' });
      const m = arpOut.match(/(\d+\.\d+\.\d+\.\d+)\s+dynamic/);
      if (m) gatewayIp = m[1];
    } catch {}
  }
  console.log(`Gateway IP: ${gatewayIp || 'Not found'}`);

  try {
    const netsh = execFileSync('netsh', ['wlan', 'show', 'interfaces'], { timeout: 5000, encoding: 'utf-8' });
    const ssidMatch = netsh.match(/^\s+SSID\s*:\s*(.+)$/m);
    const stateMatch = netsh.match(/^\s+State\s*:\s*(.+)$/m);
    console.log(`WiFi: ${stateMatch ? stateMatch[1].trim() : 'N/A'} | SSID: ${ssidMatch ? ssidMatch[1].trim() : 'N/A'}`);
  } catch (e) {
    console.log(`WiFi check failed: ${e.message}`);
  }

  console.log('\n--- Testing URLs ---');
  const urls = [
    { label: 'm.net', url: 'http://m.net/' },
    { label: 'm.net/index', url: 'http://m.net/index.html' },
    { label: 'm.net/login', url: 'http://m.net/login' },
    { label: 'Gateway', url: gatewayIp ? `http://${gatewayIp}/` : null },
    { label: 'Gateway/index', url: gatewayIp ? `http://${gatewayIp}/index.html` : null },
    { label: 'Gateway/login', url: gatewayIp ? `http://${gatewayIp}/login` : null },
    { label: 'Google', url: 'http://google.com/' },
  ];

  for (const { label, url } of urls) {
    if (url) await testUrl(label, url);
  }

  console.log('\n=== DONE ===');
}

main().catch(console.error);
