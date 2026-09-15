/* ============================================
   APEX FINTECH - SHEETS DIRECT v1.1
   CHIASEV1.2: KHÔNG cần backend PHP — gửi lead THẲNG LÊN GOOGLE SHEETS.

   Flow:
     main.js → ApexSheetsDirect.send() → Google Apps Script Web App → Google Sheets
   Cách dùng:
     window.ApexSheetsDirect.send({
       name, phone, form_type, channel,
       idempotency_key,                  // từ main.js
       user_ip: ''                        // (optional, sẽ async fetch nếu rỗng)
     });
   ============================================ */

(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════════════
  //  CONFIG — SAU KHI CHẠY setup() TRÊN GOOGLE SCRIPT, COPY URL + SECRET
  // ════════════════════════════════════════════════════════════════════
  var APEX_SHEETS_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbznH5MauOQ75K9yoGEGPB0WKDEzQ9tDe8EW-L5wVuj--bfHG1_05xuAYPAO7Pn6cG6O4Q/exec';   // Dán URL dạng https://script.google.com/macros/s/AKfy.../exec
  var APEX_LEADS_SECRET      = 'Xf3Y4rUbRkGgnahtjipzs5do6dmGz0X0rZehBFfw0yc';   // Dán secret đã copy từ log của setup()

  // Bật/tắt sheets-send (true: gửi sang Google Sheet khi submit)
  var ENABLED = true;

  // Timeout cho fire-and-forget POST sang Google Sheet (ms)
  var SHEETS_REQUEST_TIMEOUT_MS = 8000;

  // Max số lần retry cho mỗi lead (để tránh gửi vô hạn khi bị CORS/file://)
  var MAX_RETRY_PER_LEAD = 2;

  // DEBUG flag — BẬT = true khi dev, TẮT = false khi deploy production
  // (ẩn toàn bộ console.log/warn để tránh leak URL/secret & thông tin nhạy cảm)
  var DEBUG = false;
  var _log = function () { if (DEBUG) { try { console.log.apply(console, ['[SheetsDirect]'].concat(Array.prototype.slice.call(arguments))); } catch (_) {} } };
  var _warn = function () { if (DEBUG) { try { console.warn.apply(console, ['[SheetsDirect]'].concat(Array.prototype.slice.call(arguments))); } catch (_) {} } };

  // Detect môi trường: nếu là file:// thì KHÔNG retry queue (tránh duplicate)
  var IS_FILE_PROTOCOL = (typeof location !== 'undefined' &&
    location.protocol === 'file:');

  // ════════════════════════════════════════════════════════════════════
  //  safeStorage — fallback khi localStorage bị Tracking Prevention block
  //  Thứ tự ưu tiên: localStorage → sessionStorage → in-memory Map
  //  Chrome/Edge/Safari đều dùng được. Không bao giờ throw exception.
  // ════════════════════════════════════════════════════════════════════
  var _memStore = {};
  function safeStorageGet(key) {
    try { var v = localStorage.getItem(key); if (v !== null) return v; } catch (_) {}
    try { var v2 = sessionStorage.getItem(key); if (v2 !== null) return v2; } catch (_) {}
    return (typeof _memStore[key] !== 'undefined') ? _memStore[key] : null;
  }
  function safeStorageSet(key, value) {
    try { localStorage.setItem(key, value); return; } catch (_) {}
    try { sessionStorage.setItem(key, value); return; } catch (_) {}
    try { _memStore[key] = value; } catch (_) {}
  }
  function safeStorageDel(key) {
    try { localStorage.removeItem(key); } catch (_) {}
    try { sessionStorage.removeItem(key); } catch (_) {}
    try { delete _memStore[key]; } catch (_) {}
  }
  function safeStorageClear() {
    try { localStorage.clear(); } catch (_) {}
    try { sessionStorage.clear(); } catch (_) {}
    try { _memStore = {}; } catch (_) {}
  }
  // Expose ra window để main.js / chucmung.html / tracker.js dùng chung
  window.ApexSafeStorage = {
    get: safeStorageGet,
    set: safeStorageSet,
    del: safeStorageDel,
    clear: safeStorageClear
  };

  // ════════════════════════════════════════════════════════════════════
  //  INTERNAL STATE
  // ════════════════════════════════════════════════════════════════════
  var queue = [];
  var isFlushing = false;
  var lastResult = null;

  // Set các idempotency_key đã gửi thành công trong session này
  // (chống gửi trùng khi user click submit nhiều lần hoặc queue bị retry lặp)
  var sentKeys = {};

  // ════════════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ════════════════════════════════════════════════════════════════════

  /**
   * Gửi 1 lead sang Google Sheet (fire-and-forget).
   * Sẽ async-fetch IP public (IPv4 hoặc IPv6) từ ipapi.co trước khi gửi,
   * fallback ipify nếu ipapi lỗi. Nếu cả 2 đều fail thì Apps Script sẽ tự fetch.
   * @param {object} leadInput {name, phone, form_type, channel, idempotency_key, ...}
   * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
   */
  function send(leadInput) {
    if (!ENABLED) return Promise.resolve({ ok: false, error: 'disabled' });
    if (!APEX_SHEETS_WEBAPP_URL || !APEX_LEADS_SECRET) {
      _warn('Webapp URL hoặc SECRET chưa được cấu hình.');
      return Promise.resolve({ ok: false, error: 'not_configured' });
    }

    // ─── Dedup check: nếu idempotency_key đã gửi OK trong session → skip ───
    var idemKey = leadInput && leadInput.idempotency_key;
    if (idemKey && sentKeys[idemKey]) {
      _log('Skip duplicate (idempotency_key already sent):', idemKey);
      return Promise.resolve({ ok: true, status: 200, dedup: true });
    }

    // Try fetch IP, then build + send. Timeout 2.5s — không block UX.
    return fetchPublicIp_().then(function (ip) {
      if (ip) leadInput.user_ip = ip;
      var payload = buildPayload_(leadInput);
      return doSend_(payload, 0 /* attempt */);
    }).catch(function () {
      // IP fetch fail → vẫn gửi payload (Apps Script sẽ tự fetch IP)
      var payload = buildPayload_(leadInput);
      return doSend_(payload, 0);
    });
  }

  /**
   * Enqueue 1 lead (sẽ gửi sau khi online trở lại).
   */
  function enqueue(leadInput) {
    if (!ENABLED) return;
    queue.push(leadInput);
    scheduleFlush_(0);
  }

  /**
   * Flush queue ngay.
   */
  function flushQueue() {
    if (!queue.length) return Promise.resolve();
    return flushQueueInternal_();
  }

  /**
   * Bật/tắt dual-send runtime.
   */
  function setEnabled(v) { ENABLED = !!v; }

  /**
   * Cập nhật config runtime (không cần reload page).
   */
  function configure(url, secret) {
    if (typeof url === 'string' && url) APEX_SHEETS_WEBAPP_URL = url;
    if (typeof secret === 'string' && secret) APEX_LEADS_SECRET = secret;
  }

  /**
   * Trả về info debug.
   */
  function status() {
    return {
      enabled: ENABLED,
      url_configured: !!APEX_SHEETS_WEBAPP_URL,
      secret_configured: !!APEX_LEADS_SECRET,
      queue_length: queue.length,
      last_result: lastResult
    };
  }

  // Expose
  window.ApexSheetsDirect = {
    send: send,
    enqueue: enqueue,
    flush: flushQueue,
    setEnabled: setEnabled,
    configure: configure,
    status: status
  };

  // ════════════════════════════════════════════════════════════════════
  //  PAYLOAD BUILDER
  // ════════════════════════════════════════════════════════════════════

  function buildPayload_(leadInput) {
    var now = new Date();

    // UTM (lấy từ URL query)
    var utmSource   = qParam_('utm_source');
    var utmMedium   = qParam_('utm_medium');
    var utmCampaign = qParam_('utm_campaign');
    var utmContent  = qParam_('utm_content');
    var utmTerm     = qParam_('utm_term');
    var fbclid      = qParam_('fbclid');
    var gclid       = qParam_('gclid');

    // Facebook cookies (tạo fbc nếu có fbclid mà cookie rỗng)
    var fbc = cookie_('_fbc');
    var fbp = cookie_('_fbp');
    if (!fbc && fbclid) {
      fbc = 'fb.1.' + Math.floor(Date.now() / 1000) + '.' + fbclid;
    }

    // Tracking context
    var tracking = {
      fbc: fbc || '',
      fbp: fbp || '',
      utm_source:   utmSource,
      utm_medium:   utmMedium,
      utm_campaign: utmCampaign,
      utm_content:  utmContent,
      utm_term:     utmTerm,
      gclid:        gclid,
      fbclid:       fbclid,

      user_agent: navigator.userAgent,
      device_type: /Mobi|Andr|iP(hone|ad|od)/i.test(navigator.userAgent) ? 'mobile' : (/Tablet|iPad/i.test(navigator.userAgent) ? 'tablet' : 'desktop'),
      browser_name: detectBrowser_(),
      os_name: detectOS_(),
      screen_res: screen.width + 'x' + screen.height,
      viewport_w: window.innerWidth,
      viewport_h: window.innerHeight,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      timezone: (Intl.DateTimeFormat().resolvedOptions().timeZone || '').slice(0, 50),
      // client TZ offset (phút) — dương = phía Đông UTC. Lưu để debug nếu Cloudflare/WARP làm sai.
      // Date.getTimezoneOffset() trả về phút ÂM nếu ở Đông UTC (vd UTC+7 → -420).
      tz_offset_minutes: -new Date().getTimezoneOffset(),
      language: (navigator.language || 'vi').slice(0, 10),
      cookie_enabled: navigator.cookieEnabled ? 'TRUE' : 'FALSE',
      connection_type: (navigator.connection && navigator.connection.effectiveType) || '',

      referrer: document.referrer || '',
      page_url: location.href,
      // local_time LUÔN ở UTC+7 (Asia/Ho_Chi_Minh), không phụ thuộc browser timezone
      local_time: isoLocal_(),
      // epoch ms gốc (server có thể dùng để format lại nếu cần)
      epoch_ms: Date.now(),
      user_ip: leadInput && leadInput.user_ip ? leadInput.user_ip : '',

      source: 'landing_page_direct',
      received_from: 'frontend'
    };

    // Lead
    var phoneDigits = (leadInput.phone || '').replace(/\D/g, '');
    var lead = {
      name: leadInput.name || '',
      phone: leadInput.phone || '',
      form_type: leadInput.form_type || 'unknown',
      channel: leadInput.channel || '',
      idempotency_key: leadInput.idempotency_key || ''
    };

    return {
      secret: APEX_LEADS_SECRET,
      lead: lead,
      tracking: tracking
    };
  }

  // ════════════════════════════════════════════════════════════════════
  //  SENDER (fire-and-forget + retry queue)
  // ════════════════════════════════════════════════════════════════════

  /**
   * Gửi payload lên Google Sheet. Luôn fire-and-forget.
   * @param {object} payload - payload đã build sẵn
   * @param {number} attempt - số lần retry (0 = lần đầu)
   * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
   */
  function doSend_(payload, attempt) {
    attempt = attempt || 0;

    return new Promise(function (resolve) {
      try {
        var body = JSON.stringify(payload);
        var ctrl = new AbortController();
        var timeoutId = setTimeout(function () { ctrl.abort(); }, SHEETS_REQUEST_TIMEOUT_MS);

        fetch(APEX_SHEETS_WEBAPP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: body,
          // Google Apps Script không hỗ trợ no-cors + POST thực sự
          // → gửi bình thường, CORS sẽ được Google xử lý
          signal: ctrl.signal,
          redirect: 'follow',
          mode: 'cors',
          credentials: 'omit',
          keepalive: true
        })
        .then(function (res) {
          clearTimeout(timeoutId);
          var idemKey = (payload.lead && payload.lead.idempotency_key) || '';
          var result = { ok: res.ok, status: res.status, ts: Date.now(), idem: idemKey };
          lastResult = result;

          if (res.ok) {
            _log('OK', res.status, payload.lead && payload.lead.phone);
            if (idemKey) sentKeys[idemKey] = Date.now();
          } else {
            _warn('HTTP', res.status, payload.lead && payload.lead.phone);
            handleRetry_(payload, attempt);
          }
          resolve(result);
        })
        .catch(function (err) {
          clearTimeout(timeoutId);
          var idemKey = (payload.lead && payload.lead.idempotency_key) || '';
          var result = { ok: false, error: err.name || 'network', message: String(err), ts: Date.now(), idem: idemKey };
          lastResult = result;
          _warn('Send failed:', err && err.message, payload.lead && payload.lead.phone);
          handleRetry_(payload, attempt);
          resolve(result);
        });
      } catch (e) {
        var result = { ok: false, error: 'exception', message: String(e) };
        lastResult = result;
        resolve(result);
      }
    });
  }

  /**
   * Quyết định có retry hay không dựa trên attempt count và môi trường.
   * - file:// → KHÔNG retry (CORS chặn vĩnh viễn)
   * - attempt >= MAX_RETRY_PER_LEAD → KHÔNG retry (đã retry đủ)
   */
  function handleRetry_(payload, attempt) {
    // Môi trường file:// → không retry queue (gây duplicate vô hạn)
    if (IS_FILE_PROTOCOL) {
      _warn('file:// detected → skip retry queue');
      return;
    }
    // Đã retry đủ → không enqueue nữa
    if (attempt >= MAX_RETRY_PER_LEAD) {
      _warn('Max retry reached → drop (attempt=' + attempt + '/max=' + MAX_RETRY_PER_LEAD + ')');
      return;
    }
    enqueueWithAttempt_(payload, attempt + 1);
  }

  // ════════════════════════════════════════════════════════════════════
  //  RETRY QUEUE (persistent localStorage)
  // ════════════════════════════════════════════════════════════════════

  var QUEUE_KEY = 'apex_sheets_queue';
  var MAX_QUEUE_SIZE = 30;

  function loadQueue_() {
    try {
      var raw = safeStorageGet(QUEUE_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function saveQueue_() {
    try {
      if (queue.length > MAX_QUEUE_SIZE) queue = queue.slice(-MAX_QUEUE_SIZE);
      safeStorageSet(QUEUE_KEY, JSON.stringify(queue));
    } catch (_) {}
  }

  /**
   * Thêm payload vào queue kèm attempt count.
   * Mỗi item trong queue có dạng: { payload: {...}, attempt: 1|2 }
   */
  function enqueueWithAttempt_(payload, attempt) {
    // Dedupe theo idempotency_key — không enqueue 2 lần cùng 1 key
    var idemKey = (payload.lead && payload.lead.idempotency_key) || '';
    if (idemKey && sentKeys[idemKey]) return; // đã gửi OK → skip
    if (idemKey) {
      for (var i = 0; i < queue.length; i++) {
        var qItem = queue[i];
        var qKey = qItem && qItem.payload && qItem.payload.lead && qItem.payload.lead.idempotency_key;
        if (qKey === idemKey) return; // đã có trong queue
      }
    }
    queue.push({ payload: payload, attempt: attempt || 1 });
    saveQueue_();
  }

  function scheduleFlush_(delayMs) {
    setTimeout(flushQueueInternal_, delayMs);
  }

  function flushQueueInternal_() {
    if (isFlushing) return Promise.resolve();
    if (!queue.length) return Promise.resolve();
    // file:// → không flush
    if (IS_FILE_PROTOCOL) return Promise.resolve();

    isFlushing = true;
    var items = queue.slice();
    var stillFailing = [];

    return Promise.all(items.map(function (item) {
      var payload = item.payload;
      var attempt = item.attempt || 1;
      return doSend_(payload, attempt).then(function (result) {
        // Nếu fail VÀ chưa đạt max retry → giữ lại trong queue (tăng attempt)
        if (!result || !result.ok) {
          if (attempt < MAX_RETRY_PER_LEAD) {
            stillFailing.push({ payload: payload, attempt: attempt + 1 });
          } else {
            _warn('Drop after max retry (attempt=' + attempt + ')');
          }
        }
        // Nếu OK → đã được lưu vào sentKeys (trong doSend_)
      });
    }))
    .then(function () {
      // Replace queue với chỉ những item còn fail (giới hạn attempt)
      queue = stillFailing.filter(function (item) {
        return item.attempt <= MAX_RETRY_PER_LEAD;
      });
      saveQueue_();
      isFlushing = false;
    })
    .catch(function () {
      isFlushing = false;
    });
  }

  // Expose enqueue (override public enqueue to use internal)
  var publicEnqueue = enqueue;
  enqueue = function (leadInput) {
    if (!APEX_SHEETS_WEBAPP_URL || !APEX_LEADS_SECRET) return;
    if (IS_FILE_PROTOCOL) return; // không queue khi file://
    var payload = (leadInput && leadInput.secret)
      ? leadInput  // đã là payload rồi
      : buildPayload_(leadInput);
    enqueueWithAttempt_(payload, 1);
  };

  // ════════════════════════════════════════════════════════════════════
  //  INIT: load queue từ localStorage + auto-flush
  // ════════════════════════════════════════════════════════════════════
  queue = loadQueue_();

  // Migration: nếu item cũ là payload thuần (không có wrapper {payload, attempt})
  // → wrap lại. Nếu là file:// → clear queue luôn (tránh duplicate cũ).
  if (IS_FILE_PROTOCOL && queue.length) {
    _warn('file:// detected → clear queue (no auto-retry)');
    queue = [];
    saveQueue_();
  } else {
    queue = queue.map(function (item) {
      if (item && item.payload && item.lead) {
        // đã là wrapper đúng
        return item;
      }
      // item cũ: payload thuần → wrap
      if (item && item.lead) {
        return { payload: item, attempt: 1 };
      }
      return null;
    }).filter(Boolean);

    if (queue.length) {
      _log('Có ' + queue.length + ' lead chờ gửi lại');
      // Đợi 2s cho page ổn định rồi flush
      setTimeout(flushQueueInternal_, 2000);
    }
  }

  // Auto-flush mỗi 60s (chỉ khi KHÔNG phải file://)
  if (!IS_FILE_PROTOCOL) {
    setInterval(function () {
      if (queue.length > 0) flushQueueInternal_();
    }, 60000);
  }

  // Flush khi online
  window.addEventListener('online', function () {
    if (queue.length > 0) {
      _log('Online → flush queue');
      flushQueueInternal_();
    }
  });

  // Flush trước khi unload
  window.addEventListener('pagehide', function () {
    if (queue.length === 0) return;
    if (IS_FILE_PROTOCOL) return; // không beacon khi file://
    try {
      var items = queue.map(function (item) { return item.payload; });
      var body = JSON.stringify({
        secret: APEX_LEADS_SECRET,
        batch: items.length,
        items: items
      });
      var blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
      navigator.sendBeacon && navigator.sendBeacon(APEX_SHEETS_WEBAPP_URL, blob);
    } catch (_) {}
  });

  // Re-export lại window.ApexSheetsDirect sau khi override enqueue
  window.ApexSheetsDirect.enqueue = enqueue;

  // ════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ════════════════════════════════════════════════════════════════════

  function qParam_(name) {
    var m = location.search.match(new RegExp('[?&]' + name + '=([^&#]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  /**
   * Fetch public IP. Trả về IPv4 hoặc IPv6 (tùy client network).
   * Ưu tiên ipapi.co (cũng trả geo), nhưng nếu chỉ cần IP thì dùng ipify.
   * Cache 5 phút để tránh spam.
   */
  var _ipCache = { ip: '', ts: 0 };
  function fetchPublicIp_() {
    var now = Date.now();
    if (_ipCache.ip && (now - _ipCache.ts) < 5 * 60 * 1000) {
      return Promise.resolve(_ipCache.ip);
    }
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (ip) {
        if (done) return;
        done = true;
        if (ip) { _ipCache.ip = ip; _ipCache.ts = Date.now(); }
        resolve(ip || '');
      };
      var timeoutId = setTimeout(function () { finish(''); }, 2500);

      // Primary: ipify (hỗ trợ cả IPv4 và IPv6, dual-stack auto-detect)
      try {
        fetch('https://api.ipify.org?format=json', { method: 'GET', cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) { clearTimeout(timeoutId); finish(j && j.ip ? j.ip : ''); })
          .catch(function () { /* fallback tiếp */ });
      } catch (_) { clearTimeout(timeoutId); finish(''); }

      // Fallback: ipapi.co (just IP)
      setTimeout(function () {
        if (done) return;
        try {
          fetch('https://ipapi.co/json/', { method: 'GET', cache: 'no-store' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (j) { clearTimeout(timeoutId); finish(j && j.ip ? j.ip : ''); })
            .catch(function () { clearTimeout(timeoutId); finish(''); });
        } catch (_) { clearTimeout(timeoutId); finish(''); }
      }, 600);
    });
  }

  function cookie_(name) {
    var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  function detectBrowser_() {
    var ua = navigator.userAgent;
    if (/Edg\//.test(ua)) return 'Edge';
    if (/OPR/.test(ua)) return 'Opera';
    if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) return 'Chrome';
    if (/Firefox\//.test(ua)) return 'Firefox';
    if (/Safari\//.test(ua) && !/Chrome/.test(ua)) return 'Safari';
    return 'Unknown';
  }

  function detectOS_() {
    var ua = navigator.userAgent;
    if (/Windows/.test(ua)) return 'Windows';
    if (/Android/.test(ua)) return 'Android';
    if (/iP(hone|ad|od)/.test(ua)) return 'iOS';
    if (/Mac/.test(ua)) return 'macOS';
    if (/Linux/.test(ua)) return 'Linux';
    return 'Unknown';
  }

  /**
   * Build ISO 8601 timestamp ở múi giờ Việt Nam (UTC+7) — KHÔNG phụ thuộc
   * timezone của browser (kể cả khi Cloudflare WARP / VPN làm browser
   * báo sai timezone).
   *
   *  Cách làm đúng:
   *    1. Lấy epoch ms (luôn là UTC, không phụ thuộc browser tz)
   *    2. Cộng 7h = moment tương ứng ở UTC+7 wall clock
   *    3. Đọc lại components bằng getUTC* (vì đã shift sang UTC+7)
   *
   *  Cách làm CŨ (BUG):
   *    now.getHours() + 7   ← sai khi browser đã ở UTC+7 (double-shift)
   *
   * @param {Date} [date] - optional Date object, mặc định = now
   * @returns {string} "YYYY-MM-DDTHH:MM:SS" ở UTC+7
   */
  function isoLocal_(date) {
    var now = date || new Date();
    // VN_OFFSET_MS = 7 * 60 * 60 * 1000
    var VN_OFFSET_MS = 25200000;
    var vn = new Date(now.getTime() + VN_OFFSET_MS);
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return vn.getUTCFullYear() + '-' +
           pad(vn.getUTCMonth() + 1) + '-' +
           pad(vn.getUTCDate()) + 'T' +
           pad(vn.getUTCHours()) + ':' +
           pad(vn.getUTCMinutes()) + ':' +
           pad(vn.getUTCSeconds());
  }

  /**
   * Build "YYYY-MM-DD HH:MM:SS" ở UTC+7 — dùng cho cột timestamp (không có T).
   */
  function vnDateTime_(date) {
    var iso = isoLocal_(date);
    return iso.replace('T', ' ');
  }

  // Log init — CHỈ hiện khi DEBUG=true (mặc định tắt ở production để bảo mật)
  // Không in URL/secret ra console ở production.
  if (DEBUG) {
    try {
      console.log(
        '%c [SheetsDirect] %c ' + (ENABLED ? 'enabled' : 'DISABLED') +
        ' / URL: ' + (APEX_SHEETS_WEBAPP_URL ? '[REDACTED]' : 'NOT CONFIGURED') +
        ' / Secret: ' + (APEX_LEADS_SECRET ? '✓' : '✗') +
        ' / Queue: ' + queue.length,
        'background: #0A192F; color: #fff; padding: 2px 6px; border-radius: 3px;',
        'color: #888;'
      );
    } catch (_) {}
  }
})();
