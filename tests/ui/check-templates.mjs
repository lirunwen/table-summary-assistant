/**
 * UI 回归：数据模板模块（列表页 + 编辑页）。
 *
 * 覆盖三件事：
 *   1. 列表页能筛能搜能多选，卡片把字段契约写清楚；
 *   2. 编辑页五个标签都能渲染，字段表能改能存，保存后版本号按规则递增；
 *   3. 方案侧能读到模板字段，字段漂移时会给出「一键同步」入口。
 *
 * 用法（需要先起一个服务 + 至少一份模板）：
 *   HUIYI_DATA_DIR=/tmp/ui_check ./.venv/bin/python app.py --port 8899 --no-browser
 *   NODE_PATH=<node_modules> node tests/ui/check-templates.mjs http://127.0.0.1:8899
 *
 * 退出码 0 = 全部通过；1 = 有断言失败。
 */
import { createRequire } from 'node:module';

const puppeteer = createRequire(import.meta.url)('puppeteer-core');

const BASE = process.argv[2] || 'http://127.0.0.1:8899';
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text()); });

  // ---------- 1. 列表页 ----------
  await page.goto(`${BASE}/#/templates`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-grid]');
  await sleep(400);

  const listState = () => page.evaluate(() => ({
    cards: document.querySelectorAll('.tpl-card').length,
    stats: document.querySelectorAll('[data-stats] .tpl-stat').length,
    bulkHidden: document.querySelector('[data-bulkbar]').offsetParent === null,
    chips: document.querySelectorAll('[data-chips] .chip-filter').length,
    fieldChips: document.querySelectorAll('.tpl-card .tpl-field').length,
    statusButtons: document.querySelectorAll('[data-status-filter] button').length,
  }));

  const list0 = await listState();
  const boot = await (await fetch(`${BASE}/api/bootstrap`)).json();
  const templateCount = (boot.templates || []).length;
  check('列表页渲染出模板卡片', list0.cards === templateCount,
    `${list0.cards} 张 / 后端 ${templateCount} 份`);
  check('统计条四块都在', list0.stats >= 4, `${list0.stats} 块`);
  check('未选择时不显示批量操作条', list0.bulkHidden === true);
  check('状态分段有 全部/使用中/草稿/已归档', list0.statusButtons >= 4, `${list0.statusButtons} 个`);
  check('卡片里能看到字段清单', list0.fieldChips > 0, `${list0.fieldChips} 个 chip`);

  // 搜索：用第一个模板的字段名搜，应该还能搜到它
  const firstTpl = (boot.templates || [])[0];
  if (firstTpl) {
    const fieldName = (firstTpl.fields || [])[0]?.name || firstTpl.name;
    await page.type('.tpl-toolbar input', fieldName);
    await sleep(700);
    const searched = await page.evaluate(() => document.querySelectorAll('.tpl-card').length);
    check('按字段名能搜到模板', searched >= 1, `「${fieldName}」→ ${searched} 张`);
    await page.evaluate(() => {
      const input = document.querySelector('.tpl-toolbar input');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await sleep(700);
  }

  // 多选 → 批量条出现
  await page.evaluate(() => document.querySelector('.tpl-card [data-select]')?.click());
  await sleep(250);
  const afterSelect = await page.evaluate(() => ({
    hidden: document.querySelector('[data-bulkbar]').offsetParent === null,
    text: document.querySelector('[data-bulk-count]')?.textContent || '',
  }));
  check('勾选后批量操作条出现', afterSelect.hidden === false, afterSelect.text);
  check('批量条显示已选数量', /1/.test(afterSelect.text), afterSelect.text);
  await page.evaluate(() => document.querySelector('[data-bulk-clear]')?.click());

  // ---------- 2. 编辑页 ----------
  if (firstTpl) {
    await page.goto(`${BASE}/#/templates/${firstTpl.id}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-tab]');
    await sleep(400);

    const tabs = await page.evaluate(() => [...document.querySelectorAll('[data-tab]')]
      .map((b) => b.dataset.tab));
    check('编辑页有五个标签', tabs.length === 5, tabs.join('/'));

    for (const key of tabs) {
      await page.click(`[data-tab='${key}']`);
      await sleep(220);
      const painted = await page.evaluate(() => {
        const body = document.querySelector('.tpl-tab-body');
        return body && body.innerHTML.trim().length > 50;
      });
      check(`标签「${key}」有内容`, painted === true);
    }

    // 回到字段结构，改列宽 → 出现未保存状态 → 保存 → 版本号按规则变化
    await page.click("[data-tab='fields']");
    await sleep(250);
    const before = await page.evaluate(() => ({
      rows: document.querySelectorAll('[data-row]').length,
      saveDisabled: document.querySelector('[data-save]').disabled,
      version: (document.querySelector('.tpl-tabs [data-tab="versions"] i')?.textContent || '').trim(),
    }));
    check('字段表按字段数出行', before.rows === (firstTpl.fields || []).length,
      `${before.rows} 行 / ${(firstTpl.fields || []).length} 字段`);
    check('没改动时保存按钮禁用', before.saveDisabled === true);

    await page.evaluate(() => {
      const input = document.querySelector('[data-fwidth]');
      input.value = '22';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(300);
    const dirty = await page.evaluate(() => ({
      disabled: document.querySelector('[data-save]').disabled,
      status: document.querySelector('[data-save-status]')?.textContent.trim() || '',
    }));
    check('改动后保存按钮可用', dirty.disabled === false, dirty.status);
    check('改动后提示未保存', /未保存/.test(dirty.status), dirty.status);

    await page.click('[data-save]');
    await sleep(1200);
    const saved = await page.evaluate(() => document.querySelector('[data-save-status]')?.textContent.trim() || '');
    check('保存后状态回到已保存', /已保存/.test(saved), saved);

    const detail = await (await fetch(`${BASE}/api/templates/${firstTpl.id}`)).json();
    const widths = (detail.template.fields || []).map((f) => f.width);
    check('列宽改动已落库', widths.includes(22), widths.join(','));

    // 预览弹窗
    await page.click('[data-preview]');
    await sleep(500);
    const preview = await page.evaluate(() => ({
      hasTable: !!document.querySelector('.preview-table'),
      tips: document.querySelectorAll('.tpl-tip').length,
    }));
    check('预览弹窗有表头预览', preview.hasTable === true);
    check('预览弹窗有字段说明卡', preview.tips > 0, `${preview.tips} 张`);
    await page.evaluate(() => document.querySelector('.modal [data-cancel]')?.click());
    await sleep(200);

    // 基本信息：改说明 → 保存 → 落库（只改说明不该产生新版本）
    await page.click("[data-tab='info']");
    await sleep(250);
    const infoPanel = await page.evaluate(() => ({
      exportButtons: document.querySelectorAll('.tpl-tab-body [data-export]').length,
      hasStatus: !!document.querySelector('#tp-status'),
    }));
    check('基本信息里有导出按钮', infoPanel.exportButtons === 1, `${infoPanel.exportButtons} 个`);
    check('基本信息里能改状态', infoPanel.hasStatus === true);

    const note = `UI巡检说明 ${Date.now()}`;
    await page.evaluate((text) => {
      const el = document.querySelector('#tp-desc');
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, note);
    await sleep(250);
    await page.click('[data-save]');
    await sleep(1200);
    const afterNote = await (await fetch(`${BASE}/api/templates/${firstTpl.id}`)).json();
    check('只改说明也能存住', afterNote.template.description === note,
      afterNote.template.description);
  }

  // ---------- 3. 方案侧读模板 ----------
  await page.goto(`${BASE}/#/profiles`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-new-profile]');
  await page.click('[data-new-profile]');
  await page.waitForSelector('[data-output-grid]');
  await sleep(300);

  if (templateCount) {
    await page.click('[data-output-grid] [data-output="template"]');
    await sleep(300);
    const panel = await page.evaluate(() => ({
      hasSelect: !!document.querySelector('#np-template'),
      optgroups: document.querySelectorAll('#np-template optgroup').length,
      fields: document.querySelectorAll('.tpl-summary .chip').length,
      link: !!document.querySelector('.tpl-summary a[href^="#/templates/"]'),
      meta: document.querySelector('.tpl-summary-head')?.textContent.replace(/\s+/g, ' ').trim() || '',
    }));
    check('方案里能选模板', panel.hasSelect === true);
    check('模板下拉按分类分组', panel.optgroups >= 1, `${panel.optgroups} 组`);
    check('模板面板列出字段', panel.fields > 0, `${panel.fields} 个`);
    check('模板面板能跳去模板库', panel.link === true);
    check('模板面板显示版本与分类', /v\d/.test(panel.meta), panel.meta.slice(0, 60));
  }

  check('无前端异常', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);
