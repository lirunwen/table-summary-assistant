/** 数据源库：上传、预览、调整表头、删除。 */
import { api } from '../api.js';
import { state, loadBootstrap, sourceKind } from '../store.js';
import {
  attr, confirmDialog, emptyState, esc, fmtDate, fmtNumber, fmtSize, icon,
  openModal, pageHead, toast, withButtonLoading,
} from '../ui.js';

let filter = 'all';
let uploading = false;

const EXT = ['xlsx', 'xlsm', 'xls', 'csv', 'txt', 'tsv', 'msg', 'oft', 'eml'];

function totalRows(source) {
  const own = (source.meta?.tables || []).reduce((sum, t) => sum + (t.row_count || 0), 0);
  const children = (source.children || []).reduce((sum, child) => sum + totalRows(child), 0);
  return own + children;
}

function totalTables(source) {
  return (source.meta?.tables || []).length
    + (source.children || []).reduce((sum, child) => sum + totalTables(child), 0);
}

function tableChips(source) {
  const tables = source.meta?.tables || [];
  if (!tables.length) return '<span class="chip chip-gold">未识别到数据表</span>';
  const shown = tables.slice(0, 5);
  return shown.map((table) => `
    <button class="table-chip" type="button" data-preview-table="${attr(table.id)}" data-source="${attr(source.id)}">
      ${icon('table')}${esc(table.label)}
      <span class="rows">${fmtNumber(table.row_count)} 行</span>
    </button>`).join('') + (tables.length > 5 ? `<span class="table-chip more">+${tables.length - 5} 张</span>` : '');
}

function childRows(source) {
  const children = source.children || [];
  if (!children.length) return '';
  return `<div class="child-list">${children.map((child) => {
    const meta = sourceKind(child);
    return `<div class="child-row">
      ${icon(meta.icon)}
      <span class="name" title="${attr(child.name)}">${esc(child.name)}</span>
      ${(child.meta?.tables || []).map((table) => `
        <button class="table-chip" type="button" data-preview-table="${attr(table.id)}" data-source="${attr(child.id)}">
          ${esc(table.label)} <span class="rows">${fmtNumber(table.row_count)} 行</span>
        </button>`).join('')}
      <button class="icon-btn" type="button" data-delete-source="${attr(child.id)}" title="删除附件" aria-label="删除附件">${icon('trash', 'icon-sm')}</button>
    </div>`;
  }).join('')}</div>`;
}

function sourceCard(source) {
  const meta = sourceKind(source);
  const tables = source.meta?.tables || [];
  const email = source.meta?.email;
  const warnings = source.meta?.warnings || [];
  return `
    <article class="source-card" data-kind="${attr(source.kind)}">
      <div class="source-top">
        <div class="file-badge ${meta.cls}">${icon(meta.icon)}</div>
        <div class="flex-1" style="min-width:0">
          <div class="source-name" title="${attr(source.name)}">${esc(source.name)}</div>
          <div class="source-sub">
            ${esc(meta.label)} · ${fmtSize(source.size)} · ${fmtDate(source.created_at)}
          </div>
          ${email ? `<div class="source-sub truncate" title="${attr(email.subject || '')}">${esc(email.subject || '')}${email.sender ? ` · ${esc(email.sender)}` : ''}</div>` : ''}
        </div>
        <div class="source-actions">
          ${tables.length ? `<button class="icon-btn" type="button" data-preview-table="${attr(tables[0].id)}" data-source="${attr(source.id)}" title="预览数据" aria-label="预览数据">${icon('eye')}</button>` : ''}
          <button class="icon-btn danger" type="button" data-delete-source="${attr(source.id)}" title="删除数据源" aria-label="删除数据源">${icon('trash')}</button>
        </div>
      </div>
      ${tables.length ? `<div class="source-tables">${tableChips(source)}</div>` : ''}
      ${childRows(source)}
      ${warnings.length ? `<div class="warning-note">${icon('alert')}<span>${warnings.map((w) => esc(w)).join('<br>')}</span></div>` : ''}
      <div class="source-foot">
        <span class="filename">${totalTables(source) ? `${totalTables(source)} 张数据表` : '无可用数据表'} · 共 ${fmtNumber(totalRows(source))} 行</span>
        <span class="flex-1"></span>
        ${source.children?.length ? `<span class="chip">${icon('paperclip')}${source.children.length} 个附件</span>` : ''}
      </div>
    </article>`;
}

function openPreview(sourceId, tableId) {
  const source = findSource(sourceId);
  if (!source) return;
  const tables = (source.meta?.tables || []).filter((t) => t.id);
  let activeId = tableId || tables[0]?.id;
  const ref = openModal({
    title: esc(source.name),
    sub: `${esc(sourceKind(source).label)} · 预览与表头设置`,
    size: 'modal-xl',
    body: `<div data-preview-body>${loadingPreview()}</div>`,
    footer: `<span class="left">预览最多显示 30 行，实际汇总会读取全部数据。</span>
             <button class="btn btn-secondary" type="button" data-close>关闭</button>`,
  });
  ref.modal.querySelector('[data-close]').addEventListener('click', ref.close);

  const body = ref.modal.querySelector('[data-preview-body]');

  async function load(id) {
    activeId = id;
    body.innerHTML = loadingPreview();
    let data;
    try {
      data = await api.tablePreview(id, 30);
    } catch (err) {
      body.innerHTML = `<div class="empty small"><div class="empty-icon">${icon('alert')}</div><h3>无法读取这张表</h3><p>${esc(err.message)}</p></div>`;
      return;
    }
    const current = findSource(sourceId)?.meta?.tables?.find((t) => t.id === id) || data;
    const tabs = tables.length > 1 ? `<div class="sheet-tabs">${tables.map((t) => `
      <button class="sheet-tab ${t.id === activeId ? 'active' : ''}" type="button" data-tab="${attr(t.id)}">
        ${esc(t.label)} <span class="faint">${fmtNumber(t.row_count)}</span>
      </button>`).join('')}</div>` : '';
    const header = data.headers.map((h) => `<th>${esc(h)}</th>`).join('');
    const rows = data.rows.map((row) => `<tr>${row.map((cell) => {
      const text = cell === null || cell === undefined || cell === '' ? '—' : String(cell);
      return `<td><div class="preview-cell" title="${attr(text)}">${cell === null || cell === undefined || cell === '' ? '<span class="faint">—</span>' : esc(text)}</div></td>`;
    }).join('')}</tr>`).join('');
    body.innerHTML = `
      ${tabs}
      <div class="preview-meta">
        <span class="chip chip-brand">${icon('rows')}${fmtNumber(data.row_count)} 行</span>
        <span class="chip">${icon('columns')}${fmtNumber(data.headers.length)} 列</span>
        <span class="chip">${icon('file-spreadsheet')}${esc(current.label)}</span>
        <span class="flex-1"></span>
        <label class="small muted" for="header-row-input">表头所在行</label>
        <input class="input input-sm" id="header-row-input" type="number" min="1" max="50" value="${data.header_row || 1}" style="width:64px;text-align:center">
        <button class="btn btn-secondary btn-sm" type="button" data-apply-header>应用</button>
      </div>
      ${data.headers.length ? `
        <div class="preview-scroll">
          <table class="table compact">
            <thead><tr>${header}</tr></thead>
            <tbody>${rows || `<tr><td colspan="${Math.max(1, data.headers.length)}"><span class="faint">这张表没有数据行。</span></td></tr>`}</tbody>
          </table>
        </div>` : `<div class="empty small"><div class="empty-icon">${icon('table')}</div><h3>没有可用列</h3><p>请调整表头行，或检查文件内容。</p></div>`}
      <div class="table-scroll-note">${data.truncated ? '源文件行数超过 20 万行，汇总时只读取前 20 万行。' : `预览前 ${fmtNumber(data.shown)} 行，共 ${fmtNumber(data.row_count)} 行。`}</div>`;

    body.querySelectorAll('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => load(btn.dataset.tab));
    });
    body.querySelector('[data-apply-header]')?.addEventListener('click', async (event) => {
      const applyButton = event.currentTarget;
      const input = body.querySelector('#header-row-input');
      const value = Number(input.value);
      if (!Number.isInteger(value) || value < 1 || value > 50) {
        toast('表头行号需在 1–50 之间。', 'warn');
        return;
      }
      const restore = withButtonLoading(applyButton, '应用中…');
      try {
        await api.patchSource(sourceId, { table_id: activeId, header_row: value });
        await loadBootstrap();
        const updatedTabs = (findSource(sourceId)?.meta?.tables || []).filter((t) => t.id);
        tables.splice(0, tables.length, ...updatedTabs);
        await load(activeId);
        toast('表头行已更新，字段映射会按列位置重新读取。', 'ok');
      } catch (err) {
        toast(err.message, 'error');
        restore();
      }
    });
  }

  load(activeId);
  return ref;
}

function loadingPreview() {
  return `<div style="padding:20px 0">${Array.from({ length: 4 }, () => `<div class="skeleton skeleton-line" style="width:${50 + Math.random() * 40}%"></div>`).join('')}</div>`;
}

function findSource(id) {
  for (const source of state.sources) {
    if (source.id === id) return source;
    const child = (source.children || []).find((c) => c.id === id);
    if (child) return child;
  }
  return null;
}

async function removeSource(id, name) {
  const source = findSource(id);
  const childCount = source?.children?.length || 0;
  const ok = await confirmDialog({
    title: '删除数据源',
    message: `确定删除「${esc(name)}」吗？文件、已解析的表格都会从本机删除。`,
    detail: childCount ? `<div class="warning-note">${icon('alert')}<span>这封邮件还包含 ${childCount} 个附件数据源，会一起删除。</span></div>` : '',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteSource(id);
    await loadBootstrap();
    toast('数据源已删除。', 'ok');
    await renderPage();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function sourceMatchesFilter(source) {
  if (filter === 'all') return true;
  if (filter === 'email') return source.kind === 'email';
  if (filter === 'excel') return ['excel', 'xls'].includes(source.kind);
  if (filter === 'csv') return source.kind === 'csv';
  return true;
}

let viewRef = null;
let ctxRef = null;

async function renderPage() {
  if (!viewRef) return;
  const sources = state.sources || [];
  const filtered = sources.filter(sourceMatchesFilter);
  const counts = {
    all: sources.length,
    excel: sources.filter((s) => ['excel', 'xls'].includes(s.kind)).length,
    email: sources.filter((s) => s.kind === 'email').length,
    csv: sources.filter((s) => s.kind === 'csv').length,
  };
  const tableCount = sources.reduce((sum, s) => sum + totalTables(s), 0);

  viewRef.innerHTML = `
    ${pageHead({
      eyebrow: `${icon('database')}数据文件管理`,
      title: '数据源',
      desc: '把要参与汇总的文件放在这里。支持 Excel、CSV、Outlook 邮件与附件；系统会自动识别工作表、表头和行数。',
      actions: `
        <button class="btn btn-secondary" type="button" data-upload-trigger>${icon('upload')}选择文件</button>
        <button class="btn btn-primary" type="button" data-upload-trigger>${icon('plus')}上传数据</button>`,
    })}
    <div class="card upload-card" id="upload-card">
      <div class="dropzone" id="dropzone" role="button" tabindex="0">
        <div class="dropzone-icon">${icon('upload-cloud')}</div>
        <div class="dropzone-main">
          <strong>拖拽文件到这里，或点击选择</strong>
          <p>Excel（.xlsx / .xlsm / .xls）、CSV、Outlook 邮件（.msg / .oft）、.eml。邮件正文表格与附件会自动展开，单个文件最大 100 MB。</p>
        </div>
        <div class="dropzone-side">
          ${uploading
            ? `<span class="inline-loading"><span class="spinner spinner-sm"></span>正在解析文件…</span>`
            : `<span class="chip">${icon('shield')}仅本机</span><button class="btn btn-secondary" type="button" data-upload-trigger>浏览文件</button>`}
        </div>
      </div>
      <input type="file" id="file-input" multiple hidden accept=".xlsx,.xlsm,.xls,.csv,.txt,.tsv,.msg,.oft,.eml">
      <div class="uploading-bar ${uploading ? '' : 'hidden'}" id="uploading-bar">
        <span class="spinner spinner-sm"></span>
        <span>正在上传并解析，较大的工作簿可能需要几秒钟…</span>
      </div>
    </div>

    <div class="filter-row">
      <div class="segmented" data-filter-group>
        <button type="button" data-filter="all" class="${filter === 'all' ? 'active' : ''}">全部 <span class="count">${counts.all}</span></button>
        <button type="button" data-filter="excel" class="${filter === 'excel' ? 'active' : ''}">Excel <span class="count">${counts.excel}</span></button>
        <button type="button" data-filter="email" class="${filter === 'email' ? 'active' : ''}">邮件 <span class="count">${counts.email}</span></button>
        <button type="button" data-filter="csv" class="${filter === 'csv' ? 'active' : ''}">CSV <span class="count">${counts.csv}</span></button>
      </div>
      <div class="small muted">${sources.length} 个文件 · ${tableCount} 张数据表</div>
    </div>

    ${filtered.length
      ? `<div class="source-grid">${filtered.map(sourceCard).join('')}</div>`
      : (sources.length
        ? `<div class="card">${emptyState({ iconName: 'filter', title: '这个分类下还没有文件', desc: '切换到「全部」看看，或者上传新的数据文件。', small: true })}</div>`
        : `<div class="card">${emptyState({
          iconName: 'inbox',
          title: '数据源还是空的',
          desc: '先上传员工名单、业务台账、考勤表或邮件附件。上传后可以直接预览表头和前 30 行数据，确认无误再开始映射。',
          action: `<button class="btn btn-primary" type="button" data-upload-trigger>${icon('upload-cloud')}上传第一份文件</button>`,
        })}</div>`)}`;

  if (ctxRef?.query?.get('upload') === '1') {
    setTimeout(() => {
      const zone = viewRef.querySelector('#dropzone');
      zone?.classList.add('dragging');
      zone?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => zone?.classList.remove('dragging'), 1600);
    }, 250);
  }

  bindEvents();
}

function bindEvents() {
  const input = viewRef.querySelector('#file-input');
  const dropzone = viewRef.querySelector('#dropzone');

  const trigger = () => {
    if (uploading) return;
    input.value = '';
    input.click();
  };
  viewRef.querySelectorAll('[data-upload-trigger]').forEach((btn) => btn.addEventListener('click', trigger));
  dropzone?.addEventListener('click', (e) => {
    if (e.target.closest('[data-upload-trigger]')) return;
    trigger();
  });
  dropzone?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger(); }
  });
  input?.addEventListener('change', () => {
    if (input.files?.length) uploadFiles(input.files);
  });
  ['dragenter', 'dragover'].forEach((name) => {
    dropzone?.addEventListener(name, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragging');
    });
  });
  ['dragleave', 'drop'].forEach((name) => {
    dropzone?.addEventListener(name, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragging');
    });
  });
  dropzone?.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) uploadFiles(files);
  });

  viewRef.querySelectorAll('[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      filter = btn.dataset.filter;
      renderPage();
    });
  });

  viewRef.querySelectorAll('[data-preview-table]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPreview(btn.dataset.source, btn.dataset.previewTable);
    });
  });
  viewRef.querySelectorAll('[data-delete-source]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const source = findSource(btn.dataset.deleteSource);
      await removeSource(btn.dataset.deleteSource, source?.name || '这个数据源');
    });
  });
}

async function uploadFiles(files) {
  if (uploading) return;
  const accepted = [];
  const rejected = [];
  for (const file of files) {
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    if (!EXT.includes(ext)) rejected.push(file.name);
    else accepted.push(file);
  }
  if (rejected.length) {
    toast(`暂不支持：${rejected.join('、')}。请上传 Excel、CSV 或邮件文件。`, 'warn', 5200);
  }
  if (!accepted.length) return;
  uploading = true;
  await renderPage();
  try {
    const data = await api.uploadSources(accepted);
    await loadBootstrap();
    if (data.errors?.length) {
      data.errors.forEach((msg) => toast(msg, 'error', 6500));
    }
    if (data.created?.length) {
      const first = data.created[0];
      filter = 'all';
      toast(`已接入 ${data.created.length} 个数据源。`, 'ok');
      if (data.created.length === 1 && first.meta?.tables?.length) {
        uploading = false;
        await renderPage();
        openPreview(first.id, first.meta.tables[0].id);
        return;
      }
    }
  } catch (err) {
    toast(err.message, 'error', 6000);
  } finally {
    uploading = false;
    await renderPage();
  }
}

export default {
  nav: 'sources',
  async render(view, ctx) {
    viewRef = view;
    ctxRef = ctx;
    await renderPage();
    return () => {
      viewRef = null;
      ctxRef = null;
    };
  },
};
