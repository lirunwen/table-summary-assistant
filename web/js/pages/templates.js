/** 数据模板库：列表、搜索筛选、批量维护、新建/上传/导入。 */
import { api } from '../api.js';
import { loadBootstrap } from '../store.js';
import {
  attr, confirmDialog, debounce, download, emptyState, esc, fmtNumber,
  icon, openModal, pageHead, timeAgo, toast, withButtonLoading,
} from '../ui.js';
import { openCreateProfileModal } from '../components.js';

const STATUS_META = {
  active: { label: '使用中', cls: 'badge-brand' },
  draft: { label: '草稿', cls: 'badge-gold' },
  archived: { label: '已归档', cls: 'badge-gray' },
};

function statusBadge(status) {
  const meta = STATUS_META[status] || STATUS_META.active;
  return `<span class="badge ${meta.cls}">${meta.label}</span>`;
}

function tagList(tags, limit = 3) {
  const list = (tags || []).slice(0, limit);
  return list.map((t) => `<span class="tpl-tag">${icon('tag', 'icon-sm')}${esc(t)}</span>`).join('')
    + ((tags || []).length > limit ? `<span class="tpl-tag muted">+${tags.length - limit}</span>` : '');
}

/** 字段预览：只展示前 8 个，其余折叠成 +n。 */
function fieldPreview(fields) {
  const list = (fields || []).slice(0, 8);
  if (!list.length) return '<span class="tiny faint">还没有字段定义</span>';
  return list.map((f) => `
    <span class="tpl-field${f.required ? ' required' : ''}" title="${attr(`${f.name} · ${f.type}`)}">
      ${esc(f.name)}${f.required ? '<i>必填</i>' : ''}
    </span>`).join('')
    + (fields.length > list.length ? `<span class="tpl-field muted">+${fields.length - list.length}</span>` : '');
}

function cardHtml(t, selected) {
  const fields = t.fields || [];
  return `
    <article class="tpl-card${selected ? ' selected' : ''}" data-card="${attr(t.id)}">
      <div class="tpl-card-top">
        <label class="tpl-check" title="选择">
          <input type="checkbox" data-select="${attr(t.id)}" ${selected ? 'checked' : ''}>
        </label>
        <div class="tpl-icon ${t.origin === 'fields' ? 'fields' : 'file'}">
          ${icon(t.origin === 'fields' ? 'table' : 'file-spreadsheet')}
        </div>
        <div class="tpl-head-main">
          <a class="tpl-name" href="#/templates/${encodeURIComponent(t.id)}">${esc(t.name)}</a>
          <div class="tpl-sub">
            ${t.category ? `<span>${esc(t.category)}</span><span class="dot">·</span>` : ''}
            <span>${fmtNumber(t.field_count)} 个字段</span>
            <span class="dot">·</span>
            <span title="当前版本">v${t.version}</span>
          </div>
        </div>
        ${statusBadge(t.status)}
      </div>
      <p class="tpl-desc">${t.description ? esc(t.description) : '<span class="faint">还没有写说明，建议补一句用途，方便同事挑选。</span>'}</p>
      ${(t.tags || []).length ? `<div class="tpl-tagline">${tagList(t.tags, 4)}</div>` : ''}
      <div class="tpl-fields">${fieldPreview(fields)}</div>
      <div class="tpl-card-foot">
        <span class="tpl-ref ${t.ref_count ? 'on' : ''}">
          ${t.ref_count
            ? `${icon('link', 'icon-sm')}被 ${t.ref_count} 个方案引用`
            : `${icon('info', 'icon-sm')}尚未被引用`}
        </span>
        <span class="tiny faint" title="${attr(t.updated_at || '')}">${timeAgo(t.updated_at)}</span>
      </div>
      <div class="tpl-card-actions">
        <a class="btn btn-secondary btn-sm" href="#/templates/${encodeURIComponent(t.id)}">打开 ${icon('arrow-right', 'icon-sm')}</a>
        <button class="btn btn-soft btn-sm" type="button" data-new-profile="${attr(t.id)}" title="用这个模板新建汇总方案">${icon('link')}建方案</button>
        <button class="icon-btn" type="button" data-dup="${attr(t.id)}" title="复制模板" aria-label="复制模板">${icon('copy')}</button>
        <button class="icon-btn" type="button" data-export="${attr(t.id)}" title="导出定义" aria-label="导出定义">${icon('download')}</button>
        <button class="icon-btn danger" type="button" data-del="${attr(t.id)}" title="删除模板" aria-label="删除模板">${icon('trash')}</button>
      </div>
    </article>`;
}

/** 新建模板：名称 + 分类 + 标签 + 字段快速录入。字段类型后面在编辑页精修。 */
function openCreateModal(onCreated, categories = []) {
  const ref = openModal({
    title: '新建数据模板',
    sub: '先定义目标表有哪些列，之后在编辑页补类型、必填和校验规则。',
    size: 'modal-lg',
    body: `
      <div class="form-grid cols-2">
        <div class="field">
          <label class="field-label" for="nt-name">模板名称 <span class="req">*</span></label>
          <input class="input" id="nt-name" maxlength="80" placeholder="例如：人员信息汇总表" autocomplete="off">
        </div>
        <div class="field">
          <label class="field-label" for="nt-category">分类</label>
          <input class="input" id="nt-category" maxlength="40" list="nt-categories" placeholder="例如：人事 / 财务 / 项目">
          <datalist id="nt-categories"></datalist>
        </div>
      </div>
      <div class="field mt-14">
        <label class="field-label" for="nt-tags">标签</label>
        <input class="input" id="nt-tags" maxlength="120" placeholder="用逗号分隔，例如：月度, 人事, 报总部">
        <div class="field-hint">标签用于筛选，最多 8 个。</div>
      </div>
      <div class="field mt-14">
        <label class="field-label" for="nt-desc">说明</label>
        <textarea class="textarea" id="nt-desc" rows="2" maxlength="300" placeholder="这份表给谁用、什么时候用"></textarea>
      </div>
      <div class="field mt-14">
        <label class="field-label" for="nt-fields">字段（一行一个，或逗号分隔）<span class="req">*</span></label>
        <textarea class="textarea mono" id="nt-fields" rows="6" placeholder="员工编号&#10;姓名&#10;职级&#10;入职日期&#10;月薪"></textarea>
        <div class="field-hint">列名顺序就是目标表的列顺序；创建后可在字段表里上下移动或用「字段详情」调整。</div>
      </div>`,
    footer: `
      <button class="btn btn-secondary" type="button" data-cancel>取消</button>
      <button class="btn btn-primary" type="button" data-create>${icon('plus')}创建并编辑</button>`,
  });

  ref.modal.querySelector('#nt-categories').innerHTML =
    categories.map((c) => `<option value="${attr(c.name)}"></option>`).join('');
  ref.modal.querySelector('#nt-name').focus();
  ref.modal.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', ref.close));

  ref.modal.querySelector('[data-create]').addEventListener('click', async (event) => {
    const name = ref.modal.querySelector('#nt-name').value.trim();
    const raw = ref.modal.querySelector('#nt-fields').value;
    const names = raw.split(/[\n,，、;；]+/).map((s) => s.trim()).filter(Boolean);
    if (!name) {
      toast('请填写模板名称。', 'warn');
      ref.modal.querySelector('#nt-name').focus();
      return;
    }
    if (!names.length) {
      toast('至少写一个字段名。', 'warn');
      ref.modal.querySelector('#nt-fields').focus();
      return;
    }
    const seen = new Set();
    const dup = names.find((n) => (seen.has(n) ? true : (seen.add(n), false)));
    if (dup) {
      toast(`字段名「${dup}」重复了。`, 'warn');
      return;
    }
    const restore = withButtonLoading(event.currentTarget, '创建中…');
    try {
      const data = await api.createTemplate({
        name,
        category: ref.modal.querySelector('#nt-category').value.trim(),
        tags: ref.modal.querySelector('#nt-tags').value,
        description: ref.modal.querySelector('#nt-desc').value.trim(),
        fields: names.map((n) => ({ name: n, type: 'auto' })),
      });
      await loadBootstrap();
      ref.close();
      toast(`模板「${name}」已创建。`, 'ok');
      onCreated(data.template);
    } catch (err) {
      toast(err.message, 'error');
      restore();
    }
  });
}

/** 选择文件并上传 Excel 模板。 */
/** 造一个隐藏的 file input 并触发选择；挂到 DOM 上兼容性最好（Safari/Firefox 要求）。 */
function pickFile(accept, onPick) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.style.display = 'none';
  input.dataset.tplPick = '';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (file) onPick(file);
  });
  document.body.appendChild(input);
  input.click();
}

function pickExcelAndUpload(onDone) {
  pickFile('.xlsx,.xlsm,.xltx,.xltm', async (file) => {
    toast('正在解析模板…', 'info', 1500);
    try {
      const data = await api.uploadTemplate(file);
      await loadBootstrap();
      toast(`已导入「${data.template.name}」，共 ${data.template.field_count} 个字段。`, 'ok');
      onDone(data.template);
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

function pickJsonAndImport(onDone) {
  pickFile('.json,application/json', async (file) => {
    try {
      const text = await file.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (err) {
        throw new Error('这个文件不是合法的 JSON。');
      }
      const data = await api.importTemplate(payload);
      await loadBootstrap();
      toast(`已导入模板「${data.template.name}」。`, 'ok');
      onDone(data.template);
    } catch (err) {
      toast(err.message || '导入失败。', 'error');
    }
  });
}

export default {
  nav: 'templates',
  async render(view, ctx) {
    const filters = { q: '', category: '', tag: '', status: 'all', sort: 'updated' };
    const selected = new Set();
    let data = { templates: [], total: 0, categories: [], tags: [], stats: {} };

    view.innerHTML = `
      ${pageHead({
        eyebrow: `${icon('template')}数据模板 · 目标表结构`,
        title: '数据模板',
        desc: '模板定义“目标表长什么样”：有哪些列、每列什么类型、要不要必填、有什么校验规则。汇总方案引用模板，把数据填进这些列。',
        actions: `
          <button class="btn btn-secondary" type="button" data-upload>${icon('upload')}上传 Excel</button>
          <button class="btn btn-secondary" type="button" data-import>${icon('download')}导入定义</button>
          <button class="btn btn-primary" type="button" data-new>${icon('plus')}新建模板</button>`,
      })}
      <div class="tpl-stat-row" data-stats></div>

      <div class="tpl-toolbar card card-pad">
        <div class="tpl-search">
          ${icon('search')}
          <input id="tpl-q" class="input" type="search" placeholder="搜索模板名、字段名、标签…" autocomplete="off">
        </div>
        <div class="segmented" data-status-filter>
          <button type="button" class="active" data-status="all">全部</button>
          <button type="button" data-status="active">使用中</button>
          <button type="button" data-status="draft">草稿</button>
          <button type="button" data-status="archived">已归档</button>
        </div>
        <select class="select select-sm" data-sort style="width:130px">
          <option value="updated">最近更新</option>
          <option value="created">最近创建</option>
          <option value="name">名称 A→Z</option>
          <option value="fields">字段数多→少</option>
          <option value="refs">引用数多→少</option>
        </select>
      </div>

      <div class="tpl-filter-row" data-chips></div>
      <div class="tpl-bulkbar" data-bulkbar hidden>
        <span data-bulk-count></span>
        <div class="flex gap-8">
          <button class="btn btn-secondary btn-sm" type="button" data-bulk-export>${icon('download')}批量导出</button>
          <button class="btn btn-secondary btn-sm" type="button" data-bulk-archive>${icon('folder')}批量归档</button>
          <button class="btn btn-danger btn-sm" type="button" data-bulk-delete>${icon('trash')}批量删除</button>
          <button class="btn btn-ghost btn-sm" type="button" data-bulk-clear>取消选择</button>
        </div>
      </div>
      <div data-grid></div>`;

    const gridEl = view.querySelector('[data-grid]');
    const statsEl = view.querySelector('[data-stats]');
    const chipsEl = view.querySelector('[data-chips]');
    const bulkEl = view.querySelector('[data-bulkbar]');
    const searchEl = view.querySelector('#tpl-q');

    function paintStats() {
      const stats = data.stats || {};
      statsEl.innerHTML = `
        <div class="tpl-stat">
          <span class="tpl-stat-label">模板总数</span>
          <strong>${fmtNumber(stats.total)}</strong>
          <span class="tiny faint">其中 ${fmtNumber(stats.active)} 个使用中</span>
        </div>
        <div class="tpl-stat">
          <span class="tpl-stat-label">字段总数</span>
          <strong>${fmtNumber(stats.fields)}</strong>
          <span class="tiny faint">所有模板的列定义合计</span>
        </div>
        <div class="tpl-stat">
          <span class="tpl-stat-label">被方案引用</span>
          <strong>${fmtNumber(stats.referenced)}</strong>
          <span class="tiny faint">删除前需要先解绑</span>
        </div>
        <div class="tpl-stat">
          <span class="tpl-stat-label">分类</span>
          <strong>${fmtNumber((data.categories || []).length)}</strong>
          <span class="tiny faint">用分类和标签归类</span>
        </div>`;
    }

    function paintChips() {
      const cats = data.categories || [];
      const tags = data.tags || [];
      if (!cats.length && !tags.length) {
        chipsEl.innerHTML = '';
        return;
      }
      chipsEl.innerHTML = `
        ${cats.length ? `
          <div class="tpl-filter-group">
            <span class="tpl-filter-label">${icon('grid', 'icon-sm')}分类</span>
            <button class="chip chip-filter ${filters.category ? '' : 'on'}" type="button" data-cat="">全部</button>
            ${cats.map((c) => `<button class="chip chip-filter ${filters.category === c.name ? 'on' : ''}" type="button" data-cat="${attr(c.name)}">${esc(c.name)}<i>${c.count}</i></button>`).join('')}
          </div>` : ''}
        ${tags.length ? `
          <div class="tpl-filter-group">
            <span class="tpl-filter-label">${icon('tag', 'icon-sm')}标签</span>
            <button class="chip chip-filter ${filters.tag ? '' : 'on'}" type="button" data-tag="">全部</button>
            ${tags.slice(0, 14).map((t) => `<button class="chip chip-filter ${filters.tag === t.name ? 'on' : ''}" type="button" data-tag="${attr(t.name)}">${esc(t.name)}<i>${t.count}</i></button>`).join('')}
          </div>` : ''}`;

      chipsEl.querySelectorAll('[data-cat]').forEach((btn) => btn.addEventListener('click', () => {
        filters.category = btn.dataset.cat;
        load();
      }));
      chipsEl.querySelectorAll('[data-tag]').forEach((btn) => btn.addEventListener('click', () => {
        filters.tag = btn.dataset.tag;
        load();
      }));
    }

    function paintGrid() {
      const list = data.templates || [];
      if (!list.length) {
        const filtered = filters.q || filters.category || filters.tag || filters.status !== 'all';
        gridEl.innerHTML = `<div class="card">${emptyState({
          iconName: 'template',
          title: filtered ? '没有符合条件的模板' : '还没有数据模板',
          desc: filtered
            ? '换个关键词，或清空筛选条件再看看。'
            : '模板是目标表的“结构契约”：先定义字段，汇总方案就能按这些字段去匹配数据。可以从空白字段开始，也可以上传现成的 Excel 表头。',
          action: filtered
            ? `<button class="btn btn-secondary" type="button" data-clear-filters>${icon('refresh')}清空筛选</button>`
            : `<div class="flex gap-10 justify-center flex-wrap">
                 <button class="btn btn-primary" type="button" data-new>${icon('plus')}新建模板</button>
                 <button class="btn btn-secondary" type="button" data-upload>${icon('upload')}上传 Excel 模板</button>
               </div>`,
        })}</div>`;
        gridEl.querySelector('[data-clear-filters]')?.addEventListener('click', () => {
          Object.assign(filters, { q: '', category: '', tag: '', status: 'all' });
          searchEl.value = '';
          view.querySelectorAll('[data-status-filter] button').forEach((b) => {
            b.classList.toggle('active', b.dataset.status === 'all');
          });
          load();
        });
        gridEl.querySelector('[data-new]')?.addEventListener('click', openCreate);
        gridEl.querySelector('[data-upload]')?.addEventListener('click', () => pickExcelAndUpload(goEditor));
        return;
      }
      gridEl.innerHTML = `<div class="tpl-grid">${list.map((t) => cardHtml(t, selected.has(t.id))).join('')}</div>`;
      gridEl.querySelectorAll('[data-select]').forEach((box) => box.addEventListener('change', () => {
        if (box.checked) selected.add(box.dataset.select);
        else selected.delete(box.dataset.select);
        syncBulk();
        box.closest('.tpl-card')?.classList.toggle('selected', box.checked);
      }));
    }

    function syncBulk() {
      bulkEl.hidden = selected.size === 0;
      bulkEl.querySelector('[data-bulk-count]').textContent = `已选择 ${selected.size} 个模板`;
    }

    function paint() {
      paintStats();
      paintChips();
      paintGrid();
      syncBulk();
    }

    async function load() {
      try {
        data = await api.listTemplates(filters);
        // 选中的项可能已被筛掉，但保留选择更符合预期（批量删除前会再确认）
        paint();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    const goEditor = (template) => ctx.navigate(`#/templates/${template.id}`);

    function openCreate() {
      openCreateModal(goEditor, data.categories || []);
    }

    // ---- 事件 ---------------------------------------------------------
    view.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', openCreate));
    view.querySelectorAll('[data-upload]').forEach((b) => b.addEventListener('click', () => pickExcelAndUpload(goEditor)));
    view.querySelectorAll('[data-import]').forEach((b) => b.addEventListener('click', () => pickJsonAndImport(goEditor)));

    searchEl.addEventListener('input', debounce(() => {
      filters.q = searchEl.value.trim();
      load();
    }, 260));

    view.querySelectorAll('[data-status-filter] button').forEach((btn) => btn.addEventListener('click', () => {
      filters.status = btn.dataset.status;
      view.querySelectorAll('[data-status-filter] button').forEach((b) => b.classList.toggle('active', b === btn));
      load();
    }));

    view.querySelector('[data-sort]').addEventListener('change', (e) => {
      filters.sort = e.target.value;
      load();
    });

    view.querySelector('[data-bulk-clear]').addEventListener('click', () => {
      selected.clear();
      paintGrid();
      syncBulk();
    });

    view.querySelector('[data-bulk-export]').addEventListener('click', async () => {
      const ids = [...selected];
      for (const id of ids) {
        download(api.templateExportUrl(id));
        // 连续触发下载时给浏览器一点间隔，避免被拦截
        await new Promise((r) => setTimeout(r, 380));
      }
      toast(`已导出 ${ids.length} 个模板定义。`, 'ok');
    });

    view.querySelector('[data-bulk-archive]').addEventListener('click', async () => {
      const ids = [...selected].filter((id) => (data.templates.find((t) => t.id === id)?.status || 'active') !== 'archived');
      if (!ids.length) {
        toast('选中的模板都已经是归档状态。', 'info');
        return;
      }
      const ok = await confirmDialog({
        title: '归档选中的模板',
        message: `将把 ${ids.length} 个模板标记为「已归档」。归档只是标记，不会影响正在使用它们的方案。`,
        confirmText: '归档',
      });
      if (!ok) return;
      for (const id of ids) {
        try {
          await api.updateTemplate(id, { status: 'archived' });
        } catch (err) {
          toast(err.message, 'error');
          return;
        }
      }
      await loadBootstrap();
      selected.clear();
      await load();
      toast(`已归档 ${ids.length} 个模板。`, 'ok');
    });

    view.querySelector('[data-bulk-delete]').addEventListener('click', async () => {
      const ids = [...selected];
      if (!ids.length) return;
      const ok = await confirmDialog({
        title: `删除 ${ids.length} 个模板`,
        message: '确定删除选中的模板吗？被方案引用的模板会被自动跳过。',
        detail: `<div class="warning-note">${icon('alert')}<span>模板文件与版本历史会一起删除，此操作不可撤销。</span></div>`,
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      let done = 0;
      const skipped = [];
      for (const id of ids) {
        try {
          await api.deleteTemplate(id);
          done += 1;
        } catch (err) {
          skipped.push(data.templates.find((t) => t.id === id)?.name || id);
        }
      }
      await loadBootstrap();
      selected.clear();
      await load();
      if (skipped.length) {
        toast(`已删除 ${done} 个；${skipped.length} 个因被方案引用而跳过：${skipped.slice(0, 3).join('、')}`, 'warn', 6000);
      } else {
        toast(`已删除 ${done} 个模板。`, 'ok');
      }
    });

    // 卡片上的操作（事件委托）
    view.onclick = async (event) => {
      const makeProfile = event.target.closest('[data-new-profile]');
      if (makeProfile) {
        // 从模板直接开一个方案：省掉「先进方案列表 → 新建 → 选模板」三步
        openCreateProfileModal({
          templateId: makeProfile.dataset.newProfile,
          onCreated: (profile) => { location.hash = `#/profiles/${encodeURIComponent(profile.id)}`; },
        });
        return;
      }
      const dup = event.target.closest('[data-dup]');
      if (dup) {
        try {
          const res = await api.duplicateTemplate(dup.dataset.dup);
          await loadBootstrap();
          toast(`已复制为「${res.template.name}」。`, 'ok');
          await load();
        } catch (err) {
          toast(err.message, 'error');
        }
        return;
      }
      const exp = event.target.closest('[data-export]');
      if (exp) {
        download(api.templateExportUrl(exp.dataset.export));
        return;
      }
      const del = event.target.closest('[data-del]');
      if (del) {
        const id = del.dataset.del;
        const item = data.templates.find((t) => t.id === id);
        if (!item) return;
        const ok = await confirmDialog({
          title: '删除数据模板',
          message: `确定删除「${esc(item.name)}」吗？`,
          detail: item.ref_count
            ? `<div class="warning-note">${icon('alert')}<span>还有 ${item.ref_count} 个汇总方案在用它。删除后这些方案的目标表会失效，需要重新选择模板。</span></div>`
            : `<div class="warning-note">${icon('alert')}<span>模板文件与版本历史会一起删除，此操作不可撤销。</span></div>`,
          confirmText: '删除模板',
          danger: true,
        });
        if (!ok) return;
        try {
          await api.deleteTemplate(id, item.ref_count > 0);
        } catch (err) {
          toast(err.message, 'error');
          return;
        }
        selected.delete(id);
        await loadBootstrap();
        await load();
        toast('模板已删除。', 'ok');
      }
    };

    paint();
    await load();
    // 首次进入且没有模板时，把注意力放到「新建」上更合理
    if (!data.templates.length) view.querySelector('[data-new]')?.focus();

    return () => {
      view.onclick = null;
    };
  },
};
