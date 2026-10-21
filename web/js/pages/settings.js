/** 设置与本机运行信息。 */
import { api } from '../api.js';
import { loadBootstrap, state } from '../store.js';
import {
  confirmDialog, esc, fmtDate, fmtNumber, icon, pageHead, toast, withButtonLoading,
} from '../ui.js';

export default {
  nav: 'settings',
  async render(view, ctx) {
    const app = state.app || {};
    const settings = state.settings || {};
    const stats = state.stats || {};
    const exposed = !!app.exposed;

    view.innerHTML = `
      ${pageHead({
        eyebrow: `${icon('settings')}本机设置`,
        title: '设置',
        desc: '调整本机工作台的使用偏好，查看数据存放位置。所有设置只影响这台电脑。',
        actions: `<button class="btn btn-primary" type="button" data-save-settings>${icon('save')}保存设置</button>`,
      })}
      <div class="settings-grid">
        <div class="stack">
          <section class="card">
            <div class="card-head"><div><h2 class="section-title">常规设置</h2><p class="section-sub">影响之后生成的汇总结果</p></div></div>
            <div class="card-body" style="padding-top:6px">
              <div class="setting-row">
                <div class="setting-main">
                  <strong>日期显示格式</strong>
                  <p>目标列类型为「日期」时，写入 Excel 的单元格格式。</p>
                </div>
                <div class="setting-control">
                  <select class="select" id="set-date-format">
                    <option value="yyyy-mm-dd" ${settings.date_format === 'yyyy-mm-dd' ? 'selected' : ''}>2026-10-18</option>
                    <option value="yyyy/mm/dd" ${settings.date_format === 'yyyy/mm/dd' ? 'selected' : ''}>2026/10/18</option>
                    <option value="yyyy年mm月dd日" ${settings.date_format === 'yyyy年mm月dd日' ? 'selected' : ''}>2026年10月18日</option>
                  </select>
                </div>
              </div>
              <div class="setting-row">
                <div class="setting-main">
                  <strong>自动清理文本首尾空格</strong>
                  <p>汇总时对文本值去除首尾空白，避免“E001 ”和“E001”被当成两个值。</p>
                </div>
                <div class="setting-control">
                  <label class="switch">
                    <input type="checkbox" id="set-trim" ${settings.trim_text !== false ? 'checked' : ''}>
                    <span class="switch-track"></span>
                  </label>
                </div>
              </div>
              <div class="setting-row">
                <div class="setting-main">
                  <strong>保留生成记录</strong>
                  <p>超出数量的旧结果文件会自动清理，避免长期使用占满磁盘。范围 5–500 条。</p>
                </div>
                <div class="setting-control">
                  <div class="input-group">
                    <input class="input" id="set-keep-runs" type="number" min="5" max="500" value="${Number(settings.keep_runs) || 30}" style="width:90px;text-align:center">
                    <span class="small muted">条</span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section class="card">
            <div class="card-head"><div><h2 class="section-title">数据与存储</h2><p class="section-sub">上传的原始文件、模板、结果和配置都存放在本机</p></div></div>
            <div class="card-body">
              <div class="data-path">${icon('folder')}<span>${esc(app.data_dir || 'data')}</span></div>
              <div class="grid-2 mt-14" style="gap:12px">
                <div class="diff-stat same"><div class="label">${icon('database')}数据文件</div><div class="value">${fmtNumber(stats.sources || 0)}</div><div class="sub">另有 ${fmtNumber(Math.max(0, (stats.files || 0) - (stats.sources || 0)))} 个邮件附件 · ${fmtNumber(stats.tables || 0)} 张表</div></div>
                <div class="diff-stat same"><div class="label">${icon('history')}生成结果</div><div class="value">${fmtNumber(stats.runs || 0)}</div><div class="sub">最近汇总 ${fmtNumber(stats.rows_last || 0)} 行</div></div>
              </div>
              <div class="flex items-center gap-8 flex-wrap mt-16">
                <button class="btn btn-secondary" type="button" data-open-folder>${icon('folder')}打开数据目录</button>
                <button class="btn btn-secondary" type="button" data-cleanup>${icon('trash')}清理旧记录</button>
                <span class="tiny faint">建议定期把重要结果复制到业务文件夹。</span>
              </div>
              <div class="rail-tip mt-16">${icon('shield')}<span>升级程序时，只要保留整个 <b>data</b> 文件夹，历史数据、方案和设置都不会丢失。卸载程序不会自动删除数据。</span></div>
            </div>
          </section>
        </div>

        <div class="stack">
          <section class="card">
            <div class="card-head"><div><h2 class="section-title">系统信息</h2><p class="section-sub">当前实例信息</p></div><span class="chip chip-green">${icon('check')}正常</span></div>
            <div class="card-body" style="padding-top:8px">
              <div class="info-list">
                <div class="info-row"><span class="k">程序版本</span><span class="v">表格汇总助手 v${esc(app.version || '0.1.0')}</span></div>
                <div class="info-row"><span class="k">使用方式</span><span class="v">${exposed ? 'OrbStack 虚拟机 + 浏览器界面' : '本机服务 + 浏览器界面'}</span></div>
                <div class="info-row"><span class="k">监听地址</span><span class="v">${esc(app.host || '127.0.0.1')}:${esc(app.port || 9090)}${exposed ? '（虚拟机）' : ''}</span></div>
                <div class="info-row"><span class="k">操作系统</span><span class="v">${esc(app.platform || '—')}</span></div>
                <div class="info-row"><span class="k">网络依赖</span><span class="v">无 · 全部资源本地化</span></div>
                <div class="info-row"><span class="k">当前时间</span><span class="v">${fmtDate(new Date().toISOString())}</span></div>
              </div>
            </div>
          </section>

          <section class="card">
            <div class="card-head"><div><h2 class="section-title">关于表格汇总助手</h2><p class="section-sub">为办公室内网准备的本地工具</p></div></div>
            <div class="card-body">
              <p class="small muted" style="line-height:1.75">表格汇总助手把 Excel、CSV、Outlook 邮件与附件的汇总工作收在一个工作台里。前端样式、图标与脚本全部随程序分发，不加载任何公网字体、CDN 或统计代码，断网也能直接使用。</p>
              <div class="rail-divider"></div>
              <div class="info-row"><span class="k">数据安全</span><span class="v">${exposed ? '虚拟机端口，仅用于本机验证' : '仅监听本机回环地址'}</span></div>
              <div class="info-row"><span class="k">文件格式</span><span class="v">.xlsx / .xlsm / .xls / .csv / .msg / .eml</span></div>
              <div class="info-row"><span class="k">结果文件</span><span class="v">保留模板样式与公式列</span></div>
              <div class="mt-14 tiny faint">技术栈：Python · Flask · openpyxl · SQLite · 原生 ES Modules / CSS。无需 Node.js，无需联网安装前端依赖。</div>
            </div>
          </section>
        </div>
      </div>`;

    view.querySelector('[data-save-settings]')?.addEventListener('click', async (event) => {
      const keepRuns = Number(view.querySelector('#set-keep-runs').value);
      if (!Number.isInteger(keepRuns) || keepRuns < 5 || keepRuns > 500) {
        toast('保留记录数需在 5–500 之间。', 'warn');
        return;
      }
      const restore = withButtonLoading(event.currentTarget, '保存中…');
      try {
        await api.updateSettings({
          date_format: view.querySelector('#set-date-format').value,
          trim_text: view.querySelector('#set-trim').checked,
          keep_runs: keepRuns,
        });
        await loadBootstrap();
        toast('设置已保存。', 'ok');
        await this.render(view, ctx);
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        restore();
      }
    });

    view.querySelector('[data-open-folder]')?.addEventListener('click', async () => {
      try {
        await api.openDataFolder();
        toast('已打开数据目录。', 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    view.querySelector('[data-cleanup]')?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: '清理旧记录',
        message: '将按保留数量删除较早的运行结果，并清理 30 天前的对比报告。',
        detail: `<div class="warning-note">${icon('alert')}<span>删除的结果 Excel 无法恢复。重要文件请先下载或复制到业务文件夹。</span></div>`,
        confirmText: '开始清理',
        danger: true,
      });
      if (!ok) return;
      try {
        const data = await api.cleanup();
        await loadBootstrap();
        toast(`已清理 ${data.runs || 0} 条生成记录、${data.compares || 0} 份对比报告。`, 'ok');
        await this.render(view, ctx);
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    return () => {};
  },
};
