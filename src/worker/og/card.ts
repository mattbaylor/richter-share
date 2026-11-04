import { initWasm, Resvg } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import type { PublicPage } from "../../shared/types";
import { INTER_BOLD, INTER_MEDIUM, WIDTHS } from "./fonts";

export const CARD_W = 1200;
export const CARD_H = 630;

export const OVERALL_TEXT: Record<PublicPage["overall"], { label: string; color: string }> = {
	operational: { label: "All systems operational", color: "#22c55e" },
	degraded: { label: "Degraded performance", color: "#f59e0b" },
	partial: { label: "Partial outage", color: "#f59e0b" },
	major: { label: "Major outage", color: "#ef4444" },
	maintenance: { label: "Under maintenance", color: "#0ea5e9" },
};

const esc = (s: string) => s.replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[ch]!);

/** Text width in px with Inter's advance widths (unknown glyphs ≈ 0.6 em). */
export function textWidth(s: string, size: number, weight: "bold" | "medium" = "bold"): number {
	const w = WIDTHS[weight];
	let em = 0;
	for (const ch of s) em += w[String(ch.codePointAt(0))] ?? 0.6;
	return em * size;
}

/** Greedy word wrap into at most `max` lines of `width` px; the last line gets an ellipsis if cut. */
export function wrap(s: string, size: number, width: number, max = Infinity, weight: "bold" | "medium" = "bold"): string[] {
	const fits = (t: string) => textWidth(t, size, weight) <= width;
	const lines: string[] = [];
	let cur = "";
	for (const word of s.trim().split(/\s+/).filter(Boolean)) {
		const cand = cur ? `${cur} ${word}` : word;
		if (fits(cand)) {
			cur = cand;
			continue;
		}
		if (cur) lines.push(cur);
		cur = word;
		while (!fits(cur)) {
			let k = cur.length - 1;
			while (k > 1 && !fits(cur.slice(0, k))) k--;
			lines.push(cur.slice(0, k));
			cur = cur.slice(k);
		}
	}
	if (cur) lines.push(cur);
	if (lines.length <= max) return lines;
	let last = lines[max - 1];
	while (last.length > 1 && !fits(`${last}…`)) last = last.slice(0, -1);
	return [...lines.slice(0, max - 1), `${last.trimEnd()}…`];
}

/** Title font size and lines: one line as large as 96 px if it fits at ≥ 72 px, else two lines at ≤ 80 px. */
export function titleLayout(title: string, width: number): { size: number; lines: string[] } {
	for (let size = 96; size >= 72; size -= 8) if (wrap(title, size, width).length === 1) return { size, lines: [title.trim()] };
	for (let size = 80; size > 56; size -= 8) if (wrap(title, size, width).length <= 2) return { size, lines: wrap(title, size, width) };
	return { size: 56, lines: wrap(title, 56, width, 2) };
}

/** Worst uptime per day across all items, for the decorative bar strip (oldest first). */
export function dayStrip(p: PublicPage, n: number): (number | null)[] {
	const items = p.groups.flatMap((g) => g.items);
	const len = Math.max(0, ...items.map((i) => i.bars.length));
	const out: (number | null)[] = [];
	for (let d = Math.max(0, len - n); d < len; d++) {
		let worst: number | null = null;
		for (const it of items) {
			const u = it.bars[d - (len - it.bars.length)]?.uptime;
			if (u != null) worst = worst == null ? u : Math.min(worst, u);
		}
		out.push(worst);
	}
	return out;
}
const barColor = (u: number | null) => (u == null ? "#3f3f46" : u >= 99.9 ? "#22c55e" : u >= 99 ? "#84cc16" : u >= 95 ? "#f59e0b" : "#ef4444");

const RICHTER_MARK = `<rect width="64" height="64" rx="14" fill="#7c3aed"/><path d="M7 34h9l4-7 5 19 6.5-32 6 27 4-11 3.5 4H57" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`;

export interface CardInput {
	page: PublicPage;
	host: string;
	/** data: URI of the page's logo, if it could be fetched. */
	logo?: string | null;
}

export function cardSvg({ page: p, host, logo }: CardInput): string {
	const accent = /^#[0-9a-f]{6}$/i.test(p.page.accent_color ?? "") ? p.page.accent_color! : "#7c3aed";
	const o = OVERALL_TEXT[p.overall] ?? OVERALL_TEXT.operational;
	const X = 80;
	const W = CARD_W - 2 * X;
	const { size, lines } = titleLayout(p.page.title || "Status", W);
	const lh = Math.round(size * 1.1);
	const titleTop = 250 - (lines.length - 1) * lh * 0.5;
	const title = lines.map((l, i) => `<text x="${X}" y="${Math.round(titleTop + i * lh)}" font-size="${size}" font-weight="700" fill="#fafafa" letter-spacing="-${(size * 0.02).toFixed(1)}">${esc(l)}</text>`).join("");
	const pill = textWidth(o.label, 30, "medium") + 82;
	const strip = dayStrip(p, 90);
	const bw = 8;
	const gap = (W - strip.length * bw) / Math.max(1, strip.length - 1);
	const bars = strip.map((u, i) => `<rect x="${(X + i * (bw + gap)).toFixed(1)}" y="500" width="${bw}" height="44" rx="3" fill="${barColor(u)}" opacity="${u == null ? 0.5 : 0.9}"/>`).join("");
	const icon = logo
		? `<image href="${logo}" x="${X}" y="72" width="64" height="64" preserveAspectRatio="xMidYMid meet"/>`
		: `<g transform="translate(${X} 72)">${RICHTER_MARK}</g>`;
	return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${CARD_W}" height="${CARD_H}" viewBox="0 0 ${CARD_W} ${CARD_H}" font-family="Inter">
<defs>
<radialGradient id="glow" cx="0.85" cy="0" r="0.9"><stop offset="0" stop-color="${accent}" stop-opacity="0.35"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
<radialGradient id="glow2" cx="0" cy="1" r="0.7"><stop offset="0" stop-color="${o.color}" stop-opacity="0.12"/><stop offset="1" stop-color="${o.color}" stop-opacity="0"/></radialGradient>
</defs>
<rect width="100%" height="100%" fill="#09090b"/>
<rect width="100%" height="100%" fill="url(#glow)"/>
<rect width="100%" height="100%" fill="url(#glow2)"/>
<rect x="0" y="0" width="${CARD_W}" height="6" fill="${accent}"/>
${icon}
<text x="${X + 88}" y="114" font-size="26" font-weight="500" fill="#a1a1aa" letter-spacing="6">STATUS</text>
${title}
<g transform="translate(${X} ${Math.round(titleTop + (lines.length - 1) * lh + 52)})">
<rect width="${pill.toFixed(0)}" height="56" rx="28" fill="${o.color}" fill-opacity="0.14" stroke="${o.color}" stroke-opacity="0.45" stroke-width="2"/>
<circle cx="32" cy="28" r="9" fill="${o.color}"/>
<text x="54" y="38.5" font-size="30" font-weight="500" fill="${o.color}">${esc(o.label)}</text>
</g>
${bars}
<text x="${X}" y="586" font-size="22" font-weight="500" fill="#71717a">90 days ago</text>
<text x="${CARD_W - X}" y="586" font-size="22" font-weight="500" fill="#71717a" text-anchor="end">${esc(host)}</text>
</svg>`;
}

let ready: Promise<void> | null = null;
let fonts: Uint8Array[] | null = null;
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function cardPng(input: CardInput): Promise<Uint8Array> {
	ready ??= initWasm(resvgWasm);
	await ready;
	fonts ??= [b64(INTER_BOLD), b64(INTER_MEDIUM)];
	const r = new Resvg(cardSvg(input), { fitTo: { mode: "original" }, font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: "Inter" } });
	const png = r.render().asPng();
	r.free();
	return png;
}
