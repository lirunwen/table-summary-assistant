/**
 * UI 回归：侧栏「退出应用」按钮 + 设置页「快捷方式与退出」。
 *
 * 这个脚本会真的把被测服务关掉（这是它的目的），所以放在最后跑，
 * 并且要在独立的临时数据目录上起服务：
 *   HUIYI_DATA_DIR=/tmp/ui_exit ./.venv/bin/python app.py --port 8898 --no-browser
 *   NODE_PATH=<node_modules> node tests/ui/check-app-control.mjs http://127.0.0.1:8898
 */
import { createRequire } from 'node:module';

const puppeteer = createRequire(import.meta.url)('puppeteer-core');

const BASE = process.argv[2] || 'http://127.0.0.1:8898';
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const bootstrap = await (await fetch(`${BASE}/api/bootstrap`)).json();
const canShortcut = !!bootstrap.app?.can_shortcut;

async function apiAlive() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1500);
    const resp = await fetch(`${BASE}/api/health`, { signal: ctl.signal });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text()); });

  await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('#exit-btn');

  const shell = await page.evaluate(() => {
    const btn = document.querySelector('#exit-btn');
    const rect = btn.getBoundingClientRect();
    return {
      tag: btn.tagName,
      text: btn.textContent.trim(),
      visible: rect.width > 0 && rect.height > 0,
      hasIcon: !!btn.querySelector('use[href*="i-power"]'),
    };
  });
  check('侧栏有「退出应用」按钮', shell.tag === 'BUTTON' && shell.text.includes('退出'), shell.text);
  check('按钮可见且带电源图标', shell.visible && shell.hasIcon);

  // ---- 设置页：快捷方式与退出 ----
  await page.goto(`${BASE}/#/settings`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-exit-app]');
  const settings = await page.evaluate(() => {
    const make = document.querySelector('[data-make-shortcut]');
    return {
      hasMake: !!make,
      makeDisabled: !!make?.disabled,
      hasExit: !!document.querySelector('[data-exit-app]'),
      tipMentionsData: (document.body.textContent || '').includes('不会删除 data'),
    };
  });
  check('设置页有「创建快捷方式」按钮', settings.hasMake);
  check(
    canShortcut ? 'Windows 下可点击' : '非 Windows 时按钮置灰（不可误点）',
    canShortcut ? settings.makeDisabled === false : settings.makeDisabled === true,
    `can_shortcut=${canShortcut} disabled=${settings.makeDisabled}`,
  );
  check('设置页有「退出应用」按钮', settings.hasExit);
  check('卡片说明退出不会删数据', settings.tipMentionsData);

  // ---- 取消不应退出 ----
  await page.click('[data-exit-app]');
  await page.waitForSelector('.modal [data-cancel]', { timeout: 3000 });
  const modal = await page.evaluate(() => ({
    title: document.querySelector('.modal h2, .modal .modal-title, .modal header')?.textContent || '',
    danger: !!document.querySelector('.modal .btn-danger'),
  }));
  check('点退出弹出确认框', modal.title.includes('退出') || modal.danger, modal.title.trim());
  await page.click('.modal [data-cancel]');
  await wait(400);
  const stillHere = await page.evaluate(() => !!document.querySelector('#exit-btn') && !document.querySelector('.exit-screen'));
  check('取消后页面照常可用', stillHere && await apiAlive());

  // ---- 确认退出：界面切走 + 服务真的停 ----
  await page.click('[data-exit-app]');
  await page.waitForSelector('.modal [data-confirm]', { timeout: 3000 });
  await page.click('.modal [data-confirm]');
  await page.waitForSelector('.exit-screen', { timeout: 6000 });
  const exitView = await page.evaluate(() => ({
    title: document.querySelector('.exit-card h1')?.textContent?.trim() || '',
    tips: document.querySelectorAll('.exit-tips > div').length,
    bodyClass: document.body.className,
  }));
  check('出现「已退出」落地页', exitView.title.includes('已退出'), exitView.title);
  check('落地页给出重开与数据位置提示', exitView.tips === 2, `${exitView.tips} 条`);

  await wait(1200);
  check('本地服务已停止（端口不再响应）', (await apiAlive()) === false);
  check('无前端异常', jsErrors.length === 0, jsErrors.join(' | '));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);
