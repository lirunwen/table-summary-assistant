/**
 * UI 巡检：字段映射第 3 步的「Excel 公式」与「列级日期格式」。
 *
 * 前置：
 *   1. HUIYI_DATA_DIR=/tmp/ui_fx_data .venv/bin/python app.py --port 8899 --no-browser
 *   2. .venv/bin/python /tmp/prep_ui_fx.py http://127.0.0.1:8899
 * 运行：
 *   NODE_PATH=<node_modules> node tests/ui/check-formula-mapping.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const puppeteer = createRequire(import.meta.url)('puppeteer-core');

const ctx = JSON.parse(readFileSync('/tmp/ui_fx_ctx.json', 'utf8'));
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
  // 打开「映射」弹层：等旧的弹层关掉，确认页面上只有一层，避免选到上一次的控件
  const openMapping = async (key) => {
    await page.click(`[data-map-open="${key}"]`);
    await page.waitForSelector('[data-mp-source]', { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('.modal').length === 1, { timeout: 10000 });
    await wait(400);
  };
  await page.setViewport({ width: 1440, height: 1000 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text()); });

  await page.goto(`${BASE}/#/profiles/${ctx.profile_id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-map-row="k1"]', { timeout: 15000 });
  await wait(300);

  // --- 1. 每行都有映射入口（公式入口收在映射弹层里） ---
  const mapButtons = await page.$$eval('[data-map-open]', (els) => els.length);
  check('每个映射行都有映射入口', mapButtons >= 3, `实际 ${mapButtons} 个`);

  // --- 2. 打开映射弹层 → 写公式 ---
  await openMapping('k1');
  await page.click('[data-mp-formula]');
  await page.waitForSelector('[data-fx-input]', { timeout: 8000 });
  await wait(500);

  const dialog = await page.evaluate(() => ({
    title: document.querySelector('.fx-dialog')?.closest('.modal')?.querySelector('.modal-title')?.textContent || '',
    fieldChips: document.querySelectorAll('[data-fx-field]').length,
    funcButtons: document.querySelectorAll('[data-fx-fn]').length,
    hasPreviewPane: !!document.querySelector('[data-fx-preview]'),
    hasStatus: !!document.querySelector('[data-fx-status]'),
    dateRow: !!document.querySelector('[data-fx-datefmt]'),
  }));
  check('弹窗标题带列名', dialog.title.includes('总额'), dialog.title);
  check('弹窗列出可引用字段', dialog.fieldChips >= 5, `${dialog.fieldChips} 个字段`);
  check('函数速查已加载', dialog.funcButtons >= 20, `${dialog.funcButtons} 个函数`);
  check('有试算预览区', dialog.hasPreviewPane && dialog.hasStatus);
  check('非日期列不显示日期格式', dialog.dateRow === false);

  // --- 3. 输入合法公式 → 校验通过 + 试算 ---
  const input = await page.$('[data-fx-input]');
  await input.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type('[data-fx-input]', '=[单价]*[数量]', { delay: 12 });
  await wait(1400);

  const good = await page.evaluate(() => ({
    statusClass: document.querySelector('[data-fx-status]')?.className || '',
    statusText: document.querySelector('[data-fx-status]')?.textContent || '',
    rows: Array.from(document.querySelectorAll('[data-fx-preview] tbody tr')).map(
      (tr) => Array.from(tr.cells).map((td) => td.textContent.trim()),
    ),
  }));
  check('合法公式提示语法正确', good.statusClass.includes('good'), good.statusText.trim().slice(0, 60));
  check('试算得到 3 行结果',
    good.rows.length === 3,
    `实际 ${good.rows.length} 行`);
  const results = good.rows.map((r) => r[r.length - 1]);
  check('试算结果正确（30 / 0 / 0）',
    results[0] === '30' && results[1] === '0' && results[2] === '0',
    results.join(' | '));
  check('试算展示引用字段的输入值',
    (good.rows[0] || []).join(' ').includes('单价'), (good.rows[0] || []).join(' / '));

  // --- 4. 应用公式 ---
  await page.click('[data-fx-apply]');
  await wait(700);
  await page.evaluate(() => (() => { const ms = document.querySelectorAll('.modal'); ms[ms.length - 1]?.querySelector('[data-close]')?.click(); })());
  await wait(600);
  const applied = await page.evaluate(() => ({
    source: document.querySelector('[data-map-row="k1"] .src-text')?.textContent || '',
    badge: document.querySelector('[data-map-row="k1"] .map-badge')?.textContent || '',
  }));
  check('应用后行内显示公式摘要', applied.source.includes('单价'), applied.source);
  check('公式列的状态标签是「ƒx 公式」', /公式/.test(applied.badge), applied.badge);

  // --- 5. 空公式的错误提示 ---
  await openMapping('k1');
  await page.click('[data-mp-formula]');
  await page.waitForSelector('[data-fx-input]', { timeout: 8000 });
  await wait(400);
  const reopened = await page.$eval('[data-fx-input]', (el) => el.value);
  check('重新打开时带出已保存的公式', reopened.includes('[单价]'), reopened);
  await page.click('[data-fx-input]', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.click('[data-fx-apply]');
  await wait(400);
  const emptyWarn = await page.evaluate(() => ({
    statusClass: document.querySelector('[data-fx-status]')?.className || '',
    statusText: document.querySelector('[data-fx-status]')?.textContent || '',
    dialogOpen: !!document.querySelector('[data-fx-input]'),
  }));
  check('空公式给出错误提示且不关闭弹窗',
    emptyWarn.statusClass.includes('bad') && emptyWarn.dialogOpen
      && emptyWarn.statusText.includes('不能为空'),
    emptyWarn.statusText.trim().slice(0, 60));

  // 恢复公式，供后面预览使用
  await page.type('[data-fx-input]', '=[单价]*[数量]', { delay: 10 });
  await wait(1200);
  await page.click('[data-fx-apply]');
  await wait(600);

  // --- 6. 日期格式下拉（在映射弹层里） ---
  await openMapping('k2');
  await page.waitForSelector('[data-mp-datefmt]', { timeout: 10000 });
  await wait(400);
  const fmtExists = await page.$('[data-mp-datefmt]');
  check('映射弹层里有日期格式下拉', !!fmtExists);
  const options = await page.$$eval('[data-mp-datefmt] option',
    (els) => els.map((o) => ({ value: o.value, text: o.textContent.trim() })));
  check('格式下拉包含中文格式选项',
    options.some((o) => o.value === 'YYYY年M月D日'),
    options.map((o) => o.value).join(','));
  check('格式下拉用示例值展示效果',
    options.some((o) => o.text === '2026年10月21日'),
    options.map((o) => o.text).slice(0, 3).join(' / '));

  await page.select('[data-mp-datefmt]', 'YYYY年M月D日');
  await wait(500);
  await page.evaluate(() => (() => { const ms = document.querySelectorAll('.modal'); ms[ms.length - 1]?.querySelector('[data-close]')?.click(); })());
  await wait(500);

  // --- 7. 生成公式后打开预览，验证日期展示效果 ---
  await page.click('[data-preview]');
  await page.waitForSelector('.preview-scroll', { timeout: 15000 });
  await wait(500);
  const preview = await page.evaluate(() => {
    const headers = Array.from(document.querySelectorAll('.preview-scroll thead th'))
      .map((th) => th.textContent.trim());
    const firstRow = Array.from(document.querySelectorAll('.preview-scroll tbody tr'))
      .slice(0, 3).map((tr) => Array.from(tr.cells).map((td) => td.textContent.trim()));
    return { headers, firstRow, warnings: document.querySelectorAll('.diff-warning').length };
  });
  check('预览包含公式列与日期列',
    preview.headers.includes('总额') && preview.headers.includes('业务日期'),
    preview.headers.join(','));
  check('公式列预览值正确', preview.firstRow[0]?.[1] === '30', JSON.stringify(preview.firstRow[0]));
  check('日期按所选格式展示（中文年月日）',
    (preview.firstRow[0]?.[2] || '').includes('2026年3月5日'),
    preview.firstRow[0]?.[2] || '(空)');

  // 关闭预览弹窗
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('.modal-foot .btn'))
      .find((b) => b.textContent.trim() === '关闭');
    if (btn) btn.click();
  });
  await wait(400);

  // --- 8. 配置真的存进了后端 ---
  await wait(1600); // 等自动保存
  const boot = await (await fetch(`${BASE}/api/bootstrap`)).json();
  const saved = (boot.profiles || []).find((p) => p.id === ctx.profile_id);
  const m1 = saved?.config?.mappings?.k1 || {};
  const m2 = saved?.config?.mappings?.k2 || {};
  check('后端已保存公式', m1.formula_on === true && String(m1.formula).includes('[单价]'),
    `formula_on=${m1.formula_on} formula=${m1.formula}`);
  check('后端已保存日期格式', m2.date_format === 'YYYY年M月D日', `date_format=${m2.date_format}`);

  check('无前端异常', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);
