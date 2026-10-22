/** 数据模板编辑器：字段结构、校验规则、版本历史、引用方案、基本信息。 */
import { api } from '../api.js';
import { loadBootstrap } from '../store.js';
import {
  attr, confirmDialog, download, emptyState, esc, fmtDate, fmtNumber,
  icon, openModal, timeAgo, toast, typeName, withButtonLoading,
} from '../ui.js';

const STATUS_META = {
  active: { label: '使用中', cls: 'badge-brand' },
  draft: { label: '草稿', cls: 'badge-gold' },
  archived: { label: '已归档', cls: 'badge-gray' },
};

const RULE_ORDER = ['unique', 'enum', 'pattern', 'min', 'max', 'min_len', 'max_len'];

/** 汇总方案的匹配方式，决定方案怎么读数据，模板只管目标表长什么样。 */
const MODE_LABEL = { single: '单表匹配', join: '主表关联', append: '纵向合并' };

const PATTERN_PRESETS = [
  ['^\\d{6,12}$', '纯数字 6–12 位'],
  ['^[A-Za-z0-9_-]{3,32}$', '字母数字下划线 3–32 位'],
  ['^WX\\d{6,7}$', 'WX + 6–7 位数字'],
  ['^1[3-9]\\d{9}$', '手机号'],
  ['^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$', '邮箱'],
  ['^\\d{4}-\\d{2}-\\d{2}$', '日期 YYYY-MM-DD'],
];

const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

function toDraft(template) {
  return {
    name: template.name || '',
    description: template.description || '',
    category: template.category || '',
    tags: [...(template.tags || [])],
    status: template.status || 'active',
    fields: clone(template.fields || []),
  };
}

function ruleChips(field, options) {
  const chips = [];
  if (field.required) chips.push('<span class="rule-chip required">必填</span>');
  for (const rule of field.rules || []) {
    const label = options?.rules?.[rule.kind] || rule.kind;
    const value = rule.kind === 'enum'
      ? `：${(rule.value || []).slice(0, 3).join('/')}${(rule.value || []).length > 3 ? '…' : ''}`
      : (rule.kind === 'unique' ? '' : `：${rule.value}`);
    chips.push(`<span class="rule-chip">${esc(label)}${esc(value)}</span>`);
  }
  return chips.length ? chips.join('') : '<span class="tiny faint">未设置</span>';
}

/** 校验规则的编辑表单：勾选启用的规则，未勾选的输入框不参与提交。 */
function rulesFormHtml(field, options) {
  const find = (kind) => (field.rules || []).find((r) => r.kind === kind) || null;
  const enumRule = find('enum');
  const patternRule = find('pattern');
  const minRule = find('min');
  const maxRule = find('max');
  const minLen = find('min_len');
  const maxLen = find('max_len');
  const unique = find('unique');
  return `
    <div class="rule-block">
      <label class="rule-toggle">
        <input type="checkbox" data-rule-on="unique" ${unique ? 'checked' : ''}>
        <span><strong>不允许重复</strong><em>同一列里出现两次相同的值会报错（空值不参与比较）</em></span>
      </label>
    </div>
    <div class="rule-block" data-rule-box="enum">
      <label class="rule-toggle">
        <input type="checkbox" data-rule-on="enum" ${enumRule ? 'checked' : ''}>
        <span><strong>只允许指定值</strong><em>例如职级只能是 8A / 12B / 13A</em></span>
      </label>
      <div class="rule-body">
        <input class="input input-sm" data-rule-enum placeholder="用逗号分隔，例如：8A, 12B, 13A"
               value="${attr((enumRule?.value || []).join(', '))}">
      </div>
    </div>
    <div class="rule-block" data-rule-box="pattern">
      <label class="rule-toggle">
        <input type="checkbox" data-rule-on="pattern" ${patternRule ? 'checked' : ''}>
        <span><strong>正则匹配</strong><em>整串匹配，常用于工号、手机号、邮件等固定格式</em></span>
      </label>
      <div class="rule-body">
        <div class="flex gap-8 flex-wrap">
          <input class="input input-sm mono flex-1" data-rule-pattern placeholder="^WX\\d{6,7}$"
                 value="${attr(patternRule?.value || '')}">
          <select class="select select-sm" data-rule-preset style="width:170px">
            <option value="">常用格式…</option>
            ${PATTERN_PRESETS.map(([v, label]) => `<option value="${attr(v)}">${esc(label)}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>
    <div class="rule-block" data-rule-box="range">
      <label class="rule-toggle">
        <input type="checkbox" data-rule-on="range" ${(minRule || maxRule) ? 'checked' : ''}>
        <span><strong>数值范围</strong><em>只对数值列生效，留空表示不限</em></span>
      </label>
      <div class="rule-body">
        <div class="flex items-center gap-8">
          <input class="input input-sm" type="number" data-rule-min placeholder="下限" value="${attr(minRule?.value ?? '')}">
          <span class="faint">~</span>
          <input class="input input-sm" type="number" data-rule-max placeholder="上限" value="${attr(maxRule?.value ?? '')}">
        </div>
      </div>
    </div>
    <div class="rule-block" data-rule-box="length">
      <label class="rule-toggle">
        <input type="checkbox" data-rule-on="length" ${(minLen || maxLen) ? 'checked' : ''}>
        <span><strong>字符长度</strong><em>按去除首尾空格后的字符数计算</em></span>
      </label>
      <div class="rule-body">
        <div class="flex items-center gap-8">
          <input class="input input-sm" type="number" min="0" data-rule-minlen placeholder="最少" value="${attr(minLen?.value ?? '')}">
          <span class="faint">~</span>
          <input class="input input-sm" type="number" min="0" data-rule-maxlen placeholder="最多" value="${attr(maxLen?.value ?? '')}">
        </div>
      </div>
    </div>
    <div class="field-hint mt-8">校验在预览与生成时执行，问题会汇总成警告，不会阻断生成。</div>`;
}

function bindRulesForm(modal) {
  const sync = () => {
    modal.querySelectorAll('[data-rule-box]').forEach((box) => {
      const on = modal.querySelector(`[data-rule-on="${box.dataset.ruleBox}"]`)?.checked;
      box.classList.toggle('on', !!on);
      box.querySelectorAll('.rule-body input, .rule-body select').forEach((el) => {
        el.disabled = !on;
      });
    });
  };
  modal.querySelectorAll('[data-rule-on]').forEach((box) => {
    box.addEventListener('change', sync);
    if (box.dataset.ruleOn === 'range' || box.dataset.ruleOn === 'length') {
      box.closest('.rule-block')?.classList.toggle('on', box.checked);
    }
  });
  modal.querySelectorAll('[data-rule-preset]').forEach((select) => {
    select.addEventListener('change', () => {
      if (!select.value) return;
      const input = modal.querySelector('[data-rule-pattern]');
      if (input) {
        input.value = select.value;
        modal.querySelector('[data-rule-on="pattern"]').checked = true;
        sync();
      }
      select.value = '';
    });
  });
  sync();
}

function collectRules(modal) {
  const on = (kind) => !!modal.querySelector(`[data-rule-on="${kind}"]`)?.checked;
  const value = (selector) => modal.querySelector(selector)?.value?.trim() ?? '';
  const rules = [];
  if (on('unique')) rules.push({ kind: 'unique' });
  if (on('enum')) {
    const raw = value('[data-rule-enum]');
    const options = raw.split(/[,，;；\n]+/).map((s) => s.trim()).filter(Boolean);
    if (!options.length) throw new Error('「只允许指定值」需要填至少一个可选值。');
    rules.push({ kind: 'enum', value: options });
  }
  if (on('pattern')) {
    const pattern = value('[data-rule-pattern]');
    if (!pattern) throw new Error('「正则匹配」需要填表达式。');
    rules.push({ kind: 'pattern', value: pattern });
  }
  if (on('range')) {
    const min = value('[data-rule-min]');
    const max = value('[data-rule-max]');
    if (min !== '') rules.push({ kind: 'min', value: Number(min) });
    if (max !== '') rules.push({ kind: 'max', value: Number(max) });
  }
  if (on('length')) {
    const min = value('[data-rule-minlen]');
    const max = value('[data-rule-maxlen]');
    if (min !== '') rules.push({ kind: 'min_len', value: Number(min) });
    if (max !== '') rules.push({ kind: 'max_len', value: Number(max) });
  }
  return rules.sort((a, b) => RULE_ORDER.indexOf(a.kind) - RULE_ORDER.indexOf(b.kind));
}

export default {
  nav: 'templates',
  async render(view, ctx) {
    let detail = null;
    let draft = null;
    let options = { types: {}, rules: {}, status: {}, date_formats: [] };
    let dirty = false;
    let tab = 'fields';
    let saving = false;

    try {
      const [payload, opts] = await Promise.all([
        api.getTemplate(ctx.params.id),
        api.templateOptions(),
      ]);
      detail = payload.template;
      options = { date_formats: [], ...opts };
      draft = toDraft(detail);
    } catch (err) {
      view.innerHTML = `<div class="card" style="max-width:560px;margin:10vh auto">${emptyState({
        iconName: 'template',
        title: '模板打不开',
        desc: esc(err.message),
        action: '<a class="btn btn-primary" href="#/templates">返回模板库</a>',
      })}</div>`;
      return () => {};
    }

    const typeLabels = options.types || {};

    // ---- 保存 ---------------------------------------------------------
    function payloadForSave() {
      return {
        name: draft.name,
        description: draft.description,
        category: draft.category,
        tags: draft.tags,
        status: draft.status,
        fields: draft.fields,
      };
    }

    async function save(silent = false) {
      if (saving || !dirty) {
        if (!dirty && !silent) toast('没有需要保存的修改。', 'info');
        return;
      }
      saving = true;
      paintStatus('saving');
      try {
        const res = await api.updateTemplate(detail.id, payloadForSave());
        const versionChanged = res.template.version !== detail.version;
        detail = res.template;
        draft = toDraft(detail);
        dirty = false;
        await loadBootstrap();
        paintShell();
        paintStatus('saved');
        if (!silent) {
          toast(versionChanged ? `已保存，字段变化记为 v${detail.version}。` : '模板已保存。', 'ok');
        }
      } catch (err) {
        paintStatus('error');
        toast(err.message, 'error');
      } finally {
        saving = false;
      }
    }

    function markDirty(repaintBody = false) {
      dirty = true;
      paintStatus('dirty');
      if (repaintBody) paintBody();
    }

    // ---- 壳层 ---------------------------------------------------------
    function badge(text, cls = '') {
      return `<span class="badge ${cls}">${esc(text)}</span>`;
    }

    function headerMeta() {
      const status = STATUS_META[detail.status] || STATUS_META.active;
      return `
        ${detail.category ? badge(detail.category, 'badge-blue') : ''}
        ${badge(status.label, status.cls)}
        <span class="chip chip-plain" title="当前版本">v${detail.version}</span>
        <span class="chip chip-plain">${detail.origin === 'fields' ? '结构定义' : 'Excel 文件'}</span>
        ${detail.ref_count ? `<a class="chip chip-brand" href="#/templates/${encodeURIComponent(detail.id)}" data-tab-jump="refs">${icon('link', 'icon-sm')}${detail.ref_count} 个方案在用</a>` : '<span class="chip chip-plain">未被引用</span>'}`;
    }

    function paintShell() {
      view.innerHTML = `
        <div class="tpl-editor">
          <div class="editor-head tpl-editor-head">
            <div class="tpl-head-left">
              <a class="tpl-back" href="#/templates">${icon('arrow-left', 'icon-sm')}数据模板</a>
              <div class="editor-title-line">
                <h1 class="editor-title">${esc(detail.name)}</h1>
                ${headerMeta()}
              </div>
              <div class="editor-sub">
                ${detail.description ? esc(detail.description) : '<span class="faint">还没有写说明</span>'}
              </div>
              <div class="tiny faint mt-6">
                ${fmtNumber(detail.field_count)} 个字段 · ${fmtNumber(detail.rules_count)} 条校验 ·
                工作表「${esc(detail.sheet)}」 · 更新于 ${timeAgo(detail.updated_at)}
              </div>
            </div>
            <div class="editor-actions">
              <span class="tpl-save-status" data-save-status></span>
              <button class="btn btn-secondary btn-sm" type="button" data-preview>${icon('eye')}预览</button>
              <button class="btn btn-secondary btn-sm" type="button" data-export>${icon('download')}导出</button>
              <button class="btn btn-secondary btn-sm" type="button" data-duplicate>${icon('copy')}复制</button>
              <button class="icon-btn danger" type="button" data-delete title="删除模板">${icon('trash')}</button>
              <button class="btn btn-primary btn-sm" type="button" data-save disabled>${icon('save')}保存</button>
            </div>
          </div>

          <div class="tpl-tabs" role="tablist">
            ${[
              ['fields', 'columns', '字段结构', detail.field_count],
              ['rules', 'rule', '校验规则', detail.rules_count],
              ['versions', 'versions', '版本历史', (detail.versions || []).length],
              ['refs', 'link', '引用方案', detail.ref_count],
              ['info', 'settings', '基本信息', null],
            ].map(([key, ic, label, count]) => `
              <button class="tpl-tab ${tab === key ? 'active' : ''}" type="button" data-tab="${key}" role="tab">
                ${icon(ic, 'icon-sm')}${label}${count !== null ? `<i>${count}</i>` : ''}
              </button>`).join('')}
          </div>

          <div class="tpl-tab-body" data-body></div>
        </div>`;

      bindShell();
      paintStatus(dirty ? 'dirty' : 'saved');
      paintBody();
    }

    function bindShell() {
      view.querySelectorAll('[data-tab]').forEach((btn) => btn.addEventListener('click', () => {
        if (dirty && !window.confirm('当前修改还没保存，切换标签会丢失。继续吗？')) return;
        tab = btn.dataset.tab;
        view.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
        paintBody();
      }));
      view.querySelectorAll('[data-tab-jump]').forEach((el) => el.addEventListener('click', (e) => {
        e.preventDefault();
        tab = el.dataset.tabJump;
        view.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
        paintBody();
      }));
      view.querySelector('[data-save]').addEventListener('click', () => save());
      view.querySelector('[data-preview]').addEventListener('click', openPreview);
      view.querySelector('[data-export]').addEventListener('click', () => download(api.templateExportUrl(detail.id)));
      view.querySelector('[data-duplicate]').addEventListener('click', duplicate);
      view.querySelector('[data-delete]').addEventListener('click', remove);
    }

    function paintStatus(state) {
      const el = view.querySelector('[data-save-status]');
      const btn = view.querySelector('[data-save]');
      if (!el || !btn) return;
      if (state === 'saving') {
        el.innerHTML = '<span class="inline-loading"><span class="spinner spinner-sm"></span>保存中…</span>';
      } else if (state === 'dirty') {
        el.innerHTML = '<span class="dirty-dot"></span> 有未保存修改';
      } else if (state === 'error') {
        el.innerHTML = '<span style="color:var(--red)">保存失败</span>';
      } else {
        el.innerHTML = `${icon('check-circle', 'icon-sm')} 已保存`;
      }
      btn.disabled = !dirty || saving;
    }

    // ---- 各标签内容 ---------------------------------------------------
    function paintBody() {
      const body = view.querySelector('[data-body]');
      if (!body) return;
      if (tab === 'fields') body.innerHTML = fieldsHtml();
      else if (tab === 'rules') body.innerHTML = rulesHtml();
      else if (tab === 'versions') body.innerHTML = versionsHtml();
      else if (tab === 'refs') body.innerHTML = refsHtml();
      else body.innerHTML = infoHtml();
      bindBody();
    }

    function fieldsHtml() {
      const fields = draft.fields || [];
      return `
        <div class="tpl-panel">
          <div class="panel-head">
            <div>
              <strong>字段结构</strong>
              <span class="faint tiny">共 ${fields.length} 列 · 列名与顺序就是生成表格的表头与列顺序</span>
            </div>
            <div class="flex gap-8">
              ${detail.origin === 'upload' ? `<button class="btn btn-secondary btn-sm" type="button" data-resync>${icon('refresh')}从文件重读表头</button>` : ''}
              <button class="btn btn-primary btn-sm" type="button" data-add-field>${icon('plus')}添加字段</button>
            </div>
          </div>
          ${fields.length ? `
          <div class="field-table-wrap">
            <table class="field-table">
              <thead>
                <tr>
                  <th style="width:44px">#</th>
                  <th>列名</th>
                  <th style="width:110px">类型</th>
                  <th style="width:64px">必填</th>
                  <th style="width:84px">列宽</th>
                  <th style="width:150px">默认值</th>
                  <th>校验规则</th>
                  <th style="width:126px"></th>
                </tr>
              </thead>
              <tbody>
                ${fields.map((field, index) => `
                  <tr data-row="${attr(field.key)}">
                    <td class="num">${index + 1}</td>
                    <td><input class="input input-sm" data-fname value="${attr(field.name)}" placeholder="列名"></td>
                    <td>
                      <select class="select select-sm" data-ftype>
                        ${Object.entries(typeLabels).map(([v, label]) => `<option value="${v}" ${field.type === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}
                      </select>
                    </td>
                    <td class="center"><label class="switch switch-sm"><input type="checkbox" data-freq ${field.required ? 'checked' : ''}><span class="switch-track"></span></label></td>
                    <td><input class="input input-sm" type="number" min="6" max="60" data-fwidth value="${field.width || 14}"></td>
                    <td><input class="input input-sm" data-fdefault value="${attr(field.default || '')}" placeholder="留空"></td>
                    <td class="rules-cell">${ruleChips(field, options)}</td>
                    <td class="row-actions">
                      <button class="icon-btn" type="button" data-fdetail title="字段详情与规则">${icon('rule', 'icon-sm')}</button>
                      <button class="icon-btn" type="button" data-fup title="上移" ${index === 0 ? 'disabled' : ''}>${icon('arrow-up', 'icon-sm')}</button>
                      <button class="icon-btn" type="button" data-fdown title="下移" ${index === fields.length - 1 ? 'disabled' : ''}>${icon('arrow-down', 'icon-sm')}</button>
                      <button class="icon-btn danger" type="button" data-fdel title="删除字段">${icon('x', 'icon-sm')}</button>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>` : `<div class="empty small" style="padding:38px 20px">
            <div class="empty-icon">${icon('columns')}</div>
            <h3>还没有字段</h3>
            <p>字段就是目标表的列。先加几列，再为关键列设置校验规则。</p>
            <button class="btn btn-primary btn-sm" type="button" data-add-field>${icon('plus')}添加第一个字段</button>
          </div>`}
          <div class="tpl-notice">
            ${icon('info', 'icon-sm')}
            <span>列名改动会同步写到 Excel 表头；已被汇总方案引用的模板改动后，方案里会出现「字段有变化」，可一键同步。</span>
          </div>
        </div>`;
    }

    function rulesHtml() {
      const fields = draft.fields || [];
      const rows = fields.map((field) => {
        const chips = [];
        if (field.required) chips.push('<span class="rule-chip required">必填</span>');
        for (const rule of field.rules || []) {
          const label = options.rules?.[rule.kind] || rule.kind;
          const detailText = rule.kind === 'unique' ? '' : `：${Array.isArray(rule.value) ? rule.value.join(' / ') : rule.value}`;
          chips.push(`<span class="rule-chip">${esc(label)}${esc(detailText)}</span>`);
        }
        return `
          <tr>
            <td><strong>${esc(field.name)}</strong><div class="tiny faint">${esc(typeName(field.type))}</div></td>
            <td>${chips.length ? chips.join('') : '<span class="tiny faint">不做校验</span>'}</td>
          </tr>`;
      }).join('');
      return `
        <div class="tpl-panel">
          <div class="panel-head">
            <div><strong>校验规则一览</strong><span class="faint tiny">按模板字段执行，在预览和生成时给出问题清单</span></div>
            <button class="btn btn-secondary btn-sm" type="button" data-goto-fields>${icon('columns')}去字段结构里修改</button>
          </div>
          <table class="field-table rules-table">
            <thead><tr><th style="width:220px">字段</th><th>规则</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="2" class="faint">还没有字段</td></tr>'}</tbody>
          </table>
          <div class="tpl-tip-grid">
            <div class="tpl-tip">
              <strong>${icon('info', 'icon-sm')}什么时候校验</strong>
              <p>方案预览、正式生成时会检查。发现问题只提示、不中断——数据质量问题应该由人判断怎么处理。</p>
            </div>
            <div class="tpl-tip">
              <strong>${icon('rule', 'icon-sm')}规则怎么组合</strong>
              <p>同一字段可以同时有「必填 + 格式 + 不重复」。空值只触发必填，其他规则会跳过。</p>
            </div>
            <div class="tpl-tip">
              <strong>${icon('table', 'icon-sm')}和 Excel 数据验证的关系</strong>
              <p>结构定义的模板会把「只允许指定值」写成下拉框；上传的 Excel 模板保持你自己的格式，不改动数据验证。</p>
            </div>
          </div>
        </div>`;
    }

    function versionsHtml() {
      const versions = detail.versions || [];
      return `
        <div class="tpl-panel">
          <div class="panel-head">
            <div>
              <strong>版本历史</strong>
              <span class="faint tiny">字段结构每次变化前自动留一份快照；同一模板最多保留 20 个版本</span>
            </div>
            <button class="btn btn-secondary btn-sm" type="button" data-snapshot>${icon('versions')}记录当前版本</button>
          </div>
          ${versions.length ? `
            <div class="version-list">
              <div class="version-row current">
                <div class="version-badge">v${detail.version}</div>
                <div class="version-main">
                  <strong>当前版本</strong>
                  <div class="tiny faint">${fmtNumber(detail.field_count)} 个字段 · ${fmtNumber(detail.rules_count)} 条规则 · 更新于 ${fmtDate(detail.updated_at)}</div>
                </div>
              </div>
              ${versions.map((v) => `
                <div class="version-row">
                  <div class="version-badge">v${v.version}</div>
                  <div class="version-main">
                    <strong>${esc(v.note || '自动快照')}</strong>
                    <div class="tiny faint">
                      ${fmtDate(v.created_at)} · ${fmtNumber(v.snapshot?.field_count)} 个字段 · ${fmtNumber(v.snapshot?.rules_count)} 条规则
                      ${(v.snapshot?.fields || []).length ? ` · ${(v.snapshot.fields || []).slice(0, 4).map((f) => esc(f.name)).join('、')}${(v.snapshot.fields || []).length > 4 ? '…' : ''}` : ''}
                    </div>
                  </div>
                  <button class="btn btn-secondary btn-sm" type="button" data-restore="${attr(v.id)}" data-version="${v.version}">回滚到这一版</button>
                </div>`).join('')}
            </div>` : `<div class="empty small" style="padding:34px"><div class="empty-icon">${icon('versions')}</div><h3>还没有历史版本</h3><p>改动字段结构时，旧版本会自动存到这里。也可以手动记录一个节点。</p></div>`}
        </div>`;
    }

    function refsHtml() {
      const refs = detail.refs || [];
      return `
        <div class="tpl-panel">
          <div class="panel-head">
            <div><strong>引用这个模板的汇总方案</strong><span class="faint tiny">方案单向依赖模板：换掉或删除模板前，先看这里</span></div>
            <a class="btn btn-secondary btn-sm" href="#/profiles">${icon('layers')}去汇总方案</a>
          </div>
          ${refs.length ? `
            <div class="ref-list">
              ${refs.map((r) => `
                <a class="ref-row" href="#/profiles/${encodeURIComponent(r.id)}">
                  <div class="ref-icon">${icon(r.mode === 'append' ? 'layers' : 'link')}</div>
                  <div class="ref-main">
                    <strong>${esc(r.name)}</strong>
                    <div class="tiny faint">${MODE_LABEL[r.mode] || '主表关联'} · 写入工作表「${esc(r.sheet || '—')}」</div>
                  </div>
                  <span class="tiny faint">${timeAgo(r.updated_at)}</span>
                  ${icon('chevron-right', 'icon-sm')}
                </a>`).join('')}
            </div>
            ${detail.ref_count > refs.length ? `<div class="tiny faint mt-8">还有 ${detail.ref_count - refs.length} 个方案，去「汇总方案」里查看全部。</div>` : ''}
          ` : `<div class="empty small" style="padding:34px">
            <div class="empty-icon">${icon('link')}</div>
            <h3>还没有方案引用它</h3>
            <p>在汇总方案的「目标表」里选择这个模板，就会出现在这里。</p>
            <a class="btn btn-secondary btn-sm" href="#/profiles">去创建方案</a>
          </div>`}
        </div>`;
    }

    function infoHtml() {
      return `
        <div class="tpl-panel">
          <div class="panel-head"><div><strong>基本信息</strong><span class="faint tiny">分类与标签用于筛选，说明用于让同事一眼看懂用途</span></div></div>
          <div class="form-grid cols-2">
            <div class="field">
              <label class="field-label" for="tp-name">模板名称</label>
              <input class="input" id="tp-name" data-meta="name" maxlength="80" value="${attr(draft.name)}">
            </div>
            <div class="field">
              <label class="field-label" for="tp-category">分类</label>
              <input class="input" id="tp-category" data-meta="category" maxlength="40" value="${attr(draft.category)}" placeholder="例如：人事 / 财务 / 项目">
            </div>
            <div class="field">
              <label class="field-label" for="tp-tags">标签</label>
              <input class="input" id="tp-tags" data-meta="tags" value="${attr(draft.tags.join(', '))}" placeholder="逗号分隔，最多 8 个">
            </div>
            <div class="field">
              <label class="field-label" for="tp-status">状态</label>
              <select class="select" id="tp-status" data-meta="status">
                ${Object.entries(options.status || STATUS_META).map(([v, meta]) => {
                  const label = typeof meta === 'string' ? meta : meta.label;
                  return `<option value="${v}" ${draft.status === v ? 'selected' : ''}>${esc(label)}</option>`;
                }).join('')}
              </select>
              <div class="field-hint">归档后仍可被方案使用，只是列表里默认不突出。</div>
            </div>
          </div>
          <div class="field mt-14">
            <label class="field-label" for="tp-desc">说明</label>
            <textarea class="textarea" id="tp-desc" data-meta="description" rows="3" maxlength="300" placeholder="这份表给谁用、什么时候用、有什么口径要注意">${esc(draft.description)}</textarea>
          </div>
          <div class="rail-divider"></div>
          <div class="info-list">
            <div class="info-row"><span class="k">工作表</span><span class="v">${esc(detail.sheet || '—')}</span></div>
            <div class="info-row"><span class="k">表头行</span><span class="v">第 ${detail.header_row} 行</span></div>
            <div class="info-row"><span class="k">来源</span><span class="v">${detail.origin === 'fields' ? '按字段定义生成' : '上传的 Excel 文件'}</span></div>
            <div class="info-row"><span class="k">文件</span><span class="v">${esc(detail.file_name || '—')}</span></div>
            <div class="info-row"><span class="k">创建 / 更新</span><span class="v">${fmtDate(detail.created_at)} / ${fmtDate(detail.updated_at)}</span></div>
          </div>
          <div class="flex gap-8 mt-14 flex-wrap">
            <a class="btn btn-secondary btn-sm" href="${api.templateFileUrl(detail.id)}">${icon('file-spreadsheet')}下载 Excel 模板</a>
            <button class="btn btn-secondary btn-sm" type="button" data-export>${icon('download')}导出定义（JSON）</button>
          </div>
        </div>`;
    }

    // ---- 事件绑定 -----------------------------------------------------
    function bindBody() {
      if (tab === 'fields') bindFields();
      else if (tab === 'versions') bindVersions();
      else if (tab === 'info') bindInfo();
      else if (tab === 'rules') {
        view.querySelector('[data-goto-fields]')?.addEventListener('click', () => {
          tab = 'fields';
          view.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'fields'));
          paintBody();
        });
      }
    }

    function bindFields() {
      view.querySelectorAll('[data-add-field]').forEach((btn) => btn.addEventListener('click', () => {
        openFieldModal(-1);
      }));

      view.querySelectorAll('[data-row]').forEach((row) => {
        const key = row.dataset.row;
        const index = draft.fields.findIndex((f) => f.key === key);
        if (index < 0) return;
        const field = draft.fields[index];

        row.querySelector('[data-fname]').addEventListener('input', (e) => {
          field.name = e.target.value;
          dirty = true;
          paintStatus('dirty');
        });
        row.querySelector('[data-fname]').addEventListener('change', () => paintBody());
        row.querySelector('[data-ftype]').addEventListener('change', (e) => {
          field.type = e.target.value;
          markDirty(index >= 0);
        });
        row.querySelector('[data-freq]').addEventListener('change', (e) => {
          field.required = e.target.checked;
          markDirty(true);
        });
        row.querySelector('[data-fwidth]').addEventListener('change', (e) => {
          field.width = Math.max(6, Math.min(60, Number(e.target.value) || 14));
          markDirty(false);
        });
        row.querySelector('[data-fdefault]').addEventListener('input', (e) => {
          field.default = e.target.value;
          dirty = true;
          paintStatus('dirty');
        });
        row.querySelector('[data-fdetail]').addEventListener('click', () => openFieldModal(index));
        row.querySelector('[data-fup]').addEventListener('click', () => {
          if (index === 0) return;
          [draft.fields[index - 1], draft.fields[index]] = [draft.fields[index], draft.fields[index - 1]];
          markDirty(true);
        });
        row.querySelector('[data-fdown]').addEventListener('click', () => {
          if (index >= draft.fields.length - 1) return;
          [draft.fields[index + 1], draft.fields[index]] = [draft.fields[index], draft.fields[index + 1]];
          markDirty(true);
        });
        row.querySelector('[data-fdel]').addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: '删除字段',
            message: `确定删除字段「${esc(field.name)}」吗？`,
            detail: `<div class="warning-note">${icon('alert')}<span>删除后生成表格会少一列；已引用它的方案需要同步字段。</span></div>`,
            confirmText: '删除字段',
            danger: true,
          });
          if (!ok) return;
          draft.fields.splice(index, 1);
          markDirty(true);
        });
      });

      view.querySelector('[data-resync]')?.addEventListener('click', resync);
    }

    function bindInfo() {
      view.querySelectorAll('[data-meta]').forEach((el) => {
        el.addEventListener('input', () => {
          const key = el.dataset.meta;
          if (key === 'tags') {
            draft.tags = el.value.split(/[,，;；]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
          } else {
            draft[key] = el.value;
          }
          dirty = true;
          paintStatus('dirty');
        });
      });
      // 基本信息面板里也有一个导出按钮，和顶栏那个是两个元素，必须各自绑定
      view.querySelectorAll('.tpl-tab-body [data-export]').forEach((btn) => {
        btn.addEventListener('click', () => download(api.templateExportUrl(detail.id)));
      });
    }

    function bindVersions() {
      view.querySelector('[data-snapshot]')?.addEventListener('click', async () => {
        const ref = openModal({
          title: '记录当前版本',
          sub: '把当前字段结构存成一个可回滚的节点。',
          size: 'modal-sm',
          body: `<div class="field">
            <label class="field-label" for="sn-note">版本备注</label>
            <input class="input" id="sn-note" maxlength="60" placeholder="例如：年底报表口径调整">
          </div>`,
          footer: `<button class="btn btn-secondary" type="button" data-cancel>取消</button>
                   <button class="btn btn-primary" type="button" data-ok>记录</button>`,
        });
        ref.modal.querySelector('[data-cancel]').addEventListener('click', ref.close);
        ref.modal.querySelector('[data-ok]').addEventListener('click', async (e) => {
          const restore = withButtonLoading(e.currentTarget, '记录中…');
          try {
            const res = await api.saveTemplateVersion(detail.id, ref.modal.querySelector('#sn-note').value.trim());
            detail = res.template;
            dirty = false;
            paintShell();
            toast('已记录当前版本。', 'ok');
            ref.close();
          } catch (err) {
            toast(err.message, 'error');
            restore();
          }
        });
      });

      view.querySelectorAll('[data-restore]').forEach((btn) => btn.addEventListener('click', async () => {
        const ok = await confirmDialog({
          title: `回滚到 v${btn.dataset.version}`,
          message: '当前字段结构会先存成一份快照，然后恢复成这个历史版本。',
          detail: `<div class="warning-note">${icon('alert')}<span>模板文件会按回滚后的字段重建；已引用的方案需要同步字段。</span></div>`,
          confirmText: '回滚',
          danger: true,
        });
        if (!ok) return;
        const restore = withButtonLoading(btn, '回滚中…');
        try {
          const res = await api.restoreTemplateVersion(detail.id, btn.dataset.restore);
          detail = res.template;
          draft = toDraft(detail);
          dirty = false;
          await loadBootstrap();
          paintShell();
          toast(`已回滚，当前版本 v${detail.version}。`, 'ok');
        } catch (err) {
          toast(err.message, 'error');
          restore();
        }
      }));
    }

    // ---- 字段弹窗 -----------------------------------------------------
    function openFieldModal(index) {
      const isNew = index < 0;
      const field = isNew
        ? { key: `f_${Math.random().toString(36).slice(2, 9)}`, name: `字段 ${draft.fields.length + 1}`, type: 'auto', required: false, default: '', width: 14, date_format: '', note: '', sample: '', rules: [] }
        : clone(draft.fields[index]);
      const ref = openModal({
        title: isNew ? '添加字段' : `字段：${field.name}`,
        sub: '列名决定表头，类型决定写进 Excel 的格式，校验规则在生成时检查数据。',
        size: 'modal-lg',
        body: `
          <div class="form-grid cols-2">
            <div class="field">
              <label class="field-label" for="fd-name">列名 <span class="req">*</span></label>
              <input class="input" id="fd-name" maxlength="60" value="${attr(field.name)}">
            </div>
            <div class="field">
              <label class="field-label" for="fd-type">类型</label>
              <select class="select" id="fd-type">
                ${Object.entries(typeLabels).map(([v, label]) => `<option value="${v}" ${field.type === v ? 'selected' : ''}>${esc(label)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="field-label" for="fd-width">列宽</label>
              <input class="input" id="fd-width" type="number" min="6" max="60" value="${field.width || 14}">
            </div>
            <div class="field">
              <label class="field-label" for="fd-default">默认值</label>
              <input class="input" id="fd-default" value="${attr(field.default || '')}" placeholder="没有映射到数据时用它">
            </div>
            <div class="field" data-date-box>
              <label class="field-label" for="fd-datefmt">日期格式</label>
              <select class="select" id="fd-datefmt">
                <option value="">跟随全局设置</option>
                ${(options.date_formats || []).map((f) => `<option value="${attr(f)}" ${field.date_format === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="field-label" for="fd-sample">示例值</label>
              <input class="input" id="fd-sample" maxlength="120" value="${attr(field.sample || '')}" placeholder="帮助同事理解这一列填什么">
            </div>
          </div>
          <div class="field mt-14">
            <label class="field-label" for="fd-note">字段说明</label>
            <input class="input" id="fd-note" maxlength="200" value="${attr(field.note || '')}" placeholder="例如：工号规则为 WX + 6~7 位数字">
          </div>
          <div class="field mt-16">
            <label class="field-label">必填与校验规则</label>
            <label class="rule-toggle required-toggle">
              <input type="checkbox" id="fd-required" ${field.required ? 'checked' : ''}>
              <span><strong>必填</strong><em>生成时该列为空会记一条问题</em></span>
            </label>
          </div>
          <div class="rule-form">${rulesFormHtml(field, options)}</div>`,
        footer: `<button class="btn btn-secondary" type="button" data-cancel>取消</button>
                 <button class="btn btn-primary" type="button" data-ok>${isNew ? '添加' : '保存字段'}</button>`,
      });

      const modal = ref.modal;
      bindRulesForm(modal);
      const syncDate = () => {
        modal.querySelector('[data-date-box]').style.display =
          modal.querySelector('#fd-type').value === 'date' ? '' : 'none';
      };
      modal.querySelector('#fd-type').addEventListener('change', syncDate);
      syncDate();
      modal.querySelector('[data-cancel]').addEventListener('click', ref.close);

      modal.querySelector('[data-ok]').addEventListener('click', () => {
        const name = modal.querySelector('#fd-name').value.trim();
        if (!name) {
          toast('请填写列名。', 'warn');
          modal.querySelector('#fd-name').focus();
          return;
        }
        const dup = draft.fields.some((f, i) => i !== index && f.name === name);
        if (dup) {
          toast(`列名「${name}」已存在，列名必须唯一。`, 'warn');
          return;
        }
        let rules;
        try {
          rules = collectRules(modal);
        } catch (err) {
          toast(err.message, 'warn');
          return;
        }
        const next = {
          ...field,
          name,
          type: modal.querySelector('#fd-type').value,
          width: Math.max(6, Math.min(60, Number(modal.querySelector('#fd-width').value) || 14)),
          default: modal.querySelector('#fd-default').value,
          date_format: modal.querySelector('#fd-datefmt').value,
          sample: modal.querySelector('#fd-sample').value.trim(),
          note: modal.querySelector('#fd-note').value.trim(),
          required: modal.querySelector('#fd-required').checked,
          rules,
        };
        if (isNew) draft.fields.push(next);
        else draft.fields[index] = next;
        ref.close();
        markDirty(true);
      });
    }

    async function resync() {
      const ok = await confirmDialog({
        title: '从文件重新读取表头',
        message: `将重新读取「${detail.sheet}」的表头，按实际列重建字段。`,
        detail: `<div class="warning-note">${icon('alert')}<span>同名字段的类型、必填与规则会保留；文件里已不存在的列会消失。</span></div>`,
        confirmText: '重新读取',
      });
      if (!ok) return;
      try {
        const data = await api.inspectTemplate(detail.id, detail.sheet, detail.header_row);
        const fields = data.sheet.fields || [];
        if (!fields.length) {
          toast('文件里没读到表头，请检查表头行。', 'warn');
          return;
        }
        draft.fields = fields;
        markDirty(true);
        toast(`已按文件重建 ${fields.length} 个字段，保存后生效。`, 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    // ---- 预览 / 复制 / 删除 -------------------------------------------
    function openPreview() {
      const fields = (dirty ? draft.fields : detail.fields) || [];
      const sample = fields.map((f) => f.sample || f.default || '');
      const ref = openModal({
        title: `预览：${detail.name}`,
        sub: `工作表「${detail.sheet}」 · 第 ${detail.header_row} 行表头 · 数据从第 ${detail.header_row + 1} 行开始`,
        size: 'modal-lg',
        body: fields.length ? `
          <div class="preview-scroll">
            <table class="field-table preview-table">
              <thead><tr>${fields.map((f) => `<th>${esc(f.name)}${f.required ? '<i class="req-dot" title="必填"></i>' : ''}</th>`).join('')}</tr></thead>
              <tbody>
                <tr>${sample.map((v) => `<td class="${v ? '' : 'faint'}">${v ? esc(v) : '（示例）'}</td>`).join('')}</tr>
              </tbody>
            </table>
          </div>
          <div class="tpl-tip-grid mt-14">
            ${fields.slice(0, 6).map((f) => `
              <div class="tpl-tip">
                <strong>${esc(f.name)}<span class="tiny faint"> · ${esc(typeName(f.type))}${f.required ? ' · 必填' : ''}</span></strong>
                <p>${f.note ? esc(f.note) : '<span class="faint">没有填写说明</span>'}${(f.rules || []).length ? `<br>${ruleChips(f, options)}` : ''}</p>
              </div>`).join('')}
          </div>` : '<div class="empty small"><h3>还没有字段</h3><p>先添加字段再预览。</p></div>',
        footer: `<button class="btn btn-secondary" type="button" data-cancel>关闭</button>
                 <a class="btn btn-primary" href="${api.templateFileUrl(detail.id)}">${icon('file-spreadsheet')}下载 Excel 模板</a>`,
      });
      ref.modal.querySelector('[data-cancel]').addEventListener('click', ref.close);
    }

    async function duplicate() {
      try {
        const res = await api.duplicateTemplate(detail.id);
        await loadBootstrap();
        toast(`已复制为「${res.template.name}」。`, 'ok');
        ctx.navigate(`#/templates/${res.template.id}`);
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function remove() {
      const ok = await confirmDialog({
        title: '删除数据模板',
        message: `确定删除「${esc(detail.name)}」吗？`,
        detail: detail.ref_count
          ? `<div class="warning-note">${icon('alert')}<span>还有 ${detail.ref_count} 个汇总方案在用它，删除后这些方案的目标表会失效。</span></div>`
          : `<div class="warning-note">${icon('alert')}<span>模板文件与版本历史会一起删除，此操作不可撤销。</span></div>`,
        confirmText: '删除模板',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteTemplate(detail.id, detail.ref_count > 0);
        await loadBootstrap();
        toast('模板已删除。', 'ok');
        ctx.navigate('#/templates');
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    // ---- 快捷键：Ctrl/Cmd + S -----------------------------------------
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
      }
    };
    document.addEventListener('keydown', onKey);

    paintShell();
    ctx.setCrumb([
      { label: '工作台', href: '#/' },
      { label: '数据模板', href: '#/templates' },
      { label: detail.name },
    ]);

    return () => {
      document.removeEventListener('keydown', onKey);
    };
  },
};
