/** 汇总方案列表。 */
import { api } from '../api.js';
import { openCreateProfileModal } from '../components.js';
import { activeTableIds, includedColumns, loadBootstrap, state } from '../store.js';
import {
  confirmDialog, emptyState, esc, icon, pageHead, timeAgo, toast,
} from '../ui.js';

function profileRow(profile) {
  const cfg = profile.config || {};
  const cols = includedColumns(cfg);
  const sources = activeTableIds(cfg);
  const runs = state.runs.filter((r) => r.profile_id === profile.id);
  const ready = cols.length > 0 && sources.length > 0;
  return `
    <div class="profile-row">
      <div class="profile-icon">${icon(cfg.mode === 'append' ? 'layers' : 'link')}</div>
      <div class="profile-main">
        <div class="flex items-center gap-8 flex-wrap">
          <a class="profile-name" href="#/profiles/${encodeURIComponent(profile.id)}">${esc(profile.name)}</a>
          <span class="chip ${ready ? 'chip-brand' : 'chip-gold'}">${cfg.mode === 'append' ? '纵向合并' : '主表关联'}</span>
          ${cfg.target?.kind === 'template' ? `<span class="chip chip-plain">${icon('file-spreadsheet')}模板</span>` : ''}
          ${!ready ? `<span class="chip chip-gold">待完善</span>` : ''}
        </div>
        ${profile.note ? `<div class="profile-note" style="margin-top:3px">${esc(profile.note)}</div>` : ''}
        <div class="profile-stats">
          <span class="profile-stat">${icon('columns')}${cols.length} 个输出列</span>
          <span class="profile-stat">${icon('database')}${sources.length} 张数据表</span>
          <span class="profile-stat">${icon('history')}${runs.length} 次生成</span>
          <span class="profile-stat">${icon('clock')}更新于 ${timeAgo(profile.updated_at)}</span>
        </div>
      </div>
      <div class="row-actions">
        <a class="btn btn-secondary btn-sm" href="#/profiles/${encodeURIComponent(profile.id)}">打开 ${icon('arrow-right')}</a>
        <button class="icon-btn" type="button" data-duplicate="${attrId(profile.id)}" title="复制方案" aria-label="复制方案">${icon('copy')}</button>
        <button class="icon-btn danger" type="button" data-delete="${attrId(profile.id)}" title="删除方案" aria-label="删除方案">${icon('trash')}</button>
      </div>
    </div>`;
}

function attrId(value) {
  return String(value).replaceAll('"', '&quot;');
}

export default {
  nav: 'profiles',
  async render(view, ctx) {
    const profiles = state.profiles || [];
    view.innerHTML = `
      ${pageHead({
        eyebrow: `${icon('layers')}汇总方案管理`,
        title: '汇总方案',
        desc: '一个方案就是一套固定的汇总规则：数据来源、目标表结构、每一列的来源和缺省值。配置一次，可以反复使用。',
        actions: `<button class="btn btn-primary" type="button" data-new-profile>${icon('plus')}新建方案</button>`,
      })}
      ${profiles.length
        ? `<div class="profile-list">${profiles.map(profileRow).join('')}</div>`
        : `<div class="card">${emptyState({
          iconName: 'layers',
          title: '还没有汇总方案',
          desc: '创建方案后，可以上传现有的 Excel 模板，为每个目标列选择数据来源，然后一键生成填好的表格。',
          action: `<button class="btn btn-primary" type="button" data-new-profile>${icon('plus')}创建第一个方案</button>`,
        })}</div>`}
      <div class="card card-pad mt-18" style="background:linear-gradient(150deg,#fbfdfc,#f5f9f7)">
        <div class="flex items-center gap-12 flex-wrap">
          <div class="profile-icon">${icon('info')}</div>
          <div class="flex-1">
            <div class="strong" style="font-size:12.5px">方案里保存的是“规则”，不是数据副本</div>
            <p class="tiny muted mt-4">修改数据源后重新生成即可得到新结果。历史结果与差异报告会按保留策略自动清理，重要文件请及时下载到业务文件夹。</p>
          </div>
        </div>
      </div>`;

    const openCreate = () => openCreateProfileModal({
      onCreated: (profile) => ctx.navigate(`#/profiles/${profile.id}`),
    });
    view.querySelectorAll('[data-new-profile]').forEach((btn) => btn.addEventListener('click', openCreate));

    view.onclick = async (event) => {
      const dup = event.target.closest('[data-duplicate]');
      if (dup) {
        try {
          const data = await api.duplicateProfile(dup.dataset.duplicate);
          await loadBootstrap();
          toast('方案已复制。', 'ok');
          ctx.navigate(`#/profiles/${data.profile.id}`);
        } catch (err) {
          toast(err.message, 'error');
        }
        return;
      }
      const del = event.target.closest('[data-delete]');
      if (del) {
        const profile = state.profiles.find((p) => p.id === del.dataset.delete);
        if (!profile) return;
        const runs = state.runs.filter((r) => r.profile_id === profile.id).length;
        const ok = await confirmDialog({
          title: '删除汇总方案',
          message: `确定删除「${esc(profile.name)}」吗？`,
          detail: `<div class="warning-note">${icon('alert')}<span>方案配置会被删除${runs ? `，但它生成的 ${runs} 份历史结果会保留在生成记录中` : ''}。此操作不可撤销。</span></div>`,
          confirmText: '删除方案',
          danger: true,
        });
        if (!ok) return;
        try {
          await api.deleteProfile(profile.id);
          await loadBootstrap();
          toast('方案已删除。', 'ok');
          ctx.navigate('#/profiles');
          if (location.hash === '#/profiles') {
            await this.render(view, ctx);
          }
        } catch (err) {
          toast(err.message, 'error');
        }
      }
    };

    return () => { view.onclick = null; };
  },
};
