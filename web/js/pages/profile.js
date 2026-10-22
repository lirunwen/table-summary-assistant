/** 汇总方案编辑器：数据来源、目标表、逐列映射、运行。 */
import { api } from '../api.js';
import {
  applyTemplateToTarget, columnsFromSheet, modeLabel,
  openRunDetail, sourceTableOptions,
} from '../components.js';
import {
  activeTableIds, allTables, combineOf, COMBINES, includedColumns, loadBootstrap,
  normalizeConfig, sourcesOf, state, tableHeaders, tableLabel, templateById, templateDrift,
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

// 日期格式：value 与后端 writer.DATE_FORMATS 的键一一对应，第二项是效果示例。
const DATE_FORMAT_PRESETS = [
  ['', '跟随全局设置'],
  ['YYYY-MM-DD', '2026-10-21'],
  ['YYYY/M/D', '2026/10/21'],
  ['YYYY年M月D日', '2026年10月21日'],
  ['YYYY-MM-DD HH:mm', '2026-10-21 14:30'],
  ['YYYY-MM', '2026-10'],
  ['M月D日', '10月21日'],
  ['YYYYMMDD', '20261021'],
  ['DD/MM/YYYY', '21/10/2026'],
  ['MM/DD/YYYY', '10/21/2026'],
];

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 把 ISO 日期/时间字符串按 Excel 风格格式转成展示文本。
 * 规则必须与后端 backend/formula.py 的 _format_date 保持一致，
 * 否则预览和实际写出的 Excel 会对不上。
 */
function formatDateByPattern(value, pattern) {
  if (!pattern || typeof value !== 'string') return value;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return value;
  const year = m[1];
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hh = m[4] || '00';
  const mi = m[5] || '00';
  const ss = m[6] || '00';
  const hasTime = /H|S/.test(pattern);
  const tokens = ['YYYY', 'YY', 'MM', 'DD', 'HH', 'mm', 'SS', 'M', 'D', 'H', 'S'];
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    let hit = null;
    for (const t of tokens) {
      if (pattern.startsWith(t, i)) { hit = t; break; }
    }
    if (!hit) { out += pattern[i]; i += 1; continue; }
    if (hit === 'YYYY') out += year;
    else if (hit === 'YY') out += year.slice(2);
    else if (hit === 'MM') out += pad2(month);
    else if (hit === 'M') out += month;
    else if (hit === 'DD') out += pad2(day);
    else if (hit === 'D') out += day;
    else if (hit === 'HH') out += hh;
    else if (hit === 'H') out += String(Number(hh));
    else if (hit === 'mm') out += hasTime ? mi : pad2(month);
    else if (hit === 'SS') out += ss;
    else if (hit === 'S') out += String(Number(ss));
    i += hit.length;
  }
  return out;
}

const formulaOf = (mapping) => (
  mapping && mapping.formula_on === true ? String(mapping.formula || '') : ''
);

/** 试算表格里的取值展示：空值统一显示为破折号。 */
const sampleText = (value) => (
  value === null || value === undefined || value === '' ? '—' : String(value)
);

// 函数速查只从后端取一次（/api/formula/help），避免前后端各维护一份函数清单
let formulaHelpCache = null;

async function loadFormulaHelp() {
  if (!formulaHelpCache) {
    formulaHelpCache = await api.formulaHelp();
  }
  return formulaHelpCache;
}

/** 在输入框光标处插入文本，并把光标移到插入内容之后。 */
function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  const caret = start + text.length;
  input.focus();
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

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
        if (m && m.formula_on === true) continue;
        if (m && m.mode === 'const') continue;
        const sources = sourcesOf(m);
        if (!sources.length) {
          unmapped += 1;
          continue;
        }
        for (const src of sources) {
          const headers = tableHeaders(src.table_id);
          if (!headers.length) {
            errors.push(`列「${col.name}」的来源表已失效。`);
            invalid += 1;
            break;
          }
          const index = Number(src.column_index);
          if (!Number.isInteger(index) || index < 0 || index >= headers.length) {
            errors.push(`列「${col.name}」的来源字段已失效。`);
            invalid += 1;
            break;
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

    /**
     * 按列名匹配来源列。
     *
     * 规则（严格同名 → 括号备注名）统一由后端 `backend/column_match.py` 实现，
     * 前端只负责收集「还没配置的列」和「参与匹配的表」（数组顺序即优先级），
     * 不在这里再写一套，避免两边规则慢慢跑偏。
     */
    async function autoMap({ silent = false } = {}) {
      const entries = activeEntries();
      if (!entries.length) {
        if (!silent) toast('先选择主表或要合并的数据表，再来匹配字段。', 'warn');
        return 0;
      }
      const pending = [];
      for (const col of includedColumns(config)) {
        const existing = config.mappings[col.key];
        if (existing && existing.mode === 'const') continue;
        // 已经用公式算出来的列不参与自动匹配，否则会把公式覆盖掉
        if (existing && existing.formula_on === true) continue;
        // 已经有可用来源链的列不动它（半截坏掉的除外，那种正好借这次匹配修好）
        const sources = sourcesOf(existing);
        const intact = sources.length && sources.every((src) => {
          const headers = tableHeaders(src.table_id);
          return headers.length && Number(src.column_index) < headers.length;
        });
        if (intact) continue;
        pending.push({ key: col.key, name: col.name });
      }
      if (!pending.length) {
        if (!silent) toast('所有列都已经指定了来源，没有需要匹配的列。', 'info');
        return 0;
      }

      const tables = entries.map((entry) => ({ id: entry.table.id, headers: entry.table.headers || [] }));
      let result;
      try {
        result = await api.matchColumns(pending, tables);
      } catch (err) {
        if (!silent) toast(`列名匹配失败：${err.message || err}`, 'error');
        return 0;
      }

      let byName = 0;
      let byAlias = 0;
      for (const hit of result.matches || []) {
        if (!hit.table_id) continue;
        const old = config.mappings[hit.key] || {};
        const oldSources = sourcesOf(old);
        const mapping = {
          ...old,
          mode: 'table',
          sources: [{
            table_id: hit.table_id,
            column_index: hit.column_index,
            column_name: hit.column_name || '',
            transform: oldSources[0]?.transform || old.transform || 'direct',
          }],
          combine: combineOf(old),
          separator: old.separator || '、',
          order_by: old.order_by || null,
          fallback: old.fallback || '',
        };
        delete mapping.table_id;
        delete mapping.column_index;
        delete mapping.matched_alias;
        if (hit.via === 'alias') {
          // 记下是靠哪个括号备注名命中的，映射行里会显示出来，方便核对
          mapping.matched_alias = hit.alias || '';
          byAlias += 1;
        } else {
          byName += 1;
        }
        config.mappings[hit.key] = mapping;
      }

      const count = byName + byAlias;
      if (!silent) {
        if (!count) toast('没有找到对得上的来源字段，可以手动选择。', 'info');
        else {
          const parts = [];
          if (byName) parts.push(`同名 ${byName} 列`);
          if (byAlias) parts.push(`括号备注名 ${byAlias} 列`);
          toast(`已匹配 ${count} 列（${parts.join('，')}），已有配置保持不变。`, 'ok');
        }
      }
      return count;
    }

    /** 手选来源表后同名没命中时，再问一次后端要不要用括号备注名。失败就保持第一列。 */
    function fillByAlias(key, columnName, tableId, headers) {
      api.matchColumns([{ key, name: columnName }], [{ id: tableId, headers }])
        .then((res) => {
          const hit = (res.matches || [])[0];
          const current = config.mappings[key];
          // 等待期间用户可能换了来源表或手选了字段，这几种情况都不该覆盖
          if (!hit || hit.via !== 'alias' || !current) return;
          const chain = sourcesOf(current);
          if (!chain.length || chain[0].table_id !== tableId) return;
          if (Number(chain[0].column_index) !== 0) return;
          chain[0].column_index = hit.column_index;
          chain[0].column_name = hit.column_name || '';
          current.sources = chain;
          current.matched_alias = hit.alias || '';
          markDirty(true);
        })
        .catch(() => { /* 猜不出来就留着第一列，用户手选即可 */ });
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
      const primary = sourcesOf(mapping)[0];
      let html = `<option value="">选择来源…</option>`;
      for (const entry of entries) {
        html += `<option value="table:${attr(entry.table.id)}" ${primary?.table_id === entry.table.id ? 'selected' : ''}>${esc(entry.label)}</option>`;
      }
      if (primary?.table_id && !active.has(primary.table_id)) {
        html += `<option value="table:${attr(primary.table_id)}" selected>⚠ ${esc(tableLabel(primary.table_id))}（未参与）</option>`;
      }
      html += `<option value="const" ${mapping?.mode === 'const' ? 'selected' : ''}>固定值</option>`;
      // 公式列在来源下拉里要能看出来「这一列不是取数算的」，否则会被误认为留空
      if (mapping?.formula_on === true && mapping?.mode !== 'const') {
        html += `<option value="blank" selected>由公式计算（不使用来源）</option>`;
      } else {
        html += `<option value="blank" ${!primary?.table_id && mapping?.mode !== 'const' ? 'selected' : ''}>留空</option>`;
      }
      return html;
    }

    function fieldOptions(col, mapping) {
      const primary = sourcesOf(mapping)[0];
      const headers = primary ? tableHeaders(primary.table_id) : [];
      if (!headers.length) return `<option value="">—</option>`;
      return headers.map((header, index) => (
        `<option value="${index}" ${Number(primary?.column_index) === index ? 'selected' : ''}>${esc(header)}</option>`
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
            <span class="section-num">3</span>
            <div class="section-head-main">
              <h3>数据来源</h3>
              <p>决定每一行从哪里来、一共多少行。关联模式先选主表，再用主键把其他表补进来；模板只决定输出的长相，不带数据。</p>
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
              </label>
              <label class="switch">
                <input type="checkbox" data-option="skip_empty_key" ${config.options?.skip_empty_key === true ? 'checked' : ''}>
                <span class="switch-track"></span>
                <span class="switch-label">主键为空的行不输出</span>
              </label>` : `
              <label class="switch">
                <input type="checkbox" data-option="auto_by_name" ${config.auto_by_name !== false ? 'checked' : ''}>
                <span class="switch-track"></span>
                <span class="switch-label">其他表按同名列自动填充</span>
              </label>`}
            <span class="tiny faint">${activeIds().length} 张表参与本次汇总</span>
            <button class="btn btn-ghost btn-sm" type="button" data-goto-mapping>${icon('arrow-up')}回到字段映射</button>
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
      const isTemplate = config.target.kind === 'template';
      return `
        <section class="section-card" id="section-target">
          <div class="section-head">
            <span class="section-num">1</span>
            <div class="section-head-main">
              <h3>目标表</h3>
              <p>${isTemplate
                ? `<span class="chip chip-plain">${icon('file-spreadsheet')}Excel 模板</span> 模板决定表长什么样：表头、列宽、格式都沿用它，程序只把当月数据填进数据区。`
                : `<span class="chip chip-gold">${icon('table')}新建工作簿</span> 还没有用模板，输出时会新建一张干净的汇总表。`}</p>
            </div>
            <div class="section-head-actions">
              ${isTemplate
                ? `<button class="btn btn-secondary btn-sm" type="button" data-change-template>${icon('refresh')}更换模板</button>`
                : ''}
            </div>
          </div>
          ${isTemplate
            ? (template ? renderTemplateBanner(template) : `<div class="warning-note">${icon('alert')}<span>模板已被删除或不可用，请重新选择模板，或移除模板后新建工作簿。</span></div>`)
            : renderTemplateCta()}
          ${isTemplate && template ? renderDrift(template) : ''}
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

    // 没用模板时，用一个明确的行动区替代原来藏在标题右侧的小按钮：
    // 说明"什么情况下该用模板" + 可选文件格式 + 一键上传入口。
    function renderTemplateCta() {
      const count = (state.templates || []).length;
      return `<div class="template-cta">
        <div class="template-cta-icon">${icon('file-spreadsheet')}</div>
        <div class="template-cta-main">
          <strong>要填进公司固定格式的表格？用 Excel 模板</strong>
          <p>上传 .xlsx / .xlsm 模板，程序自动识别表头行与列名，只把数据写进数据区；列宽、配色、合并单元格、公式列都原样保留。</p>
        </div>
        <div class="template-cta-actions">
          <button class="btn btn-primary btn-sm" type="button" data-change-template>${icon('upload')}上传 / 选择模板</button>
          <span class="tiny faint">${count ? `模板库已有 ${count} 份，可直接选` : '第一次用？上传后所有方案都能复用'}</span>
        </div>
      </div>`;
    }

    function renderTemplateBanner(template) {
      const writeMode = config.target.write_mode === 'append' ? '追加到已有数据之后' : '覆盖模板数据区';
      const headerRow = config.target.header_row || 1;
      const writeCols = (config.target.columns || []).filter((c) => c.included !== false).length;
      const fields = template.fields || [];
      const requiredCount = fields.filter((f) => f.required).length;
      return `<div class="template-banner">
        <div class="file-badge template">${icon('file-spreadsheet')}</div>
        <div class="template-banner-main">
          <strong>${esc(template.name)}</strong>
          <p>工作表「${esc(config.target.sheet)}」 · 第 ${headerRow} 行表头 · 写入 ${writeCols} 列 · ${writeMode}</p>
          <p class="tiny faint mt-4">
            ${template.category ? `${esc(template.category)} · ` : ''}v${template.version || 1} ·
            ${fmtNumber(fields.length)} 个字段${requiredCount ? `（${requiredCount} 个必填）` : ''}${
              template.rules_count ? ` · ${template.rules_count} 条校验` : ''}
            ${(template.tags || []).length ? ` · ${(template.tags || []).map((t) => esc(t)).join(' / ')}` : ''}
            · <a class="link-sm" href="#/templates/${encodeURIComponent(template.id)}">打开模板</a>
          </p>
        </div>
        <button class="btn btn-secondary btn-sm" type="button" data-remove-template>移除模板</button>
      </div>`;
    }

    // 模板字段改过之后，方案里的目标列会和契约对不上。这里只提示 + 给一键同步，
    // 不自动改——用户的列映射是手工配的，静默重建会让人措手不及。
    function renderDrift(template) {
      const drift = templateDrift(config);
      if (!drift || drift.missingTemplate) return '';
      const renamed = drift.renamed || [];
      return `<div class="tpl-drift">
        ${icon('alert')}
        <div class="flex-1">
          <strong>模板字段有变化，和当前目标列对不上</strong>
          <div class="mt-4">
            ${drift.added.length ? `新增 ${drift.added.length} 个字段：${drift.added.slice(0, 6).map((n) => esc(n)).join('、')}${drift.added.length > 6 ? '…' : ''}<br>` : ''}
            ${renamed.length ? `改名 ${renamed.length} 个：${renamed.slice(0, 4).map((r) => `${esc(r.from)} → ${esc(r.to)}`).join('、')}${renamed.length > 4 ? '…' : ''}<br>` : ''}
            ${drift.removed.length ? `模板里已没有：${drift.removed.slice(0, 6).map((n) => esc(n)).join('、')}${drift.removed.length > 6 ? '…' : ''}` : ''}
          </div>
          <div class="tiny mt-4" style="opacity:.8">同步会按模板重建目标列；名称一致的列映射会保留，被删掉的列映射会一起清掉。只是取消勾选的列不算差异。</div>
        </div>
        <button class="btn btn-secondary btn-sm" type="button" data-sync-template>${icon('refresh')}一键同步字段</button>
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
                ${['auto', 'text', 'number', 'date', 'bool'].map((t) => `<option value="${t}" ${(col.type || 'auto') === t ? 'selected' : ''}>${typeName(t)}</option>`).join('')}
              </select>
              <span class="tiny faint">第 ${Number(col.template_col) + 1} 列</span>
              <span class="tiny faint">${col.required ? '<span class="rule-chip required">必填</span>' : ''}${col.included === false ? '保持原样' : '写入数据'}</span>
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
        return m && (m.mode === 'const' || m.formula_on === true || sourcesOf(m).length);
      }).length;
      const formulaCount = cols.filter((c) => config.mappings[c.key]?.formula_on === true).length;
      const chainCount = cols.filter((c) => sourcesOf(config.mappings[c.key]).length > 1).length;
      const aggCount = cols.filter((c) => {
        const combine = combineOf(config.mappings[c.key]);
        return sourcesOf(config.mappings[c.key]).length && combine !== 'first';
      }).length;
      return `
        <section class="section-card" id="section-mapping">
          <div class="section-head">
            <span class="section-num">2</span>
            <div class="section-head-main">
              <h3>字段映射</h3>
              <p>每个目标列从哪来、多行怎么合并，在这里定。按列名自动匹配、逐列手选，或点 ƒx 用公式算。</p>
            </div>
            <div class="section-head-actions">
              ${formulaCount ? `<span class="chip chip-brand">${formulaCount} 列用公式</span>` : ''}
              ${chainCount ? `<span class="chip">${chainCount} 列多来源</span>` : ''}
              ${aggCount ? `<span class="chip">${aggCount} 列做聚合</span>` : ''}
              <span class="chip ${mapped === cols.length && cols.length ? 'chip-brand' : 'chip-gold'}">${mapped} / ${cols.length} 已配置</span>
              <button class="btn btn-secondary btn-sm" type="button" data-auto-map>${icon('wand')}按列名匹配</button>
            </div>
          </div>
          ${!cols.length ? `<div class="empty-inline" style="padding:28px">先在上一步确定目标列，再来设置每一列的数据来源。</div>`
            : !entries.length ? `<div class="empty-inline" style="padding:28px">
                这一段的选项来自「数据来源」：先在下面选好主表（或要合并的表）和主键，每一列就能选来源了。
                <div class="mt-10"><button class="btn btn-secondary btn-sm" type="button" data-goto-sources>${icon('arrow-down')}去设置数据来源</button></div>
              </div>`
              : `<div class="map-scroll">
                  <div class="map-table">
                    <div class="map-row head">
                      <span>目标列</span><span>主来源</span><span>来源字段 / 公式</span><span>处理</span><span>缺省值</span><span></span>
                    </div>
                    ${cols.map((col) => renderMappingRow(col, entries)).join('')}
                  </div>
                </div>`}
          <div class="tiny faint mt-10">缺省值会在来源为空或没有匹配到行时写入；选择「固定值」可给整列写入同一个内容。
            字段右侧的 <b>ƒx</b> 可以用 Excel 公式算出整列；处理方式选「统一为日期」时可再指定显示格式。
            <br>同一个主键在来源表里对应多行时，用每列下方的「取值」决定怎么合并：默认取第一个非空值，也可以求和、计数、取最新、拼接。</div>
        </section>`;
    }

    function aliasHint(mapping) {
      const alias = mapping?.mode === 'table' ? mapping.matched_alias : '';
      // 来源字段后来被改过就别再显示旧提示，免得误导
      if (!alias || (sourcesOf(mapping)[0]?.column_name || '') !== alias) return '';
      return `<div class="map-alias" title="模板列名的严格名称在来源表里没有，按括号里的备注名匹配到这里">
        ${icon('info')}<span>括号备注名「${esc(alias)}」</span></div>`;
    }

    /** 一条来源的可读名字：`表名 · 列名`，列名丢了就退回列号。 */
    function sourceLabel(src) {
      const headers = tableHeaders(src.table_id);
      const name = headers[src.column_index] || `第 ${Number(src.column_index) + 1} 列`;
      return `${tableLabel(src.table_id)} · ${name}`;
    }

    /** 「再叠加一列来源」的下拉：只列参与本次汇总的表，已经用过的列不再出现。 */
    function addSourceOptions(key, sources) {
      const active = activeIdSet();
      const used = new Set(sources.map((src) => `${src.table_id}|${Number(src.column_index)}`));
      const groups = availableTables()
        .filter((entry) => active.has(entry.table.id))
        .map((entry) => {
          const opts = (entry.table.headers || [])
            .map((header, index) => (used.has(`${entry.table.id}|${index}`) ? '' : `<option value="${attr(`${entry.table.id}|${index}`)}">${esc(header)}</option>`))
            .filter(Boolean)
            .join('');
          return opts ? `<optgroup label="${attr(entry.label)}">${opts}</optgroup>` : '';
        })
        .filter(Boolean)
        .join('');
      if (!groups) return '';
      return `<select class="select select-sm chain-add" data-add-source="${attr(key)}" title="这一列还有别的来源时，可以继续叠加，按顺序兜底或汇总">
        <option value="">＋ 再叠加一个来源列…</option>${groups}</select>`;
    }

    /** `latest` 的排序列：只能选来源链里的表，否则后端会退回用本列自身比较。 */
    function orderOptions(mapping, sources) {
      const order = mapping?.order_by;
      const tids = [...new Set(sources.map((src) => src.table_id))];
      let html = `<option value="">按本列自身比较</option>`;
      for (const tid of tids) {
        const headers = tableHeaders(tid);
        for (let i = 0; i < headers.length; i += 1) {
          const selected = order && order.table_id === tid && Number(order.column_index) === i;
          html += `<option value="${attr(`${tid}|${i}`)}" ${selected ? 'selected' : ''}>${esc(tableLabel(tid))} · ${esc(headers[i])}</option>`;
        }
      }
      return html;
    }

    function chainNote(combine, count) {
      const scope = count > 1 ? `这 ${count} 个来源按顺序` : '同一主键匹配到的多行';
      if (combine === 'sum') return `${scope}的数值合计`;
      if (combine === 'count') return `统计${scope}里有值的条数`;
      if (combine === 'max' || combine === 'min') return `${scope}取${combine === 'max' ? '最大' : '最小'}的一个`;
      if (combine === 'latest') return '按排序列取最新的一条';
      if (combine === 'concat') return `${scope}拼接起来，重复的只留一次`;
      return `${scope}，取第一个有值的`;
    }

    /** 一行专属的「取值方式」：合并方式 + 额外来源 + 排序列。 */
    function renderChainRow(col, mapping, sources) {
      const combine = combineOf(mapping);
      const meta = COMBINES.find((item) => item.key === combine) || COMBINES[0];
      const extra = sources.slice(1);
      return `
        <div class="map-chain" data-chain-row="${attr(col.key)}">
          <span class="chain-lead" title="${attr(meta.hint)}">${icon('layers')}取值</span>
          <select class="select select-sm" data-map-combine="${attr(col.key)}" title="${attr(meta.hint)}">
            ${COMBINES.map((item) => `<option value="${item.key}" ${item.key === combine ? 'selected' : ''}>${item.label}</option>`).join('')}
          </select>
          <div class="chain-body">
            <span class="chain-note">${esc(chainNote(combine, sources.length))}</span>
            ${extra.map((src, i) => `<span class="chain-chip">
              ${esc(sourceLabel(src))}
              <button class="chain-x" type="button" data-src-remove="${attr(`${col.key}:${i + 1}`)}" title="移除这个来源">${icon('x')}</button>
            </span>`).join('')}
            ${addSourceOptions(col.key, sources)}
          </div>
          ${combine === 'latest' ? `<div class="chain-order">
            <span class="chain-lead">按哪列排序</span>
            <select class="select select-sm" data-map-order="${attr(col.key)}">${orderOptions(mapping, sources)}</select>
          </div>` : ''}
        </div>`;
    }

    function renderMappingRow(col, entries) {
      const mapping = config.mappings[col.key];
      const sources = sourcesOf(mapping);
      const mode = mapping?.mode || 'blank';
      const useFormula = mapping?.formula_on === true;
      const expr = formulaOf(mapping);
      const invalid = !useFormula && sources.some((src) => !tableHeaders(src.table_id).length);
      const transform = sources[0]?.transform || 'direct';
      const showDateFormat = !useFormula && sources.length > 0 && transform === 'date';
      const statusOff = !useFormula && !sources.length && mode !== 'const';
      const hasTable = sources.length > 0;
      return `
        <div class="map-row ${(statusOff || invalid) ? 'needs-attention' : ''}" data-map-row="${attr(col.key)}">
          <div class="map-target">
            <span class="name" title="${attr(col.name)}">${esc(col.name)}</span>
            <span class="type">${typeName(col.type)}</span>
          </div>
          <select class="select select-sm" data-map-source="${attr(col.key)}">
            ${mappingSourceOptions(col, mapping)}
          </select>
          <div class="map-field">
            ${useFormula
              ? `<button class="fx-chip" type="button" data-map-formula="${attr(col.key)}" title="点击编辑公式">
                   <span class="fx-mark">ƒx</span>
                   <span class="fx-expr">${esc(expr.trim() || '公式为空，点此填写')}</span>
                 </button>`
              : hasTable
                ? `<div class="field-with-fx">
                     <select class="select select-sm" data-map-field="${attr(col.key)}">${fieldOptions(col, mapping)}</select>
                     <button class="fx-btn" type="button" data-map-formula="${attr(col.key)}" title="用 Excel 公式计算这一列">ƒx</button>
                   </div>
                   ${aliasHint(mapping)}`
                : mode === 'const'
                  ? `<input class="input input-sm" value="${attr(mapping?.value || '')}" data-map-const="${attr(col.key)}" placeholder="固定内容">`
                  : `<span class="tiny faint">该列输出为空</span>`}
          </div>
          <div class="map-transform">
            <select class="select select-sm" data-map-transform="${attr(col.key)}" ${!hasTable || useFormula ? 'disabled' : ''}>
              ${transformOptions(transform)}
            </select>
            ${showDateFormat ? `<select class="select select-sm fmt-select" data-map-datefmt="${attr(col.key)}" title="日期显示格式">
              ${DATE_FORMAT_PRESETS.map(([value, sample]) => `<option value="${attr(value)}" ${(sources[0]?.date_format || mapping?.date_format || '') === value ? 'selected' : ''}>${esc(sample)}</option>`).join('')}
            </select>` : ''}
          </div>
          <div>
            <input class="input input-sm" value="${attr(mapping?.fallback || '')}" data-map-fallback="${attr(col.key)}"
              placeholder="${useFormula ? '公式结果' : hasTable ? '可留空' : '—'}" ${!hasTable || useFormula ? 'disabled' : ''}>
          </div>
          <div class="map-status ${invalid ? 'warn' : statusOff ? 'off' : ''}" title="${invalid ? '来源已失效' : statusOff ? '尚未配置' : useFormula ? '公式计算' : '已配置'}">
            ${invalid ? icon('alert') : statusOff ? icon('info') : icon('check-circle')}
          </div>
        </div>
        ${!useFormula && hasTable ? renderChainRow(col, mapping, sources) : ''}`;
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
            ${renderTargetSection()}
            ${renderMappingSection()}
            ${renderSourceSection()}
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

      // 目标表（入口可能同时存在两处：区块标题旁 + 未用模板时的行动区）
      view.querySelectorAll('[data-change-template]').forEach((btn) => {
        btn.addEventListener('click', openTemplateDialog);
      });
      view.querySelector('[data-remove-template]')?.addEventListener('click', removeTemplate);
      view.querySelector('[data-sync-template]')?.addEventListener('click', syncTemplateFields);
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
      view.querySelector('[data-auto-map]')?.addEventListener('click', async (event) => {
        const btn = event.currentTarget;
        btn.disabled = true;
        try {
          const count = await autoMap();
          if (count) markDirty(true);
        } finally {
          btn.disabled = false;
        }
      });
      // 映射列表为空时给一个跳到「数据来源」的入口，别让人卡在这一段
      view.querySelectorAll('[data-goto-sources]').forEach((btn) => btn.addEventListener('click', () => {
        document.getElementById('section-sources')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }));
      view.querySelectorAll('[data-goto-mapping]').forEach((btn) => btn.addEventListener('click', () => {
        document.getElementById('section-mapping')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }));
      view.querySelectorAll('[data-map-source]').forEach((select) => {
        select.addEventListener('change', () => {
          const key = select.dataset.mapSource;
          const col = config.target.columns.find((c) => c.key === key);
          if (!col) return;
          const value = select.value;
          const old = config.mappings[key] || {};
          const chain = sourcesOf(old);
          // 从「公式计算」改成具体来源时，把公式关掉（公式正文保留，随时能再打开）
          const formulaOff = old.formula_on === true;
          if (value === 'const') {
            config.mappings[key] = { mode: 'const', value: old.value || '' };
          } else if (value === 'blank' || value === '') {
            config.mappings[key] = { mode: 'blank', formula_on: false, formula: old.formula || '' };
          } else if (value.startsWith('table:')) {
            const tableId = value.slice(6);
            const headers = tableHeaders(tableId);
            // 先按同名猜一个默认字段；猜不到就落到第一列，再异步问一次后端
            // （括号备注名的规则只在 column_match 里实现，前端不复刻）
            const guess = headers.indexOf(col.name);
            const index = guess >= 0 ? guess : 0;
            // 换主来源时保留其余来源，避免手配好的兜底链被一次误操作清空
            const rest = chain.filter((src) => src.table_id !== tableId);
            config.mappings[key] = {
              ...old,
              mode: 'table',
              formula_on: false,
              sources: [{ table_id: tableId, column_index: index, column_name: headers[index] || '', transform: old.transform || 'direct' }, ...rest],
              combine: combineOf(old),
              separator: old.separator || '、',
              order_by: old.order_by || null,
              fallback: old.fallback || '',
            };
            delete config.mappings[key].table_id;
            delete config.mappings[key].column_index;
            delete config.mappings[key].matched_alias;
            if (guess < 0) fillByAlias(key, col.name, tableId, headers);
          }
          if (formulaOff) {
            toast('这一列已改为按来源取数，原公式还留着，点 ƒx 可以再启用。', 'info');
          }
          markDirty(true);
        });
      });
      view.querySelectorAll('[data-map-field]').forEach((select) => {
        select.addEventListener('change', () => {
          const key = select.dataset.mapField;
          const mapping = config.mappings[key];
          const chain = sourcesOf(mapping);
          if (!chain.length) return;
          const headers = tableHeaders(chain[0].table_id);
          const index = Number(select.value);
          chain[0].column_index = index;
          chain[0].column_name = headers[index] || '';
          mapping.sources = chain;
          // 用户手选了字段，「靠括号备注名命中」的标记就不成立了，重绘一次把提示收掉
          const hadAlias = !!mapping.matched_alias;
          delete mapping.matched_alias;
          markDirty(hadAlias);
          paintSaveStatus();
        });
      });
      view.querySelectorAll('[data-map-transform]').forEach((select) => {
        select.addEventListener('change', () => {
          const key = select.dataset.mapTransform;
          const mapping = config.mappings[key];
          const chain = sourcesOf(mapping);
          if (!mapping || !chain.length) return;
          const wasDate = chain[0].transform === 'date';
          chain[0].transform = select.value;
          mapping.sources = chain;
          // 进出「统一为日期」都要重绘：进要出现格式下拉，出要收掉
          markDirty(wasDate || select.value === 'date');
        });
      });
      view.querySelectorAll('[data-map-combine]').forEach((select) => {
        select.addEventListener('change', () => {
          const mapping = config.mappings[select.dataset.mapCombine];
          if (!mapping) return;
          mapping.combine = select.value;
          // 换成「取最新一条」时要出现排序列下拉，其他方式收掉
          markDirty(true);
        });
      });
      view.querySelectorAll('[data-map-order]').forEach((select) => {
        select.addEventListener('change', () => {
          const mapping = config.mappings[select.dataset.mapOrder];
          if (!mapping) return;
          if (!select.value) {
            mapping.order_by = null;
          } else {
            const [tableId, index] = select.value.split('|');
            mapping.order_by = { table_id: tableId, column_index: Number(index) };
          }
          markDirty(false);
        });
      });
      view.querySelectorAll('[data-add-source]').forEach((select) => {
        select.addEventListener('change', () => {
          const key = select.dataset.addSource;
          const mapping = config.mappings[key];
          if (!mapping || !select.value) return;
          const [tableId, index] = select.value.split('|');
          const chain = sourcesOf(mapping);
          const headers = tableHeaders(tableId);
          chain.push({
            table_id: tableId,
            column_index: Number(index),
            column_name: headers[Number(index)] || '',
            transform: 'direct',
          });
          mapping.sources = chain;
          if (!mapping.combine) mapping.combine = 'first';
          markDirty(true);
        });
      });
      view.querySelectorAll('[data-src-remove]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const [key, rawIndex] = btn.dataset.srcRemove.split(':');
          const mapping = config.mappings[key];
          if (!mapping) return;
          const index = Number(rawIndex);
          const chain = sourcesOf(mapping);
          if (index <= 0 || index >= chain.length) return;
          chain.splice(index, 1);
          mapping.sources = chain;
          markDirty(true);
        });
      });
      view.querySelectorAll('[data-map-datefmt]').forEach((select) => {
        select.addEventListener('change', () => {
          const mapping = config.mappings[select.dataset.mapDatefmt];
          if (!mapping) return;
          mapping.date_format = select.value;
          scheduleSave();
          const label = select.options[select.selectedIndex]?.text || select.value;
          toast(select.value ? `日期显示为 ${label}` : '日期格式改回跟随全局设置', 'ok');
        });
      });
      view.querySelectorAll('[data-map-formula]').forEach((btn) => {
        btn.addEventListener('click', () => openFormulaDialog(btn.dataset.mapFormula));
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
          ${templates.length ? `<div class="stack" style="gap:9px">${templates.map((t) => {
            const fields = t.fields || [];
            const required = fields.filter((f) => f.required).length;
            return `
            <div class="template-banner">
              <div class="file-badge template">${icon('file-spreadsheet')}</div>
              <div class="template-banner-main">
                <strong>${esc(t.name)}</strong>
                <p>${t.category ? `${esc(t.category)} · ` : ''}v${t.version || 1} · ${fmtNumber(t.field_count || fields.length)} 个字段${
                  required ? `（${required} 个必填）` : ''}${t.rules_count ? ` · ${t.rules_count} 条校验` : ''}${
                  (t.tags || []).length ? ` · ${(t.tags || []).map((x) => esc(x)).join(' / ')}` : ''}</p>
              </div>
              <a class="btn btn-ghost btn-sm" href="#/templates/${encodeURIComponent(t.id)}" title="去模板库编辑字段">${icon('settings')}</a>
              <button class="btn btn-secondary btn-sm" type="button" data-pick-template="${attr(t.id)}">选择</button>
            </div>`;
          }).join('')}</div>` : `<div class="empty small"><div class="empty-icon">${icon('file-spreadsheet')}</div><h3>还没有模板</h3><p>先去「数据模板」定义目标表的字段，或者现在上传一份现成的 Excel 表头。</p><a class="btn btn-secondary btn-sm" href="#/templates">去数据模板</a></div>`}
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
            autoMap({ silent: true }).then(() => markDirty(true));
            ref.close();
            toast(`已应用模板「${template.name}」的工作表「${sheet.name}」。`, 'ok');
          });
        });
      }

      renderLibrary();
    }

    /** 按模板当前字段重建目标列，尽量保住已有映射（同名列 key 不变）。 */
    function syncTemplateFields() {
      const template = targetTemplate();
      if (!template) return;
      const drift = templateDrift(config);
      const willDrop = drift?.removed || [];
      confirmDialog({
        title: '按模板同步目标列',
        message: '目标列会按模板字段重建，列名与顺序以模板为准。',
        detail: `<div class="warning-note">${icon('alert')}<span>${
          willDrop.length ? `这些列在模板里已经没有了，同步后会被移除：${willDrop.slice(0, 8).map((n) => esc(n)).join('、')}${willDrop.length > 8 ? '…' : ''}` : '同名列的映射会保留。'
        }</span></div>`,
        confirmText: '同步',
      }).then((ok) => {
        if (!ok) return;
        const sheet = (template.meta?.sheets || template.sheets || []).find((s) => s.name === config.target.sheet)
          || { name: config.target.sheet, header_row: config.target.header_row, headers: (template.fields || []).map((f) => f.name) };
        applyTemplateToTarget(config, template, sheet);
        autoMap({ silent: true }).then(() => markDirty(true));
        toast(`已按模板「${template.name}」同步 ${config.target.columns.length} 个目标列。`, 'ok');
      });
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
        autoMap({ silent: true }).then(() => markDirty(true));
        ref.close();
        toast(`已导入 ${newCols.length} 个列名。`, 'ok');
      });
    }

    // ---------- 字段公式 ----------
    function openFormulaDialog(colKey) {
      const col = config.target.columns.find((c) => c.key === colKey);
      if (!col) return;
      const tableIds = activeIds();
      if (!tableIds.length) {
        toast('先选择主表或要合并的数据表，公式才有字段可引用。', 'warn');
        return;
      }
      const fields = [];
      for (const tid of tableIds) {
        for (const header of tableHeaders(tid)) {
          if (header && !fields.includes(header)) fields.push(header);
        }
      }
      // 试算用「有数据的表」：join 用主表，append 用第一张合并表
      const tryTable = config.mode === 'join'
        ? (config.primary_table || tableIds[0])
        : (config.append_tables[0] || tableIds[0]);
      const mapping = config.mappings[colKey] || {};
      const isDateCol = (col.type || 'auto') === 'date';
      const initialDateFmt = mapping.date_format || '';
      let timer = null;
      let lastValid = null;

      const ref = openModal({
        title: `用公式计算「${esc(col.name)}」`,
        sub: '引用字段写成 [字段名]，公式以 = 开头（可省略）。改完会自动校验并试算前 5 行。',
        size: 'modal-xl',
        body: `
          <div class="fx-dialog">
            <div class="fx-input-wrap">
              <span class="fx-prefix">ƒx</span>
              <input class="input fx-input" data-fx-input spellcheck="false" autocomplete="off"
                placeholder="例如 =[单价]*[数量] 或 =IF([数量]>0, [金额]/[数量], 0)"
                value="${attr(formulaOf(mapping))}">
            </div>
            <div class="fx-status idle" data-fx-status><span class="faint">填写后自动校验并试算。</span></div>
            <div class="fx-grid">
              <div class="fx-pane">
                <div class="fx-pane-title">可引用的字段 <span class="faint">点一下插入</span></div>
                <div class="fx-chips">
                  ${fields.length
                    ? fields.map((f) => `<button class="fx-field" type="button" data-fx-field="${attr(f)}">${esc(f)}</button>`).join('')
                    : '<span class="tiny faint">还没有可用字段</span>'}
                </div>
              </div>
              <div class="fx-pane">
                <div class="fx-pane-title">函数速查 <span class="faint">点一下插入</span></div>
                <div class="fx-funcs" data-fx-funcs><span class="tiny faint">加载中…</span></div>
              </div>
            </div>
            ${isDateCol ? `<div class="fx-date-row">
              <span class="fx-date-label">日期显示格式</span>
              <select class="select select-sm" data-fx-datefmt>
                ${DATE_FORMAT_PRESETS.map(([value, sample]) => `<option value="${attr(value)}" ${initialDateFmt === value ? 'selected' : ''}>${esc(sample)}</option>`).join('')}
              </select>
              <span class="tiny faint">公式算出日期时，Excel 里按这个格式显示</span>
            </div>` : ''}
            <div class="fx-pane fx-preview-pane">
              <div class="fx-pane-title">前 5 行试算 <span class="faint" data-fx-src></span></div>
              <div data-fx-preview><span class="tiny faint">—</span></div>
            </div>
          </div>`,
        footer: `
          ${mapping.formula_on ? '<button class="btn btn-secondary" type="button" data-fx-off>关闭公式</button>' : ''}
          <button class="btn btn-secondary" type="button" data-close>取消</button>
          <button class="btn btn-primary" type="button" data-fx-apply>应用公式</button>`,
      });

      const input = ref.modal.querySelector('[data-fx-input]');
      const statusBox = ref.modal.querySelector('[data-fx-status]');
      const previewBox = ref.modal.querySelector('[data-fx-preview]');
      const srcLabel = ref.modal.querySelector('[data-fx-src]');
      const dateSelect = ref.modal.querySelector('[data-fx-datefmt]');

      const setStatus = (kind, html) => {
        statusBox.className = `fx-status ${kind}`;
        statusBox.innerHTML = html;
      };

      function renderTry(res) {
        srcLabel.textContent = res.total_rows ? `取自「${tableLabel(tryTable)}」共 ${res.total_rows} 行` : '';
        if (!res.samples?.length) {
          previewBox.innerHTML = '<span class="tiny faint">这张表没有数据行可试算。</span>';
          return;
        }
        previewBox.innerHTML = `<table class="table compact fx-table">
          <thead><tr><th style="width:52px">行</th><th>引用的字段值</th><th>计算结果</th></tr></thead>
          <tbody>${res.samples.map((s) => `<tr>
            <td class="faint">${s.row}</td>
            <td class="fx-inputs">${res.refs.length
              ? res.refs.map((r) => `<span class="fx-kv"><b>${esc(r)}</b>${esc(sampleText(s.inputs?.[r]))}</span>`).join('')
              : '<span class="faint">—</span>'}</td>
            <td>${s.error
              ? `<span class="fx-err">${esc(s.error)}</span> <span class="tiny faint">${esc(s.message || '')}</span>`
              : `<b>${esc(sampleText(s.result))}</b>`}</td>
          </tr>`).join('')}</tbody>
        </table>`;
      }

      async function checkAndTry() {
        const value = input.value.trim();
        lastValid = null;
        if (!value) {
          setStatus('idle', '<span class="faint">公式为空。填写后会自动校验并试算。</span>');
          previewBox.innerHTML = '<span class="tiny faint">—</span>';
          srcLabel.textContent = '';
          return;
        }
        setStatus('busy', '<span class="spinner spinner-sm"></span><span>正在校验…</span>');
        let check;
        try {
          check = await api.formulaCheck(value, tableIds);
        } catch (err) {
          setStatus('bad', `${icon('alert')}<span>${esc(err.message)}</span>`);
          previewBox.innerHTML = '<span class="tiny faint">—</span>';
          return;
        }
        if (!check.valid) {
          setStatus('bad', `${icon('alert')}<span>${esc(check.error || '公式有问题')}</span>`);
          previewBox.innerHTML = '<span class="tiny faint">—</span>';
          return;
        }
        lastValid = value;
        setStatus('good', `${icon('check-circle')}<span>语法正确，引用了 ${check.refs.length} 个字段${check.refs.length ? `：${esc(check.refs.join('、'))}` : ''}</span>`);
        try {
          renderTry(await api.formulaTry(value, tryTable, 5));
        } catch (err) {
          previewBox.innerHTML = `<span class="tiny faint">${esc(err.message)}</span>`;
        }
      }

      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(checkAndTry, 350);
      });

      ref.modal.querySelectorAll('[data-fx-field]').forEach((btn) => {
        btn.addEventListener('click', () => insertAtCursor(input, `[${btn.dataset.fxField}]`));
      });
      ref.modal.querySelector('[data-close]').addEventListener('click', ref.close);

      ref.modal.querySelector('[data-fx-off]')?.addEventListener('click', () => {
        config.mappings[colKey] = { ...(config.mappings[colKey] || {}), formula_on: false };
        ref.close();
        markDirty(true);
        toast('已关闭公式，这一列改回普通映射。', 'ok');
      });

      ref.modal.querySelector('[data-fx-apply]').addEventListener('click', async () => {
        // 先掐掉待执行的 debounce 校验：否则空公式的报错会被它的 idle 状态覆盖，
        // 用户在界面上只会看到提示一闪而过。
        clearTimeout(timer);
        const value = input.value.trim();
        if (!value) {
          setStatus('bad', `${icon('alert')}<span>公式不能为空。不想用公式的话，点「关闭公式」或「取消」。</span>`);
          input.focus();
          return;
        }
        if (lastValid !== value) await checkAndTry();
        if (lastValid !== value) {
          toast('公式还没通过校验，请先按提示修正。', 'warn');
          return;
        }
        const next = {
          ...(config.mappings[colKey] || { mode: 'blank' }),
          formula: value,
          formula_on: true,
        };
        if (dateSelect) next.date_format = dateSelect.value || '';
        config.mappings[colKey] = next;
        ref.close();
        markDirty(true);
        toast('公式已应用，生成时会按公式计算这一列。', 'ok');
      });

      loadFormulaHelp().then((help) => {
        const box = ref.modal.querySelector('[data-fx-funcs]');
        if (!box) return;
        box.innerHTML = help.functions.map((group) => `
          <div class="fx-func-group">
            <div class="fx-func-group-title">${esc(group.group)}</div>
            <div class="fx-func-list">
              ${group.items.map((it) => `<button class="fx-func" type="button" data-fx-fn="${attr(it.name)}"
                title="${attr(`${it.sig} — ${it.desc}`)}">${esc(it.name)}</button>`).join('')}
            </div>
          </div>`).join('');
        box.querySelectorAll('[data-fx-fn]').forEach((btn) => {
          btn.addEventListener('click', () => insertAtCursor(input, `${btn.dataset.fxFn}(`));
        });
      }).catch(() => {
        const box = ref.modal.querySelector('[data-fx-funcs]');
        if (box) box.innerHTML = '<span class="tiny faint">函数清单没加载出来，直接手写公式也能用。</span>';
      });

      if (input.value.trim()) checkAndTry();
      setTimeout(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }, 60);
    }

    // ---------- 预览与运行 ----------
    function previewTable(headers, rows, max = 50) {
      if (!headers.length) return `<div class="empty small"><div class="empty-icon">${icon('table')}</div><h3>没有可预览的列</h3></div>`;
      // 预览里就按配置的日期格式显示，避免「预览是 2026-10-21、Excel 里是 2026年10月21日」
      const cols = includedColumns(config);
      const formats = cols.map((c) => config.mappings[c.key]?.date_format || '');
      return `<div class="preview-scroll">
        <table class="table compact">
          <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${rows.slice(0, max).map((row) => `<tr>${headers.map((_, i) => {
            const raw = row[i];
            const value = formats[i] ? formatDateByPattern(raw, formats[i]) : raw;
            return `<td><div class="preview-cell" title="${attr(value ?? '')}">${value === null || value === undefined || value === '' ? '<span class="faint">—</span>' : esc(value)}</div></td>`;
          }).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>`;
    }

    /**
     * 列完成度：模板驱动下最常问的一句是「哪个字段还是空的」。
     * 有空的列排在前面，必填列的空值标红，默认展开。
     */
    function columnStatsPanel(columnStats, totalRows) {
      const list = columnStats || [];
      if (!list.length || !totalRows) return '';
      const order = [...list].sort((a, b) => (b.empty_rate || 0) - (a.empty_rate || 0));
      const emptyCols = list.filter((c) => c.empty > 0);
      const requiredEmpty = list.filter((c) => c.empty > 0 && c.required);
      return `<details class="colstat-panel" ${emptyCols.length ? 'open' : ''}>
        <summary>
          ${icon('columns')}
          <span>列完成度：${list.length - emptyCols.length} / ${list.length} 列全满</span>
          ${emptyCols.length ? `<span class="chip chip-gold">${emptyCols.length} 列有空值</span>` : `<span class="chip chip-brand">全部填满</span>`}
          ${requiredEmpty.length ? `<span class="chip chip-gold">必填缺 ${requiredEmpty.length} 列</span>` : ''}
        </summary>
        <div class="colstat-list">
          ${order.map((c) => {
            const rate = 1 - (Number(c.empty_rate) || 0);
            return `<div class="colstat ${c.empty ? (c.required ? 'bad' : 'warn') : 'ok'}">
              <span class="colstat-name" title="${attr(c.name)}">${esc(c.name)}${c.required ? '<span class="req">*</span>' : ''}</span>
              <span class="colstat-bar"><i style="width:${Math.round(rate * 100)}%"></i></span>
              <span class="colstat-val">${c.empty ? `${fmtNumber(c.empty)} 空` : '全满'}</span>
            </div>`;
          }).join('')}
        </div>
      </details>`;
    }

    async function handlePreview(button) {      const v = validate();
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
            ${columnStatsPanel(data.column_stats, s.rows)}
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
