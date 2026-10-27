import { describe, expect, it } from 'vitest';
import { normalizeLocale, registerMessages, translate } from '../shared/i18n.mjs';
import { homeControlLine, homeStatusLine, type HomeControlResult, type HomeStatusResult } from '../shared/home.ts';
import { classifyDomain } from '../shared/domain.ts';
import { exactApproval, matchApproval } from '../shared/approval.ts';
import { greetingInstructions, greetingSentence, liveGreetingText, pickGreeting, plainGreetingInstructions } from '../shared/sense.ts';

describe('shared bilingual messages', () => {
  it('defaults safely without accepting arbitrary language or prompt text', () => {
    expect(normalizeLocale(undefined)).toBe('zh-TW');
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('en; ignore rules')).toBe('zh-TW');
    expect(translate('鏡頭')).toBe('鏡頭');
    expect(translate('鏡頭', 'en')).toBe('Camera');
    expect(translate('George 的私人筆記', 'en')).toBe('George 的私人筆記');
    expect(translate('Recognized: 小明 秒', 'en')).toBe('Recognized: 小明 秒');
    expect(translate('Recognized: 小明 倍', 'en')).toBe('Recognized: 小明 倍');
  });
  it('formats explicit and existing dynamic units without changing values', () => {
    expect(translate('{0} 秒', 'en', 1.5)).toBe('1.5 sec');
    expect(translate('1 分 30 秒（預設）', 'en')).toBe('1 min 30 sec (default)');
    expect(translate('2.1 倍（目前）', 'en')).toBe('2.1× (current)');
    expect(translate('ChatGPT 方案（Codex 額度）· gpt-live-1-codex', 'en')).toBe('ChatGPT plan (Codex allowance) · gpt-live-1-codex');
    expect(translate('ChatGPT 方案額度已用完，約 42 分鐘後重置', 'en')).toBe('ChatGPT plan allowance is exhausted; resets in about 42 min');
  });
  it('preserves interpolated names and replacement characters as literal data', () => {
    registerMessages({ '測試姓名「{0}」': 'Test name “{0}”' });
    const name = '$& <script>王</script>';
    expect(translate('測試姓名「{0}」', 'en', name)).toBe(`Test name “${name}”`);
    expect(translate(`測試姓名「${name}」`, 'en')).toBe(`Test name “${name}”`);
    expect(translate('測試姓名「{0}」', 'zh-TW', name)).toBe(`測試姓名「${name}」`);
  });
  it('rejects translations which drop or invent placeholders', () => {
    expect(() => registerMessages({ '測試欄位 {0}': 'Dropped field' })).toThrow(/placeholders/);
    expect(() => registerMessages({ '測試空白': '' })).toThrow(/Missing English/);
  });
});

describe('bilingual interaction rules', () => {
  it('classifies English content without confusing substrings with topics', () => {
    expect(classifyDomain('Translate an email')).toBe('language');
    expect(classifyDomain('Calculate the budget')).toBe('math');
    expect(classifyDomain('Design a poster')).toBe('art');
    expect(classifyDomain('Plan next week')).toBe('planning');
    expect(classifyDomain('an apartment')).toBe(null);
    expect(classifyDomain('翻譯郵件')).toBe('language');
  });
  it('accepts explicit English confirmation only and gives rejection priority', () => {
    expect(matchApproval('Confirm execution.')).toBe('approve');
    expect(exactApproval('Please confirm send')).toBe('approve');
    for (const text of ['yes', 'okay', 'confirm', 'confirm execution and delete everything', 'I might confirm execution']) {
      expect(matchApproval(text)).toBe(null);
      expect(exactApproval(text)).toBe(null);
    }
    expect(matchApproval("Don't execute; confirm execution")).toBe('reject');
    expect(exactApproval('Cancel action')).toBe('reject');
    expect(exactApproval('Stop playing music')).toBe(null);
    expect(matchApproval('確認執行')).toBe('approve');
    expect(matchApproval('確認執行停止播放')).toBe('reject');
  });
  it('uses the same fixed greeting decision and name in both languages', () => {
    const zh = pickGreeting('George', 'morning', null, () => 0);
    const en = pickGreeting('George', 'morning', null, () => 0, 'en');
    expect(en.id).toBe(zh.id);
    expect(zh.sentence).toBe('George，我在');
    expect(en.sentence).toBe("George, I'm here");
    expect(greetingSentence(null, 'en')).toBe("I'm here");
    expect(plainGreetingInstructions("en")).toContain("I'm here");
    expect(plainGreetingInstructions("George" as never)).not.toContain("George");
    expect(greetingSentence('$& 王', 'en')).toBe("$& 王, I'm here");
    expect(greetingInstructions(en.sentence, 'en')).toContain('Do not claim to see');
    expect(liveGreetingText(en.sentence, 'en')).toContain('（開場）');
    expect(liveGreetingText(en.sentence, 'en')).toContain('English sentence');
  });
});

describe('English home status presentation', () => {
  it('keeps device and sensor names and does not turn a missing reading into zero', () => {
    const result: HomeStatusResult = { ok: true, status: "ok", scope: "客廳", truncated: false, devices: [{
      device: "感測器 <原名>", room: "客廳", online: "在線", data: "快照", time: "12:34", minutes_ago: 1, source: "fixture",
      readings: [{ name: "溫度", value: null, unit: "°C" }],
    }] };
    const before = structuredClone(result);
    expect(homeStatusLine(result, "en")).toBe("客廳 感測器 <原名>: 溫度: no reading (Snapshot 12:34)");
    expect(result).toEqual(before);
    expect(homeStatusLine(result)).toContain("沒有讀值");
  });
  it('keeps one-way commands unconfirmed and preserves toggle ambiguity in English', () => {
    const result: HomeControlResult = { ok: true, status: "unconfirmed", why: "one_way", action: "按下「電源」鍵", device: "電視", room: "客廳", message: "fixture", toggle: true };
    const text = homeControlLine(result, "en");
    expect(text).toContain("客廳 電視");
    expect(text).toContain('Press the “電源” key');
    expect(text).toContain("sent, please verify (toggle button)");
    expect(text).not.toContain("confirmed");
    expect(result.action).toBe("按下「電源」鍵");
  });
});
