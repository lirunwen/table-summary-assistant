/** 生成记录：结果下载、详情、对比与清理。 */
import { api } from '../api.js';
import { openRunDetail } from '../components.js';
import { loadBootstrap, state } from '../store.js';
import {
  confirmDialog, emptyState, esc, fmtDate, fmtNumber, icon, pageHead, toast,
} from '../ui.js';

export default {
  nav: 'runs',
  async render(view, ctx) {
    let busy = false;

    function paint() {
      const runs = state.runs || [];
      const keep = state.settings?.keep_runs || 30;
      view.innerHTML = `
        ${pageHead({
          eyebrow: `${icon('history')}生成记录`,
          title: '生成记录',
          desc: '每一次生成的汇总表都会留在这里，可随时重新下载或与另一次结果对比。结果文件保存在本机。',
          actions: `
            <button class="btn btn-secondary" type="button" data-refresh ${busy ? 'disabled' : ''}>${icon('refresh')}刷新</button>
            <a class="btn btn-primary" href="#/compare">${icon('compare')}数据对比</a>`,
        })}
        ${runs.length ? `
          <div class="card run-table-card">
            <div class="table-wrap" style="border:0;border-radius:var(--radius-lg)">
              <table class="table run-table">
                <thead><tr>
                  <th style="min-width:220px">输出文件</th>
                  <th>所属方案</th>
                  <th>生成时间</th>
                  <th class="num">数据规模</th>
                  <th class="num">耗时</th>
                  <th>状态</th>
                  <th style="width:150px">操作</th>
                </tr></thead>
                <tbody>
                  ${runs.map((run) => `
                    <tr>
                      <td>
                        <div class="output">
                          <div class="file-icon">${icon('file-spreadsheet')}</div>
                          <div style="min-width:0">
                            <div class="output-name" title="${esc(run.output_name || '')}">${esc(run.output_name || '结果文件')}</div>
                            <div class="output-sub">${esc(run.summary?.output?.sheet || '汇总')} · ${fmtNumber(run.summary?.columns || 0)} 列</div>
                          </div>
                        </div>
                      </td>
                      <td class="cell-strong">${esc(run.profile_name || '—')}</td>
                      <td><div class="cell-strong" style="font-weight:500">${fmtDate(run.created_at, true, true)}</div></td>
                      <td class="num">${fmtNumber(run.summary?.rows || 0)} 行</td>
                      <td class="num">${fmtNumber(run.duration_ms || run.summary?.duration_ms || 0)} ms</td>
                      <td><span class="chip chip-green">${icon('check')}成功</span></td>
                      <td>
                        <div class="row-actions">
                          <a class="icon-btn" href="${attrUrl(run.download_url)}" title="下载结果" aria-label="下载结果">${icon('download')}</a>
                          <button class="icon-btn" type="button" data-run-detail="${esc(run.id)}" title="生成详情" aria-label="生成详情">${icon('info')}</button>
                          <button class="icon-btn" type="button" data-run-compare="${esc(run.id)}" title="与其他结果对比" aria-label="与其他结果对比">${icon('compare')}</button>
                          <button class="icon-btn danger" type="button" data-run-delete="${esc(run.id)}" title="删除记录" aria-label="删除记录">${icon('trash')}</button>
                        </div>
                      </td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>
            <div class="table-scroll-note">共 ${runs.length} 条记录 · 按「设置」中的保留数量（当前 ${keep} 条）自动清理较早的结果文件。</div>
          </div>` : `<div class="card">${emptyState({
            iconName: 'history',
            title: '还没有生成过汇总表',
            desc: '打开一个汇总方案，配置好来源与字段映射后点击「生成汇总表」，结果会出现在这里。',
            action: '<a class="btn btn-primary" href="#/profiles">去汇总方案</a>',
          })}</div>`}`;

      view.querySelector('[data-refresh]')?.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        try {
          await loadBootstrap();
          toast('生成记录已刷新。', 'ok');
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          busy = false;
          paint();
        }
      });

      view.querySelectorAll('[data-run-detail]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const run = state.runs.find((r) => r.id === btn.dataset.runDetail);
          if (run) openRunDetail(run);
        });
      });
      view.querySelectorAll('[data-run-compare]').forEach((btn) => {
        btn.addEventListener('click', () => {
          ctx.navigate(`#/compare?left=run:${encodeURIComponent(btn.dataset.runCompare)}`);
        });
      });
      view.querySelectorAll('[data-run-delete]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const run = state.runs.find((r) => r.id === btn.dataset.runDelete);
          if (!run) return;
          const ok = await confirmDialog({
            title: '删除生成记录',
            message: `确定删除「${esc(run.output_name || '结果文件')}」吗？`,
            detail: `<div class="warning-note">${icon('alert')}<span>结果 Excel 会从本机删除，方案配置不受影响。如已在业务文件夹留存副本，不受影响。</span></div>`,
            confirmText: '删除',
            danger: true,
          });
          if (!ok) return;
          try {
            await api.deleteRun(run.id);
            await loadBootstrap();
            toast('生成记录已删除。', 'ok');
            paint();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      });
    }

    paint();
    return () => {};
  },
};

function attrUrl(url) {
  return String(url || '').replaceAll('"', '&quot;');
}
