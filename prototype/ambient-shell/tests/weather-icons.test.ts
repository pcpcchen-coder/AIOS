// CLK-1：天氣圖示（WMO 代碼 → 手繪 SVG；白天／夜晚；不認得的代碼不畫）。
import { describe, expect, it } from "vitest";
import { clockIcon, CLOCK_WMO, DAY_NIGHT_ICONS } from "../shared/clock.ts";
import { weatherIcon, weatherIconSvg } from "../src/weather-icons.ts";

const ALL_CODES = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];

describe("WMO weather codes → icons", () => {
  it("every documented Open-Meteo code has exactly one icon and a zh / en condition", () => {
    for (const code of ALL_CODES) {
      expect(CLOCK_WMO.filter((w) => w.codes.includes(code))).toHaveLength(1);
      const svg = weatherIcon(code, true);
      expect(svg).toMatch(/^<svg class="weather-icon" viewBox="0 0 24 24"/);
      expect(svg).toContain('aria-hidden="true"');
    }
    expect(CLOCK_WMO.flatMap((w) => w.codes).sort((a, b) => a - b)).toEqual(ALL_CODES);
  });

  it("follows the plan's table", () => {
    const icon = (code: number) => clockIcon(code, true)?.kind;
    expect([0, 1, 2, 3].map(icon)).toEqual(["clear", "mostly_clear", "partly_cloudy", "overcast"]);
    expect([45, 48].map(icon)).toEqual(["fog", "fog"]);
    expect([51, 53, 55].map(icon)).toEqual(["drizzle", "drizzle", "drizzle"]);
    expect([56, 57, 66, 67].map(icon)).toEqual(["sleet", "sleet", "sleet", "sleet"]);
    expect([61, 63, 65].map(icon)).toEqual(["rain", "rain", "heavy_rain"]);
    expect([80, 81, 82].map(icon)).toEqual(["showers", "showers", "showers"]);
    expect([71, 73, 75, 77, 85, 86].map(icon)).toEqual(Array(6).fill("snow"));
    expect([95, 96, 99].map(icon)).toEqual(["thunder", "thunder", "thunder"]);
  });

  it("night swaps the sun for the moon only on sun icons", () => {
    for (const code of ALL_CODES) {
      const day = clockIcon(code, true)!;
      const night = clockIcon(code, false)!;
      expect(day.night).toBe(false);
      expect(night.night).toBe(DAY_NIGHT_ICONS.includes(night.kind));
      if (night.night) {
        expect(weatherIcon(code, false)).not.toBe(weatherIcon(code, true));
        expect(weatherIcon(code, false)).toContain("#c9d6ff");
        expect(weatherIcon(code, false)).not.toContain("--amber");
      } else {
        expect(weatherIcon(code, false)).toBe(weatherIcon(code, true));
      }
    }
    expect(weatherIcon(0, true)).toContain("--amber");
  });

  it("unknown or missing codes draw no icon", () => {
    expect(weatherIcon(1234, true)).toBeNull();
    expect(weatherIcon(null, true)).toBeNull();
    expect(clockIcon(-1, false)).toBeNull();
  });

  it("icons are fixed markup: no external references, scripts or event handlers", () => {
    for (const w of CLOCK_WMO) for (const night of [false, true]) {
      const svg = weatherIconSvg(w.icon, night);
      expect(svg).not.toMatch(/href|<script|on[a-z]+=|https?:/i);
    }
  });
});
