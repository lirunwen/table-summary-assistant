/** 与本地服务通信的最小封装。 */
class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request(path, options = {}) {
  const opts = { method: options.method || 'GET', headers: {}, ...options };
  if (options.body !== undefined) {
    if (options.body instanceof FormData) {
      opts.body = options.body;
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(options.body);
    }
  }
  let resp;
  try {
    resp = await fetch(path, opts);
  } catch (err) {
    throw new ApiError('无法连接本地服务，请确认「表格汇总助手」的启动窗口仍在运行。');
  }
  let data = null;
  const type = resp.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    try { data = await resp.json(); } catch (err) { data = null; }
  }
  if (!resp.ok || (data && data.ok === false)) {
    const message = (data && data.error) || `请求失败（HTTP ${resp.status}）`;
    throw new ApiError(message, resp.status);
  }
  return data;
}

export const api = {
  bootstrap: () => request('/api/bootstrap'),

  uploadSources(files) {
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append('files', f, f.name));
    return request('/api/sources/upload', { method: 'POST', body: fd });
  },

  patchSource(id, payload) {
    return request(`/api/sources/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload });
  },

  deleteSource(id) {
    return request(`/api/sources/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  tablePreview(tableId, limit = 30) {
    const qs = new URLSearchParams({ table_id: tableId, limit: String(limit) });
    return request(`/api/table-preview?${qs.toString()}`);
  },

  uploadTemplate(file, extra = {}) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    Object.entries(extra).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') fd.append(k, Array.isArray(v) ? v.join(',') : v);
    });
    return request('/api/templates/upload', { method: 'POST', body: fd });
  },

  templateOptions() {
    return request('/api/template-options');
  },

  listTemplates(params = {}) {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    });
    const suffix = qs.toString();
    return request(`/api/templates${suffix ? `?${suffix}` : ''}`);
  },

  getTemplate(id) {
    return request(`/api/templates/${encodeURIComponent(id)}`);
  },

  createTemplate(payload) {
    return request('/api/templates', { method: 'POST', body: payload });
  },

  updateTemplate(id, payload) {
    return request(`/api/templates/${encodeURIComponent(id)}`, { method: 'PUT', body: payload });
  },

  duplicateTemplate(id, name = '') {
    return request(`/api/templates/${encodeURIComponent(id)}/duplicate`, { method: 'POST', body: { name } });
  },

  deleteTemplate(id, force = false) {
    return request(`/api/templates/${encodeURIComponent(id)}${force ? '?force=1' : ''}`, { method: 'DELETE' });
  },

  saveTemplateVersion(id, note = '') {
    return request(`/api/templates/${encodeURIComponent(id)}/versions`, { method: 'POST', body: { note } });
  },

  restoreTemplateVersion(id, versionId) {
    return request(`/api/templates/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`, { method: 'POST' });
  },

  importTemplate(payload) {
    return request('/api/templates/import', { method: 'POST', body: payload });
  },

  templateExportUrl(id) {
    return `/api/templates/${encodeURIComponent(id)}/export`;
  },

  templateFileUrl(id) {
    return `/api/templates/${encodeURIComponent(id)}/file`;
  },

  validateWithTemplate(id, headers, rows, firstRow = 2) {
    return request(`/api/templates/${encodeURIComponent(id)}/validate`, {
      method: 'POST',
      body: { headers, rows, first_row: firstRow },
    });
  },

  inspectTemplate(templateId, sheet, headerRow) {
    return request(`/api/templates/${encodeURIComponent(templateId)}/inspect`, {
      method: 'POST',
      body: { sheet, header_row: headerRow },
    });
  },

  createProfile(payload) {
    return request('/api/profiles', { method: 'POST', body: payload });
  },

  updateProfile(id, payload) {
    return request(`/api/profiles/${encodeURIComponent(id)}`, { method: 'PUT', body: payload });
  },

  deleteProfile(id) {
    return request(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  duplicateProfile(id) {
    return request(`/api/profiles/${encodeURIComponent(id)}/duplicate`, { method: 'POST' });
  },

  preview(config, limit = 50) {
    return request('/api/preview', { method: 'POST', body: { config, limit } });
  },

  formulaHelp() {
    return request('/api/formula/help');
  },

  matchColumns(columns, tables) {
    return request('/api/match-columns', {
      method: 'POST',
      body: { columns, tables },
    });
  },

  formulaCheck(formula, tableIds) {
    return request('/api/formula/check', {
      method: 'POST',
      body: { formula, table_ids: tableIds },
    });
  },

  formulaTry(formula, tableId, limit = 5) {
    return request('/api/formula/try', {
      method: 'POST',
      body: { formula, table_id: tableId, limit },
    });
  },

  run(profileId, config, name) {
    return request(`/api/profiles/${encodeURIComponent(profileId)}/run`, {
      method: 'POST',
      body: { config, name },
    });
  },

  listRuns() {
    return request('/api/runs');
  },

  deleteRun(id) {
    return request(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  compare(payload) {
    return request('/api/compare', { method: 'POST', body: payload });
  },

  updateSettings(patch) {
    return request('/api/settings', { method: 'PUT', body: patch });
  },

  cleanup() {
    return request('/api/cleanup', { method: 'POST' });
  },

  openDataFolder() {
    return request('/api/open-data-folder', { method: 'POST' });
  },

  createShortcut() {
    return request('/api/app/shortcut', { method: 'POST' });
  },

  exitApp() {
    return request('/api/app/exit', { method: 'POST' });
  },
};

export { ApiError };
