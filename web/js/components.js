/** 跨页面复用的 UI 片段与交互。 */
import { api } from './api.js';
import {
  activeTableIds, includedColumns, loadBootstrap, state, tableLabel,
} from './store.js';
import {
  attr, esc, fmtDate, fmtNumber, icon, openModal, timeAgo, toast, withButtonLoading,
} from './ui.js';

export function modeLabel(mode) {
  return mode === 'append' ? '纵向合并' : '主表关联';
}

export function profileCard(profile) {
  const cfg = profile.config || {};
  const cols = includedColumns(cfg);
  const sources = activeTableIds(cfg);
  const ready = cols.length > 0 && sources.length > 0;
  const mode = modeLabel(cfg.mode);
  return `
    <a class="profile-card" href="#/profiles/${encodeURIComponent(profile.id)}">
      <div class="profile-card-top">
        <div class="profile-icon">${icon(cfg.mode === 'append' ? 'layers' : 'table')}</div>
        <div class="flex-1" style="min-width:0">
          <div class="profile-name truncate">${esc(profile.name)}</div>
          <div class="profile-note">${esc(profile.note || '尚未填写方案说明')}</div>
        </div>
        <span class="chip ${ready ? 'chip-brand' : 'chip-gold'}">${esc(mode)}</span>
      </div>
      <div class="profile-meta">
        <span class="chip">${icon('columns')}${cols.length} 个输出列</span>
        <span class="chip">${icon('database')}${sources.length} 张数据表</span>
        ${cfg.target?.kind === 'template' ? `<span class="chip chip-plain">${icon('file-spreadsheet')}模板输出</span>` : ''}
      </div>
      <div class="profile-foot">
        <span>${profile.last_run_at ? `最近生成 ${timeAgo(profile.last_run_at)}` : '还没有生成过'}</span>
        <span class="open">打开方案 ${icon('arrow-right')}</span>
      </div>
    </a>`;
}

export function runMiniItem(run) {
  const rows = run.summary?.rows ?? 0;
  return `
    <div class="run-item">
      <div class="run-dot">${icon('file-spreadsheet')}</div>
      <div class="run-main">
        <div class="run-title">${esc(run.profile_name || '未命名方案')}</div>
        <div class="run-sub">${fmtDate(run.created_at, true, true)} · ${fmtNumber(rows)} 行 · ${esc(run.output_name || '')}</div>
      </div>
      <div class="run-actions">
        <a class="icon-btn" href="${attr(run.download_url)}" title="下载结果" aria-label="下载结果">${icon('download')}</a>
        <button class="icon-btn" type="button" data-run-detail="${attr(run.id)}" title="查看详情" aria-label="查看详情">${icon('info')}</button>
      </div>
    </div>`;
}

export function openRunDetail(run) {
  const s = run.summary || {};
  const warnings = s.warnings || [];
  const sources = s.sources || [];
  const cells = (s.rows || 0) * (s.columns || 0);
  const fillRate = cells ? Math.round(((s.filled_cells || 0) / cells) * 100) : 0;
  const warningsHtml = warnings.length
    ? `<div class="diff-warnings mt-14">${warnings.map((w) => `<div class="diff-warning">${icon('alert')}<span>${esc(w)}</span></div>`).join('')}</div>`
    : '';
  const sourcesHtml = sources.length
    ? `<div class="mt-16"><div class="field-label mb-8">参与汇总的数据表</div>
        <div class="flex flex-wrap gap-6">${sources.map((item) => `<span class="chip">${icon('table')}${esc(item.label)} · ${fmtNumber(item.rows)} 行</span>`).join('')}</div></div>`
    : '';
  const ref = openModal({
    title: '生成详情',
    sub: `${esc(run.profile_name || '')} · ${fmtDate(run.created_at, true, true)}`,
    body: `
      <div class="grid-3" style="gap:10px">
        <div class="diff-stat same"><div class="label">${icon('rows')}输出行数</div><div class="value">${fmtNumber(s.rows || 0)}</div><div class="sub">共 ${fmtNumber(s.columns || 0)} 列</div></div>
        <div class="diff-stat same"><div class="label">${icon('check-circle')}填充率</div><div class="value">${fillRate}%</div><div class="sub">${fmtNumber(s.empty_cells || 0)} 个空单元格</div></div>
        <div class="diff-stat same"><div class="label">${icon('clock')}耗时</div><div class="value">${fmtNumber(run.duration_ms || s.duration_ms || 0)}<small style="font-size:11px;color:var(--faint)"> ms</small></div><div class="sub">${esc(s.mode === 'append' ? '纵向合并' : '主表关联')}</div></div>
      </div>
      ${sourcesHtml}
      ${warningsHtml}
      <div class="info-list mt-16">
        <div class="info-row"><span class="k">结果文件</span><span class="v">${esc(run.output_name || '—')}</span></div>
        <div class="info-row"><span class="k">输出工作表</span><span class="v">${esc(s.output?.sheet || '—')} · 第 ${esc(s.output?.header_row || 1)} 行表头</span></div>
        <div class="info-row"><span class="k">关联命中</span><span class="v">${fmtNumber(s.matched || 0)} 次 · 未命中 ${fmtNumber(s.missing || 0)} 次</span></div>
      </div>`,
    footer: `
      <button class="btn btn-secondary" type="button" data-close>关闭</button>
      <a class="btn btn-primary" href="${attr(run.download_url)}">${icon('download')}下载结果</a>`,
  });
  ref.modal.querySelector('[data-close]').addEventListener('click', ref.close);
}

export function columnsFromSheet(sheet, existing = []) {
  return (sheet.headers || []).map((name, index) => {
    const old = existing.find((c) => c.name === name);
    return {
      key: old?.key || `c_${Math.random().toString(36).slice(2, 9)}`,
      name,
      type: old?.type || 'auto',
      width: old?.width || 14,
      included: old?.included !== false,
      template_col: index,
    };
  });
}

export function applyTemplateToTarget(config, template, sheet) {
  const oldCols = config.target?.columns || [];
  const oldMappings = config.mappings || {};
  const newCols = columnsFromSheet(sheet, oldCols);
  const newMappings = {};
  for (const col of newCols) {
    if (oldMappings[col.key]) newMappings[col.key] = oldMappings[col.key];
  }
  config.target = {
    ...config.target,
    kind: 'template',
    template_id: template.id,
    sheet: sheet.name,
    header_row: sheet.header_row || 1,
    write_mode: config.target?.write_mode || 'replace',
    columns: newCols,
  };
  config.mappings = newMappings;
  return config;
}

export function openCreateProfileModal({ onCreated } = {}) {
  const templates = state.templates || [];
  const templateOptions = templates.map((t) => {
    const sheetCount = t.meta?.sheets?.length || 0;
    return `<option value="${attr(t.id)}">${esc(t.name)}（${sheetCount} 个工作表）</option>`;
  }).join('');
  let mode = 'join';
  const ref = openModal({
    title: '新建汇总方案',
    sub: '一个方案对应一项固定的汇总工作，可以反复使用。',
    size: 'modal-lg',
    body: `
      <div class="field">
        <label class="field-label" for="np-name">方案名称 <span class="req">*</span></label>
        <input class="input" id="np-name" maxlength="80" placeholder="例如：10 月人员信息汇总" autocomplete="off">
        <div class="field-hint">建议写清楚用途和周期，方便同事辨认。</div>
      </div>
      <div class="field mt-18">
        <span class="field-label">行数据怎么产生？</span>
        <div class="mode-grid" data-mode-grid>
          <label class="mode-option selected" data-mode="join">
            <span class="mode-icon">${icon('link')}</span>
            <span class="mode-main"><strong>以主表为准，关联补齐</strong><p>适合人员名单、订单台账：一行一个对象，其他表格按主键把字段补进来。</p></span>
            <span class="mode-check">${icon('check')}</span>
            <input type="radio" name="np-mode" value="join" checked>
          </label>
          <label class="mode-option" data-mode="append">
            <span class="mode-icon">${icon('layers')}</span>
            <span class="mode-main"><strong>多张表纵向合并</strong><p>适合结构相同的多个月份 / 多个部门的表，按列名上下拼接成一张总表。</p></span>
            <span class="mode-check">${icon('check')}</span>
            <input type="radio" name="np-mode" value="append">
          </label>
        </div>
      </div>
      <div class="field mt-18">
        <label class="field-label" for="np-template">目标 Excel 模板（可选）</label>
        <select class="select" id="np-template">
          <option value="">先不使用模板，稍后在方案里设置</option>
          ${templateOptions}
        </select>
        <div class="field-hint">如果汇总结果要填进公司固定格式的表格，选择已有模板；也可以创建后在方案里上传。</div>
      </div>
      ${templates.length === 0 ? `<div class="rail-tip mt-14">${icon('info')}<span>还没有上传过模板。创建方案后，可以在「目标表」里上传带格式的 Excel 模板。</span></div>` : ''}`,
    footer: `
      <button class="btn btn-secondary" type="button" data-cancel>取消</button>
      <button class="btn btn-primary" type="button" data-create>${icon('plus')}创建方案</button>`,
  });

  ref.modal.querySelectorAll('.mode-option').forEach((option) => {
    option.addEventListener('click', () => {
      mode = option.dataset.mode;
      ref.modal.querySelectorAll('.mode-option').forEach((el) => {
        el.classList.toggle('selected', el === option);
      });
    });
  });
  ref.modal.querySelector('[data-cancel]').addEventListener('click', ref.close);
  const nameInput = ref.modal.querySelector('#np-name');
  setTimeout(() => nameInput.focus(), 60);

  ref.modal.querySelector('[data-create]').addEventListener('click', async (event) => {
    const name = nameInput.value.trim();
    if (!name) {
      toast('请先填写方案名称。', 'warn');
      nameInput.focus();
      return;
    }
    const templateId = ref.modal.querySelector('#np-template').value;
    const template = state.templates.find((t) => t.id === templateId);
    const config = {
      mode,
      primary_table: '',
      primary_keys: [],
      lookups: [],
      append_tables: [],
      auto_by_name: true,
      target: {
        kind: 'blank', template_id: null, sheet: '汇总', header_row: 1,
        write_mode: 'replace', columns: [],
      },
      mappings: {},
      options: { dedupe: true, skip_empty_key: true },
    };
    if (template && template.meta?.sheets?.length) {
      applyTemplateToTarget(config, template, template.meta.sheets[0]);
    }
    const restore = withButtonLoading(event.currentTarget, '创建中…');
    try {
      const data = await api.createProfile({ name, mode, config });
      await loadBootstrap();
      ref.close();
      toast('方案已创建，接下来选择数据来源。', 'ok');
      if (onCreated) onCreated(data.profile);
    } catch (err) {
      toast(err.message, 'error');
      restore();
    }
  });
}

export function sourceTableOptions(selected = '', { placeholder = '请选择数据表', ids = null } = {}) {
  let entries = [];
  const seenGroups = new Set();
  const groups = [];
  for (const source of state.sources) {
    const walk = (node, prefix = '') => {
      for (const table of node.meta?.tables || []) {
        if (ids && !ids.includes(table.id)) continue;
        const groupName = node.kind === 'email'
          ? `邮件 · ${node.meta?.email?.subject || node.name}`
          : `${prefix}${node.name}`;
        let group = groups.find((g) => g.name === groupName);
        if (!group) {
          group = { name: groupName, options: [] };
          groups.push(group);
        }
        group.options.push({
          value: table.id,
          label: `${table.label} · ${fmtNumber(table.row_count)} 行`,
          selected: table.id === selected,
        });
        entries.push(table.id);
      }
      for (const child of node.children || []) walk(child, `附件 · `);
    };
    walk(source);
  }
  const head = placeholder ? `<option value="">${esc(placeholder)}</option>` : '';
  const body = groups.map((g) => `<optgroup label="${attr(g.name)}">${g.options.map((o) => (
    `<option value="${attr(o.value)}" ${o.selected ? 'selected' : ''}>${esc(o.label)}</option>`
  )).join('')}</optgroup>`).join('');
  return head + body;
}

export function sourceMetaLine(tableId) {
  const source = state.sources.find((s) => (s.meta?.tables || []).some((t) => t.id === tableId));
  return source ? source.name : '数据表已失效';
}

export function countActiveColumns(config) {
  return includedColumns(config).length;
}

export function tableName(tableId) {
  return tableLabel(tableId);
}
