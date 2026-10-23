/**
 * UI 巡检：模板优先布局 + 字段来源链（多来源 / 合并方式 / 排序列）+ 列完成度。
 *
 * 前置：
 *   1. HUIYI_DATA_DIR=/tmp/ui_chain_data .venv/bin/python app.py --port 8898 --no-browser
 *   2. .venv/bin/python /tmp/prep_ui_chain.py http://127.0.0.1:8898
 * 运行：
 *   NODE_PATH=/Users/thinkage/.workbuddy/binaries/node/workspace/node_modules \
 *   node tests/ui/check-mapping-chain.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';

const puppeteer = createRequire(import.meta.url)('puppeteer-core');
const ctx = JSON.parse(readFileSync('/tmp/ui_chain_ctx.json', 'utf8'));
const BASE = process.argv[2] || ctx.base;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOT_DIR = '/tmp/ui_chain_shots';
mkdirSync(SHOT_DIR, { recursive: true });

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1100 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text()); });

  // 用例会改配置并自动保存，直接用 API 复位成 prep 的初始状态，
  // 免得「每次跑都多叠一个来源」，几轮之后就没有可选项了。
  const boot = await (await fetch(`${BASE}/api/bootstrap`)).json();
  const prof = (boot.profiles || []).find((p) => p.id === ctx.profile_id);
  if (prof) {
    const cfg = prof.config;
    cfg.mappings.c2 = {
      mode: 'table', combine: 'first', separator: '、',
      sources: [
        { table_id: ctx.emp_table, column_index: 2, transform: 'direct' },
        { table_id: ctx.det_table, column_index: 4, transform: 'direct' },
      ],
    };
    cfg.mappings.c3 = {
      mode: 'table', combine: 'sum', separator: '、',
      sources: [{ table_id: ctx.det_table, column_index: 1, transform: 'number' }],
    };
    await fetch(`${BASE}/api/profiles/${ctx.profile_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: prof.name, config: cfg }),
    });
  }

  await page.goto(`${BASE}/#/profiles/${ctx.profile_id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-map-row="c0"]', { timeout: 20000 });
  await wait(500);

  // --- 1. 段落顺序：数据来源 → 目标表 → 字段映射 ---
  const order = await page.evaluate(() => [...document.querySelectorAll('.section-card')]
    .map((el) => ({ id: el.id, num: el.querySelector('.section-num')?.textContent.trim() })));
  check('段落顺序为 数据来源 → 目标表 → 字段映射',
    order.map((o) => o.id).join(',') === 'section-sources,section-target,section-mapping',
    JSON.stringify(order));
  check('段落编号为 1/2/3', order.map((o) => o.num).join('') === '123', JSON.stringify(order.map((o) => o.num)));

  // --- 2. 每个目标列只占一行 ---
  const rows = await page.$$eval('[data-map-row]', (els) => els.map((el) => el.dataset.mapRow));
  const chains = await page.$$eval('[data-chain-row]', (els) => els.map((el) => el.dataset.chainRow));
  check('5 个目标列都渲染了映射行', rows.length === 5, rows.join(','));
  check('没有单独的「取值」第二行（取值并入行内下拉）', chains.length === 0, chains.join(','));

  // --- 3. 多来源：手机号那一行有两个来源 ---
  const phone = await page.evaluate(() => {
    const row = document.querySelector('[data-map-row="c2"]');
    return {
      source: row?.querySelector('.src-text')?.textContent.trim() || '',
      combine: row?.querySelector('[data-map-combine]')?.value,
      chip: row?.querySelector('.map-chip')?.textContent.trim() || '',
    };
  });
  check('手机号列显示了两个来源', /等 \d+ 个来源/.test(phone.source), JSON.stringify(phone));
  check('手机号的合并方式是 first', phone.combine === 'first', phone.combine);

  // --- 4. 聚合与最新：取值方式回显正确，排序列在「映射」弹层里 ---
  const agg = await page.evaluate(() => {
    const val = (key) => document.querySelector(`[data-map-combine="${key}"]`)?.value;
    return { sum: val('c3'), latest: val('c4') };
  });
  check('加班合计列为求和', agg.sum === 'sum', agg.sum);
  check('最近医院列为取最新一条', agg.latest === 'latest', agg.latest);

  // 打开「映射」弹层，latest 应出现排序列下拉
  await page.click('[data-map-open="c4"]');
  await page.waitForSelector('[data-mp-source]', { timeout: 10000 });
  await wait(600);
  const latest = await page.evaluate(() => {
    const wrap = document.querySelector('[data-mp-order-wrap]');
    const sel = document.querySelector('[data-mp-order]');
    return {
      shown: wrap ? !wrap.hidden : false,
      value: sel?.value || '',
      text: sel ? sel.options[sel.selectedIndex]?.textContent.trim() : '',
    };
  });
  check('latest 行的弹层里出现排序列', latest.shown === true, JSON.stringify(latest));
  check('排序列指向日期', /日期/.test(latest.text || ''), `${latest.text} (${latest.value})`);
  await page.evaluate(() => (() => { const ms = document.querySelectorAll('.modal'); ms[ms.length - 1]?.querySelector('[data-close]')?.click(); })());
  await wait(500);

  // 非 latest 的行：弹层里不出现排序列
  await page.click('[data-map-open="c3"]');
  await page.waitForSelector('[data-mp-source]', { timeout: 10000 });
  await wait(500);
  const sumRow = await page.evaluate(() => {
    const wrap = document.querySelector('[data-mp-order-wrap]');
    return { shown: wrap ? !wrap.hidden : false, combine: document.querySelector('[data-mp-combine]')?.value };
  });
  check('非 latest 的行不显示排序列', sumRow.shown === false, JSON.stringify(sumRow));
  check('弹层里的取值方式与行内一致', sumRow.combine === 'sum', sumRow.combine);
  await page.evaluate(() => (() => { const ms = document.querySelectorAll('.modal'); ms[ms.length - 1]?.querySelector('[data-close]')?.click(); })());
  await wait(500);

  // --- 5. 预览：列完成度面板 ---
  await page.click('[data-preview]');
  await page.waitForSelector('.colstat-panel', { timeout: 20000 });
  await wait(400);
  const stats = await page.evaluate(() => {
    const panel = document.querySelector('.colstat-panel');
    return {
      open: panel.hasAttribute('open'),
      summary: panel.querySelector('summary')?.textContent.replace(/\s+/g, ' ').trim(),
      items: [...panel.querySelectorAll('.colstat')].map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
    };
  });
  check('预览弹窗出现列完成度', stats.items.length === 5, JSON.stringify(stats.items));
  check('列完成度显示全部填满', /全部填满|全满/.test(stats.summary + stats.items.join()), stats.summary);
  await page.screenshot({ path: `${SHOT_DIR}/preview-colstats.png` });
  await page.evaluate(() => document.querySelector('.modal-close, [data-close]')?.click());
  await wait(300);

  // --- 6. 切合并方式：行内下拉直接改，取值标签跟着变 ---
  await page.select('[data-map-combine="c3"]', 'count');
  await wait(600);
  const afterCount = await page.evaluate(() => ({
    combine: document.querySelector('[data-map-combine="c3"]')?.value,
    chip: document.querySelector('[data-map-row="c3"] .map-chip')?.textContent.trim() || '',
  }));
  check('切合并方式后行内取值标签更新', /计数/.test(afterCount.chip || ''), JSON.stringify(afterCount));

  // --- 7. 在「映射」弹层里叠加第二个来源 ---
  await page.click('[data-map-open="c3"]');
  await page.waitForSelector('[data-mp-source]', { timeout: 10000 });
  await wait(500);
  const addValue = await page.evaluate(() => {
    const sel = document.querySelector('[data-mp-add]');
    if (!sel) return null;
    const opt = [...sel.options].find((o) => o.value);
    return opt ? opt.value : null;
  });
  check('弹层里可以叠加第二个来源', !!addValue, String(addValue));
  if (addValue) {
    await page.select('[data-mp-add]', addValue);
    await wait(800);
    const afterAdd = await page.evaluate(() => ({
      chips: [...document.querySelectorAll('[data-mp-extra] .chain-chip')].map((c) => c.textContent.trim()),
      source: document.querySelector('[data-map-row="c3"] .src-text')?.textContent.trim() || '',
    }));
    check('叠加后弹层里出现来源 chip', afterAdd.chips.length >= 1, JSON.stringify(afterAdd.chips));
    check('叠加后行内显示「等 N 个来源」', /等 \d+ 个来源/.test(afterAdd.source), afterAdd.source);
  }
  await page.evaluate(() => (() => { const ms = document.querySelectorAll('.modal'); ms[ms.length - 1]?.querySelector('[data-close]')?.click(); })());
  await wait(500);

  // --- 8. F6 回归：取消勾选某列不应报「模板新增字段」 ---
  // 目标列详情默认收起，先展开才拿得到勾选框
  await page.click('[data-toggle-col-detail]');
  await wait(600);
  await page.evaluate(() => {
    const box = document.querySelector('[data-col-included="c3"]');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await wait(700);
  const driftAfterUncheck = await page.evaluate(() => document.querySelector('.tpl-drift')?.textContent.replace(/\s+/g, ' ').trim() || '');
  check('取消勾选一列不再误报模板差异', driftAfterUncheck === '', driftAfterUncheck);
  await page.evaluate(() => {
    const box = document.querySelector('[data-col-included="c3"]');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await wait(600);

  // --- 9. 模板卡片上的「建方案」入口 ---
  await page.goto(`${BASE}/#/templates`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-new-profile]', { timeout: 20000 });
  await page.click('[data-new-profile]');
  await page.waitForSelector('.modal-title', { timeout: 8000 });
  await wait(400);
  const modal = await page.evaluate(() => ({
    title: document.querySelector('.modal-title')?.textContent.trim(),
    name: document.querySelector('#np-name')?.value || '',
    template: document.querySelector('#np-template')?.value || '',
  }));
  check('模板卡片可直接建方案', /建汇总方案|建汇总/.test(modal.title || ''), JSON.stringify(modal));
  check('建方案时预填方案名', (modal.name || '').length > 0, modal.name);
  check('建方案时锁定该模板', modal.template === ctx.template_id, `${modal.template} vs ${ctx.template_id}`);
  await page.screenshot({ path: `${SHOT_DIR}/template-new-profile.png` });

  check('没有 JS 报错', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

  await page.goto(`${BASE}/#/profiles/${ctx.profile_id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-map-row="c0"]', { timeout: 20000 });
  await wait(500);
  await page.screenshot({ path: `${SHOT_DIR}/profile-full.png`, fullPage: true });
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  → ${c.detail}` : ''}`);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);
