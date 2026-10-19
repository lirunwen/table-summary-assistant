/** 数据对比：两次运行结果或任意两张数据表。 */
import { api } from '../api.js';
import {
  allTables, loadBootstrap, runHeaders, state, tableHeaders,
} from '../store.js';
import {
  attr, emptyState, esc, fmtDate, fmtNumber, icon, pageHead, toast,
} from '../ui.js';

let leftSel = '';
let rightSel = '';
let keys = [];
let result = null;
let filter = 'all';
let busy = false;

function sideHeaders(sel) {
  if (!sel) return [];
  if (sel.startsWith('run:')) {
    const run = state.runs.find((r) => `run:${r.id}` === sel);
    return runHeaders(run);
  }
  if (sel.startsWith('table:')) return tableHeaders(sel.slice(6));
  return [];
}

function runTime(run) {
  const d = new Date(run.created_at);
  if (Number.isNaN(d.getTime())) return fmtDate(run.created_at);
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function sideLabel(sel) {
  if (!sel) return '未选择';
  if (sel.startsWith('run:')) {
    const run = state.runs.find((r) => `run:${r.id}` === sel);
    return run ? `${run.profile_name} · ${runTime(run)}` : '生成记录已删除';
  }
  const entry = allTables().find((t) => `table:${t.table.id}` === sel);
  return entry?.label || '数据表已删除';
}

function sideSpec(sel) {
  if (sel.startsWith('run:')) return { type: 'run', id: sel.slice(4) };
  return { type: 'table', table_id: sel.slice(6) };
}

function commonHeaders() {
  const left = sideHeaders(leftSel);
  const right = sideHeaders(rightSel);
  return left.filter((h) => right.includes(h));
}

function ensureKeys() {
  const common = commonHeaders();
  keys = keys.filter((k) => common.includes(k));
  if (!keys.length && common.length) {
    const preferred = ['工号', '员工编号', '订单号', '编号', '姓名'];
    const found = preferred.find((k) => common.includes(k));
    keys = [found || common[0]];
  }
}

function runOptions() {
  return state.runs
    .filter((r) => r.status === 'ok' && runHeaders(r).length)
    .map((r) => ({ value: `run:${r.id}`, label: `${r.profile_name} · ${runTime(r)} · ${fmtNumber(r.summary?.rows || 0)} 行` }));
}

function tableOptions() {
  return allTables().map((entry) => ({
    value: `table:${entry.table.id}`,
    label: `${entry.label} · ${fmtNumber(entry.table.row_count)} 行`,
    group: entry.group,
  }));
}

function optionGroups(items, selected) {
  const groups = new Map();
  for (const item of items) {
    const group = item.group || '生成结果';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  return groups.size
    ? Array.from(groups.entries()).map(([group, list]) => `
      <optgroup label="${attr(group)}">
        ${list.map((item) => `<option value="${attr(item.value)}" ${item.value === selected ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}
      </optgroup>`).join('')
    : '';
}

function sidePicker(side, selected) {
  const isLeft = side === 'left';
  const value = isLeft ? leftSel : rightSel;
  const headers = sideHeaders(value);
  return `
    <div class="side-picker ${isLeft ? 'A' : 'B'}">
      <div class="side-label">
        <span class="badge ${isLeft ? 'badge-blue' : 'badge-gold'}">${isLeft ? '左侧' : '右侧'}</span>
        <span>${isLeft ? '基准数据' : '对比数据'}</span>
      </div>
      <select class="select" data-side="${side}">
        <option value="">请选择生成结果或数据表</option>
        ${optionGroups([
          ...runOptions().map((item) => ({ ...item, group: '生成结果' })),
          ...tableOptions(),
        ], value)}
      </select>
      <div class="side-meta">
        ${value
          ? `<span class="chip chip-brand">${icon('table')}${headers.length} 列</span>
             <span class="chip">${esc(sideLabel(value))}</span>`
          : `<span class="chip">等待选择</span>`}
      </div>
    </div>`;
}

function setupCard() {
  ensureKeys();
  const common = commonHeaders();
  const canCompare = !!(leftSel && rightSel && keys.length);
  const hasRuns = runOptions().length >= 2;
  return `
    <div class="card card-pad">
      <div class="flex items-center justify-between gap-12 flex-wrap mb-16">
        <div>
          <h2 class="section-title">选择对比双方</h2>
          <p class="section-sub">可以对比两次生成结果，也可以拿结果与原始数据表核对。</p>
        </div>
        ${hasRuns ? `<button class="btn btn-secondary btn-sm" type="button" data-latest-two>${icon('history')}对比最近两次生成</button>` : ''}
      </div>
      <div class="compare-picker">
        ${sidePicker('left')}
        <div class="swap-wrap">
          <button class="swap-btn" type="button" data-swap title="交换左右" aria-label="交换左右">${icon('refresh')}</button>
        </div>
        ${sidePicker('right')}
      </div>
      ${leftSel && rightSel ? `
        <div class="key-picker-row">
          <span class="label">${icon('key', 'icon-sm')} 对比主键</span>
          ${common.length
            ? common.map((h) => `<button class="pick ${keys.includes(h) ? 'selected' : ''}" type="button" data-key="${attr(h)}">${keys.includes(h) ? icon('check') : ''}${esc(h)}</button>`).join('')
            : `<span class="tiny" style="color:var(--red)">两侧没有同名列，无法按主键对比。</span>`}
          <span class="hint">可选择多个字段组成组合主键</span>
        </div>` : ''}
      <div class="compare-cta">
        <span class="note">${icon('shield')}对比只在本机内存中完成，报告会保存到本机。</span>
        <div class="flex items-center gap-8">
          ${result ? `<button class="btn btn-ghost btn-sm" type="button" data-reset>清空结果</button>` : ''}
          <button class="btn btn-primary" type="button" data-compare ${busy ? 'disabled' : ''}>
            ${busy ? '<span class="spinner spinner-sm"></span>对比中…' : `${icon('compare')}开始对比`}
          </button>
        </div>
      </div>
      ${!canCompare && (leftSel || rightSel) ? `<div class="warning-note mt-12">${icon('alert')}<span>${!common.length ? '两张表没有相同的列，无法按主键对比。' : '请选择至少一个对比主键。'}</span></div>` : ''}
    </div>`;
}

function summaryCard(kind, label, value, sub, iconName) {
  return `<div class="diff-stat ${kind}">
    <div class="label">${icon(iconName)}${label}</div>
    <div class="value">${fmtNumber(value)}</div>
    <div class="sub">${sub}</div>
  </div>`;
}

function resultItemRow(item) {
  const typeMap = {
    changed: ['修改', 'badge-gold'],
    added: ['新增', 'badge-green'],
    removed: ['删除', 'badge-red'],
  };
  const [label, cls] = typeMap[item.type];
  const left = item.left === '' || item.left === null || item.left === undefined
    ? '<span class="empty-val">空</span>' : `<span class="${item.type === 'changed' ? 'old' : ''}">${esc(item.left)}</span>`;
  const right = item.right === '' || item.right === null || item.right === undefined
    ? '<span class="empty-val">空</span>' : `<span class="${item.type === 'changed' ? 'new' : ''}">${esc(item.right)}</span>`;
  return `<tr>
    <td><span class="badge ${cls}">${label}</span></td>
    <td class="cell-strong">${esc(item.key || '—')}</td>
    <td>${esc(item.field || '整行')}</td>
    <td>${left}</td>
    <td>${right}</td>
  </tr>`;
}

function resultsHTML() {
  if (!result) return '';
  const s = result.summary;
  const items = [];
  for (const change of result.changes || []) {
    items.push({ type: 'changed', key: change.key, field: change.field, left: change.left, right: change.right });
  }
  for (const row of result.added || []) {
    const summary = Object.entries(row.values || {}).filter(([, v]) => v !== '').slice(0, 5)
      .map(([k, v]) => `${k}: ${v}`).join(' · ');
    items.push({ type: 'added', key: row.key, field: '整行', left: '—', right: summary || '—' });
  }
  for (const row of result.removed || []) {
    const summary = Object.entries(row.values || {}).filter(([, v]) => v !== '').slice(0, 5)
      .map(([k, v]) => `${k}: ${v}`).join(' · ');
    items.push({ type: 'removed', key: row.key, field: '整行', left: summary || '—', right: '—' });
  }
  const counts = {
    all: items.length,
    changed: (result.changes || []).length,
    added: s.added || 0,
    removed: s.removed || 0,
  };
  const filtered = filter === 'all' ? items : items.filter((item) => item.type === filter);
  const shown = filtered.slice(0, 400);
  const noDiff = !s.added && !s.removed && !s.changed_rows;
  const truncatedNote = result.truncated?.changes || result.truncated?.added || result.truncated?.removed;

  return `
    <div id="compare-results" class="mt-24">
      <div class="section-bar">
        <div>
          <h2 class="section-title">对比结果</h2>
          <p class="section-sub">${esc(s.left_name)} <span class="faint">对比</span> ${esc(s.right_name)} · 主键 ${esc((s.keys || []).join(' + '))}</p>
        </div>
        <a class="btn btn-primary btn-sm" href="${attr(result.export_url)}">${icon('download')}导出对比报告</a>
      </div>
      <div class="diff-summary">
        ${summaryCard('add', '新增行', s.added, '只在右侧出现', 'plus')}
        ${summaryCard('del', '删除行', s.removed, '只在左侧出现', 'trash')}
        ${summaryCard('chg', '修改行', s.changed_rows, `${fmtNumber(s.changed_cells)} 个单元格变化`, 'refresh')}
        ${summaryCard('same', '未变化', s.unchanged, '两侧一致的行', 'check-circle')}
      </div>
      ${result.warnings?.length ? `<div class="diff-warnings">${result.warnings.map((w) => `<div class="diff-warning">${icon('alert')}<span>${esc(w)}</span></div>`).join('')}</div>` : ''}
      ${(s.only_left_columns?.length || s.only_right_columns?.length) ? `<div class="column-diff">
        ${s.only_left_columns?.length ? `<span>仅左侧有：</span>${s.only_left_columns.map((c) => `<span class="chip chip-blue">${esc(c)}</span>`).join('')}` : ''}
        ${s.only_right_columns?.length ? `<span>仅右侧有：</span>${s.only_right_columns.map((c) => `<span class="chip chip-gold">${esc(c)}</span>`).join('')}` : ''}
      </div>` : ''}
      ${noDiff
        ? `<div class="card mt-18">${emptyState({ iconName: 'check-circle', title: '两侧数据完全一致', desc: '按所选主键逐行比对后，没有发现新增、删除或修改。', small: true })}</div>`
        : `<div class="card card-pad mt-18" style="padding-bottom:8px">
            <div class="diff-toolbar" style="margin-top:0">
              <div class="segmented">
                ${[['all', '全部'], ['changed', '修改'], ['added', '新增'], ['removed', '删除']].map(([key, label]) => `
                  <button type="button" data-diff-filter="${key}" class="${filter === key ? 'active' : ''}">${label} <span class="count">${fmtNumber(counts[key])}</span></button>`).join('')}
              </div>
              <span class="tiny faint">差异明细按行列出，完整内容见导出报告</span>
            </div>
            ${shown.length ? `
              <div class="table-wrap max-h">
                <table class="table compact diff-table">
                  <thead><tr><th style="width:78px">类型</th><th style="width:190px">主键</th><th style="width:140px">字段</th><th>左侧值</th><th>右侧值</th></tr></thead>
                  <tbody>${shown.map(resultItemRow).join('')}</tbody>
                </table>
              </div>
              <div class="table-scroll-note">${filtered.length > shown.length ? `当前显示前 ${shown.length} 条，共 ${fmtNumber(filtered.length)} 条。请导出报告查看全部差异。` : `共 ${fmtNumber(filtered.length)} 条差异。`}${truncatedNote ? ' 本次返回的明细已截断，导出报告包含全部内容。' : ''}</div>`
              : `<div class="empty small"><div class="empty-icon">${icon('search')}</div><h3>这个分类下没有记录</h3><p>切换到其他分类看看。</p></div>`}
          </div>`}
    </div>`;
}

function paint(view) {
  const canCompare = !!(leftSel && rightSel && keys.length);
  view.innerHTML = `
    ${pageHead({
      eyebrow: `${icon('compare')}结果对比`,
      title: '数据对比',
      desc: '按主键逐行核对两次结果或原始数据。新增、删除、修改会自动分类，并可导出带颜色的差异报告。',
      actions: '',
    })}
    ${setupCard()}
    ${result ? resultsHTML() : `<div class="card mt-18">${emptyState({
      iconName: leftSel && rightSel && keys.length ? 'check-circle' : 'compare',
      title: leftSel && rightSel && keys.length ? '准备就绪，点击「开始对比」' : '选择两侧数据开始核对',
      desc: leftSel && rightSel && keys.length
        ? '会按所选主键逐行比较，找出新增、删除和字段变化。整个过程只在本机内存中完成。'
        : '左侧通常是上期结果或基准表，右侧是本期结果。选一个共同的主键（如工号、订单号），系统会逐行比较。',
      small: true,
    })}</div>`}`;

  view.querySelectorAll('[data-side]').forEach((select) => {
    select.addEventListener('change', () => {
      if (select.dataset.side === 'left') leftSel = select.value;
      else rightSel = select.value;
      result = null;
      filter = 'all';
      ensureKeys();
      paint(view);
    });
  });
  view.querySelector('[data-swap]')?.addEventListener('click', () => {
    [leftSel, rightSel] = [rightSel, leftSel];
    result = null;
    filter = 'all';
    ensureKeys();
    paint(view);
  });
  view.querySelector('[data-latest-two]')?.addEventListener('click', () => {
    const runs = state.runs.filter((r) => r.status === 'ok' && runHeaders(r).length);
    if (runs.length < 2) {
      toast('至少需要两次成功的生成记录。', 'info');
      return;
    }
    leftSel = `run:${runs[1].id}`;
    rightSel = `run:${runs[0].id}`;
    keys = [];
    result = null;
    ensureKeys();
    paint(view);
  });
  view.querySelectorAll('[data-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      if (keys.includes(key)) keys = keys.filter((k) => k !== key);
      else keys = [...keys, key];
      result = null;
      paint(view);
    });
  });
  view.querySelector('[data-compare]')?.addEventListener('click', async () => {
    if (!leftSel || !rightSel) {
      toast('请先选择左右两侧的数据。', 'warn');
      return;
    }
    if (!keys.length) {
      toast('请至少选择一个对比主键。', 'warn');
      return;
    }
    busy = true;
    paint(view);
    try {
      const data = await api.compare({
        left: sideSpec(leftSel),
        right: sideSpec(rightSel),
        keys,
      });
      result = data;
      filter = 'all';
      await loadBootstrap();
      busy = false;
      paint(view);
      document.querySelector('#compare-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      busy = false;
      paint(view);
      toast(err.message, 'error', 6500);
    }
  });
  view.querySelectorAll('[data-reset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      result = null;
      filter = 'all';
      paint(view);
    });
  });
  view.querySelectorAll('[data-diff-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      filter = btn.dataset.diffFilter;
      const y = window.scrollY;
      paint(view);
      window.scrollTo(0, y);
    });
  });
}

export default {
  nav: 'compare',
  async render(view, ctx) {
    const left = ctx.query.get('left') || '';
    if ((left.startsWith('run:') || left.startsWith('table:')) && left !== leftSel) {
      leftSel = left;
      result = null;
      const right = ctx.query.get('right') || '';
      if (right.startsWith('run:') || right.startsWith('table:')) {
        rightSel = right;
      } else {
        const leftRun = leftSel.startsWith('run:')
          ? state.runs.find((r) => `run:${r.id}` === leftSel) : null;
        const sameProfile = leftRun
          ? state.runs.find((r) => r.profile_id === leftRun.profile_id
            && r.id !== leftRun.id && r.status === 'ok' && runHeaders(r).length)
          : null;
        const candidate = sameProfile
          ? { value: `run:${sameProfile.id}` }
          : (runOptions().find((item) => item.value !== leftSel)
            || tableOptions().find((item) => item.value !== leftSel));
        if (candidate) rightSel = candidate.value;
      }
    }
    ensureKeys();
    paint(view);
    return () => {};
  },
};
