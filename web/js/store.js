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

/** 方案目标列与模板字段的差异——用于提示「模板已更新，字段对不上了」。 */
export function templateDrift(config) {
  const target = config?.target || {};
  if (target.kind !== 'template' || !target.template_id) return null;
  const template = templateById(target.template_id);
  if (!template) return { missingTemplate: true, added: [], removed: [], renamed: [] };
  const fieldNames = (template.fields || []).map((f) => f.name);
  const colNames = (target.columns || []).filter((c) => c.included !== false).map((c) => c.name);
  const added = fieldNames.filter((n) => !colNames.includes(n));
  const removed = colNames.filter((n) => !fieldNames.includes(n));
  if (!added.length && !removed.length) return null;
  return { missingTemplate: false, added, removed, renamed: [], template };
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
    if (m && (m.mode === 'table' || m.mode === 'const')) mapped += 1;
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
  cfg.options = { dedupe: true, skip_empty_key: false, ...(cfg.options || {}) };
  return cfg;
}
