/** 通用 UI 工具：图标、转义、格式化、Toast、Modal。 */

const ICONS = '/assets/icons.svg';
let toastSeq = 0;

export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" aria-hidden="true"><use href="${ICONS}#i-${name}"></use></svg>`;
}

export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function attr(value) {
  return esc(value).replaceAll('`', '&#96;');
}

export function uid(prefix = 'c') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export function fmtNumber(n) {
  const num = Number(n || 0);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('zh-CN');
}

export function fmtSize(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtDate(iso, withTime = true, withSeconds = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).replace('T', ' ').slice(0, withSeconds ? 19 : 16);
  const pad = (v) => String(v).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (!withTime) return date;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}${withSeconds ? `:${pad(d.getSeconds())}` : ''}`;
  return `${date} ${time}`;
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 16);
  const diff = Date.now() - d.getTime();
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 86400 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
  return fmtDate(iso, false);
}

export function fmtPercent(part, total) {
  if (!total) return '—';
  return `${Math.round((part / total) * 100)}%`;
}

export function debounce(fn, delay = 400) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

export function toast(message, type = 'ok', timeout = 3800) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const names = { ok: 'check-circle', error: 'alert', warn: 'alert', info: 'info' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.dataset.toast = String(++toastSeq);
  el.innerHTML = `
    ${icon(names[type] || 'info')}
    <div class="flex-1">${esc(message)}</div>
    <button class="toast-close" type="button" aria-label="关闭">${icon('x', 'icon-sm')}</button>`;
  const remove = () => {
    if (!el.isConnected) return;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 190);
  };
  el.querySelector('.toast-close').addEventListener('click', remove);
  root.appendChild(el);
  while (root.children.length > 4) root.firstElementChild.remove();
  if (timeout > 0) setTimeout(remove, timeout);
}

export function openModal({
  title = '',
  sub = '',
  body = '',
  footer = '',
  size = '',
  flush = false,
  onClose = null,
} = {}) {
  const root = document.getElementById('modal-root');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal ${size}" role="dialog" aria-modal="true" aria-label="${attr(title)}">
      <div class="modal-head">
        <div class="modal-title-wrap">
          <div class="modal-title">${title}</div>
          ${sub ? `<div class="modal-sub">${sub}</div>` : ''}
        </div>
        <button class="icon-btn modal-close" type="button" aria-label="关闭">${icon('x')}</button>
      </div>
      <div class="modal-body ${flush ? 'flush' : ''}">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  root.appendChild(overlay);
  const modal = overlay.querySelector('.modal');
  const previousFocus = document.activeElement;

  const close = () => {
    if (!overlay.isConnected) return;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (previousFocus && previousFocus.focus) {
      try { previousFocus.focus(); } catch (e) { /* ignore */ }
    }
    if (onClose) onClose();
  };

  const focusables = () => Array.from(modal.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((el) => el.offsetParent !== null);

  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'Tab') {
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector('.modal-close').addEventListener('click', close);

  setTimeout(() => {
    const first = modal.querySelector('input:not([type="hidden"]), select, textarea, .modal-foot .btn-primary, .btn-primary');
    if (first) first.focus();
  }, 40);

  return { root: overlay, modal, close, body: overlay.querySelector('.modal-body') };
}

export function confirmDialog({
  title = '确认操作',
  message = '',
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  detail = '',
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      ref.close();
    };
    const ref = openModal({
      title: esc(title),
      size: 'modal-sm',
      body: `<p class="muted" style="font-size:12.5px;line-height:1.75">${message}</p>
             ${detail ? `<div class="mt-14">${detail}</div>` : ''}`,
      footer: `
        <button class="btn btn-secondary" type="button" data-cancel>${esc(cancelText)}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="button" data-confirm>${esc(confirmText)}</button>`,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
    });
    ref.modal.querySelector('[data-cancel]').addEventListener('click', () => finish(false));
    ref.modal.querySelector('[data-confirm]').addEventListener('click', () => finish(true));
  });
}

export function pageHead({ eyebrow = '', title = '', desc = '', actions = '' } = {}) {
  return `
    <div class="page-head">
      <div class="page-head-main">
        ${eyebrow ? `<div class="eyebrow">${eyebrow}</div>` : ''}
        <h1 class="page-title">${title}</h1>
        ${desc ? `<p class="page-desc">${desc}</p>` : ''}
      </div>
      ${actions ? `<div class="page-actions">${actions}</div>` : ''}
    </div>`;
}

export function emptyState({ iconName = 'inbox', title, desc = '', action = '', small = false } = {}) {
  return `
    <div class="empty ${small ? 'small' : ''}">
      <div class="empty-icon">${icon(iconName)}</div>
      <h3>${esc(title)}</h3>
      ${desc ? `<p>${desc}</p>` : ''}
      ${action || ''}
    </div>`;
}

export function withButtonLoading(button, loadingText = '处理中…') {
  if (!button) return () => {};
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spinner spinner-sm"></span>${esc(loadingText)}`;
  return () => {
    button.disabled = false;
    button.innerHTML = original;
  };
}

export function typeName(type) {
  return { auto: '自动', text: '文本', number: '数值', date: '日期' }[type] || '自动';
}

export function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function truncate(text, length = 80) {
  const value = String(text ?? '');
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

export function optionList(items, selected, { placeholder = '请选择' } = {}) {
  const head = placeholder ? `<option value="">${esc(placeholder)}</option>` : '';
  return head + items.map((item) => {
    const value = typeof item === 'object' ? item.value : item;
    const label = typeof item === 'object' ? item.label : item;
    return `<option value="${attr(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(label)}</option>`;
  }).join('');
}

export function skeletonRows(count = 4) {
  return Array.from({ length: count }, () => `
    <div class="card" style="padding:18px;margin-bottom:12px">
      <div class="skeleton skeleton-line" style="width:38%"></div>
      <div class="skeleton skeleton-line" style="width:62%"></div>
      <div class="skeleton skeleton-line" style="width:24%;margin-bottom:0"></div>
    </div>`).join('');
}
