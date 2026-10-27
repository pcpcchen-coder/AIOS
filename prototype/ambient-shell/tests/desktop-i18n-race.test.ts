import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

it('discards a late localized settings response after the selected language changes', async () => {
  const source = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8');
  const begin = source.indexOf('async function refreshSettings()');
  const end = source.indexOf('\n/**', begin);
  const pending: ((value: unknown) => void)[] = [];
  const context = {
    prefs: { locale: 'en' }, settings: null, settingsReadGeneration: 0,
    api: vi.fn(() => new Promise(resolve => pending.push(resolve))), rebuildMenu: vi.fn(),
    refreshSettings: async () => {},
  };
  runInNewContext(source.slice(begin, end), context);
  const english = context.refreshSettings();
  context.prefs.locale = 'zh-TW';
  const chinese = context.refreshSettings();
  pending[1]({ detail: '中文目前設定' });
  await chinese;
  expect(context.settings).toEqual({ detail: '中文目前設定' });
  pending[0]({ detail: 'Stale English settings' });
  await english;
  expect(context.settings).toEqual({ detail: '中文目前設定' });
  expect(context.rebuildMenu).toHaveBeenCalledTimes(1);
});
