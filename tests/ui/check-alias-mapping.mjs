/**
 * UI 巡检：「按列名匹配」的两级匹配（严格同名 → 模板列名括号里的备注名）。
 *
 * 前置：
 *   1. HUIYI_DATA_DIR=/tmp/ui_alias_data .venv/bin/python app.py --port 8899 --no-browser
 *   2. .venv/bin/python /tmp/prep_ui_alias.py http://127.0.0.1:8899
 * 运行：
 *   NODE_PATH=<node_modules> node tests/ui/check-alias-mapping.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const puppeteer = createRequire(import.meta.url)('puppeteer-core');

const ctx = JSON.parse(readFileSync('/tmp/ui_alias_ctx.json', 'utf8'));
const BASE = process.argv[2] || ctx.base;
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

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
  await page.setViewport({ width: 1440, height: 1000 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text()); });

  await page.goto(`${BASE}/#/profiles/${ctx.profile_id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-map-row="k1"]', { timeout: 15000 });
  await wait(400);

  // --- 1. 初始状态：三列都还没来源 ---
  const before = await page.$$eval('[data-map-field]', (els) => els.length);
  check('初始没有可选的来源字段（3 列都空着）', before === 0, `实际 ${before} 个字段下拉`);

  // --- 2. 点「按列名匹配」 ---
  await page.click('[data-auto-map]');
  await page.waitForSelector('[data-map-field="k1"]', { timeout: 10000 });
  await wait(600);

  const picked = await page.evaluate(() => {
    const text = (key) => {
      const sel = document.querySelector(`[data-map-field="${key}"]`);
      return sel ? sel.options[sel.selectedIndex]?.textContent.trim() : null;
    };
    const source = (key) => document.querySelector(`[data-map-source="${key}"]`)?.value || '';
    const row = (key) => document.querySelector(`[data-map-row="${key}"]`);
    return {
      k0: { field: text('k0'), source: source('k0') },
      k1: { field: text('k1'), source: source('k1'), alias: row('k1')?.querySelector('.map-alias')?.textContent.trim() || '' },
      k2: { field: text('k2'), source: source('k2') },
      toast: document.querySelector('[data-toast]')?.textContent || '',
    };
  });

  // 严格同名：姓名在两表都有，按 append_tables 顺序取第一张（工资表）
  check('姓名按同名匹配到工资表', picked.k0.source === `table:${ctx.wage_id}` && picked.k0.field === '姓名',
    `${picked.k0.source} / ${picked.k0.field}`);
  // 括号备注名：模板列「月薪（税前）」→ 工资表的「税前」
  check('月薪（税前）按括号备注名匹配到「税前」',
    picked.k1.source === `table:${ctx.wage_id}` && picked.k1.field === '税前',
    `${picked.k1.source} / ${picked.k1.field}`);
  check('映射行标出了别名来源', picked.k1.alias.includes('税前'), picked.k1.alias);
  check('部门按同名匹配到通讯录', picked.k2.source === `table:${ctx.contact_id}` && picked.k2.field === '部门',
    `${picked.k2.source} / ${picked.k2.field}`);
  check('提示区分了同名与括号备注名',
    picked.toast.includes('同名 2 列') && picked.toast.includes('括号备注名 1 列'), picked.toast);

  // --- 3. 截图（此时别名提示还在） ---
  await page.screenshot({ path: '/tmp/ui_alias_shot.png', fullPage: true });
  const section = await page.$('#section-mapping');
  if (section) await section.screenshot({ path: '/tmp/ui_alias_map.png' });

  // --- 4. 配置已落盘 ---
  await wait(1600);
  const saved = await page.evaluate(async (base, pid) => {
    const resp = await fetch(`${base}/api/bootstrap`);
    const data = await resp.json();
    const profile = (data.profiles || []).find((p) => p.id === pid);
    return profile?.config?.mappings || {};
  }, BASE, ctx.profile_id);
  check('括号别名匹配结果已保存', saved.k1?.column_index === 1 && saved.k1?.column_name === '税前'
    && saved.k1?.matched_alias === '税前', JSON.stringify(saved.k1 || {}));

  // --- 5. 手改来源字段后，别名提示要消失 ---
  await page.select('[data-map-field="k1"]', '0');
  await wait(500);
  const afterManual = await page.evaluate(() => ({
    field: document.querySelector('[data-map-field="k1"]')?.selectedOptions[0]?.textContent.trim(),
    alias: document.querySelector('[data-map-row="k1"] .map-alias')?.textContent || '',
  }));
  check('手改字段后别名提示消失', afterManual.field === '姓名' && !afterManual.alias,
    `${afterManual.field} / ${afterManual.alias}`);

  check('没有前端 JS 报错', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

let bad = 0;
for (const c of checks) {
  if (!c.ok) bad += 1;
  console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(bad ? `\n${bad} 项未通过` : '\n全部通过');
process.exit(bad ? 1 : 0);
