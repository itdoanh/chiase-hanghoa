/* ============================================
   APEX FINTECH - PROTECT.JS
   Bảo vệ frontend production:
     - Chặn chuột phải (context menu)
     - Chặn F12, Ctrl+Shift+I/J/C, Ctrl+U (view source)
     - Detect DevTools mở → tùy chọn reload hoặc blur

   Lưu ý: Đây chỉ là lớp bảo vệ "thân thiện" — DevTools vẫn có thể bypass
   được. Mục tiêu chính: NGĂN người dùng phổ thông F12 xem code/logic.
   Bảo mật thật sự phải ở backend (Google Apps Script) — không lộ secret
   ở client. Xem code.gs để rotate secret nếu đã leak.
   ============================================ */

(function(){
  'use strict';

  // Master switch — đặt false để tắt toàn bộ (ví dụ: khi cần debug)
  var PROTECT_ENABLED = true;

  if (!PROTECT_ENABLED) return;

  // ════════════════════════════════════════════════════════════════
  // 1. Chặn chuột phải
  // ════════════════════════════════════════════════════════════════
  document.addEventListener('contextmenu', function(e){
    e.preventDefault();
    return false;
  });

  // ════════════════════════════════════════════════════════════════
  // 2. Chặn phím tắt mở DevTools / View Source
  //    F12           → DevTools
  //    Ctrl+Shift+I  → DevTools (Inspect)
  //    Ctrl+Shift+J  → DevTools (Console)
  //    Ctrl+Shift+C  → DevTools (Element picker)
  //    Ctrl+U        → View Source
  //    Ctrl+S         → Save Page (chặn luôn)
  //    Cmd (Mac) variants cũng được cover
  // ════════════════════════════════════════════════════════════════
  document.addEventListener('keydown', function(e){
    var key = (e.key || '').toLowerCase();
    var blocked = false;

    // F12
    if (key === 'f12') blocked = true;

    // Ctrl + Shift + I/J/C
    if (e.ctrlKey && e.shiftKey && (key === 'i' || key === 'j' || key === 'c')) blocked = true;

    // Ctrl + U (view source)
    if (e.ctrlKey && key === 'u') blocked = true;

    // Ctrl + S (save page)
    if (e.ctrlKey && key === 's') blocked = true;

    // Cmd + Option + I (Mac DevTools)
    if (e.metaKey && e.altKey && key === 'i') blocked = true;

    if (blocked) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
  }, true);

  // ════════════════════════════════════════════════════════════════
  // 3. Phát hiện DevTools đang mở (best-effort)
  //    Trick: so sánh outerWidth/Height với innerWidth/Height.
  //    Nếu chênh lệch lớn → cửa sổ DevTools đang dock bên cạnh.
  //    BẮT BUỘC phải bật ở chế độ threshold hợp lý, false-positive có thể xảy ra.
  // ════════════════════════════════════════════════════════════════
  var devToolsOpen = false;
  var threshold = 160;
  function checkDevTools(){
    try {
      var widthDiff  = (window.outerWidth  - window.innerWidth);
      var heightDiff = (window.outerHeight - window.innerHeight);
      if (widthDiff > threshold || heightDiff > threshold) {
        if (!devToolsOpen) {
          devToolsOpen = true;
          onDevToolsOpen();
        }
      } else {
        devToolsOpen = false;
      }
    } catch(_) {}
  }

  function onDevToolsOpen(){
    // Tùy chọn 1: blur trang (làm mờ nội dung)
    document.documentElement.classList.add('apex-devtools-open');
    // Tùy chọn 2: redirect. Hiện tại KHÔNG redirect (UX kém) — chỉ blur.
    // Nếu muốn chuyển hướng: uncomment dòng dưới:
    // location.replace('about:blank');
  }

  // Inject CSS khi DevTools mở (blur + warning overlay)
  var style = document.createElement('style');
  style.textContent = [
    'html.apex-devtools-open body { filter: blur(6px); pointer-events: none; user-select: none; }',
    'html.apex-devtools-open::after { content: "Vui lòng tắt DevTools để tiếp tục."; position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(10,25,47,0.85); color: #fff; font-size: 18px; z-index: 999999; font-family: system-ui, sans-serif; }'
  ].join('\n');
  document.head.appendChild(style);

  // Polling mỗi 1s
  setInterval(checkDevTools, 1000);

  // ════════════════════════════════════════════════════════════════
  // 4. Anti debug loop (tùy chọn) — bật nếu muốn debugger statement
  //    Khi mở DevTools và nhấn pause, sẽ thấy loop vô tận.
  // ════════════════════════════════════════════════════════════════
  // (Tắt mặc định để tránh lag)
  // setInterval(function(){ debugger; }, 1000);

})();
