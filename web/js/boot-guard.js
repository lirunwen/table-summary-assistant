/**
 * 启动兜底：模块加载失败时不要把页面停在空白状态。
 *
 * 这段逻辑原来写在 index.html 的内联 <script> 里，为了能启用严格的
 * Content-Security-Policy（script-src 'self'）搬到了独立文件。
 */
(function () {
  'use strict';

  function render(detail) {
    var view = document.getElementById('view');
    if (!view) return;
    var safe = String(detail).replace(/[<>&"]/g, '');
    view.innerHTML =
      '<div style="max-width:640px;margin:10vh auto;padding:24px;background:#fff;border:1px solid #e3e9e5;border-radius:16px;font-family:sans-serif">' +
      '<h2 style="margin:0 0 8px;font-size:18px">界面脚本没有正常加载</h2>' +
      '<p style="color:#728078;font-size:13px">' + safe + '</p>' +
      '<button type="button" data-boot-reload style="margin-top:12px;padding:9px 14px;border:0;border-radius:8px;background:#0e6b5c;color:#fff">重新加载</button>' +
      '</div>';
    var btn = view.querySelector('[data-boot-reload]');
    if (btn) btn.addEventListener('click', function () { location.reload(); });
    document.title = '加载失败 · 表格汇总助手';
  }

  window.addEventListener('error', function (event) {
    var target = event.target;
    var detail = event.message ||
      (target && target.src ? '资源加载失败：' + target.src : '脚本执行失败');
    render(detail);
  }, true);
})();
