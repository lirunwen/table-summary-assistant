/** 全局只读数据与选择器辅助。 */
import { api } from './api.js';

// 数据表索引缓存：allTables() 每次都要遍历整棵树并拼标签，
// 而 tableHeaders/tableLabel 在方案编辑页的渲染循环里被调用十几次，
// 不缓存的话一次渲染要重建上千次索引。
let tableIndex = null;

export const state = {
  app: null,
  settings: {},
  sources: [],
  profiles: [],
  templates: [],
  runs: [],
  stats: {},
  loaded: false,
};

export async function loadBootstrap() {
  const data = await api.bootstrap();
  Object.assign(state, {
    app: data.app,
    settings: data.settings || {},
    sources: data.sources || [],
    profiles: data.profiles || [],
    templates: data.templates || [],
    runs: data.runs || [],
    stats: data.stats || {},
    loaded: true,
  });
  tableIndex = null;   // 数据变了，索引失效
  updateChrome();
  return data;
}

export function updateChrome() {
  document.querySelectorAll('[data-version]').forEach((el) => {
    el.textContent = state.app?.version || '0.1.0';
  });
  document.querySelectorAll('[data-count]').forEach((el) => {
    const key = el.dataset.count;
    const value = state.stats?.[key] ?? 0;
    el.textContent = value > 99 ? '99+' : String(value);
    el.hidden = !value;
  });
}

export function flatSources(nodes = state.sources, depth = 0, parent = null) {
  const out = [];
  for (const node of nodes) {
    out.push({ ...node, depth, parent });
    if (node.children?.length) out.push(...flatSources(node.children, depth + 1, node));
  }
  return out;
}

function buildTableIndex() {
  const list = [];
  const byId = new Map();
  for (const source of flatSources()) {
    for (const table of source.meta?.tables || []) {
      const entry = {
        table,
        source,
        root: source.depth === 0 ? source : findRoot(source),
        depth: source.depth,
        label: tableOptionLabel(source, table),
        group: groupLabel(source, table),
      };
      list.push(entry);
      if (table?.id) byId.set(table.id, entry);
    }
  }
  return { list, byId };
}

export function invalidateTableIndex() {
  tableIndex = null;
}

export function allTables() {
  if (!tableIndex) tableIndex = buildTableIndex();
  return tableIndex.list;
}

function findRoot(source) {
  if (!source.parent) return source;
  let current = source;
  while (current.parent) current = current.parent;
  return current;
}

function tableOptionLabel(source, table) {
  if (source.kind === 'email' && table.kind === 'mail_table') {
    const subject = source.meta?.email?.subject || source.name;
    return `${subject} · ${table.label}`;
  }
  if (source.depth > 0) return `${source.name} · ${table.label}`;
  if (source.meta?.tables?.length > 1) return `${source.name} · ${table.label}`;
  return source.name;
}

function groupLabel(source, table) {
  if (source.depth > 0) return `邮件附件 · ${source.name}`;
  if (source.kind === 'email') return `邮件 · ${source.meta?.email?.subject || source.name}`;
  if (source.meta?.tables?.length > 1) return `${source.name} · ${table.label}`;
  return source.name;
}

export function tableEntry(tableId) {
  if (!tableId) return null;
  if (!tableIndex) tableIndex = buildTableIndex();
  return tableIndex.byId.get(tableId) || null;
}

export function tableHeaders(tableId) {
  return tableEntry(tableId)?.table?.headers || [];
}

export function tableLabel(tableId) {
  return tableEntry(tableId)?.label || '（数据表已失效）';
}

export function tableRowCount(tableId) {
  return tableEntry(tableId)?.table?.row_count || 0;
}

export function profileById(id) {
  return state.profiles.find((p) => p.id === id) || null;
}

export function templateById(id) {
  return state.templates.find((t) => t.id === id) || null;
}

/** 模板字段（契约）。旧数据没有 fields 时返回空数组，调用方自己兜底。 */
export function templateFields(id) {
  return templateById(id)?.fields || [];
}

/** 模板所有标签，按出现次数降序——列表页的标签筛选直接用。 */
export function templateTags() {
  const counter = new Map();
  for (const t of state.templates || []) {
    for (const tag of t.tags || []) counter.set(tag, (counter.get(tag) || 0) + 1);
  }
  return [...counter.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export function templateCategories() {
  const counter = new Map();
  for (const t of state.templates || []) {
    if (t.category) counter.set(t.category, (counter.get(t.category) || 0) + 1);
  }
  return [...counter.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 方案目标列与模板字段的差异——用于提示「模板已更新，字段对不上了」。
 *
 * 判定原则（对应评审里的 F5/F6）：
 * - 按**全部**目标列比，`included === false` 的列也算「方案里有这一列」，
 *   所以「取消勾选某列」不会被误报成「模板新增了字段」；
 * - 名字优先、位置其次：先在名字上对齐，剩下的再按模板列号配对，
 *   配上的算「改名」，没配上的才是真正的增/删；
 * - 模板在中间插入字段时，后面所有列的位置都会平移，按名字对齐不受影响。
 */
export function templateDrift(config) {
  const target = config?.target || {};
  if (target.kind !== 'template' || !target.template_id) return null;
  const template = templateById(target.template_id);
  if (!template) return { missingTemplate: true, added: [], removed: [], renamed: [] };
  const fields = template.fields || [];
  const cols = target.columns || [];
  const nameOfCol = (c) => String(c.name || '').trim();
  const nameOfField = (f) => String(f?.name || '').trim();
  const colNames = new Set(cols.map(nameOfCol));
  const fieldNames = new Set(fields.map(nameOfField));

  const addedFields = fields
    .map((f, index) => ({ name: nameOfField(f), index }))
    .filter((f) => f.name && !colNames.has(f.name));
  const removedCols = cols
    .filter((c) => c.included !== false && nameOfCol(c) && !fieldNames.has(nameOfCol(c)))
    .map((c) => ({
      name: nameOfCol(c),
      col: c.template_col === null || c.template_col === undefined ? null : Number(c.template_col),
    }));

  const renamed = [];
  const pairedAdded = new Set();
  const pairedRemoved = new Set();
  removedCols.forEach((removed, ri) => {
    if (removed.col === null || Number.isNaN(removed.col)) return;
    const hit = addedFields.find((f) => f.index === removed.col && !pairedAdded.has(f.index));
    if (!hit) return;
    renamed.push({ from: removed.name, to: hit.name, col: removed.col });
    pairedAdded.add(hit.index);
    pairedRemoved.add(ri);
  });

  const added = addedFields.filter((f) => !pairedAdded.has(f.index)).map((f) => f.name);
  const removed = removedCols.filter((_, i) => !pairedRemoved.has(i)).map((c) => c.name);
  if (!added.length && !removed.length && !renamed.length) return null;
  return { missingTemplate: false, added, removed, renamed, template };
}

export function runById(id) {
  return state.runs.find((r) => r.id === id) || null;
}

export function runHeaders(run) {
  return run?.summary?.output?.headers || [];
}

export function runColumns(run) {
  return run?.summary?.output?.columns || [];
}

export function sourceKind(source) {
  if (source.kind === 'email') return { cls: 'email', icon: 'mail', label: 'Outlook 邮件' };
  if (source.kind === 'csv') return { cls: 'csv', icon: 'file-text', label: 'CSV 数据' };
  if (source.kind === 'xls') return { cls: 'excel', icon: 'file-spreadsheet', label: 'Excel 97-2003' };
  if (source.kind === 'excel') return { cls: 'excel', icon: 'file-spreadsheet', label: 'Excel 工作簿' };
  return { cls: 'csv', icon: 'file', label: '文件' };
}

export function allSourceNames() {
  return flatSources().map((s) => s.name);
}

export function tableOptionsFor(ids = null) {
  const all = allTables();
  return ids ? all.filter((entry) => ids.includes(entry.table.id)) : all;
}

/**
 * 合并方式目录：key 与 backend/fieldmap.py 的 COMBINES 一一对应。
 * `needsOrder` 为真的方式必须知道「按哪一列排序」，界面上要引导用户选排序列。
 */
export const COMBINES = [
  { key: 'first', label: '取第一个非空值', hint: '按来源顺序，第一个有值的胜出' },
  { key: 'sum', label: '求和', hint: '把匹配到的多行数值加起来' },
  { key: 'count', label: '计数', hint: '数一下匹配到多少条记录' },
  { key: 'max', label: '最大值', hint: '数值或日期取最大' },
  { key: 'min', label: '最小值', hint: '数值或日期取最小' },
  { key: 'latest', label: '取最新一条', hint: '按排序列取最新的一条', needsOrder: true },
  { key: 'concat', label: '拼接', hint: '多个值用顿号连起来，自动去重' },
];

export const COMBINE_LABELS = COMBINES.reduce((acc, item) => {
  acc[item.key] = item.label;
  return acc;
}, {});

/** 一条来源：哪张表的第几列，取值后怎么处理。集合内的列名不参与运算，只用于界面回显。 */
export function normalizeSource(src) {
  if (!src || !src.table_id) return null;
  const index = Number(src.column_index);
  return {
    table_id: src.table_id,
    column_index: Number.isInteger(index) && index >= 0 ? index : 0,
    transform: src.transform || 'direct',
    column_name: src.column_name || '',
  };
}

/**
 * 读出一列的来源链。
 *
 * 新结构是 `sources[]`（可多条，按顺序兜底/聚合）；老配置是
 * `{mode:'table', table_id, column_index}`，等价于「单来源 + 取第一个非空值」，
 * 所以这里统一折成数组，界面和引擎都不用写两套分支。
 */
export function sourcesOf(mapping) {
  if (!mapping) return [];
  if (Array.isArray(mapping.sources) && mapping.sources.length) {
    return mapping.sources.map(normalizeSource).filter(Boolean);
  }
  if (mapping.mode === 'table' && mapping.table_id) {
    const one = normalizeSource(mapping);
    return one ? [one] : [];
  }
  return [];
}

export function combineOf(mapping) {
  const key = String(mapping?.combine || '').toLowerCase();
  return COMBINE_LABELS[key] ? key : 'first';
}

/** 把任意历史形态的映射整理成当前结构（mode 保留，兼容旧分支判断）。 */
export function normalizeMapping(raw) {
  const mapping = { ...(raw || {}) };
  if (mapping.mode === 'const') {
    return { ...mapping, mode: 'const', value: mapping.value ?? '', sources: [] };
  }
  const sources = sourcesOf(mapping);
  if (!sources.length) {
    if (mapping.formula_on === true) return { ...mapping, sources: [] };
    return { ...mapping, mode: 'blank', sources: [] };
  }
  delete mapping.table_id;
  delete mapping.column_index;
  return {
    ...mapping,
    mode: 'table',
    sources,
    combine: combineOf(mapping),
    separator: mapping.separator || '、',
    order_by: mapping.order_by && mapping.order_by.table_id ? {
      table_id: mapping.order_by.table_id,
      column_index: Number(mapping.order_by.column_index) || 0,
    } : null,
  };
}

export function includedColumns(config) {
  return (config?.target?.columns || []).filter((c) => c.included !== false && String(c.name || '').trim());
}

export function activeTableIds(config) {
  if (!config) return [];
  if (config.mode === 'append') return config.append_tables || [];
  return [config.primary_table, ...(config.lookups || []).map((l) => l.table_id)].filter(Boolean);
}

export function mappingSummary(config) {
  const cols = includedColumns(config);
  const mappings = config?.mappings || {};
  let mapped = 0;
  let missing = 0;
  for (const col of cols) {
    const m = mappings[col.key];
    if (m && (m.formula_on === true || m.mode === 'const' || sourcesOf(m).length)) mapped += 1;
    else missing += 1;
  }
  return { total: cols.length, mapped, missing };
}

export function defaultConfig(mode = 'join') {
  return {
    mode,
    primary_table: '',
    primary_keys: [],
    lookups: [],
    append_tables: [],
    auto_by_name: true,
    target: {
      kind: 'blank',
      template_id: null,
      sheet: '汇总',
      header_row: 1,
      write_mode: 'replace',
      columns: [],
    },
    mappings: {},
    options: { dedupe: true, skip_empty_key: false },
  };
}

export function normalizeConfig(raw, mode = 'join') {
  const base = defaultConfig(mode);
  const cfg = { ...base, ...(raw || {}) };
  cfg.mode = cfg.mode === 'append' ? 'append' : 'join';
  cfg.target = { ...base.target, ...(cfg.target || {}) };
  cfg.target.columns = Array.isArray(cfg.target.columns) ? cfg.target.columns : [];
  cfg.target.header_row = Number(cfg.target.header_row) || 1;
  cfg.primary_keys = (cfg.primary_keys || []).map(Number).filter((n) => Number.isInteger(n));
  cfg.lookups = (cfg.lookups || []).map((l) => ({
    table_id: l.table_id || '',
    keys: (l.keys || []).map(Number),
  }));
  cfg.append_tables = Array.isArray(cfg.append_tables) ? cfg.append_tables.filter(Boolean) : [];
  cfg.mappings = cfg.mappings && typeof cfg.mappings === 'object' ? cfg.mappings : {};
  // 老配置（mode=table + 单条 table_id）在这里就折成来源链，
  // 界面只面对一种结构，保存时写回的也是新结构（后端仍兼容旧结构）。
  const normalized = {};
  for (const [key, value] of Object.entries(cfg.mappings)) normalized[key] = normalizeMapping(value);
  cfg.mappings = normalized;
  cfg.options = { dedupe: true, skip_empty_key: false, ...(cfg.options || {}) };
  return cfg;
}
