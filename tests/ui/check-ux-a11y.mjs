/**
 * UX / 可访问性回归：守住 0.8.0 这批修复，防止再退化。
 *
 * 覆盖：
 *   P0  窄屏（390 / 768）无横向溢出、编辑器头部不被压扁、映射操作在视口内
 *   P1  正文对比度 ≥4.5、表单控件都有可访问名称、编辑器有 h1、导航有 aria-current、
 *       一次 Esc 只关最上层弹层、清空可撤销、全部重配先确认、切换路由焦点进主内容
 *   P2  完成度状态条可点开待处理清单、未匹配列可筛选
 *
 * 前置：
 *   1. HUIYI_DATA_DIR=/tmp/ui_mapui_data .venv/bin/python app.py --port 8896 --no-browser
 *   2. .venv/bin/python /tmp/prep_ui_mapui.py http://127.0.0.1:8896
 * 运行：
 *   NODE_PATH=<node_modules> node tests/ui/check-ux-a11y.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const puppeteer = createRequire(import.meta.url)('puppeteer-core');
const ctx = JSON.parse(readFileSync('/tmp/ui_mapui_ctx.json', 'utf8'));
const BASE = process.argv[2] || ctx.base;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

function parseColor(str) {
  const s = String(str || '').trim();
  const hex = s.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16)];
  const rgb = s.match(/rgba?\(([^)]+)\)/);
  if (rgb) return rgb[1].split(',').slice(0, 3).map((v) => Math.round(parseFloat(v)));
  return [0, 0, 0];
}
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [l1, l2] = [luminance(parseColor(a)), luminance(parseColor(b))].sort((x, y) => y - x);
  return Number(((l1 + 0.05) / (l2 + 0.05)).toFixed(2));
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
});

// ---------- 宽屏：可访问性与交互 ----------
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  await page.goto(`${BASE}/#/profiles/${ctx.profile_id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-map-row="c0"]', { timeout: 20000 });
  await wait(1500);

  const palette = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const tiny = document.querySelector('.tiny.faint');
    return {
      faint: cs.getPropertyValue('--faint').trim(),
      muted: cs.getPropertyValue('--muted').trim(),
      tinySize: tiny ? getComputedStyle(tiny).fontSize : '0px',
    };
  });
  const faintRatio = contrast(palette.faint, '#ffffff');
  const mutedRatio = contrast(palette.muted, '#ffffff');
  check(`--faint 对比度 ≥4.5（实际 ${faintRatio}:1）`, faintRatio >= 4.5, palette.faint);
  check(`--muted 对比度 ≥4.5（实际 ${mutedRatio}:1）`, mutedRatio >= 4.5, palette.muted);
  check('说明文字字号 ≥12px', parseFloat(palette.tinySize) >= 12, palette.tinySize);

  const nameless = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
      const id = el.id;
      const labeled = (id && document.querySelector(`label[for="${id}"]`)) || el.closest('label')
        || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
      if (!labeled) out.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 20)}`);
    }
    return out;
  });
  check('所有表单控件都有可访问名称', nameless.length === 0, nameless.join(' | '));

  const structure = await page.evaluate(() => ({
    h1: document.querySelectorAll('h1').length,
    current: document.querySelectorAll('[aria-current="page"]').length,
    statusPill: !!document.querySelector('[data-open-issues]'),
    retryBtn: !!document.querySelector('[data-retry-save]'),
  }));
  check('编辑器有且只有一个 h1', structure.h1 === 1, String(structure.h1));
  check('当前导航项带 aria-current', structure.current >= 1, String(structure.current));
  check('顶栏有完成度状态条', structure.statusPill);
  check('顶栏备有「保存失败 · 重试」入口', structure.retryBtn);

  // 完成度状态条 → 待处理清单
  await page.click('[data-open-issues]');
  await page.waitForSelector('.issue-list, .modal-body', { timeout: 8000 });
  await wait(400);
  const issues = await page.evaluate(() => ({
    title: document.querySelector('.modal-title')?.textContent.trim() || '',
    items: document.querySelectorAll('.issue-item').length,
  }));
  check('状态条能打开待处理清单', /项|\S/.test(issues.title) && issues.items >= 0, JSON.stringify(issues));
  await page.keyboard.press('Escape');
  await wait(300);

  // 未匹配筛选
  const filterBtn = await page.$('[data-filter-unmatched]');
  if (filterBtn) {
    await filterBtn.click();
    await wait(500);
    const filtered = await page.evaluate(() => ({
      rows: document.querySelectorAll('[data-map-row]').length,
      allBtn: !!document.querySelector('[data-filter-all]'),
    }));
    check('「未匹配」可筛选', filtered.allBtn && filtered.rows >= 1, JSON.stringify(filtered));
    await page.click('[data-filter-all]');
    await wait(400);
  } else {
    check('「未匹配」可筛选', false, '没有未匹配列（数据不符，跳过）');
  }

  // Esc 分层
  await page.click('[data-map-open="c0"]');
  await page.waitForSelector('[data-mp-source]');
  await wait(400);
  await page.click('[data-mp-formula]');
  await page.waitForSelector('[data-fx-input]');
  await wait(400);
  const before = await page.evaluate(() => document.querySelectorAll('.modal').length);
  await page.keyboard.press('Escape');
  await wait(300);
  const after = await page.evaluate(() => document.querySelectorAll('.modal').length);
  check('一次 Esc 只关最上层弹层', before === 2 && after === 1, `${before} → ${after}`);
  await page.keyboard.press('Escape');
  await wait(300);

  // 清空可撤销
  const srcBefore = await page.evaluate(() => document.querySelector('[data-map-row="c0"] .src-text')?.textContent.trim());
  await page.click('[data-map-clear="c0"]');
  await wait(700);
  const undo = await page.evaluate(() => ({
    action: !!document.querySelector('.toast-action'),
    src: document.querySelector('[data-map-row="c0"] .src-text')?.textContent.trim(),
  }));
  check('清空后给「撤销」而不是静默丢弃', undo.action && /未配置/.test(undo.src || ''), JSON.stringify(undo));
  if (undo.action) {
    await page.click('.toast-action');
    await wait(700);
    const restored = await page.evaluate(() => document.querySelector('[data-map-row="c0"] .src-text')?.textContent.trim());
    check('撤销后来源恢复', restored === srcBefore, `${srcBefore} → ${restored}`);
  }

  // 全部重配要先确认
  const hasConfigured = await page.evaluate(() => [...document.querySelectorAll('[data-map-row] .src-text')]
    .filter((el) => !/未配置/.test(el.textContent)).length > 0);
  if (hasConfigured) {
    await page.click('[data-auto-map-all]');
    await wait(600);
    const confirm = await page.evaluate(() => ({
      modals: document.querySelectorAll('.modal').length,
      focusCancel: !!document.activeElement?.hasAttribute('data-cancel'),
    }));
    check('「全部重配」先弹确认', confirm.modals === 1, JSON.stringify(confirm));
    check('危险确认框初始焦点在「取消」', confirm.focusCancel, String(confirm.focusCancel));
    await page.keyboard.press('Escape');
    await wait(300);
  }

  // 切页焦点
  await page.evaluate(() => { location.hash = '#/profiles'; });
  await wait(1000);
  const focus = await page.evaluate(() => ({
    id: document.activeElement?.id || '',
    inView: !!document.activeElement?.closest('#view'),
  }));
  check('切换路由后焦点进入主内容', focus.inView || focus.id === 'view', JSON.stringify(focus));

  check('没有前端 JS 报错', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));
  await page.close();
}

// ---------- 窄屏 ----------
for (const [w, h] of [[390, 844], [768, 1024]]) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  await page.goto(`${BASE}/#/profiles/${ctx.profile_id}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-map-row="c0"]', { timeout: 20000 });
  await wait(1200);
  const layout = await page.evaluate(() => {
    const doc = document.documentElement;
    const head = document.querySelector('.editor-head');
    const clear = document.querySelector('[data-map-clear="c0"]');
    const rect = clear?.getBoundingClientRect();
    const titleInput = document.querySelector('.editor-title');
    const titleRect = titleInput?.getBoundingClientRect();
    return {
      overflow: doc.scrollWidth - doc.clientWidth,
      headHeight: head ? Math.round(head.getBoundingClientRect().height) : 0,
      clearVisible: rect ? rect.right <= doc.clientWidth + 1 && rect.width > 0 : false,
      titleWidth: titleRect ? Math.round(titleRect.width) : 0,
    };
  });
  check(`${w}px 无横向溢出`, layout.overflow === 0, `${layout.overflow}px`);
  check(`${w}px 编辑器头部未被压扁`, layout.headHeight <= 200, `${layout.headHeight}px`);
  check(`${w}px 映射操作按钮在视口内`, layout.clearVisible, String(layout.clearVisible));
  check(`${w}px 方案标题有可用宽度（>120px）`, layout.titleWidth > 120, `${layout.titleWidth}px`);
  await page.close();
}

await browser.close();

let failed = 0;
for (const c of checks) {
  if (!c.ok) failed += 1;
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  → ${c.detail}` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);
