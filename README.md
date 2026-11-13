# PulseRelay Signaling Server (Phase 2A)

خادم إشارة (Signaling Server) مستقل يعمل عبر WebSocket (`ws` / `wss`) لتنسيق بدء الاتصال واكتشاف المسارات بين الأجهزة وتحديث حالة الاتصال (`ONLINE` / `OFFLINE`) **دون تخزين أي رسائل أو وسائط أو ملفات مستخدمين**.

## المزايا في المرحلة 2A
- **صفر تخزين للمحتوى:** يحتفظ فقط بجدول جلسات الاتصال النشطة في الذاكرة (`Map`). إذا كان الطرف الآخر غير متصل يعيد `signal.undelivered` (`PEER_OFFLINE`) دون تخزين الرسالة.
- **منع الانتحال (Anti-Spoofing):** يرفض الخادم أي إطار `signal` يختلف فيه `fromPeerId` عن الهوية المصادق عليها للجلسة.
- **مراقبة الحضور الفوري (Presence):** دعم `presence.subscribe` و`presence.query` وإشعارات `presence.update` عند دخول أو خروج جهات الاتصال.
- **إعدادات STUN/TURN:** نقطة نهاية `GET /ice-config` وفريم `welcome` يولّدان إعدادات ICE مع دعم بيانات اعتماد Coturn المؤقتة (HMAC REST credentials).
- **فصل التطوير عن الإنتاج:** يمنع الخادم تشغيل `AUTH_MODE=dev` تلقائياً إذا كانت `NODE_ENV=production`.

## التشغيل محلياً (Development)

```bash
cd F:\WeColl\PulseRelay\signaling-server
npm install
npm test
npm start
```

نقاط النهاية الافتراضية محلياً:
- Health Check: `http://127.0.0.1:8080/health`
- ICE Config: `http://127.0.0.1:8080/ice-config?peerId=+201001234567`
- WebSocket (المحاكي): `ws://10.0.2.2:8080/ws`
- WebSocket (هاتف حقيقي على نفس شبكة Wi-Fi): `ws://<PC_LAN_IP>:8080/ws`

## ملاحظة مهمّة حول الشبكات المختلفة (Wi-Fi مقابل 4G/5G) وProduction
- للاستخدام عبر الإنترنت أو بين شبكتين مختلفتين في **Production** يجب تشغيل الخادم خلف Reverse Proxy يدعم TLS (`wss://`) مثل Nginx/Caddy مع `NODE_ENV=production` و`AUTH_MODE=hmac` ومفتاح `SIGNALING_AUTH_SECRET` لا يقل عن 32 حرفاً في متغيرات البيئة فقط.
- في الشبكات ذات NAT المقيد (Symmetric NAT / بعض شبكات المحمول)، يلزم توفير خادم **TURN** ذاتي الاستضافة (مثل Coturn عبر `coturn/turnserver.conf.example`) إلى جانب STUN لعمل الترحيل المشفر عند تعذر الاتصال المباشر.
