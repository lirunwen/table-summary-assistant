/** 工作台首页。 */
import { openCreateProfileModal, openRunDetail, profileCard, runMiniItem } from '../components.js';
import { state } from '../store.js';
import {
  emptyState, esc, fmtNumber, icon, pageHead,
} from '../ui.js';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 11) return '上午好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export default {
  nav: 'dashboard',
  async render(view, ctx) {
    const stats = state.stats || {};
    const app = state.app || {};
    const exposed = !!app.exposed;
    const profiles = state.profiles || [];
    const runs = state.runs || [];
    const sources = state.sources || [];
    const hasData = sources.length > 0 || profiles.length > 0;
    const step1 = sources.length > 0;
    const step2 = profiles.length > 0;
    const step3 = runs.length > 0;

    const hero = `
      <section class="hero">
        <div class="hero-main">
          <div class="hero-eyebrow">本机运行 · 断网也能用</div>
          <h2>把散落的文件，<br>汇成一张<em>清晰的表</em>。</h2>
          <p>Excel、CSV、Outlook 邮件与附件，在同一个工作台里接入、映射、汇总。数据只留在本机，内网断开也能照常使用。</p>
          <div class="hero-actions">
            <button class="btn btn-white btn-lg" type="button" data-new-profile>${icon('plus')}新建汇总方案</button>
            <a class="btn btn-lg" href="#/sources" style="background:rgba(255,255,255,.1);color:#fff;border-color:rgba(255,255,255,.18)">${icon('upload-cloud')}上传数据</a>
          </div>
          <div class="hero-meta">
            <span>${icon('shield')}${exposed ? 'OrbStack 虚拟机内运行' : '仅监听 127.0.0.1'}</span>
            <span>${icon('hard-drive')}文件保存在本机</span>
            <span>${icon('file-spreadsheet')}保留模板格式</span>
          </div>
        </div>
        <div class="hero-visual">
          <div class="flow-panel">
            <div class="flow-panel-title"><span>使用流程</span><span>共 3 步</span></div>
            <div class="flow-step ${step1 ? 'done' : ''}">
              <span class="flow-num">${step1 ? icon('check') : '01'}</span>
              <span class="flow-text"><strong>接入数据</strong><small>Excel / CSV / 邮件附件</small></span>
              ${icon(step1 ? 'check-circle' : 'chevron-right')}
            </div>
            <div class="flow-step ${step2 ? 'done' : ''}">
              <span class="flow-num">${step2 ? icon('check') : '02'}</span>
              <span class="flow-text"><strong>逐列映射</strong><small>每一列指定一个来源</small></span>
              ${icon(step2 ? 'check-circle' : 'chevron-right')}
            </div>
            <div class="flow-step ${step3 ? 'done' : ''}">
              <span class="flow-num">${step3 ? icon('check') : '03'}</span>
              <span class="flow-text"><strong>生成与对比</strong><small>写出 Excel，按主键看差异</small></span>
              ${icon(step3 ? 'check-circle' : 'chevron-right')}
            </div>
          </div>
          <div class="hero-visual-note">${icon('lock')}不经过任何云端服务</div>
        </div>
      </section>`;

    const statGrid = `
      <div class="stat-grid mt-18">
        <div class="stat-card">
          <div class="stat-icon">${icon('database')}</div>
          <div class="stat-main">
            <div class="stat-label">数据文件</div>
            <div class="stat-value">${fmtNumber(stats.sources || 0)}<small>个</small></div>
            <div class="stat-hint">共 ${fmtNumber(stats.tables || 0)} 张可汇总数据表</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon gold">${icon('layers')}</div>
          <div class="stat-main">
            <div class="stat-label">汇总方案</div>
            <div class="stat-value">${fmtNumber(stats.profiles || 0)}<small>个</small></div>
            <div class="stat-hint">${profiles.filter((p) => (p.last_run_at)).length} 个已生成过</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon blue">${icon('history')}</div>
          <div class="stat-main">
            <div class="stat-label">生成记录</div>
            <div class="stat-value">${fmtNumber(stats.runs || 0)}<small>次</small></div>
            <div class="stat-hint">本地保留最近的结果文件</div>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon red">${icon('rows')}</div>
          <div class="stat-main">
            <div class="stat-label">最近汇总</div>
            <div class="stat-value">${fmtNumber(stats.rows_last || 0)}<small>行</small></div>
            <div class="stat-hint">${runs[0] ? esc(runs[0].profile_name || '') : '还没有生成结果'}</div>
          </div>
        </div>
      </div>`;

    const profileSection = profiles.length
      ? `<div class="profile-grid">${profiles.slice(0, 4).map(profileCard).join('')}</div>`
      : `<div class="card">${emptyState({
        iconName: 'layers',
        title: '还没有汇总方案',
        desc: '方案会把「数据来源、目标表、字段映射」保存下来。配置一次，以后每月点一下就能重新生成。',
        action: `<button class="btn btn-primary" type="button" data-new-profile>${icon('plus')}创建第一个方案</button>`,
      })}</div>`;

    const runsSection = runs.length
      ? `<div class="run-list">${runs.slice(0, 6).map(runMiniItem).join('')}</div>`
      : emptyState({
        iconName: 'history',
        title: '还没有生成记录',
        desc: '完成一次汇总后，结果文件、生成时间和数据规模都会记录在这里。',
        small: true,
      });

    const guide = !hasData
      ? `<div class="card card-pad mt-18">
          <div class="flex items-center justify-between gap-12 flex-wrap mb-16">
            <div>
              <h2 class="section-title">从一份文件开始</h2>
              <p class="section-sub">不需要安装插件，也不需要联网。三步就能得到第一张汇总表。</p>
            </div>
            <a class="btn btn-secondary" href="#/sources">${icon('upload-cloud')}去上传文件</a>
          </div>
          <div class="steps-guide">
            <div class="guide-step">
              <div class="guide-num">01</div>
              <h4>上传原始文件</h4>
              <p>把 Excel、CSV 或导出的 Outlook 邮件拖进数据源，系统会自动识别表头与工作表。</p>
            </div>
            <div class="guide-step">
              <div class="guide-num">02</div>
              <h4>选定目标与来源</h4>
              <p>上传现有的汇总模板，逐列指定来自哪张表、哪个字段。缺省值也可以单独设置。</p>
            </div>
            <div class="guide-step">
              <div class="guide-num">03</div>
              <h4>生成并核对</h4>
              <p>一键写出 Excel，保留模板格式；下次生成后可与历史结果对比，定位每一处变化。</p>
            </div>
          </div>
        </div>`
      : '';

    view.innerHTML = `
      ${pageHead({
        eyebrow: `${icon('sparkle')}工作台总览`,
        title: `${greeting()}，开始今天的汇总`,
        desc: '所有数据都在本机处理。选一个方案继续，或者从一份新文件开始。',
        actions: `
          <a class="btn btn-secondary" href="#/sources">${icon('database')}数据源</a>
          <button class="btn btn-primary" type="button" data-new-profile>${icon('plus')}新建方案</button>`,
      })}
      ${hero}
      ${statGrid}
      <div class="dash-grid mt-24">
        <section>
          <div class="section-bar">
            <div><h2 class="section-title">最近使用的方案</h2><p class="section-sub">打开即可继续编辑或重新生成</p></div>
            <a class="more" href="#/profiles">全部方案 ${icon('arrow-right')}</a>
          </div>
          ${profileSection}
        </section>
        <section>
          <div class="section-bar">
            <div><h2 class="section-title">最近生成</h2><p class="section-sub">结果文件保存在本机</p></div>
            <a class="more" href="#/runs">生成记录 ${icon('arrow-right')}</a>
          </div>
          <div class="card card-pad" style="padding-top:8px;padding-bottom:8px">${runsSection}</div>
          <div class="rail-card mt-14" style="background:linear-gradient(150deg,#f8fbf9,#f2f7f4)">
            <div class="rail-title">${icon('shield', 'icon-sm')} 本地与隐私</div>
            <p class="tiny muted" style="line-height:1.7">${exposed
              ? `服务运行在 OrbStack 虚拟机内，通过本机端口 ${esc(app.port || 9090)} 访问。数据文件保存在 Mac 的 data 目录；验证结束后可停止虚拟机服务。`
              : '服务只监听 127.0.0.1，同一内网的其他电脑也访问不到。上传、解析、生成都在本机完成，关闭窗口即停止服务。'}</p>
          </div>
        </section>
      </div>
      ${guide}`;

    const openCreate = () => openCreateProfileModal({
      onCreated: (profile) => ctx.navigate(`#/profiles/${profile.id}`),
    });
    view.querySelectorAll('[data-new-profile]').forEach((btn) => btn.addEventListener('click', openCreate));
    view.onclick = (event) => {
      const detail = event.target.closest('[data-run-detail]');
      if (detail) {
        const run = state.runs.find((r) => r.id === detail.dataset.runDetail);
        if (run) openRunDetail(run);
      }
    };

    return () => { view.onclick = null; };
  },
};
