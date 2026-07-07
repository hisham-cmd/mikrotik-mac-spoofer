# PROJECT_MAP - mikrotik-mac-spoofer

## Goal
أداة MAC Spoofing لتناوب الكروت على شبكة ميكروتيك (3D نت) مع مراقبة الكوتا وتبديل MAC address تلقائياً عند نفاد الرصيد.

## Architecture
```
API Layer (src/index.js) ← Express REST API
Application Layer (src/core/card-rotator.js) ← تنسيق التناوب
Domain Layer (src/core/quota-monitor.js, hotspot-auth.js, network-scanner.js) ← المنطق الأساسي
Infrastructure Layer (src/core/wifi-manager.js, proxy-server.js, session-store.js) ← تنفيذ
CLI Layer (src/cli/index.js) ← واجهة أوامر
Dashboard (public/index.html) ← واجهة مستخدم
PowerShell Layer (scripts/) ← ARP scan, MAC spoof, WiFi info
```

## Completed
- `package.json`: dependencies + scripts مع `pnpm start`, `pnpm build`, `pnpm cli`
- `config/default.json`: إعدادات hotspot, الشبكة, Profile السرعات من config.js الحقيقي
- `data/cards.json`: تخزين الكروت مع الكرت الافتراضي 2622771968
- `scripts/spoof-mac.ps1`: تغيير MAC عبر الريجستري + إعادة الاتصال بالشبكة
- `scripts/get-wifi-info.ps1`: قراءة معلومات الأداptor + الشبكات المتاحة
- `src/utils/logger.js`: تسجيل مع تدوير الملفات
- `src/core/wifi-manager.js`: إدارة MAC spoofing + WiFi reconnect + quickCheck() netsh مباشر
- `src/core/hotspot-auth.js`: تسجيل الدخول/الخروج + قراءة الكوتا من صفحة الحالة
- `src/core/proxy-server.js`: HTTP/HTTPS proxy مع عد البايتات
- `src/core/session-store.js`: تخزين الكروت والجلسات في JSON
- `src/core/quota-monitor.js`: مراقبة الكوتا من الproxy + صفحة الحالة مع حد 90% تنبيه
- `src/core/card-rotator.js`: تناوب تلقائي: استهلاك ← spoof MAC ← تسجيل دخول بكرت جديد
- `src/cli/index.js`: أوامر CLI (spoof, login, logout, status, cards, rotate, ...)
- `src/index.js`: Express server port 3003 + SSE progress modal + subnet scan params
- `public/index.html`: واجهة تحكم عربية + hijack progress modal متحرك + steps
- `scripts/scan-network.ps1`: مسح ARP للشبكة لاكتشاف الأجهزة النشطة + البوابة
- `src/core/network-scanner.js`: مسح الشبكة + التعرف على الشركة المصنعة من MAC OUI
- `scripts/disconnect-target.ps1`: فصل الهدف عبر ARP cache poisoning (Win32 API + netsh)
- `scripts/check-session.ps1`: التحقق من جلسة الهوتسبوت + ARP conflict detection
- `src/core/arp-spoofer.js`: تسميم ARP للهدف + إدارة ARP cache
- `src/core/card-bruteforce.js`: تخمين تلقائي لأرقام الكروت (بادئة 262277) مع MAC rotation
- `src/core/session-hijack.js`: تنسيق الاختراق الكامل + emitStep محمي من circular reference (تمت إعادة الكتابة)
- `scripts/scan-deep.ps1`: مسح 21 subnet (0-20) عبر TCP port 80 (بدلاً من ICMP) + حفظ ARP
- `src/core/deep-scanner.js`: multi-subnet scan + subnetStart/End params + fallback ARP + `runPowerfulScan()` لـ Client Isolation
- `scripts/scan-power.ps1`: فحص خارق — SNMP, REST API, Web scraping, mDNS, NetBIOS, DNS, ICMP sweep, port scan, banner grab

## V2.0 New Features
- **Multi-Strategy Hijack Engine**: 5 استراتيجيات اختراق متاحة
  - `session-wait`: انتظار الجلسة (الطريقة الأصلية) — يعمل إذا كانت الجلسة نشطة مسبقاً
  - `card-login`: تسجيل الدخول بالكروت — يستخدم الكروت المخزنة (موثوق)
  - `api-session`: API الراوتر — يتحقق من وجود جلسة للهدف عبر REST API
  - `brute-force`: تخمين الكروت — يجرب أرقام عشوائية مع تدوير MAC عند الحظر
  - `smart-auto`: ذكي — يجرب جميع الاستراتيجيات بالتسلسل (افتراضي)
- **Network Analysis Endpoint**: `POST /api/hijack/analyze` — يحلل الاستراتيجيات المناسبة للهدف
- **Dashboard Strategy Selector**: اختيار الاستراتيجية مع توصية ذكية
- **Error Messages Mole**: رسائل خطأ محددة لكل استراتيجية (بدلاً من "hotspot not reachable" الموحّد)
- **Config**: قسم `hijack` جديد في `config/default.json` مع إعدادات الاستراتيجيات

## Pending
- MAC random addresses لبعض العملاء قد لا تكون ثابتة
- الراوتر لا يدعم REST API ولا API القديم (8728/8729)
- Session cookie capture عبر proxy server (يتطلب transparent proxy setup معقد)
- Session Scan: فحص جلسات الهوتسبوت الفعلية لكل جهاز (يتطلب spoof مؤقت لكل MAC)

## V2.2 - Client Classification + Hotspot User Detection
- **Expanded VENDOR_DB**: 200+ OUI prefixes for Apple, Samsung, Xiaomi, Huawei, TP-Link, Cisco, Intel, etc.
- **Port-53 transparent proxy fix**: `classifyDevice()` now accepts `port53DevCount`. If >2 devices show port 53, it's considered transparent proxy (MikroTik DNS interception) and won't label devices as "DNS Server".
- **`isPotentialHotspotUser()`**: New heuristic detects likely hotspot clients by:
  1. Excluding infrastructure vendors (MikroTik, TP-Link, Cisco, etc.)
  2. Excluding server ports (22, 443, 8080, 8291, 9090)
  3. Including known client vendors (Apple, Samsung, etc.)
  4. Falling back to TTL-based detection (128=Windows, 64=Linux/Mac)
- **`potentialUserCount`**: Added to scan results for quick reference
- **Hotspot badges**: `🔥 جلسة محتملة` badge in scan results + MAC devices list
- **Hotspot filter**: "إظهار الجلسات فقط" toggle in MAC devices panel
- **Background highlight**: Rows for potential hotspot users are lightly green-tinted

## Fixed
- **MAC spoof failure for UAA targets (v2.1)**: `session-hijack.js` كان يمرر `{ noLaaFix: true }` مما يمنع تعديل LAA bit. الـ MAC الهدف مثل `B0:BE:76:2E:35:2E` (UAA, LAA bit = 0) يرفضه Windows. الحل: fallback إلى spoof بدون `noLaaFix` إذا فشلت المحاولة الأولى.
- **Random MAC generation LAA fix**: `generateMac()` في `wifi-manager.js` يضمن الآن أن الـ MAC المولد له LAA bit = 1 (يقبله Windows).
- **Spoof script fallbacks**: `spoof-mac.ps1` أضيفت 4 طرق fallback (registry, Set-NetAdapter, WMI, netsh) مع رسالة خطأ واضحة عند الفشل.
- **LAA bit forcing**: `spoof-mac.ps1` يغير MAC الهدف عند التصيد (AC→AE). أضفنا `-NoLaaFix` لتعطيل تعديل LAA bit عند الاختراق.
- **MAC restoration on failure**: `session-hijack.js` يستعيد MAC الأصلي تلقائياً عند فشل الاختراق (complete/handleError).
- **getAdapterInfo instability**: `get-wifi-info.ps1` بُسّط: أزيل `Start-Job`/`Wait-Job` (سبب رئيسي للفشل)، نستخدم `netsh` مباشر.
- **ARP poison detectability**: `disconnect-target.ps1` 3s first aggressive (200ms) ثم stealth (1000ms) لتجنب كشف IDS.
- **Timing optimizations**: `session-hijack.js` - تقليل مهلات الاتصال (15s→12s)، اكتشاف gateway (5s→3s)، التحقق من الجلسة (timeout 3s→2s).

## Key Network Discoveries
- DHCP pool: 172.21.14.x → 172.21.37.x (على الأقل)
- Proxy-ARP لكل IP في النطاق (4854 IP behind gateway MAC 00:00:00:00:00:0E)
- **9 real clients found** مع unique MACs (TTL=64 → Linux/Android/iOS)
- جميع العملاء لديهم جدران نار تمنع الاتصالات الواردة (zero open ports)
- البوابة: 172.21.0.1 مع open ports: 80, 443, 8291, 53, 2000

## Key Network Info (from config.js.download)
| الخاصية | القيمة |
|---------|--------|
| service-number | 779043648 |
| try-count | 20 محاولة |
| block-time | 1 دقيقة |
| login-chap | 0 (نص عادي) |
| login-speeds-mode | true |
| input-only-numbers | 1 |

## Profiles (أسعار الكروت)
| السعر | الوقت | البيانات | الصلاحية |
|-------|-------|----------|---------|
| 100 ريال | 4 ساعات | 400 ميجا | 3 أيام |
| 200 ريال | 9 ساعات | 800 ميجا | 5 أيام |
| 250 ريال | 9 ساعات | 1 جيجا | 5 أيام |
| 500 ريال | 50 ساعة | 2 جيجا | 8 أيام |
| 1500 ريال | 200 ساعة | 6200 ميجا | 15 أيام |
| 3000 ريال | شهر | 13 جيجا | 30 أيام |

## Dependencies
- express ^4.21.0
- http-proxy ^1.18.1
- axios ^1.7.0
- commander ^11.1.0
