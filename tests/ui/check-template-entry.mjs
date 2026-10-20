/**
 * UI 回归：新建汇总方案时，「目标 Excel 模板」入口是否可见、默认值是否正确、
 * 上传入口是否就位、创建后模板是否真的挂到方案上。
 *
 * 用法（需要先起一个服务）：
 *   1. 启动服务（建议用独立数据目录，避免污染自己的库）
 *        HUIYI_DATA_DIR=/tmp/ui_check ./.venv/bin/python app.py --port 8899 --no-browser
 *   2. 准备 puppeteer-core（本机 Chrome 即可，不需要下载 Chromium）
 *        NODE_PATH=<你的 node_modules> node tests/ui/check-template-entry.mjs
 *      没有的话：npm i puppeteer-core
 *   3. 运行
 *        node tests/ui/check-template-entry.mjs http://127.0.0.1:8899
 *
 * 退出码 0 = 全部通过；1 = 有断言失败（会打印失败项）。
 */
import { createRequire } from 'node:module';

// ESM 不认 NODE_PATH，用 createRequire 走 CJS 解析，这样 NODE_PATH 才生效
const puppeteer = createRequire(import.meta.url)('puppeteer-core');

const BASE = process.argv[2] || 'http://127.0.0.1:8899';
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

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

  const bootstrap = await (await fetch(`${BASE}/api/bootstrap`)).json();
  const templateCount = (bootstrap.templates || []).length;

  await page.goto(`${BASE}/#/profiles`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-new-profile]');
  await page.click('[data-new-profile]');
  await page.waitForSelector('[data-output-grid]');
  await new Promise((r) => setTimeout(r, 250));

  const state = () => page.evaluate(() => {
    const picked = document.querySelector('[data-output-grid] .mode-option.selected');
    return {
      cards: document.querySelectorAll('[data-output-grid] .mode-option').length,
      selected: picked ? picked.dataset.output : null,
      hasTemplateSelect: !!document.querySelector('#np-template'),
      hasUploadButton: !!document.querySelector('[data-pick-file]'),
      ruleItems: document.querySelectorAll('.rule-item').length,
      summaryChips: document.querySelectorAll('.tpl-summary .chip').length,
    };
  });

  const initial = await state();
  check('输出方式有三张卡片', initial.cards === 3, `实际 ${initial.cards}`);
  check(
    templateCount ? '有模板时默认选中「用已有模板」' : '无模板时默认选中「新建空白表」',
    initial.selected === (templateCount ? 'template' : 'blank'),
    `实际 ${initial.selected}`,
  );
  if (templateCount) {
    check('默认模板面板展示表头摘要', initial.summaryChips > 0, `列名 chip ${initial.summaryChips}`);
    check('默认模板面板说明生效规则', initial.ruleItems >= 3, `规则 ${initial.ruleItems} 条`);
  }

  await page.click('[data-output-grid] [data-output="upload"]');
  await new Promise((r) => setTimeout(r, 200));
  const upload = await state();
  check('「上传新模板」面板有选文件按钮', upload.hasUploadButton === true,
    `selected=${upload.selected}`);

  if (templateCount) {
    await page.click('[data-output-grid] [data-output="template"]');
    await new Promise((r) => setTimeout(r, 200));
    const tplState = await state();
    check('「用已有模板」面板有模板下拉', tplState.hasTemplateSelect === true);
    check('「用已有模板」面板有列名摘要', tplState.summaryChips > 0, `chip ${tplState.summaryChips}`);
  } else {
    // 没有模板时切回空白表，这一步同时验证「模板」选项不会把用户挡在创建之外
    await page.click('[data-output-grid] [data-output="blank"]');
    await new Promise((r) => setTimeout(r, 200));
  }

  // 用默认值直接创建，验证模板真的落到 config 上
  const name = `UI巡检_${Date.now()}`;
  await page.type('#np-name', name);
  await page.click('[data-create]');
  await new Promise((r) => setTimeout(r, 1500));

  const after = await (await fetch(`${BASE}/api/bootstrap`)).json();
  const created = (after.profiles || []).find((p) => p.name === name);
  check('方案创建成功', !!created);
  if (created) {
    const target = created.config?.target || {};
    if (templateCount) {
      check('创建后挂了模板', target.kind === 'template' && !!target.template_id,
        `kind=${target.kind} template_id=${target.template_id}`);
      check('创建后带出模板列', (target.columns || []).length > 0,
        `${(target.columns || []).length} 列`);
      check('创建后表头行来自模板', Number(target.header_row) >= 1, `header_row=${target.header_row}`);
    } else {
      check('无模板时创建为空白表', target.kind === 'blank', `kind=${target.kind}`);
    }
    await fetch(`${BASE}/api/profiles/${created.id}`, { method: 'DELETE' });
  }

  check('无前端异常', jsErrors.length === 0, jsErrors.join(' | '));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);
