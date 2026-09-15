/* ============================================
   APEX FINTECH - TRACKER.JS — CHIASEV1.2 (frontend-only)
   Không backend PHP. Tracking chỉ chạy trong console + buffer localStorage.

   - Đệm events vào window.ApexTracker.__buf[]
   - trackEvent() trong main.js vẫn gọi được window.ApexTracker.send()
   - Không còn POST sang /api/track.php
   ============================================ */

(function(){
  'use strict';

  var MAX_BUFFER = 200;
  var buffer = [];

  window.ApexTracker = {
    /**
     * Public API giữ signature cũ — push event vào buffer.
     * @param {string} type
     * @param {string=} value
     */
    send: function(type, value){
      if (!type) return;
      var ev = { t: Date.now(), type: String(type).slice(0, 40) };
      if (value !== undefined && value !== null) {
        ev.v = String(value).slice(0, 200);
      }
      buffer.push(ev);
      if (buffer.length > MAX_BUFFER) buffer.shift();
      try { console.log('[ApexTracker]', ev.type, ev.v || ''); } catch(_) {}
    },
    flush: function(){ /* no-op: không gửi đi đâu */ },
    isBot: false,
    isWhitelistedBot: false,
    sessionId: '',
    __buf: buffer
  };

})();
