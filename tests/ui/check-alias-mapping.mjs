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

  // 先把三列标成「用户明确留空」：自动匹配会跳过它们，
  // 这样才能验证手动点「按列名匹配」这条路径（用例可重复执行）。
  const boot = await (await fetch(`${BASE}/api/bootstrap`)).json();
  const prof = (boot.profiles || []).find((p) => p.id === ctx.profile_id);
  if (prof) {
    const blank = (key) => ({ mode: 'blank', user_blank: true });
    const cfg = { ...prof.config, mappings: { k0: blank('k0'), k1: blank('k1'), k2: blank('k2') } };
    await fetch(`${BASE}/api/profiles/${ctx.profile_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: prof.name, config: cfg }),
    });
  }

  await page.goto(`${BASE}/#/profiles/${ctx.profile_id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-map-row="k1"]', { timeout: 15000 });
  await wait(1200);

  // --- 1. 初始状态：标了「明确留空」的列不会被自动匹配填上 ---
  const before = await page.$$eval('[data-map-field]', (els) => els.length);
  check('明确留空的列不会被自动匹配填上', before === 0, `实际 ${before} 个字段下拉`);

  // --- 2. 点「按列名匹配」 ---
  await page.click('[data-auto-map]');
  await wait(1500);

  const picked = await page.evaluate(() => {
    const row = (key) => document.querySelector(`[data-map-row="${key}"]`);
    const src = (key) => row(key)?.querySelector('.src-text')?.textContent.trim() || '';
    const badge = (key) => row(key)?.querySelector('.map-badge')?.textContent.trim() || '';
    return {
      k0: { source: src('k0'), badge: badge('k0') },
      k1: { source: src('k1'), badge: badge('k1') },
      k2: { source: src('k2'), badge: badge('k2') },
      toast: document.querySelector('[data-toast]')?.textContent || '',
    };
  });

  // 严格同名：姓名在两表都有，按 append_tables 顺序取第一张（工资表）
  check('姓名按同名匹配到工资表', /工资表|wage/.test(picked.k0.source) && /姓名/.test(picked.k0.source),
    picked.k0.source);
  // 括号备注名：模板列「月薪（税前）」→ 工资表的「税前」
  check('月薪（税前）按括号备注名匹配到「税前」',
    /工资表|wage/.test(picked.k1.source) && /税前/.test(picked.k1.source), picked.k1.source);
  check('映射行标出了匹配层级（备注名）', /备注名/.test(picked.k1.badge), picked.k1.badge);
  check('部门按同名匹配到通讯录', /通讯录|contact/.test(picked.k2.source) && /部门/.test(picked.k2.source),
    picked.k2.source);
  check('提示区分了同名与括号备注名',
    picked.toast.includes('同名') && picked.toast.includes('备注名'), picked.toast);

  // --- 3. 截图（此时状态标签还在） ---
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
  const k1src = (saved.k1?.sources || [])[0] || {};
  check('括号别名匹配结果已保存', k1src.column_index === 1 && k1src.column_name === '税前'
    && saved.k1?.matched?.via === 'alias', JSON.stringify(saved.k1 || {}));

  // --- 5. 手改来源后，状态变成「手动」 ---
  await page.click('[data-map-open="k1"]');
  await page.waitForSelector('[data-mp-source]', { timeout: 10000 });
  await wait(500);
  await page.evaluate(() => {
    const sel = document.querySelector('[data-mp-source]');
    const opt = [...sel.options].find((o) => o.value && o.value !== sel.value);
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await wait(900);
  await page.evaluate(() => (() => { const ms = document.querySelectorAll('.modal'); ms[ms.length - 1]?.querySelector('[data-close]')?.click(); })());
  await wait(500);
  const afterManual = await page.evaluate(() => ({
    badge: document.querySelector('[data-map-row="k1"] .map-badge')?.textContent.trim() || '',
  }));
  check('手改来源后不再标「备注名」', /手动/.test(afterManual.badge), afterManual.badge);

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
