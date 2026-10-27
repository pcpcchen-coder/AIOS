#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'prototype/ambient-shell/desktop');
const outputIndex = process.argv.indexOf('--output');
const output = resolve(outputIndex < 0 ? join(tmpdir(), `aios-bilingual-desktop-${Date.now()}`) : process.argv[outputIndex + 1]);
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'aios-bilingual-electron-'));
await writeFile(join(profile, '.env'), `NOUS_PROVIDER=mock\nNOUS_CONFIG_DIR=${join(profile, 'config')}\nNOUS_CAMERA=off\nANTHROPIC_API_KEY=\nOPENAI_API_KEY=\nSMARTHOME_URL=\nSMARTHOME_TOKEN=\nNOUS_REALTIME_MCP=\n`);
await writeFile(join(profile, 'desktop.json'), JSON.stringify({ locale: 'zh-TW', showDock: false, startHidden: false }));
const env = { ...process.env, NOUS_CONFIG_DIR: join(profile, 'config'), NOUS_PROVIDER: 'mock', NOUS_CAMERA: 'off' };
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SMARTHOME_TOKEN', 'SMARTHOME_URL', 'NOUS_REALTIME_MCP']) env[key] = '';
const moduleName = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { _electron } = await import(moduleName.startsWith('/') ? pathToFileURL(moduleName).href : moduleName);
const report = { fixture: 'Real Electron development build, isolated temporary userData/config, mock core, no account/audio/camera', cases: [], errors: [] };
let electron;
try {
  electron = await _electron.launch({
    executablePath: process.env.ELECTRON_PATH || join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [`--user-data-dir=${profile}`, join(desktop, 'build/app')], env,
  });
  const page = await electron.firstWindow();
  page.on('pageerror', error => report.errors.push(String(error)));
  await page.waitForFunction(() => !!window.nousDesktop && document.body.dataset.activeRegions !== undefined);
  let navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  await page.evaluate(() => {
    const label = document.createElement('p');
    label.textContent = 'FIXTURE · Isolated Electron profile · No real account, microphone or camera';
    label.style.cssText = 'position:fixed;bottom:0;left:0;right:0;margin:0;padding:8px;background:#ffe68a;color:#111;text-align:center;font:14px sans-serif;z-index:10000;pointer-events:none';
    document.body.append(label);
  });
  const actualUserData = await electron.evaluate(({ app }) => app.getPath('userData'));
  assert.equal(await realpath(actualUserData), await realpath(profile), 'native validation must never use the production profile');
  async function menuLanguage(label) {
    await electron.evaluate(({ Menu }, label) => {
      const find = items => {
        for (const item of items) {
          if (item.label === label && item.type === 'radio') return item;
          const child = item.submenu && find(item.submenu.items);
          if (child) return child;
        }
      };
      const item = find(Menu.getApplicationMenu().items);
      if (!item) throw new Error(`Language menu missing: ${label}`);
      item.click();
    }, label);
  }
  async function settings() {
    const input = page.locator('#command-input');
    if (!await input.isVisible()) {
      await page.locator('#brain').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('Enter');
    }
    await input.fill('settings');
    await input.press('Enter');
    await page.locator('#interface-language').waitFor({ state: 'visible' });
  }
  await settings();
  assert.equal(await page.locator('#interface-language').inputValue(), 'zh-TW');
  await menuLanguage('English');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.equal(await page.locator('#interface-language').inputValue(), 'en');
  const labels = await electron.evaluate(({ Menu }) => {
    const flatten = items => items.flatMap(item => [item.label, item.sublabel || '', ...(item.submenu ? flatten(item.submenu.items) : [])]);
    return flatten(Menu.getApplicationMenu().items).filter(Boolean);
  });
  const untranslated = labels.filter(label => /[\u3400-\u9fff]/u.test(label) && !['繁體中文', '語言 / Language', 'Language / 語言'].includes(label));
  assert.deepEqual(untranslated, [], `Untranslated native menu labels: ${JSON.stringify(untranslated)}`);
  assert.ok(labels.includes('Settings') || labels.includes('View') || labels.includes('Edit'));
  report.cases.push({ name: 'native-menu-switches-renderer-without-reload', status: 'passed', labels });
  assert.equal(navigations, 0);
  await page.waitForTimeout(300);
  await page.screenshot({ animations: 'disabled', path: join(output, 'app-en.png'), fullPage: true });
  report.cases.at(-1).screenshot = join(output, 'app-en.png');

  await page.locator('#interface-language').selectOption('zh-TW');
  await page.waitForFunction(() => document.documentElement.lang === 'zh-Hant-TW');
  await new Promise((resolve, reject) => {
    const until = Date.now() + 5000;
    const poll = async () => {
      const prefs = JSON.parse(await readFile(join(profile, 'desktop.json'), 'utf8'));
      if (prefs.locale === 'zh-TW') resolve();
      else if (Date.now() > until) reject(new Error('Renderer language was not saved in native preferences'));
      else setTimeout(poll, 30);
    };
    void poll();
  });
  await page.waitForTimeout(300);
  await page.screenshot({ animations: 'disabled', path: join(output, 'app-zh-TW.png'), fullPage: true });
  report.cases.push({ name: 'renderer-switch-updates-native-persistent-preference', status: 'passed', screenshot: join(output, 'app-zh-TW.png') });
  await menuLanguage('English');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await page.reload();
  await settings();
  assert.equal(await page.locator('#interface-language').inputValue(), 'en');
  report.cases.push({ name: 'native-language-persists-on-reload', status: 'passed' });
  assert.deepEqual(report.errors, []);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error.stack;
  throw error;
} finally {
  await electron?.close();
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Bilingual desktop evidence: ${join(output, 'report.json')}`);
}
