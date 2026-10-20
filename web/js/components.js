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
  let mode = 'join';
  // 输出方式三选一：新建空白表 / 用已有模板 / 上传新模板。
  // 默认值很关键——已经上传过模板就默认选中最近一份，
  // 否则用户填完名字直接点「创建」，模板永远不会生效。
  let outputMode = templates.length ? 'template' : 'blank';
  let templateId = templates[0]?.id || '';
  let sheetName = templates[0]?.meta?.sheets?.[0]?.name || '';
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
        <span class="field-label">汇总结果写到哪里？</span>
        <div class="mode-grid output-grid" data-output-grid>
          <label class="mode-option" data-output="blank">
            <span class="mode-icon">${icon('table')}</span>
            <span class="mode-main"><strong>新建空白表</strong><p>程序生成一张干净的汇总表，列名按你配置的目标列。</p></span>
            <span class="mode-check">${icon('check')}</span>
          </label>
          <label class="mode-option" data-output="template">
            <span class="mode-icon">${icon('file-spreadsheet')}</span>
            <span class="mode-main"><strong>用已有模板</strong><p>沿用模板的表头、列宽、颜色和公式，只把数据填进去。</p></span>
            <span class="mode-check">${icon('check')}</span>
          </label>
          <label class="mode-option" data-output="upload">
            <span class="mode-icon">${icon('upload')}</span>
            <span class="mode-main"><strong>上传新模板</strong><p>现在就把公司格式的表传进来，之后所有方案都能复用。</p></span>
            <span class="mode-check">${icon('check')}</span>
          </label>
        </div>
        <div class="mt-14" data-output-panel></div>
      </div>`,
    footer: `
      <button class="btn btn-secondary" type="button" data-cancel>取消</button>
      <button class="btn btn-primary" type="button" data-create>${icon('plus')}创建方案</button>`,
  });

  ref.modal.querySelectorAll('[data-mode-grid] .mode-option').forEach((option) => {
    option.addEventListener('click', () => {
      mode = option.dataset.mode;
      ref.modal.querySelectorAll('[data-mode-grid] .mode-option').forEach((el) => {
        el.classList.toggle('selected', el === option);
      });
    });
  });

  // ---------- 汇总结果写到哪里 ----------
  const panel = ref.modal.querySelector('[data-output-panel]');

  const currentTemplate = () => (state.templates || []).find((t) => t.id === templateId) || null;
  const currentSheet = (template = currentTemplate()) => (
    (template?.meta?.sheets || []).find((s) => s.name === sheetName) || null
  );

  const ruleList = (headerRow) => `
    <div class="rule-list">
      <div class="rule-item">${icon('table')}<span>只写<b>数据区</b>：从第 ${headerRow + 1} 行开始，第 ${headerRow} 行表头保持原样</span></div>
      <div class="rule-item">${icon('layers')}<span>列宽、配色、合并单元格、公式列全部保留；没勾选「纳入」的列不会被覆盖</span></div>
      <div class="rule-item">${icon('save')}<span>输出的是新文件（汇总_方案名_时间.xlsx），你的模板原件不会被改动</span></div>
    </div>`;

  async function onUploadTemplate(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const restore = withButtonLoading(panel.querySelector('[data-pick-file]'), '上传中…');
    try {
      const data = await api.uploadTemplate(file);
      await loadBootstrap();
      templateId = data.template.id;
      sheetName = data.template.meta?.sheets?.[0]?.name || '';
      outputMode = 'template';
      renderOutputPanel();
      toast(`模板「${data.template.name}」已上传并选中。`, 'ok');
    } catch (err) {
      toast(err.message, 'error');
      restore();
    }
  }

  function renderOutputPanel() {
    ref.modal.querySelectorAll('[data-output-grid] .mode-option').forEach((el) => {
      el.classList.toggle('selected', el.dataset.output === outputMode);
    });

    if (outputMode === 'blank') {
      panel.innerHTML = `<div class="field-hint">程序会新建一张工作簿（工作表名可在方案里改）。之后随时可以在方案里换成模板，已有的列配置不会丢。</div>`;
      return;
    }

    if (outputMode === 'upload') {
      panel.innerHTML = `
        <div class="template-cta">
          <div class="template-cta-icon">${icon('upload')}</div>
          <div class="template-cta-main">
            <strong>上传一份 Excel 模板</strong>
            <p>支持 .xlsx / .xlsm / .xltx / .xltm；.xls 旧格式请先在 Excel 里另存为新格式。表头行会自动识别，之后可以手动调整。</p>
          </div>
          <button class="btn btn-primary btn-sm" type="button" data-pick-file>${icon('upload')}选择文件</button>
        </div>
        <input type="file" id="np-tpl-file" accept=".xlsx,.xlsm,.xltx,.xltm" hidden>`;
      panel.querySelector('[data-pick-file]').addEventListener('click', () => panel.querySelector('#np-tpl-file').click());
      panel.querySelector('#np-tpl-file').addEventListener('change', onUploadTemplate);
      return;
    }

    const template = currentTemplate();
    if (!template) {
      panel.innerHTML = `<div class="warning-note">${icon('alert')}<span>模板库里还没有模板。<a href="#" data-go-upload>现在上传一份</a>，或者改用「新建空白表」。</span></div>`;
      panel.querySelector('[data-go-upload]').addEventListener('click', (e) => {
        e.preventDefault();
        outputMode = 'upload';
        renderOutputPanel();
      });
      return;
    }
    const sheets = template.meta?.sheets || [];
    if (!sheets.some((s) => s.name === sheetName)) sheetName = sheets[0]?.name || '';
    const sheet = currentSheet(template);
    panel.innerHTML = `
      <div class="form-grid cols-2">
        <div class="field">
          <label class="field-label" for="np-template">模板</label>
          <select class="select" id="np-template">
            ${(state.templates || []).map((t) => `<option value="${attr(t.id)}" ${t.id === templateId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="field-label" for="np-sheet">使用哪个工作表</label>
          ${sheets.length > 1
            ? `<select class="select" id="np-sheet">
                 ${sheets.map((s) => `<option value="${attr(s.name)}" ${s.name === sheetName ? 'selected' : ''}>${esc(s.name)}（${(s.headers || []).length} 列）</option>`).join('')}
               </select>`
            : `<input class="input" id="np-sheet" value="${attr(sheetName)}" readonly>`}
        </div>
      </div>
      ${sheet ? `<div class="tpl-summary mt-12">
        <div class="tpl-summary-head">${icon('file-spreadsheet')}
          <strong>${esc(sheet.name)}</strong>
          <span class="tiny faint">第 ${sheet.header_row} 行表头 · ${(sheet.headers || []).length} 列 · ${fmtNumber(sheet.row_count || 0)} 行示例数据</span>
        </div>
        <div class="flex flex-wrap gap-6 mt-8">
          ${(sheet.headers || []).slice(0, 8).map((h) => `<span class="chip chip-plain">${esc(h)}</span>`).join('')}
          ${(sheet.headers || []).length > 8 ? `<span class="chip">+${sheet.headers.length - 8}</span>` : ''}
        </div>
      </div>${ruleList(sheet.header_row || 1)}` : `<div class="warning-note">${icon('alert')}<span>这份模板里没有识别到表头行，请换一份模板或换个工作表。</span></div>`}
      <div class="mt-10"><button class="btn btn-ghost btn-sm" type="button" data-go-upload>${icon('upload')}改上传一份新模板</button></div>`;

    panel.querySelector('#np-template').addEventListener('change', (e) => {
      templateId = e.target.value;
      sheetName = currentTemplate()?.meta?.sheets?.[0]?.name || '';
      renderOutputPanel();
    });
    panel.querySelector('#np-sheet')?.addEventListener('change', (e) => {
      sheetName = e.target.value;
      renderOutputPanel();
    });
    panel.querySelector('[data-go-upload]').addEventListener('click', () => {
      outputMode = 'upload';
      renderOutputPanel();
    });
  }

  // 小屏幕上弹窗内容比可视区高：切换输出方式后把面板滚进视野，
  // 否则用户点了「用已有模板」却看不到下面展开的摘要和规则。
  function revealPanel() {
    const body = ref.modal.querySelector('.modal-body');
    if (!body) return;
    const panelRect = panel.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    if (panelRect.bottom > bodyRect.bottom) {
      body.scrollTo({ top: body.scrollTop + (panelRect.top - bodyRect.top) - 14, behavior: 'smooth' });
    }
  }

  ref.modal.querySelectorAll('[data-output-grid] .mode-option').forEach((el) => {
    el.addEventListener('click', () => {
      outputMode = el.dataset.output;
      renderOutputPanel();
      revealPanel();
    });
  });
  renderOutputPanel();

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
    // 模板按「当前面板的选择」取，而不是回读 DOM——面板是动态重建的
    let template = null;
    let sheet = null;
    if (outputMode !== 'blank') {
      template = currentTemplate();
      if (!template) {
        toast('请先选择或上传一个模板，或者改用「新建空白表」。', 'warn');
        return;
      }
      sheet = currentSheet(template);
      if (!sheet) {
        toast('这份模板里没有可用的工作表，请换一份模板。', 'warn');
        return;
      }
    }
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
      options: { dedupe: true, skip_empty_key: false },
    };
    if (template && sheet) {
      applyTemplateToTarget(config, template, sheet);
    }
    const restore = withButtonLoading(event.currentTarget, '创建中…');
    try {
      const data = await api.createProfile({ name, mode, config });
      await loadBootstrap();
      ref.close();
      toast(template ? `方案已创建，目标模板「${template.name}」已挂上。` : '方案已创建，接下来选择数据来源。', 'ok');
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
