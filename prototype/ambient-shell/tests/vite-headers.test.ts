import { describe, expect, it } from "vitest";
import config from "../vite.config.ts";
import { pageHeaders } from "../server/page-headers.ts";

function directives(csp: string): Map<string, string> {
  return new Map(csp.split(";").map((d) => d.trim().split(/\s+(.*)/s, 2) as [string, string]));
}

// npm run dev:web／vite preview 也要擋下 @mediapipe/tasks-vision 每 60 秒外送的用量紀錄（odml.pa.googleapis.com）。
describe("vite dev/preview page headers", () => {
  const page = pageHeaders(true);

  it("preview serves exactly the core's camera-enabled page headers", () => {
    expect(config.preview?.headers).toEqual(page);
  });

  it("dev differs from the core only by inline styles for Vite's CSS injection", () => {
    const dev = config.server?.headers as Record<string, string>;
    expect({ ...dev, "Content-Security-Policy": "" }).toEqual({ ...page, "Content-Security-Policy": "" });
    const want = directives(page["Content-Security-Policy"]);
    want.set("style-src", "'self' 'unsafe-inline'");
    expect(directives(dev["Content-Security-Policy"])).toEqual(want);
  });

  it("both keep network access to the page's own origin", () => {
    for (const headers of [config.server?.headers, config.preview?.headers] as Record<string, string>[]) {
      expect(directives(headers["Content-Security-Policy"]).get("connect-src")).toBe("'self'");
      expect(directives(headers["Content-Security-Policy"]).get("default-src")).toBe("'self'");
    }
  });
});
