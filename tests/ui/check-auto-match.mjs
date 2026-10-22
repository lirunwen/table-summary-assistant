/**
 * UI 巡检：①「目标列详情」默认收起、展开可编辑、切换步骤/换模板后复位；
 *        ②打开方案即按列名自动预匹配，自动结果有标识，没匹配的给候选下拉。
 *
 * 前置：
 *   1. HUIYI_DATA_DIR=/tmp/ui_auto_data .venv/bin/python app.py --port 8897 --no-browser
 *   2. .venv/bin/python /tmp/prep_ui_automatch.py http://127.0.0.1:8897
 * 运行：
 *   NODE_PATH=/Users/thinkage/.workbuddy/binaries/node/workspace/node_modules \
 *   node tests/ui/check-auto-match.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';

const puppeteer = createRequire(import.meta.url)('puppeteer-core');
const ctx = JSON.parse(readFileSync('/tmp/ui_automatch_ctx.json', 'utf8'));
const BASE = process.argv[2] || ctx.base;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOT_DIR = '/tmp/ui_automatch_shots';
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
  // 用例会改配置并自动保存，所以先把映射清空，保证可重复执行
  const boot = await (await fetch(`${BASE}/api/bootstrap`)).json();
  const prof = (boot.profiles || []).find((p) => p.id === ctx.profile_id);
  if (prof) {
    const cfg = { ...prof.config, mappings: {} };
    await fetch(`${BASE}/api/profiles/${ctx.profile_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: prof.name, config: cfg }),
    });
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1100 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text()); });

  await page.goto(`${BASE}/#/profiles/${ctx.profile_id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-map-row="c0"]', { timeout: 20000 });
  // 自动预匹配是异步的，等它跑完
  await wait(1500);

  // ---------- ① 目标列详情：默认收起 ----------
  const collapsed = await page.evaluate(() => ({
    rows: document.querySelectorAll('#section-target .col-row').length,
    summary: document.querySelector('#section-target .col-summary')?.textContent.replace(/\s+/g, ' ').trim() || '',
    toggle: document.querySelector('[data-toggle-col-detail]')?.textContent.trim(),
  }));
  check('目标列详情默认收起（看不到列明细行）', collapsed.rows === 0, JSON.stringify(collapsed));
  check('收起时显示列概要', /9 列/.test(collapsed.summary), collapsed.summary);
  check('按钮文案提示可以展开', /目标列详情/.test(collapsed.toggle || ''), collapsed.toggle);

  // 展开
  await page.click('[data-toggle-col-detail]');
  await wait(600);
  const expanded = await page.evaluate(() => ({
    rows: document.querySelectorAll('#section-target .col-row').length,
    summary: !!document.querySelector('#section-target .col-summary'),
    names: [...document.querySelectorAll('#section-target [data-col-name]')].map((i) => i.value),
  }));
  check('展开后能看到 9 行目标列', expanded.rows === 10, `实际 ${expanded.rows} 行（含表头行）`);
  check('展开后概要收起', expanded.summary === false, String(expanded.summary));
  check('展开后列名可编辑', expanded.names.includes('月薪（税前）'), expanded.names.join('、'));
  await page.screenshot({ path: `${SHOT_DIR}/target-expanded.png` });

  // 切到别的步骤 → 复位收起
  await page.evaluate(() => document.querySelector('[data-step-head="mapping"]')?.click());
  await wait(600);
  const afterStep = await page.evaluate(() => ({
    rows: document.querySelectorAll('#section-target .col-row').length,
    summary: !!document.querySelector('#section-target .col-summary'),
  }));
  check('切换步骤后目标列详情复位收起', afterStep.rows === 0 && afterStep.summary, JSON.stringify(afterStep));

  // ---------- ② 自动预匹配 ----------
  const auto = await page.evaluate(() => [...document.querySelectorAll('[data-map-row]')].map((el) => ({
    key: el.dataset.mapRow,
    name: el.querySelector('.map-target .name')?.textContent.trim(),
    source: el.querySelector('.src-text')?.textContent.trim() || '',
    badge: el.querySelector('.map-badge')?.textContent.trim() || '',
  })));
  const byKey = Object.fromEntries(auto.map((r) => [r.key, r]));
  check('打开方案即自动匹配出 8 列', auto.filter((r) => r.source && !/未配置/.test(r.source)).length === 8,
    auto.map((r) => `${r.name}=${r.source || '未匹配'}`).join(' | '));
  check('工号严格同名匹配到人员信息表', /工号/.test(byKey.c0?.source || '') && /人员信息/.test(byKey.c0?.source || ''),
    byKey.c0?.source);
  check('加班小时匹配到考勤明细表', /加班小时/.test(byKey.c4?.source || '') && /考勤明细/.test(byKey.c4?.source || ''),
    byKey.c4?.source);
  check('月薪（税前）按备注名匹配到「税前」', /税前/.test(byKey.c3?.source || ''), byKey.c3?.source);
  check('自动匹配的行有「同名」标识', /同名/.test(byKey.c0?.badge || ''), byKey.c0?.badge);
  check('别名命中标识为「备注名」', /备注名/.test(byKey.c3?.badge || ''), byKey.c3?.badge);
  check('没匹配上的列显示未配置', /未配置/.test(byKey.c8?.badge || ''), byKey.c8?.badge);

  // 没匹配上的列：点「映射」能看到候选来源列
  await page.click('[data-map-open="c8"]');
  await page.waitForSelector('[data-mp-source]', { timeout: 10000 });
  await wait(600);
  const dialog = await page.evaluate(() => {
    const sel = document.querySelector('[data-mp-source]');
    const opts = [...sel.options].filter((o) => o.value);
    return {
      hint: document.querySelector('.map-hint')?.textContent.replace(/\s+/g, ' ').trim() || '',
      count: opts.length,
      sample: opts.slice(0, 3).map((o) => o.textContent.trim()),
    };
  });
  check('映射弹层里列出了候选来源列', dialog.count > 0, JSON.stringify(dialog.sample));
  check('弹层提示说明了没有同名命中', /没有能对上|候选/.test(dialog.hint || ''), dialog.hint);

  // 从候选里选一列 → 映射生效，状态变「手动」
  const candidateValue = await page.evaluate(() => {
    const sel = document.querySelector('[data-mp-source]');
    const opt = [...sel.options].find((o) => o.value);
    return opt ? opt.value : null;
  });
  if (candidateValue) {
    await page.select('[data-mp-source]', candidateValue);
    await wait(800);
    const afterPick = await page.evaluate(() => {
      const row = document.querySelector('[data-map-row="c8"]');
      return {
        source: row?.querySelector('.src-text')?.textContent.trim() || '',
        badge: row?.querySelector('.map-badge')?.textContent.trim() || '',
      };
    });
    check('从候选里选一列后映射生效', !/未配置/.test(afterPick.source), JSON.stringify(afterPick));
    check('手动选的列不再标「自动」', /手动/.test(afterPick.badge), afterPick.badge);
  }
  await page.evaluate(() => (() => { const ms = document.querySelectorAll('.modal'); ms[ms.length - 1]?.querySelector('[data-close]')?.click(); })());
  await wait(500);

  // 手动改一列 → 自动标识消失
  await page.click('[data-map-open="c1"]');
  await page.waitForSelector('[data-mp-source]', { timeout: 10000 });
  await wait(500);
  await page.evaluate(() => {
    const sel = document.querySelector('[data-mp-source]');
    const opt = [...sel.options].find((o) => o.value && o.value !== sel.value);
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await wait(800);
  await page.evaluate(() => (() => { const ms = document.querySelectorAll('.modal'); ms[ms.length - 1]?.querySelector('[data-close]')?.click(); })());
  await wait(500);
  const afterManual = await page.evaluate(() => ({
    badge: document.querySelector('[data-map-row="c1"] .map-badge')?.textContent.trim() || '',
  }));
  check('手动改来源后「自动」标识变成「手动」', /手动/.test(afterManual.badge), afterManual.badge);

  // 收起状态下的目标列摘要仍然正确
  await page.evaluate(() => document.querySelector('[data-step-head="target"]')?.click());
  await wait(500);
  const summary = await page.evaluate(() => document.querySelector('#section-target .col-summary')?.textContent.replace(/\s+/g, ' ').trim() || '');
  check('切回目标表步骤仍是收起状态', summary.length > 0, summary);

  // ---------- ③ 换模板后复位收起 ----------
  await page.click('[data-change-template]');
  await page.waitForSelector('[data-pick-template]', { timeout: 10000 });
  await wait(400);
  await page.click('[data-pick-template]');
  await page.waitForSelector('[data-pick-sheet]', { timeout: 10000 });
  await wait(400);
  await page.click('[data-pick-sheet]');
  await wait(1500);
  const afterTemplate = await page.evaluate(() => ({
    rows: document.querySelectorAll('#section-target .col-row').length,
    summary: !!document.querySelector('#section-target .col-summary'),
    mapped: [...document.querySelectorAll('[data-map-row]')].length,
  }));
  check('重新选择模板后目标列详情复位收起', afterTemplate.rows === 0 && afterTemplate.summary, JSON.stringify(afterTemplate));
  check('重新选择模板后自动预匹配重新跑过', afterTemplate.mapped > 0, `映射行 ${afterTemplate.mapped}`);
  await page.screenshot({ path: `${SHOT_DIR}/after-template.png`, fullPage: false });

  check('没有 JS 报错', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  → ${c.detail}` : ''}`);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);
