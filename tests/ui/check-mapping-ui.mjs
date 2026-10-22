/**
 * UI 巡检：字段映射新界面
 *   1. 每个目标列只占**一行**（不再有第二条「取值」行）；
 *   2. 自动匹配能命中写法不同但意思相同的列（下划线/空格/大小写/相似度），
 *      并在状态标签上写明是「同名 / 备注名 / 相似 xx%」；
 *   3. 「映射」弹层里能改来源、加备用来源、设取值方式；
 *   4. 「清空」后不再被自动匹配回填；
 *   5. 「规则」能看到模板里这一列的校验要求。
 *
 * 前置：
 *   1. HUIYI_DATA_DIR=/tmp/ui_mapui_data .venv/bin/python app.py --port 8896 --no-browser
 *   2. .venv/bin/python /tmp/prep_ui_mapui.py http://127.0.0.1:8896
 * 运行：
 *   NODE_PATH=/Users/thinkage/.workbuddy/binaries/node/workspace/node_modules \
 *   node tests/ui/check-mapping-ui.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';

const puppeteer = createRequire(import.meta.url)('puppeteer-core');
const ctx = JSON.parse(readFileSync('/tmp/ui_mapui_ctx.json', 'utf8'));
const BASE = process.argv[2] || ctx.base;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOT_DIR = '/tmp/ui_mapui_shots';
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
  await page.setViewport({ width: 1500, height: 1000 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text()); });

  // 用例会改配置并自动保存，先把映射清空，保证可重复执行
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

  await page.goto(`${BASE}/#/profiles/${ctx.profile_id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-map-row="c0"]', { timeout: 20000 });
  await wait(2000);

  // --- 1. 单行紧凑：每个目标列只有一行 ---
  const layout = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#section-mapping .map-row:not(.head)')];
    return {
      count: rows.length,
      extraRows: rows.filter((el) => el.nextElementSibling?.classList?.contains('map-chain')).length,
      cells: rows[0] ? rows[0].children.length : 0,
      hasSourceSelect: !!document.querySelector('#section-mapping [data-map-source]'),
      hasFieldSelect: !!document.querySelector('#section-mapping [data-map-field]'),
      hasTransformSelect: !!document.querySelector('#section-mapping [data-map-transform]'),
      hasFallbackInput: !!document.querySelector('#section-mapping [data-map-fallback]'),
      actions: [...document.querySelectorAll('#section-mapping [data-map-row] [data-map-open]')].length,
      clearBtns: [...document.querySelectorAll('#section-mapping [data-map-row] [data-map-clear]')].length,
      ruleBtns: [...document.querySelectorAll('#section-mapping [data-map-row] [data-map-rules]')].length,
    };
  });
  check('每个目标列只占一行（没有第二条取值行）', layout.extraRows === 0, JSON.stringify(layout));
  check('行内只保留 5 个格子', layout.cells === 5, String(layout.cells));
  check('行内不再有来源/字段/处理/缺省值四个下拉', !layout.hasSourceSelect && !layout.hasFieldSelect
    && !layout.hasTransformSelect && !layout.hasFallbackInput, JSON.stringify(layout));
  check('每行都有映射/清空/规则三个操作',
    layout.actions === layout.count && layout.clearBtns === layout.count && layout.ruleBtns === layout.count,
    JSON.stringify(layout));
  await page.screenshot({ path: `${SHOT_DIR}/mapping-rows.png` });

  // --- 2. 自动匹配命中写法不同的列 ---
  const matched = await page.evaluate(() => [...document.querySelectorAll('[data-map-row]')].map((el) => ({
    key: el.dataset.mapRow,
    name: el.querySelector('.map-target .name')?.textContent.trim(),
    source: el.querySelector('.src-text')?.textContent.trim(),
    badge: el.querySelector('.map-badge')?.textContent.trim(),
  })));
  const byKey = Object.fromEntries(matched.map((r) => [r.key, r]));
  check('大小写差异也能精确命中（employee_id → EmployeeID）',
    /EmployeeID/.test(byKey.c0?.source || '') && /同名/.test(byKey.c0?.badge || ''),
    `${byKey.c0?.source} / ${byKey.c0?.badge}`);
  check('多一个字走相似度（手机号 → 手机号码）',
    /手机号码/.test(byKey.c2?.source || '') && /相似/.test(byKey.c2?.badge || ''),
    `${byKey.c2?.source} / ${byKey.c2?.badge}`);
  check('括号备注名能命中（月薪（税前） → 税前）',
    /税前/.test(byKey.c3?.source || '') && /备注名/.test(byKey.c3?.badge || ''),
    `${byKey.c3?.source} / ${byKey.c3?.badge}`);
  check('列名里的空格差异也能精确命中（加班小时 → 加班 小时）',
    /加班 小时/.test(byKey.c4?.source || '') && /同名/.test(byKey.c4?.badge || ''),
    `${byKey.c4?.source} / ${byKey.c4?.badge}`);
  check('没有对应列的目标列显示未配置', /未配置/.test(byKey.c5?.badge || ''), byKey.c5?.badge);

  // --- 3. 「映射」弹层 ---
  await page.click('[data-map-open="c0"]');
  await page.waitForSelector('[data-mp-source]', { timeout: 10000 });
  await wait(600);
  const dialog = await page.evaluate(() => {
    const sel = document.querySelector('[data-mp-source]');
    const opts = [...sel.options].map((o) => ({ text: o.textContent.trim(), value: o.value, group: o.parentElement.label }));
    return {
      title: document.querySelector('.modal-title')?.textContent.trim(),
      hint: document.querySelector('.map-hint')?.textContent.replace(/\s+/g, ' ').trim(),
      hasExtra: !!document.querySelector('[data-mp-extra]'),
      hasCombine: !!document.querySelector('[data-mp-combine]'),
      hasTransform: !!document.querySelector('[data-mp-transform]'),
      hasFallback: !!document.querySelector('[data-mp-fallback]'),
      hasFormula: !!document.querySelector('[data-mp-formula]'),
      marked: opts.filter((o) => o.text.includes('✓')).map((o) => o.text),
      groups: [...new Set(opts.map((o) => o.group).filter(Boolean))],
    };
  });
  check('映射弹层标题带列名', /employee_id/.test(dialog.title || ''), dialog.title);
  check('弹层里能改来源', dialog.hasExtra && dialog.hasCombine && dialog.hasTransform && dialog.hasFallback && dialog.hasFormula,
    JSON.stringify(dialog));
  check('候选按表分组', dialog.groups.length >= 2, JSON.stringify(dialog.groups));
  check('命中项在选项上有 ✓ 标注', dialog.marked.length >= 1, JSON.stringify(dialog.marked));
  check('弹层提示说明了命中方式', /匹配|候选/.test(dialog.hint || ''), dialog.hint);
  await page.screenshot({ path: `${SHOT_DIR}/mapping-dialog.png` });

  // 改一个来源 → 行内来源随之变化，状态变「手动」
  const pickValue = await page.evaluate(() => {
    const sel = document.querySelector('[data-mp-source]');
    const opt = [...sel.options].find((o) => o.value && !o.text.includes('✓'));
    return opt ? opt.value : null;
  });
  if (pickValue) {
    await page.select('[data-mp-source]', pickValue);
    await wait(800);
    const after = await page.evaluate(() => ({
      source: document.querySelector('[data-map-row="c0"] .src-text')?.textContent.trim(),
      badge: document.querySelector('[data-map-row="c0"] .map-badge')?.textContent.trim(),
    }));
    check('在弹层里改来源后行内同步更新', after.source && after.source !== byKey.c0?.source, JSON.stringify(after));
    check('手动改过之后状态变成「手动」', /手动/.test(after.badge || ''), after.badge);
  }
  await page.evaluate(() => document.querySelector('.modal [data-close]')?.click());
  await wait(500);

  // --- 4. 「清空」后不再被自动匹配回填 ---
  await page.click('[data-map-clear="c5"]');
  await wait(700);
  const cleared = await page.evaluate(() => ({
    badge: document.querySelector('[data-map-row="c5"] .map-badge')?.textContent.trim(),
    source: document.querySelector('[data-map-row="c5"] .src-text')?.textContent.trim(),
  }));
  check('清空后状态是未配置', /未配置/.test(cleared.badge || ''), JSON.stringify(cleared));
  await page.click('[data-auto-map]');
  await wait(1500);
  const afterRematch = await page.evaluate(() => ({
    badge: document.querySelector('[data-map-row="c5"] .map-badge')?.textContent.trim(),
  }));
  check('清空后自动匹配不会把它填回去', /未配置/.test(afterRematch.badge || ''), afterRematch.badge);

  // --- 5. 「规则」 ---
  await page.click('[data-map-rules="c0"]');
  await page.waitForSelector('.modal-title', { timeout: 8000 });
  await wait(500);
  const rules = await page.evaluate(() => document.querySelector('.modal-body')?.innerText.replace(/\s+/g, ' ').trim() || '');
  check('规则弹层显示必填与校验', /必填/.test(rules) && /不允许重复/.test(rules), rules.slice(0, 120));
  await page.evaluate(() => document.querySelector('.modal [data-close]')?.click());
  await wait(300);
  await page.click('[data-map-rules="c2"]');
  await page.waitForSelector('.modal-title', { timeout: 8000 });
  await wait(500);
  const rules2 = await page.evaluate(() => document.querySelector('.modal-body')?.innerText.replace(/\s+/g, ' ').trim() || '');
  check('规则弹层显示格式类规则', /匹配/.test(rules2), rules2.slice(0, 120));
  await page.screenshot({ path: `${SHOT_DIR}/mapping-rules.png` });
  await page.evaluate(() => document.querySelector('.modal [data-close]')?.click());
  await wait(300);

  check('没有 JS 报错', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  → ${c.detail}` : ''}`);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);
