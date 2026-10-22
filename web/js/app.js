/** 应用入口：路由、全局壳层、初始化。 */
import { loadBootstrap, state } from './store.js';
import { esc, icon, openModal, requestExit, toast } from './ui.js';
import dashboardPage from './pages/dashboard.js';
import sourcesPage from './pages/sources.js';
import profilesPage from './pages/profiles.js';
import profilePage from './pages/profile.js';
import comparePage from './pages/compare.js';
import runsPage from './pages/runs.js';
import settingsPage from './pages/settings.js';

const view = document.getElementById('view');
let cleanup = null;
let routeSeq = 0;

const STATIC_ROUTES = {
  '': { page: dashboardPage, nav: 'dashboard', crumb: [{ label: '工作台' }] },
  sources: { page: sourcesPage, nav: 'sources', crumb: [{ label: '工作台', href: '#/' }, { label: '数据源' }] },
  profiles: { page: profilesPage, nav: 'profiles', crumb: [{ label: '工作台', href: '#/' }, { label: '汇总方案' }] },
  compare: { page: comparePage, nav: 'compare', crumb: [{ label: '工作台', href: '#/' }, { label: '数据对比' }] },
  runs: { page: runsPage, nav: 'runs', crumb: [{ label: '工作台', href: '#/' }, { label: '生成记录' }] },
  settings: { page: settingsPage, nav: 'settings', crumb: [{ label: '工作台', href: '#/' }, { label: '设置' }] },
};

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  return { segments, query: new URLSearchParams(queryPart || '') };
}

function setCrumb(items) {
  const el = document.getElementById('breadcrumb');
  if (!el) return;
  el.innerHTML = items.map((item, i) => {
    const isLast = i === items.length - 1;
    const label = isLast
      ? `<span class="current">${esc(item.label)}</span>`
      : `<a href="${item.href || '#/'}">${esc(item.label)}</a>`;
    return `${i > 0 ? `<span class="sep">/</span>` : ''}${label}`;
  }).join('');
  document.title = `${items[items.length - 1]?.label || '工作台'} · 表格汇总助手`;
}

function setActiveNav(nav) {
  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.classList.toggle('active', el.dataset.nav === nav);
  });
}

function closeNav() {
  document.body.classList.remove('nav-open');
}

function navigate(path) {
  if (location.hash === path) route();
  else location.hash = path;
}

function errorView(message, detail = '') {
  view.innerHTML = `
    <div class="card" style="max-width:640px;margin:10vh auto">
      <div class="empty">
        <div class="empty-icon">${icon('alert')}</div>
        <h3>页面没有正常打开</h3>
        <p>${esc(message)}</p>
        ${detail ? `<details style="margin-top:12px;max-width:100%"><summary class="small muted">查看技术细节</summary><pre class="mono" style="white-space:pre-wrap;text-align:left;margin-top:8px">${esc(detail)}</pre></details>` : ''}
        <button class="btn btn-primary" type="button" data-reload>重新加载</button>
      </div>
    </div>`;
  view.querySelector('[data-reload]')?.addEventListener('click', () => location.reload());
}

async function route() {
  closeNav();
  // 快速切页时，先发起的慢渲染可能后完成。用序号把过期结果丢掉，
  // 否则旧页面会覆盖新页面，同时把新页面的 cleanup 冲掉。
  const seq = ++routeSeq;
  const { segments, query } = parseHash();
  let page = null;
  let nav = '';
  let crumb = [];
  let params = {};

  if (segments.length === 0) {
    page = STATIC_ROUTES[''].page;
    nav = 'dashboard';
    crumb = STATIC_ROUTES[''].crumb;
  } else if (segments[0] === 'profiles' && segments.length === 2) {
    page = profilePage;
    nav = 'profiles';
    crumb = [{ label: '工作台', href: '#/' }, { label: '汇总方案', href: '#/profiles' }, { label: '方案编辑' }];
    params = { id: decodeURIComponent(segments[1]) };
  } else if (segments.length === 1 && STATIC_ROUTES[segments[0]]) {
    const conf = STATIC_ROUTES[segments[0]];
    page = conf.page;
    nav = conf.nav;
    crumb = conf.crumb;
  } else {
    page = null;
  }

  if (typeof cleanup === 'function') {
    try { cleanup(); } catch (e) { console.warn(e); }
    cleanup = null;
  }

  setActiveNav(nav);
  setCrumb(crumb);

  if (!page) {
    view.innerHTML = `
      <div class="card" style="max-width:520px;margin:12vh auto">
        <div class="empty">
          <div class="empty-icon">${icon('search')}</div>
          <h3>没有找到这个页面</h3>
          <p>链接可能已经过期，或者地址输入有误。</p>
          <a class="btn btn-primary" href="#/">回到工作台</a>
        </div>
      </div>`;
    return;
  }

  view.innerHTML = `
    <div class="boot-loading" style="min-height:38vh">
      <div class="spinner"></div>
      <p>正在准备页面…</p>
    </div>`;

  try {
    const result = await page.render(view, {
      params,
      query,
      setCrumb,
      navigate,
      setActiveNav,
    });
    if (seq !== routeSeq) {
      // 这次渲染已经过期：它写的 DOM 已被新页面取代，把它申请的清理函数就地执行
      if (typeof result === 'function') {
        try { result(); } catch (e) { console.warn(e); }
      }
      return;
    }
    if (typeof result === 'function') cleanup = result;
    window.scrollTo(0, 0);
  } catch (err) {
    if (seq !== routeSeq) return;
    console.error(err);
    errorView(err?.message || '未知错误', err?.stack || '');
  }
}

function bindShell() {
  const menuBtn = document.getElementById('menu-btn');
  const scrim = document.getElementById('sidebar-scrim');
  menuBtn?.addEventListener('click', () => document.body.classList.toggle('nav-open'));
  scrim?.addEventListener('click', closeNav);
  document.querySelectorAll('.sidebar .nav-item').forEach((item) => {
    item.addEventListener('click', closeNav);
  });

  document.getElementById('help-btn')?.addEventListener('click', () => {
    const help = openModal({
      title: '三步完成一次汇总',
      sub: '所有文件只保存在这台电脑上，不会上传到任何服务器。',
      body: `
        <div class="help-steps">
          <div class="help-step">
            <div class="help-num">01</div>
            <div><strong>把文件放进数据源</strong><p>支持 Excel（.xlsx / .xlsm / .xls）、CSV，以及 Outlook 邮件（.msg / .oft）和 .eml。邮件里的正文表格与附件会自动展开。</p></div>
          </div>
          <div class="help-step">
            <div class="help-num">02</div>
            <div><strong>选定目标表，逐列选择来源</strong><p>可以上传现有的 Excel 模板，也可以新建一张表。为主表选择主键后，每一列都能指定来自哪张表、哪个字段，并设置缺省值。</p></div>
          </div>
          <div class="help-step">
            <div class="help-num">03</div>
            <div><strong>生成、下载、对比</strong><p>生成后直接得到填好的 Excel。下一次汇总可以和历史结果按主键对比，自动标出新增、删除和修改，并导出差异报告。</p></div>
          </div>
        </div>
        <div class="rail-tip mt-18">${icon('shield')}<span>数据目录：${esc(state.app?.data_dir || '本机 data 文件夹')}<br>替换程序升级时，请保留 data 文件夹。</span></div>`,
      footer: `<button class="btn btn-primary" type="button" data-close>知道了</button>`,
    });
    help.modal.querySelector('[data-close]')?.addEventListener('click', help.close);
  });

  document.getElementById('exit-btn')?.addEventListener('click', () => {
    requestExit();
  });

  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeNav();
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error(event.reason);
    if (event.reason?.message) toast(event.reason.message, 'error');
  });
}

async function init() {
  const dateEl = document.getElementById('today-chip');
  if (dateEl) {
    const now = new Date();
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    dateEl.textContent = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 · ${week}`;
  }
  bindShell();
  try {
    await loadBootstrap();
  } catch (err) {
    errorView(err.message || '无法加载本地数据。', '请确认启动窗口仍在运行，然后刷新页面。');
    return;
  }
  await route();
}

init();
