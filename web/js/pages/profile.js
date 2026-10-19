/** 汇总方案编辑器：数据来源、目标表、逐列映射、运行。 */
import { api } from '../api.js';
import {
  applyTemplateToTarget, columnsFromSheet, modeLabel,
  openRunDetail, sourceTableOptions,
} from '../components.js';
import {
  activeTableIds, allTables, includedColumns, loadBootstrap,
  normalizeConfig, state, tableHeaders, tableLabel, templateById,
} from '../store.js';
import {
  attr, confirmDialog, emptyState, esc, fmtDate, fmtNumber,
  icon, openModal, timeAgo, toast, typeName, uid, withButtonLoading,
} from '../ui.js';

const TRANSFORMS = [
  ['direct', '保持原值'],
  ['trim', '去除首尾空格'],
  ['text', '转为文本'],
  ['number', '转为数值'],
  ['date', '统一为日期'],
  ['upper', '转为大写'],
  ['lower', '转为小写'],
];

export default {
  nav: 'profiles',
  async render(view, ctx) {
    const sourceProfile = state.profiles.find((p) => p.id === ctx.params.id);
    if (!sourceProfile) {
      view.innerHTML = `<div class="card" style="max-width:560px;margin:10vh auto">${emptyState({
        iconName: 'layers',
        title: '方案不存在',
        desc: '它可能已经被删除。回到方案列表看看其他方案。',
        action: '<a class="btn btn-primary" href="#/profiles">返回方案列表</a>',
      })}</div>`;
      return null;
    }

    const profile = sourceProfile;
    let config = normalizeConfig(JSON.parse(JSON.stringify(profile.config || {})), profile.config?.mode);
    let name = profile.name;
    let dirty = false;
    let saving = false;
    let saveTimer = null;
    let savePromise = null;
    let saveStatus = 'saved';
    let lastSaved = profile.updated_at;
    let running = false;

    ctx.setCrumb([
      { label: '工作台', href: '#/' },
      { label: '汇总方案', href: '#/profiles' },
      { label: name || '方案编辑' },
    ]);

    const availableTables = () => allTables();
    const activeIds = () => activeTableIds(config);
    const activeEntries = () => activeIds().map((id) => availableTables().find((t) => t.table.id === id)).filter(Boolean);
    const activeIdSet = () => new Set(activeIds());

    function validate() {
      const errors = [];
      const warns = [];
      const cols = includedColumns(config);
      if (!cols.length) errors.push('还没有目标列，请先选择或导入列。');
      const names = cols.map((c) => c.name.trim());
      if (new Set(names).size !== names.length) errors.push('目标列名称有重复，请改成不同的列名。');
      if (config.mode === 'join') {
        if (!config.primary_table) errors.push('还没有选择主表。');
        else if (!tableHeaders(config.primary_table).length) errors.push('主表已失效，请重新选择数据来源。');
        if (!config.primary_keys.length) errors.push('还没有选择主键字段。');
        const seen = new Set();
        for (const lookup of config.lookups || []) {
          if (!lookup.table_id || !tableHeaders(lookup.table_id).length) {
            errors.push('有相关表已失效，请重新选择。');
            continue;
          }
          if (seen.has(lookup.table_id) || lookup.table_id === config.primary_table) {
            errors.push(`关联表「${tableLabel(lookup.table_id)}」重复。`);
          }
          seen.add(lookup.table_id);
          if ((lookup.keys || []).length !== config.primary_keys.length
            || (lookup.keys || []).some((k) => k === null || k === undefined || Number.isNaN(Number(k)))) {
            errors.push(`关联表「${tableLabel(lookup.table_id)}」的关联字段还没有配置完整。`);
          }
        }
      } else if (!config.append_tables.length) {
        errors.push('还没有选择要合并的数据表。');
      }

      let unmapped = 0;
      let invalid = 0;
      const mappings = config.mappings || {};
      for (const col of cols) {
        const m = mappings[col.key];
        if (!m || m.mode === 'blank') {
          unmapped += 1;
          continue;
        }
        if (m.mode === 'table') {
          const headers = tableHeaders(m.table_id);
          if (!headers.length) {
            errors.push(`列「${col.name}」的来源表已失效。`);
            invalid += 1;
          } else if (!Number.isInteger(Number(m.column_index)) || Number(m.column_index) < 0 || Number(m.column_index) >= headers.length) {
            errors.push(`列「${col.name}」的来源字段已失效。`);
            invalid += 1;
          }
        }
      }
      if (unmapped) warns.push(`还有 ${unmapped} 列没有指定来源，将以空值输出。`);
      if (config.target.kind === 'template') {
        const template = templateById(config.target.template_id);
        if (!template) errors.push('目标模板已被删除，请重新选择模板。');
        else if (!(template.meta?.sheets || []).some((s) => s.name === config.target.sheet)) {
          errors.push('目标模板中找不到所选工作表。');
        }
      }
      const mapped = cols.length - unmapped;
      return { errors, warns, cols, mapped, unmapped, invalid };
    }

    function targetTemplate() {
      return config.target.kind === 'template' ? templateById(config.target.template_id) : null;
    }

    function saveStatusText() {
      if (saveStatus === 'saving') return `<span class="inline-loading"><span class="spinner spinner-sm"></span>保存中…</span>`;
      if (saveStatus === 'dirty') return `<span class="dirty-dot"></span> 有未保存修改`;
      if (saveStatus === 'error') return `<span style="color:var(--red)">保存失败</span>`;
      return `${icon('check-circle', 'icon-sm')} 已保存${lastSaved ? ` · ${fmtDate(lastSaved)}` : ''}`;
    }

    function paintSaveStatus() {
      view.querySelectorAll('[data-save-status]').forEach((el) => {
        el.innerHTML = saveStatusText();
      });
    }

    function setStatus(next) {
      saveStatus = next;
      paintSaveStatus();
    }

    function scheduleSave() {
      dirty = true;
      setStatus('dirty');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveDraft(true).catch(() => {});
      }, 950);
    }

    async function saveDraft(silent = false) {
      clearTimeout(saveTimer);
      if (saving && savePromise) {
        try { await savePromise; } catch (e) { /* handled below */ }
      }
      if (!dirty) {
        if (!silent) toast('当前配置已保存。', 'info');
        return profile;
      }
      saving = true;
      setStatus('saving');
      savePromise = api.updateProfile(profile.id, { name, config }).then(async (data) => {
        Object.assign(profile, data.profile);
        const index = state.profiles.findIndex((p) => p.id === profile.id);
        if (index >= 0) state.profiles[index] = data.profile;
        dirty = false;
        lastSaved = data.profile.updated_at;
        setStatus('saved');
        ctx.setCrumb([
          { label: '工作台', href: '#/' },
          { label: '汇总方案', href: '#/profiles' },
          { label: name || '方案编辑' },
        ]);
        return data.profile;
      }).catch((err) => {
        setStatus('error');
        if (!silent) toast(err.message, 'error');
        throw err;
      }).finally(() => {
        saving = false;
        savePromise = null;
      });
      return savePromise;
    }

    async function flushSave() {
      clearTimeout(saveTimer);
      if (savePromise) {
        try { await savePromise; } catch (e) { /* ignore */ }
      }
      if (dirty) await saveDraft(false);
    }

    function markDirty(structural = false) {
      scheduleSave();
      if (structural) paint(true);
    }

    function autoMap({ silent = false } = {}) {
      const entries = activeEntries();
      let count = 0;
      for (const col of includedColumns(config)) {
        const existing = config.mappings[col.key];
        if (existing && existing.mode === 'const') continue;
        if (existing && existing.mode === 'table') {
          const headers = tableHeaders(existing.table_id);
          if (headers.length && Number(existing.column_index) >= 0 && Number(existing.column_index) < headers.length) continue;
        }
        for (const entry of entries) {
          const idx = (entry.table.headers || []).indexOf(col.name);
          if (idx >= 0) {
            config.mappings[col.key] = {
              mode: 'table', table_id: entry.table.id, column_index: idx,
              column_name: entry.table.headers[idx], transform: 'direct', fallback: '',
            };
            count += 1;
            break;
          }
        }
      }
      if (!silent) {
        if (count) toast(`已按列名匹配 ${count} 列，已有配置保持不变。`, 'ok');
        else toast('没有找到同名的来源字段，可以手动选择。', 'info');
      }
      return count;
    }

    function syncLookupKeys() {
      const n = config.primary_keys.length;
      for (const lookup of config.lookups || []) {
        lookup.keys = Array.from({ length: n }, (_, i) => (
          lookup.keys?.[i] !== undefined && lookup.keys?.[i] !== null && Number.isInteger(Number(lookup.keys[i]))
            ? Number(lookup.keys[i]) : null
        ));
      }
    }

    function togglePrimaryKey(index) {
      const set = new Set(config.primary_keys.map(Number));
      if (set.has(index)) set.delete(index);
      else set.add(index);
      config.primary_keys = Array.from(set).sort((a, b) => a - b);
      syncLookupKeys();
      markDirty(true);
    }

    function primaryHeaders() {
      return tableHeaders(config.primary_table);
    }

    function activeSourceOptions(selectedId = '', { exclude = [] } = {}) {
      const entries = availableTables().filter((entry) => !exclude.includes(entry.table.id));
      if (selectedId && !entries.some((entry) => entry.table.id === selectedId)) {
        const current = availableTables().find((entry) => entry.table.id === selectedId);
        if (current) entries.unshift(current);
      }
      const groups = new Map();
      for (const entry of entries) {
        const group = entry.group || entry.source.name;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(entry);
      }
      return `<option value="">请选择数据表</option>` + Array.from(groups.entries()).map(([group, items]) => `
        <optgroup label="${attr(group)}">
          ${items.map((entry) => `<option value="${attr(entry.table.id)}" ${entry.table.id === selectedId ? 'selected' : ''}>${esc(entry.table.label)} · ${fmtNumber(entry.table.row_count)} 行</option>`).join('')}
        </optgroup>`).join('');
    }

    function mappingSourceOptions(col, mapping) {
      const active = activeIdSet();
      const entries = availableTables().filter((entry) => active.has(entry.table.id));
      let html = `<option value="">选择来源…</option>`;
      for (const entry of entries) {
        html += `<option value="table:${attr(entry.table.id)}" ${mapping?.mode === 'table' && mapping.table_id === entry.table.id ? 'selected' : ''}>${esc(entry.label)}</option>`;
      }
      if (mapping?.mode === 'table' && mapping.table_id && !active.has(mapping.table_id)) {
        html += `<option value="table:${attr(mapping.table_id)}" selected>⚠ ${esc(tableLabel(mapping.table_id))}（未参与）</option>`;
      }
      html += `<option value="const" ${mapping?.mode === 'const' ? 'selected' : ''}>固定值</option>`;
      html += `<option value="blank" ${!mapping || mapping.mode === 'blank' ? 'selected' : ''}>留空</option>`;
      return html;
    }

    function fieldOptions(col, mapping) {
      const headers = mapping?.mode === 'table' ? tableHeaders(mapping.table_id) : [];
      if (!headers.length) return `<option value="">—</option>`;
      return headers.map((header, index) => (
        `<option value="${index}" ${Number(mapping?.column_index) === index ? 'selected' : ''}>${esc(header)}</option>`
      )).join('');
    }

    function transformOptions(value) {
      return TRANSFORMS.map(([key, label]) => (
        `<option value="${key}" ${(value || 'direct') === key ? 'selected' : ''}>${label}</option>`
      )).join('');
    }

    // ---------- 页面片段 ----------
    function renderSourceSection() {
      const tablesExist = availableTables().length > 0;
      const pHeaders = primaryHeaders();
      return `
        <section class="section-card" id="section-sources">
          <div class="section-head">
            <span class="section-num">1</span>
            <div class="section-head-main">
              <h3>数据来源</h3>
              <p>决定每一行从哪里来。关联模式先选主表，再用主键把其他表补进来。</p>
            </div>
            ${!tablesExist ? `<a class="btn btn-secondary btn-sm" href="#/sources">${icon('upload-cloud')}去接入文件</a>` : ''}
          </div>
          ${!tablesExist ? `<div class="empty-inline">还没有可用的数据表。先到「数据源」上传 Excel、CSV 或邮件。</div>` : ''}
          <div class="mode-grid">
            <label class="mode-option ${config.mode === 'join' ? 'selected' : ''}" data-mode="join">
              <span class="mode-icon">${icon('link')}</span>
              <span class="mode-main"><strong>主表关联补齐</strong><p>一行一个对象，其他表格按主键把字段补进来。</p></span>
              <span class="mode-check">${icon('check')}</span>
            </label>
            <label class="mode-option ${config.mode === 'append' ? 'selected' : ''}" data-mode="append">
              <span class="mode-icon">${icon('layers')}</span>
              <span class="mode-main"><strong>多表纵向合并</strong><p>结构相同的表按列名上下拼接，形成一张总表。</p></span>
              <span class="mode-check">${icon('check')}</span>
            </label>
          </div>

          ${config.mode === 'join' ? renderJoinSource(pHeaders) : renderAppendSource()}

          <div class="rail-divider"></div>
          <div class="flex items-center gap-12 flex-wrap">
            ${config.mode === 'join' ? `
              <label class="switch">
                <input type="checkbox" data-option="dedupe" ${config.options?.dedupe !== false ? 'checked' : ''}>
                <span class="switch-track"></span>
                <span class="switch-label">主键重复时只保留第一行</span>
              </label>` : `
              <label class="switch">
                <input type="checkbox" data-option="auto_by_name" ${config.auto_by_name !== false ? 'checked' : ''}>
                <span class="switch-track"></span>
                <span class="switch-label">其他表按同名列自动填充</span>
              </label>`}
            <span class="tiny faint">${activeIds().length} 张表参与本次汇总</span>
          </div>
        </section>`;
    }

    function renderJoinSource(pHeaders) {
      const lookupIds = (config.lookups || []).map((l) => l.table_id).filter(Boolean);
      const availableLookupIds = availableTables()
        .map((entry) => entry.table.id)
        .filter((id) => id !== config.primary_table && !lookupIds.includes(id));
      return `
        <div class="form-grid mt-18">
          <div class="field span-2">
            <label class="field-label" for="primary-table">主表 <span class="req">*</span></label>
            <select class="select" id="primary-table" data-primary>
              ${activeSourceOptions(config.primary_table)}
            </select>
            <div class="field-hint">主表决定输出的行数和顺序，其他表格只补齐字段，不会增加行。</div>
          </div>
        </div>
        ${config.primary_table ? `
          <div class="field mt-16">
            <span class="field-label">${icon('key', 'icon-sm')} 主键字段 <span class="req">*</span></span>
            <div class="key-picker">
              ${pHeaders.map((header, index) => `
                <button class="pick ${config.primary_keys.includes(index) ? 'selected' : ''}" type="button" data-key-index="${index}">
                  ${config.primary_keys.includes(index) ? icon('check') : ''}${esc(header)}
                </button>`).join('')}
            </div>
            <div class="field-hint">主键用于匹配关联表，可选择多个字段组成组合主键（如 工号 + 月份）。</div>
          </div>
          <div class="mt-18">
            <div class="flex items-center justify-between gap-10 mb-8">
              <span class="field-label" style="margin:0">关联表</span>
              <span class="tiny faint">按主键从这些表中取字段</span>
            </div>
            <div class="lookup-list">
              ${(config.lookups || []).map((lookup, i) => renderLookupCard(lookup, i, availableLookupIds)).join('') || `<div class="empty-inline">还没有关联表。如果所有字段都来自主表，可以跳过。</div>`}
            </div>
            ${availableLookupIds.length ? `
              <select class="select select-sm mt-10" data-add-lookup>
                <option value="">＋ 添加关联表…</option>
                ${availableTables().filter((entry) => availableLookupIds.includes(entry.table.id)).map((entry) => (
                  `<option value="${attr(entry.table.id)}">${esc(entry.label)} · ${fmtNumber(entry.table.row_count)} 行</option>`
                )).join('')}
              </select>` : ''}
          </div>` : `<div class="empty-inline mt-16">先选择主表，再设置主键与关联表。</div>`}`;
    }

    function renderLookupCard(lookup, index, availableLookupIds) {
      const headers = tableHeaders(lookup.table_id);
      const pHeaders = primaryHeaders();
      const options = availableTables().filter((entry) => (
        entry.table.id === lookup.table_id
        || (entry.table.id !== config.primary_table
          && !(config.lookups || []).some((l, i) => i !== index && l.table_id === entry.table.id))
      ));
      const groups = new Map();
      for (const entry of options) {
        const group = entry.group || entry.source.name;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(entry);
      }
      return `
        <div class="lookup-card">
          <div class="lookup-head">
            ${icon('link')}
            <select class="select select-sm" data-lookup-table="${index}" style="flex:1;min-width:0;border-color:transparent;background-color:transparent;font-weight:600">
              ${Array.from(groups.entries()).map(([group, items]) => `<optgroup label="${attr(group)}">${items.map((entry) => (
                `<option value="${attr(entry.table.id)}" ${entry.table.id === lookup.table_id ? 'selected' : ''}>${esc(entry.label)}</option>`
              )).join('')}</optgroup>`).join('')}
            </select>
            <button class="icon-btn danger" type="button" data-remove-lookup="${index}" title="移除关联表" aria-label="移除关联表">${icon('x', 'icon-sm')}</button>
          </div>
          <div class="lookup-body">
            ${!headers.length ? `<div class="empty-inline">请选择一张关联表。</div>` : (
              config.primary_keys.length
                ? config.primary_keys.map((keyIndex, keyPos) => `
                    <div class="key-map-row">
                      <div>
                        <div class="key-map-label">主表字段</div>
                        <div class="small strong">${esc(pHeaders[keyIndex] ?? `第 ${keyIndex + 1} 列`)}</div>
                      </div>
                      <div class="arrow">${icon('arrow-right')}</div>
                      <div>
                        <div class="key-map-label">关联表字段</div>
                        <select class="select select-sm" data-lookup-key="${index}" data-key-pos="${keyPos}">
                          <option value="">请选择字段</option>
                          ${headers.map((h, hi) => `<option value="${hi}" ${Number(lookup.keys?.[keyPos]) === hi ? 'selected' : ''}>${esc(h)}</option>`).join('')}
                        </select>
                      </div>
                    </div>`).join('')
                : `<div class="empty-inline">请先选择主键字段，再设置对应关系。</div>`
            )}
          </div>
        </div>`;
    }

    function renderAppendSource() {
      const selected = config.append_tables || [];
      const available = availableTables().filter((entry) => !selected.includes(entry.table.id));
      return `
        <div class="mt-18">
          <div class="flex items-center justify-between gap-10 mb-8">
            <span class="field-label" style="margin:0">要合并的数据表 <span class="req">*</span></span>
            <span class="tiny faint">按下面的顺序纵向追加</span>
          </div>
          <div class="lookup-list">
            ${selected.length ? selected.map((id, index) => {
              const entry = availableTables().find((t) => t.table.id === id);
              return `<div class="lookup-card">
                <div class="lookup-head">
                  <span class="section-num" style="width:24px;height:24px;border-radius:7px;font-size:10px">${index + 1}</span>
                  <span class="name">${esc(entry?.label || tableLabel(id))}</span>
                  <span class="chip">${fmtNumber(entry?.table.row_count || 0)} 行</span>
                  <button class="icon-btn" type="button" data-append-move="${index}" data-dir="up" title="上移" ${index === 0 ? 'disabled' : ''}>${icon('arrow-up', 'icon-sm')}</button>
                  <button class="icon-btn" type="button" data-append-move="${index}" data-dir="down" title="下移" ${index === selected.length - 1 ? 'disabled' : ''}>${icon('arrow-down', 'icon-sm')}</button>
                  <button class="icon-btn danger" type="button" data-remove-append="${index}" title="移除" aria-label="移除">${icon('x', 'icon-sm')}</button>
                </div>
              </div>`;
            }).join('') : `<div class="empty-inline">还没有选择数据表。添加结构相近的表格后，按列名对齐合并。</div>`}
          </div>
          ${available.length ? `
            <select class="select select-sm mt-10" data-add-append>
              <option value="">＋ 添加数据表…</option>
              ${available.map((entry) => `<option value="${attr(entry.table.id)}">${esc(entry.label)} · ${fmtNumber(entry.table.row_count)} 行</option>`).join('')}
            </select>` : ''}
        </div>`;
    }

    function renderTargetSection() {
      const template = targetTemplate();
      const cols = config.target.columns || [];
      const included = cols.filter((c) => c.included !== false);
      return `
        <section class="section-card" id="section-target">
          <div class="section-head">
            <span class="section-num">2</span>
            <div class="section-head-main">
              <h3>目标表</h3>
              <p>${config.target.kind === 'template'
                ? '沿用现有 Excel 模板的列顺序与格式，只把数据写进去。'
                : '没有模板时，会新建一张干净的汇总工作簿。'}</p>
            </div>
            <div class="section-head-actions">
              ${config.target.kind === 'template'
                ? `<button class="btn btn-secondary btn-sm" type="button" data-change-template>${icon('refresh')}更换模板</button>`
                : `<button class="btn btn-secondary btn-sm" type="button" data-change-template>${icon('file-spreadsheet')}使用模板</button>`}
            </div>
          </div>
          ${config.target.kind === 'template'
            ? (template ? renderTemplateBanner(template) : `<div class="warning-note">${icon('alert')}<span>模板已被删除或不可用，请重新选择模板，或移除模板后新建工作簿。</span></div>`)
            : ''}
          <div class="form-grid mt-16 ${config.target.kind === 'template' ? 'cols-3' : ''}">
            <div class="field">
              <label class="field-label" for="target-sheet">输出工作表</label>
              ${config.target.kind === 'template'
                ? `<input class="input" id="target-sheet" value="${attr(config.target.sheet || '')}" readonly>`
                : `<input class="input" id="target-sheet" data-target-sheet value="${attr(config.target.sheet || '汇总')}" placeholder="汇总">`}
            </div>
            ${config.target.kind === 'template' ? `
              <div class="field">
                <label class="field-label">表头行</label>
                <div class="input-group">
                  <input class="input" value="第 ${config.target.header_row || 1} 行" readonly>
                  <button class="btn btn-secondary btn-sm" type="button" data-adjust-header>调整</button>
                </div>
              </div>
              <div class="field">
                <label class="field-label" for="write-mode">写入方式</label>
                <select class="select" id="write-mode" data-write-mode>
                  <option value="replace" ${config.target.write_mode !== 'append' ? 'selected' : ''}>覆盖模板数据区</option>
                  <option value="append" ${config.target.write_mode === 'append' ? 'selected' : ''}>追加到已有数据之后</option>
                </select>
              </div>` : ''}
          </div>
          <div class="rail-divider"></div>
          <div class="flex items-center justify-between gap-10 mb-10 flex-wrap">
            <div>
              <span class="field-label" style="margin:0">目标列 <span class="faint" style="font-weight:400">已纳入 ${included.length} / ${cols.length} 列</span></span>
              <div class="tiny faint mt-4">${config.target.kind === 'template' ? '取消勾选可保留模板中的公式列或人工填写列。' : '每一列都会成为输出表的一列。'}</div>
            </div>
            <div class="flex gap-6">
              ${config.target.kind === 'template' || !cols.length ? '' : `<button class="btn btn-secondary btn-sm" type="button" data-import-columns>${icon('table')}从数据表导入</button>`}
              ${config.target.kind === 'template' ? '' : `<button class="btn btn-soft btn-sm" type="button" data-add-column>${icon('plus')}添加列</button>`}
            </div>
          </div>
          ${cols.length ? renderColumnList(cols) : `<div class="empty-inline" style="padding:24px">
            还没有目标列。${config.target.kind === 'template' ? '模板中没有识别到表头，请调整表头行或更换模板。' : '可以从数据表导入列名，也可以手动添加。'}
            <div class="mt-10">${config.target.kind === 'template'
              ? `<button class="btn btn-primary btn-sm" type="button" data-change-template>${icon('refresh')}重新选择模板</button>`
              : `<button class="btn btn-primary btn-sm" type="button" data-import-columns>${icon('table')}从数据表导入列</button>`}</div>
          </div>`}
        </section>`;
    }

    function renderTemplateBanner(template) {
      return `<div class="template-banner">
        <div class="file-badge template">${icon('file-spreadsheet')}</div>
        <div class="template-banner-main">
          <strong>${esc(template.name)}</strong>
          <p>工作表「${esc(config.target.sheet)}」 · 第 ${config.target.header_row || 1} 行表头 · 模板文件保存在本机</p>
        </div>
        <button class="btn btn-secondary btn-sm" type="button" data-remove-template>移除模板</button>
      </div>`;
    }

    function renderColumnList(cols) {
      const isTemplate = config.target.kind === 'template';
      return `
        <div class="col-list">
          <div class="col-row head ${isTemplate ? 'template-row' : ''}">
            ${isTemplate ? '<span>纳入</span><span>列名</span><span>类型</span><span>模板列</span><span>状态</span><span></span>'
              : '<span></span><span>列名</span><span>类型</span><span>宽度</span><span></span>'}
          </div>
          ${cols.map((col, index) => isTemplate ? `
            <div class="col-row template-row" style="${col.included === false ? 'opacity:.55' : ''}">
              <span class="col-included"><input type="checkbox" data-col-included="${attr(col.key)}" ${col.included !== false ? 'checked' : ''}></span>
              <input class="input input-sm col-name-input" value="${attr(col.name)}" data-col-name="${attr(col.key)}" ${col.included === false ? 'disabled' : ''}>
              <select class="select select-sm" data-col-type="${attr(col.key)}">
                ${['auto', 'text', 'number', 'date'].map((t) => `<option value="${t}" ${(col.type || 'auto') === t ? 'selected' : ''}>${typeName(t)}</option>`).join('')}
              </select>
              <span class="tiny faint">第 ${Number(col.template_col) + 1} 列</span>
              <span class="tiny faint">${col.included === false ? '保持原样' : '写入数据'}</span>
              <span></span>
            </div>` : `
            <div class="col-row">
              <span class="col-grip">${icon('columns')}</span>
              <input class="input input-sm col-name-input" value="${attr(col.name)}" data-col-name="${attr(col.key)}" maxlength="80">
              <select class="select select-sm" data-col-type="${attr(col.key)}">
                ${['auto', 'text', 'number', 'date'].map((t) => `<option value="${t}" ${(col.type || 'auto') === t ? 'selected' : ''}>${typeName(t)}</option>`).join('')}
              </select>
              <input class="input input-sm" type="number" min="6" max="60" value="${col.width || 14}" data-col-width="${attr(col.key)}">
              <div class="col-move">
                <button class="icon-btn" type="button" data-col-move="${attr(col.key)}" data-dir="up" title="上移" ${index === 0 ? 'disabled' : ''}>${icon('arrow-up', 'icon-sm')}</button>
                <button class="icon-btn" type="button" data-col-move="${attr(col.key)}" data-dir="down" title="下移" ${index === cols.length - 1 ? 'disabled' : ''}>${icon('arrow-down', 'icon-sm')}</button>
                <button class="icon-btn danger" type="button" data-col-remove="${attr(col.key)}" title="删除列" aria-label="删除列">${icon('trash', 'icon-sm')}</button>
              </div>
            </div>`).join('')}
        </div>`;
    }

    function renderMappingSection() {
      const cols = includedColumns(config);
      const entries = activeEntries();
      const mapped = cols.filter((c) => {
        const m = config.mappings[c.key];
        return m && (m.mode === 'const' || m.mode === 'table');
      }).length;
      return `
        <section class="section-card" id="section-mapping">
          <div class="section-head">
            <span class="section-num">3</span>
            <div class="section-head-main">
              <h3>字段映射</h3>
              <p>为每个目标列指定来源字段。可以按列名自动匹配，也可以逐列手选。</p>
            </div>
            <div class="section-head-actions">
              <span class="chip ${mapped === cols.length && cols.length ? 'chip-brand' : 'chip-gold'}">${mapped} / ${cols.length} 已配置</span>
              <button class="btn btn-secondary btn-sm" type="button" data-auto-map>${icon('wand')}按列名匹配</button>
            </div>
          </div>
          ${!cols.length ? `<div class="empty-inline" style="padding:28px">先在上一步确定目标列，再来设置每一列的数据来源。</div>`
            : !entries.length ? `<div class="empty-inline" style="padding:28px">先选择主表或要合并的数据表，映射选项才会出现。</div>`
              : `<div class="map-scroll">
                  <div class="map-table">
                    <div class="map-row head">
                      <span>目标列</span><span>数据来源</span><span>来源字段</span><span>处理</span><span>缺省值</span><span></span>
                    </div>
                    ${cols.map((col) => renderMappingRow(col, entries)).join('')}
                  </div>
                </div>`}
          <div class="tiny faint mt-10">缺省值会在来源为空或没有匹配到行时写入；选择「固定值」可给整列写入同一个内容。</div>
        </section>`;
    }

    function renderMappingRow(col, entries) {
      const mapping = config.mappings[col.key];
      const mode = mapping?.mode || 'blank';
      const invalid = mode === 'table' && !tableHeaders(mapping.table_id).length;
      return `
        <div class="map-row ${mode === 'blank' || invalid ? 'needs-attention' : ''}" data-map-row="${attr(col.key)}">
          <div class="map-target">
            <span class="name" title="${attr(col.name)}">${esc(col.name)}</span>
            <span class="type">${typeName(col.type)}</span>
          </div>
          <select class="select select-sm" data-map-source="${attr(col.key)}">
            ${mappingSourceOptions(col, mapping)}
          </select>
          <div>
            ${mode === 'table'
              ? `<select class="select select-sm" data-map-field="${attr(col.key)}">${fieldOptions(col, mapping)}</select>`
              : mode === 'const'
                ? `<input class="input input-sm" value="${attr(mapping?.value || '')}" data-map-const="${attr(col.key)}" placeholder="固定内容">`
                : `<span class="tiny faint">该列输出为空</span>`}
          </div>
          <div>
            <select class="select select-sm" data-map-transform="${attr(col.key)}" ${mode !== 'table' ? 'disabled' : ''}>
              ${transformOptions(mapping?.transform)}
            </select>
          </div>
          <div>
            <input class="input input-sm" value="${attr(mapping?.fallback || '')}" data-map-fallback="${attr(col.key)}"
              placeholder="${mode === 'table' ? '可留空' : '—'}" ${mode !== 'table' ? 'disabled' : ''}>
          </div>
          <div class="map-status ${invalid ? 'warn' : mode === 'blank' ? 'off' : ''}" title="${invalid ? '来源已失效' : mode === 'blank' ? '尚未配置' : '已配置'}">
            ${invalid ? icon('alert') : mode === 'blank' ? icon('info') : icon('check-circle')}
          </div>
        </div>`;
    }

    function renderRail() {
      const v = validate();
      const template = targetTemplate();
      const rows = v.cols.length;
      const sourcesCount = activeIds().length;
      const checkIcon = (ok, warn = false) => ok
        ? icon('check-circle')
        : warn ? icon('alert') : icon('alert');
      const item = (ok, label, value = '', warn = false) => `
        <div class="check-item ${ok ? '' : warn ? 'warn' : 'error'}">
          ${checkIcon(ok, warn)}
          <span>${label}</span>
          ${value ? `<span class="val">${value}</span>` : ''}
        </div>`;
      return `
        <aside class="editor-rail" id="editor-rail">
          <div class="rail-card">
            <div class="rail-title">
              <span>生成前检查</span>
              <span class="chip ${v.errors.length ? 'chip-gold' : 'chip-brand'}">${v.errors.length ? '待完善' : '可以生成'}</span>
            </div>
            <div class="check-list">
              ${item(sourcesCount > 0, '数据来源', sourcesCount ? `${sourcesCount} 张表` : '未选择')}
              ${item(config.mode === 'append' || !!config.primary_table, config.mode === 'append' ? '合并数据表' : '主表与主键', config.mode === 'append'
                ? `${config.append_tables.length} 张`
                : config.primary_table ? `${config.primary_keys.length} 个主键` : '未选择', true)}
              ${item(rows > 0, '目标列', `${rows} 列`, true)}
              ${item(v.mapped === rows && rows > 0, '字段映射', `${v.mapped} / ${rows}`, true)}
              ${item(config.target.kind === 'blank' || !!template, '输出方式', template ? esc(template.name) : '新建工作簿')}
            </div>
            ${v.errors.length ? `<details class="rail-errors"><summary>${icon('alert')}有 ${v.errors.length} 项需要处理</summary><div class="check-list">${v.errors.slice(0, 6).map((e) => `<div class="check-item error">${icon('alert')}<span>${esc(e)}</span></div>`).join('')}</div></details>` : ''}
            ${v.warns.length ? `<div class="mt-10">${v.warns.slice(0, 2).map((w) => `<div class="check-item warn">${icon('info')}<span>${esc(w)}</span></div>`).join('')}</div>` : ''}
          </div>
          <div class="rail-card">
            <div class="rail-title"><span>输出预览</span><span class="chip">${config.mode === 'append' ? '追加' : '关联'}</span></div>
            <div class="rail-summary"><span>输出列</span><strong>${rows}</strong></div>
            <div class="rail-summary"><span>参与数据表</span><strong>${sourcesCount}</strong></div>
            <div class="rail-summary"><span>主表行数</span><strong>${config.primary_table ? fmtNumber(tableHeaders(config.primary_table).length ? (availableTables().find((t) => t.table.id === config.primary_table)?.table.row_count || 0) : 0) : '—'}</strong></div>
            <div class="rail-summary"><span>输出方式</span><strong class="truncate" style="max-width:150px">${template ? 'Excel 模板' : '新建工作簿'}</strong></div>
            <div class="rail-actions">
              <button class="btn btn-primary btn-block" type="button" data-run ${running ? 'disabled' : ''}>
                ${running ? '<span class="spinner spinner-sm"></span>正在汇总…' : `${icon('play')}生成汇总表`}
              </button>
              <button class="btn btn-secondary btn-block" type="button" data-preview>${icon('eye')}预览前 50 行</button>
            </div>
            <div class="rail-tip mt-12">${icon('info')}<span>生成前会自动保存当前配置。生成的文件可以在「生成记录」里重新下载。</span></div>
          </div>
        </aside>`;
    }

    // ---------- 主渲染 ----------
    function paint(preserveScroll = true) {
      const scrollY = window.scrollY;
      const template = targetTemplate();
      const v = validate();
      view.innerHTML = `
        <div class="editor-head">
          <button class="back-btn" type="button" data-back title="返回方案列表" aria-label="返回方案列表">${icon('arrow-left')}</button>
          <div class="editor-title-wrap">
            <div class="editor-title-line">
              <input class="editor-title" data-name value="${attr(name)}" maxlength="80" aria-label="方案名称">
              <span class="chip ${v.errors.length ? 'chip-gold' : 'chip-brand'}">${modeLabel(config.mode)}</span>
            </div>
            <div class="editor-sub">
              <span data-save-status>${saveStatusText()}</span>
              <span>·</span>
              <span>${v.cols.length} 个输出列</span>
              <span>·</span>
              <span>${activeIds().length} 张数据表</span>
              ${profile.last_run_at ? `<span>·</span><span>上次生成 ${timeAgo(profile.last_run_at)}</span>` : ''}
            </div>
          </div>
          <div class="editor-actions">
            <button class="btn btn-secondary" type="button" data-save>${icon('save')}保存</button>
            <button class="btn btn-secondary" type="button" data-preview>${icon('eye')}预览</button>
            <button class="btn btn-primary" type="button" data-run ${running ? 'disabled' : ''}>
              ${running ? '<span class="spinner spinner-sm"></span>正在汇总…' : `${icon('play')}生成汇总表`}
            </button>
          </div>
        </div>
        <div class="editor-layout">
          <div class="stack">
            ${renderSourceSection()}
            ${renderTargetSection()}
            ${renderMappingSection()}
            <div class="tiny faint" style="padding:2px 4px">配置会自动保存。所有计算都在本机完成，关闭启动窗口即停止服务。</div>
          </div>
          ${renderRail()}
        </div>`;
      if (preserveScroll) window.scrollTo(0, scrollY);
      bind();
    }

    function bind() {
      view.querySelector('[data-back]')?.addEventListener('click', async () => {
        if (dirty) {
          try {
            await saveDraft(true);
          } catch (err) {
            toast('保存失败，暂时没有离开当前方案，请检查后再试。', 'error');
            return;
          }
        }
        ctx.navigate('#/profiles');
      });
      const nameInput = view.querySelector('[data-name]');
      nameInput?.addEventListener('input', () => {
        name = nameInput.value;
        ctx.setCrumb([
          { label: '工作台', href: '#/' },
          { label: '汇总方案', href: '#/profiles' },
          { label: name || '方案编辑' },
        ]);
        scheduleSave();
      });
      nameInput?.addEventListener('blur', () => {
        if (!name.trim()) {
          name = '未命名方案';
          nameInput.value = name;
          scheduleSave();
        }
      });

      view.querySelector('[data-save]')?.addEventListener('click', async (event) => {
        const restore = withButtonLoading(event.currentTarget, '保存中…');
        try {
          await saveDraft(false);
          toast('方案已保存。', 'ok');
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          restore();
        }
      });

      view.querySelectorAll('[data-preview]').forEach((btn) => btn.addEventListener('click', () => handlePreview(btn)));
      view.querySelectorAll('[data-run]').forEach((btn) => btn.addEventListener('click', () => handleRun(btn)));

      // 模式
      view.querySelectorAll('[data-mode]').forEach((el) => {
        el.addEventListener('click', () => {
          const next = el.dataset.mode;
          if (config.mode === next) return;
          config.mode = next;
          if (next === 'append' && !config.append_tables.length) {
            config.append_tables = [config.primary_table, ...(config.lookups || []).map((l) => l.table_id)].filter(Boolean);
          }
          markDirty(true);
        });
      });

      // 主表 / 主键 / 关联
      view.querySelector('#primary-table')?.addEventListener('change', (e) => {
        config.primary_table = e.target.value;
        config.primary_keys = config.primary_keys.filter((i) => i < tableHeaders(config.primary_table).length);
        config.lookups = (config.lookups || []).filter((l) => l.table_id !== config.primary_table);
        syncLookupKeys();
        markDirty(true);
      });
      view.querySelectorAll('[data-key-index]').forEach((btn) => {
        btn.addEventListener('click', () => togglePrimaryKey(Number(btn.dataset.keyIndex)));
      });
      view.querySelector('[data-add-lookup]')?.addEventListener('change', (e) => {
        const id = e.target.value;
        if (!id) return;
        config.lookups = [...(config.lookups || []), {
          table_id: id,
          keys: Array(config.primary_keys.length).fill(null),
        }];
        markDirty(true);
      });
      view.querySelectorAll('[data-lookup-table]').forEach((select) => {
        select.addEventListener('change', (e) => {
          const index = Number(select.dataset.lookupTable);
          const lookup = config.lookups[index];
          if (!lookup) return;
          lookup.table_id = e.target.value;
          lookup.keys = Array(config.primary_keys.length).fill(null);
          markDirty(true);
        });
      });
      view.querySelectorAll('[data-lookup-key]').forEach((select) => {
        select.addEventListener('change', (e) => {
          const index = Number(select.dataset.lookupKey);
          const pos = Number(select.dataset.keyPos);
          const lookup = config.lookups[index];
          if (!lookup) return;
          lookup.keys = lookup.keys || [];
          lookup.keys[pos] = e.target.value === '' ? null : Number(e.target.value);
          markDirty(false);
          paintSaveStatus();
        });
      });
      view.querySelectorAll('[data-remove-lookup]').forEach((btn) => {
        btn.addEventListener('click', () => {
          config.lookups.splice(Number(btn.dataset.removeLookup), 1);
          markDirty(true);
        });
      });

      // 纵向合并
      view.querySelector('[data-add-append]')?.addEventListener('change', (e) => {
        if (!e.target.value) return;
        config.append_tables = [...config.append_tables, e.target.value];
        markDirty(true);
      });
      view.querySelectorAll('[data-remove-append]').forEach((btn) => {
        btn.addEventListener('click', () => {
          config.append_tables.splice(Number(btn.dataset.removeAppend), 1);
          markDirty(true);
        });
      });
      view.querySelectorAll('[data-append-move]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const index = Number(btn.dataset.appendMove);
          const dir = btn.dataset.dir === 'up' ? -1 : 1;
          const next = index + dir;
          if (next < 0 || next >= config.append_tables.length) return;
          [config.append_tables[index], config.append_tables[next]] = [config.append_tables[next], config.append_tables[index]];
          markDirty(true);
        });
      });

      // 开关
      view.querySelectorAll('[data-option]').forEach((input) => {
        input.addEventListener('change', () => {
          const key = input.dataset.option;
          if (key === 'auto_by_name') config.auto_by_name = input.checked;
          else config.options[key] = input.checked;
          markDirty(false);
        });
      });

      // 目标表
      view.querySelector('[data-change-template]')?.addEventListener('click', openTemplateDialog);
      view.querySelector('[data-remove-template]')?.addEventListener('click', removeTemplate);
      view.querySelector('[data-adjust-header]')?.addEventListener('click', openAdjustHeader);
      view.querySelector('[data-write-mode]')?.addEventListener('change', (e) => {
        config.target.write_mode = e.target.value;
        markDirty(false);
      });
      view.querySelector('[data-target-sheet]')?.addEventListener('input', (e) => {
        config.target.sheet = e.target.value;
        markDirty(false);
      });
      view.querySelector('[data-add-column]')?.addEventListener('click', () => {
        config.target.columns.push({
          key: uid('c'), name: `新列 ${config.target.columns.length + 1}`,
          type: 'auto', width: 14, included: true, template_col: null,
        });
        markDirty(true);
      });
      view.querySelector('[data-import-columns]')?.addEventListener('click', openImportColumns);
      view.querySelectorAll('[data-col-included]').forEach((input) => {
        input.addEventListener('change', () => {
          const col = config.target.columns.find((c) => c.key === input.dataset.colIncluded);
          if (!col) return;
          col.included = input.checked;
          markDirty(true);
        });
      });
      view.querySelectorAll('[data-col-type]').forEach((select) => {
        select.addEventListener('change', () => {
          const col = config.target.columns.find((c) => c.key === select.dataset.colType);
          if (!col) return;
          col.type = select.value;
          markDirty(true);
        });
      });
      view.querySelectorAll('[data-col-name]').forEach((input) => {
        input.addEventListener('input', () => {
          const col = config.target.columns.find((c) => c.key === input.dataset.colName);
          if (!col) return;
          col.name = input.value;
          scheduleSave();
        });
      });
      view.querySelectorAll('[data-col-width]').forEach((input) => {
        input.addEventListener('change', () => {
          const col = config.target.columns.find((c) => c.key === input.dataset.colWidth);
          if (!col) return;
          col.width = Math.max(6, Math.min(60, Number(input.value) || 14));
          markDirty(false);
        });
      });
      view.querySelectorAll('[data-col-move]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.colMove;
          const dir = btn.dataset.dir === 'up' ? -1 : 1;
          const index = config.target.columns.findIndex((c) => c.key === key);
          const next = index + dir;
          if (index < 0 || next < 0 || next >= config.target.columns.length) return;
          [config.target.columns[index], config.target.columns[next]] = [config.target.columns[next], config.target.columns[index]];
          markDirty(true);
        });
      });
      view.querySelectorAll('[data-col-remove]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.colRemove;
          config.target.columns = config.target.columns.filter((c) => c.key !== key);
          delete config.mappings[key];
          markDirty(true);
        });
      });

      // 映射
      view.querySelector('[data-auto-map]')?.addEventListener('click', () => {
        const count = autoMap();
        if (count) markDirty(true);
      });
      view.querySelectorAll('[data-map-source]').forEach((select) => {
        select.addEventListener('change', () => {
          const key = select.dataset.mapSource;
          const col = config.target.columns.find((c) => c.key === key);
          if (!col) return;
          const value = select.value;
          const old = config.mappings[key] || {};
          if (value === 'const') {
            config.mappings[key] = { mode: 'const', value: old.value || '' };
          } else if (value === 'blank' || value === '') {
            config.mappings[key] = { mode: 'blank' };
          } else if (value.startsWith('table:')) {
            const tableId = value.slice(6);
            const headers = tableHeaders(tableId);
            let index = headers.indexOf(col.name);
            if (index < 0) index = 0;
            config.mappings[key] = {
              mode: 'table', table_id: tableId, column_index: index,
              column_name: headers[index] || '',
              transform: old.transform || 'direct', fallback: old.fallback || '',
            };
          }
          markDirty(true);
        });
      });
      view.querySelectorAll('[data-map-field]').forEach((select) => {
        select.addEventListener('change', () => {
          const key = select.dataset.mapField;
          const mapping = config.mappings[key];
          if (!mapping || mapping.mode !== 'table') return;
          const headers = tableHeaders(mapping.table_id);
          const index = Number(select.value);
          mapping.column_index = index;
          mapping.column_name = headers[index] || '';
          markDirty(false);
          paintSaveStatus();
        });
      });
      view.querySelectorAll('[data-map-transform]').forEach((select) => {
        select.addEventListener('change', () => {
          const mapping = config.mappings[select.dataset.mapTransform];
          if (!mapping) return;
          mapping.transform = select.value;
          markDirty(false);
        });
      });
      view.querySelectorAll('[data-map-fallback]').forEach((input) => {
        input.addEventListener('input', () => {
          const mapping = config.mappings[input.dataset.mapFallback];
          if (!mapping) return;
          mapping.fallback = input.value;
          scheduleSave();
        });
      });
      view.querySelectorAll('[data-map-const]').forEach((input) => {
        input.addEventListener('input', () => {
          const mapping = config.mappings[input.dataset.mapConst];
          if (!mapping) return;
          mapping.value = input.value;
          scheduleSave();
        });
      });
    }

    // ---------- 模板 ----------
    function openTemplateDialog() {
      const ref = openModal({
        title: '选择目标模板',
        sub: '模板的列顺序、宽度、颜色和公式都会保留。',
        size: 'modal-lg',
        body: '',
        footer: `<button class="btn btn-secondary" type="button" data-close>取消</button>`,
      });
      ref.modal.querySelector('[data-close]').addEventListener('click', ref.close);
      const body = ref.body;
      const titleEl = ref.modal.querySelector('.modal-title');
      const subEl = ref.modal.querySelector('.modal-sub');

      function renderLibrary() {
        titleEl.textContent = '选择目标模板';
        subEl.textContent = '选择已有模板，或上传一个新的 Excel 模板。';
        const templates = state.templates || [];
        body.innerHTML = `
          ${templates.length ? `<div class="stack" style="gap:9px">${templates.map((t) => `
            <div class="template-banner">
              <div class="file-badge template">${icon('file-spreadsheet')}</div>
              <div class="template-banner-main">
                <strong>${esc(t.name)}</strong>
                <p>${(t.meta?.sheets || []).length} 个工作表 · 上传于 ${fmtDate(t.created_at, false)}</p>
              </div>
              <button class="btn btn-secondary btn-sm" type="button" data-pick-template="${attr(t.id)}">选择</button>
            </div>`).join('')}</div>` : `<div class="empty small"><div class="empty-icon">${icon('file-spreadsheet')}</div><h3>还没有模板</h3><p>上传一份 Excel 汇总表，系统会读取表头，保留原有格式。</p></div>`}
          <div class="rail-divider"></div>
          <div class="flex items-center justify-between gap-12 flex-wrap">
            <div><div class="strong small">上传新模板</div><div class="tiny faint mt-4">支持 .xlsx / .xlsm，表头可以在下一步调整。</div></div>
            <button class="btn btn-primary btn-sm" type="button" data-upload-template>${icon('upload')}选择模板文件</button>
          </div>
          <input type="file" id="tpl-file" accept=".xlsx,.xlsm,.xltx,.xltm" hidden>`;
        body.querySelector('[data-upload-template]').addEventListener('click', () => body.querySelector('#tpl-file').click());
        body.querySelector('#tpl-file').addEventListener('change', async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const restore = withButtonLoading(e.target.closest('.modal-body').querySelector('[data-upload-template]'), '上传中…');
          try {
            const data = await api.uploadTemplate(file);
            await loadBootstrap();
            toast('模板已上传。', 'ok');
            showSheets(data.template);
          } catch (err) {
            toast(err.message, 'error');
            restore();
          }
        });
        if (templates.length === 1 && !body.querySelector('[data-pick-template]')) {
          // 没有模板时不自动跳转
        }
        body.querySelectorAll('[data-pick-template]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const template = state.templates.find((t) => t.id === btn.dataset.pickTemplate);
            if (template) showSheets(template);
          });
        });
      }

      function showSheets(template) {
        titleEl.textContent = '选择工作表';
        subEl.textContent = template.name;
        const sheets = template.meta?.sheets || [];
        body.innerHTML = `
          <button class="btn btn-ghost btn-sm mb-10" type="button" data-back>${icon('arrow-left')}返回模板列表</button>
          <div class="stack" style="gap:9px">
            ${sheets.map((sheet) => `
              <div class="card" style="padding:14px;border-radius:12px">
                <div class="flex items-center justify-between gap-10 flex-wrap">
                  <div><div class="strong small">${esc(sheet.name)}</div>
                    <div class="tiny faint mt-4">第 ${sheet.header_row} 行表头 · ${sheet.headers.length} 列 · ${fmtNumber(sheet.row_count)} 行数据</div></div>
                  <button class="btn btn-primary btn-sm" type="button" data-pick-sheet="${attr(sheet.name)}">使用这个工作表</button>
                </div>
                <div class="source-tables mt-10">${(sheet.headers || []).slice(0, 10).map((h) => `<span class="chip chip-plain">${esc(h)}</span>`).join('')}${sheet.headers.length > 10 ? `<span class="chip">+${sheet.headers.length - 10}</span>` : ''}</div>
              </div>`).join('')}
          </div>`;
        body.querySelector('[data-back]').addEventListener('click', renderLibrary);
        body.querySelectorAll('[data-pick-sheet]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const sheet = sheets.find((s) => s.name === btn.dataset.pickSheet);
            if (!sheet) return;
            applyTemplateToTarget(config, template, sheet);
            autoMap({ silent: true });
            ref.close();
            markDirty(true);
            toast(`已应用模板「${template.name}」的工作表「${sheet.name}」。`, 'ok');
          });
        });
      }

      renderLibrary();
    }

    function removeTemplate() {
      confirmDialog({
        title: '移除目标模板',
        message: '移除后将改为新建工作簿输出，现有列名和映射会保留。',
        confirmText: '移除模板',
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        config.target.kind = 'blank';
        config.target.template_id = null;
        config.target.header_row = 1;
        for (const col of config.target.columns) col.template_col = null;
        markDirty(true);
        toast('已改为新建工作簿，列配置保留。', 'ok');
      });
    }

    function openAdjustHeader() {
      const template = targetTemplate();
      if (!template) return;
      const ref = openModal({
        title: '调整模板表头行',
        sub: '选错表头会让字段错位。修改后请检查列名与映射。',
        size: 'modal-sm',
        body: `<div class="field">
          <label class="field-label" for="adjust-hr">表头所在行</label>
          <input class="input" id="adjust-hr" type="number" min="1" max="50" value="${config.target.header_row || 1}">
          <div class="field-hint">从 1 开始计数。标题行、说明行不计入。</div>
        </div>`,
        footer: `<button class="btn btn-secondary" type="button" data-cancel>取消</button>
                 <button class="btn btn-primary" type="button" data-apply>应用</button>`,
      });
      ref.modal.querySelector('[data-cancel]').addEventListener('click', ref.close);
      ref.modal.querySelector('[data-apply]').addEventListener('click', async (event) => {
        const value = Number(ref.modal.querySelector('#adjust-hr').value);
        if (!Number.isInteger(value) || value < 1 || value > 50) {
          toast('表头行号需在 1–50 之间。', 'warn');
          return;
        }
        const restore = withButtonLoading(event.currentTarget, '读取中…');
        try {
          const data = await api.inspectTemplate(template.id, config.target.sheet, value);
          const sheet = data.sheet;
          config.target.header_row = sheet.header_row;
          config.target.columns = columnsFromSheet(sheet, config.target.columns);
          ref.close();
          markDirty(true);
          toast(`表头已调整为第 ${sheet.header_row} 行，请检查字段映射。`, 'ok');
        } catch (err) {
          toast(err.message, 'error');
          restore();
        }
      });
    }

    function openImportColumns() {
      if (config.target.kind === 'template') {
        toast('模板输出模式下，列来自模板表头。若要自由导入列，请先移除模板。', 'info');
        return;
      }
      let selectedTable = activeIds()[0] || availableTables()[0]?.table.id || '';
      const ref = openModal({
        title: '从数据表导入列',
        sub: '把一张表的表头变成目标列，之后可以再改列名、调整顺序。',
        size: 'modal-lg',
        body: '',
        footer: `<button class="btn btn-secondary" type="button" data-cancel>取消</button>
                 <button class="btn btn-primary" type="button" data-import disabled>导入列</button>`,
      });
      const body = ref.body;
      const importBtn = ref.modal.querySelector('[data-import]');
      ref.modal.querySelector('[data-cancel]').addEventListener('click', ref.close);

      function render() {
        const entry = availableTables().find((t) => t.table.id === selectedTable);
        const headers = entry?.table.headers || [];
        body.innerHTML = `
          <div class="field">
            <label class="field-label" for="import-table">选择数据表</label>
            <select class="select" id="import-table">${sourceTableOptions(selectedTable, { placeholder: '请选择一张数据表' })}</select>
          </div>
          <div class="field mt-16">
            <label class="check"><input type="checkbox" id="import-replace" ${config.target.columns.length ? '' : 'checked'}> 替换现有目标列（不勾选则追加）</label>
          </div>
          <div class="mt-16">
            <div class="field-label mb-8">将导入 ${headers.length} 列</div>
            <div class="source-tables">${headers.map((h) => `<span class="chip chip-plain">${esc(h)}</span>`).join('') || '<span class="faint small">选择数据表后显示列名</span>'}</div>
          </div>`;
        body.querySelector('#import-table').addEventListener('change', (e) => {
          selectedTable = e.target.value;
          render();
        });
        importBtn.disabled = !headers.length;
      }
      render();
      importBtn.addEventListener('click', () => {
        const entry = availableTables().find((t) => t.table.id === selectedTable);
        if (!entry) return;
        const replace = body.querySelector('#import-replace')?.checked;
        const newCols = (entry.table.headers || []).map((h) => ({
          key: uid('c'), name: h, type: 'auto', width: 14, included: true, template_col: null,
        }));
        if (replace) {
          config.target.columns = newCols;
          config.mappings = {};
        } else {
          const existing = new Set(config.target.columns.map((c) => c.name));
          config.target.columns.push(...newCols.filter((c) => !existing.has(c.name)));
        }
        autoMap({ silent: true });
        ref.close();
        markDirty(true);
        toast(`已导入 ${newCols.length} 个列名。`, 'ok');
      });
    }

    // ---------- 预览与运行 ----------
    function previewTable(headers, rows, max = 50) {
      if (!headers.length) return `<div class="empty small"><div class="empty-icon">${icon('table')}</div><h3>没有可预览的列</h3></div>`;
      return `<div class="preview-scroll">
        <table class="table compact">
          <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${rows.slice(0, max).map((row) => `<tr>${headers.map((_, i) => {
            const value = row[i];
            return `<td><div class="preview-cell" title="${attr(value ?? '')}">${value === null || value === undefined || value === '' ? '<span class="faint">—</span>' : esc(value)}</div></td>`;
          }).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>`;
    }

    async function handlePreview(button) {
      const v = validate();
      if (!v.cols.length || !activeIds().length) {
        toast(v.errors[0] || '先选择数据来源和目标列。', 'warn');
        return;
      }
      if (v.errors.length) {
        toast(v.errors[0], 'warn', 5000);
        document.getElementById('editor-rail')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      const restore = withButtonLoading(button, '生成预览…');
      try {
        const data = await api.preview(config, 50);
        const s = data.stats || {};
        const ref = openModal({
          title: '汇总结果预览',
          sub: `前 ${fmtNumber(data.rows.length)} 行 · 实际输出 ${fmtNumber(s.rows)} 行 × ${fmtNumber(s.columns)} 列`,
          size: 'modal-xl',
          body: `
            <div class="preview-meta">
              <span class="chip chip-brand">${icon('rows')}${fmtNumber(s.rows)} 行</span>
              <span class="chip">${icon('columns')}${fmtNumber(s.columns)} 列</span>
              <span class="chip">${icon('check-circle')}填充 ${fmtNumber(s.filled_cells)} 格</span>
              ${s.empty_cells ? `<span class="chip chip-gold">空值 ${fmtNumber(s.empty_cells)} 格</span>` : ''}
              <span class="chip">${fmtNumber(s.duration_ms)} ms</span>
            </div>
            ${data.warnings?.length ? `<div class="diff-warnings mb-12">${data.warnings.map((w) => `<div class="diff-warning">${icon('alert')}<span>${esc(w)}</span></div>`).join('')}</div>` : ''}
            ${previewTable(data.headers, data.rows)}
            <div class="table-scroll-note">${fmtNumber(s.rows) > data.rows.length ? `这里展示前 ${data.rows.length} 行，完整结果请生成汇总表。` : '这是本次汇总的全部结果。'}</div>`,
          footer: `<button class="btn btn-secondary" type="button" data-close>关闭</button>
                   <button class="btn btn-primary" type="button" data-run-from-preview>${icon('play')}生成汇总表</button>`,
        });
        ref.modal.querySelector('[data-close]').addEventListener('click', ref.close);
        ref.modal.querySelector('[data-run-from-preview]').addEventListener('click', () => {
          ref.close();
          const runBtn = view.querySelector('[data-run]');
          if (runBtn) handleRun(runBtn);
        });
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        restore();
      }
    }

    async function handleRun(button) {
      if (running) return;
      const v = validate();
      if (v.errors.length) {
        toast(v.errors[0], 'warn', 5200);
        document.getElementById('editor-rail')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      running = true;
      const restore = withButtonLoading(button, '正在汇总…');
      try {
        await flushSave();
        const data = await api.run(profile.id, config, name);
        await loadBootstrap();
        const updated = state.profiles.find((p) => p.id === profile.id);
        if (updated) {
          profile.last_run_at = updated.last_run_at;
          profile.updated_at = updated.updated_at;
        }
        toast(`汇总完成：${fmtNumber(data.run.summary.rows)} 行。`, 'ok');
        showRunResult(data.run);
      } catch (err) {
        toast(err.message, 'error', 6500);
      } finally {
        running = false;
        restore();
      }
    }

    function showRunResult(run) {
      const s = run.summary || {};
      const cells = (s.rows || 0) * (s.columns || 0);
      const fillRate = cells ? Math.round(((s.filled_cells || 0) / cells) * 100) : 0;
      const ref = openModal({
        title: '汇总表已生成',
        sub: `${run.output_name} · ${fmtDate(run.created_at, true, true)}`,
        size: 'modal-lg',
        body: `
          <div class="flex items-center gap-14 mb-18" style="padding:4px 2px">
            <div class="empty-icon" style="margin:0;width:52px;height:52px;border-radius:15px">${icon('check-circle')}</div>
            <div class="flex-1">
              <div class="strong" style="font-size:15px">数据已经写入${config.target.kind === 'template' ? '模板' : '新的工作簿'}。</div>
              <div class="tiny muted mt-4">${s.warnings?.length ? '生成过程中有提示，建议展开查看。' : '列结构、缺省值和格式都已按方案处理。'}</div>
            </div>
            <span class="chip chip-brand">${fmtNumber(s.duration_ms)} ms</span>
          </div>
          <div class="grid-3" style="gap:10px">
            <div class="diff-stat same"><div class="label">${icon('rows')}输出行数</div><div class="value">${fmtNumber(s.rows || 0)}</div><div class="sub">${fmtNumber(s.columns || 0)} 列</div></div>
            <div class="diff-stat same"><div class="label">${icon('check-circle')}填充率</div><div class="value">${fillRate}%</div><div class="sub">${fmtNumber(s.empty_cells || 0)} 个空单元格</div></div>
            <div class="diff-stat same"><div class="label">${icon('database')}数据表</div><div class="value">${fmtNumber((s.sources || []).length)}</div><div class="sub">参与本次汇总</div></div>
          </div>
          ${s.warnings?.length ? `<div class="diff-warnings mt-14">${s.warnings.map((w) => `<div class="diff-warning">${icon('alert')}<span>${esc(w)}</span></div>`).join('')}</div>` : ''}
          <div class="info-list mt-16">
            <div class="info-row"><span class="k">输出文件</span><span class="v">${esc(run.output_name)}</span></div>
            <div class="info-row"><span class="k">工作表</span><span class="v">${esc(s.output?.sheet || '—')} · 表头第 ${esc(s.output?.header_row || 1)} 行</span></div>
            <div class="info-row"><span class="k">关联情况</span><span class="v">命中 ${fmtNumber(s.matched || 0)} 次 · 未命中 ${fmtNumber(s.missing || 0)} 次</span></div>
          </div>`,
        footer: `
          <button class="btn btn-secondary" type="button" data-close>关闭</button>
          <button class="btn btn-secondary" type="button" data-detail>${icon('info')}生成详情</button>
          <button class="btn btn-secondary" type="button" data-compare>${icon('compare')}去对比</button>
          <a class="btn btn-primary" href="${attr(run.download_url)}">${icon('download')}下载结果</a>`,
      });
      ref.modal.querySelector('[data-close]').addEventListener('click', ref.close);
      ref.modal.querySelector('[data-detail]').addEventListener('click', () => openRunDetail(run));
      ref.modal.querySelector('[data-compare]').addEventListener('click', () => {
        ref.close();
        ctx.navigate(`#/compare?left=run:${encodeURIComponent(run.id)}`);
      });
    }

    paint(false);

    return () => {
      clearTimeout(saveTimer);
      if (dirty) {
        saveDraft(true).catch(() => {});
      }
    };
  },
};
