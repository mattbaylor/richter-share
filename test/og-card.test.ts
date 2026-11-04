import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PublicPage } from "../src/shared/types";

vi.mock("@resvg/resvg-wasm/index_bg.wasm", () => ({ default: readFileSync("node_modules/@resvg/resvg-wasm/index_bg.wasm") }));
import { CARD_H, CARD_W, cardPng, cardSvg, titleLayout, wrap } from "../src/worker/og/card";

const day = (i: number, uptime: number | null) => ({ day: `d${i}`, uptime, incidents: 0 });
export const samplePage = (title: string, overall: PublicPage["overall"] = "operational"): PublicPage => ({
	page: { slug: "main", title, description: null, logo_url: null, footer_text: null, show_uptime_bars: true, show_latency: true, show_tags: false, accent_color: null, custom_css: null },
	overall,
	groups: [{ name: "Web", items: [{ kind: "monitor", id: "a", name: "A", status: "up", url: null, type: "http", uptime_90d: 99.9, bars: Array.from({ length: 90 }, (_, i) => day(i, i < 20 ? null : i === 70 ? 97 : i === 80 ? 99.5 : 100)) }] }],
	announcements: [],
	maintenances: [],
	incidents: [],
	generated_at: 0,
});

describe("link preview card", () => {
	it("wraps titles: one big line when short, two smaller lines, ellipsis when too long", () => {
		expect(titleLayout("Acme Status", 1040)).toEqual({ size: 96, lines: ["Acme Status"] });
		const two = titleLayout("Acme Corporation Infrastructure and Public Services", 1040);
		expect(two.lines).toHaveLength(2);
		expect(two.size).toBeLessThanOrEqual(80);
		const long = titleLayout("word ".repeat(80), 1040);
		expect(long.lines).toHaveLength(2);
		expect(long.lines[1].endsWith("…")).toBe(true);
		expect(wrap("Supercalifragilisticexpialidocious".repeat(4), 40, 300).length).toBeGreaterThan(1);
	});

	it("escapes text and shows the overall state", () => {
		const svg = cardSvg({ page: samplePage(`<b>"Tom & Jerry"</b>`, "major"), host: "status.example.com" });
		expect(svg).toContain("&lt;b&gt;&quot;Tom &amp; Jerry&quot;&lt;/b&gt;");
		expect(svg).toContain("Major outage");
		expect(svg).not.toContain("<b>");
	});

	it("renders a 1200x630 PNG", async () => {
		const png = await cardPng({ page: samplePage("Acme Status"), host: "status.example.com" });
		expect([...png.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
		const dv = new DataView(png.buffer, png.byteOffset);
		expect([dv.getUint32(16), dv.getUint32(20)]).toEqual([CARD_W, CARD_H]);
		if (process.env.OG_OUT) writeFileSync(process.env.OG_OUT, png);
	});
});

describe("link preview meta", async () => {
	const { metaTags, pageDescription } = await import("../src/worker/routes/public");
	it("falls back to a generated description and strips markdown", () => {
		const p = samplePage("Acme");
		expect(pageDescription(p.page)).toBe("Live status and uptime for Acme");
		expect(pageDescription({ ...p.page, description: "**Live** status for [Acme](https://acme.test)" })).toBe("Live status for Acme");
	});
	it("emits og and twitter tags with escaped values", () => {
		const html = metaTags(samplePage(`A "quoted" <title>`), "https://status.test/", "https://status.test/og.png?s=operational");
		for (const t of ['property="og:title" content="A &quot;quoted&quot; &lt;title&gt;"', 'property="og:url" content="https://status.test/"', 'name="twitter:card" content="summary_large_image"', 'property="og:image" content="https://status.test/og.png?s=operational"', 'property="og:image:width" content="1200"', 'name="twitter:image"', 'property="og:site_name"'])
			expect(html).toContain(t);
	});
});
