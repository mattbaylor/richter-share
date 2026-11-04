import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Tiny inline SVG sparkline (no axes), used on public pages and lists.
 *  Pass `times` + `format` to make it interactive: hover (mouse) or tap / press-and-drag (touch)
 *  shows a guide line, a dot on the nearest point and a "2:40 PM · 108 ms" tooltip in local time. */
export function Sparkline({
	values,
	className,
	color = "currentColor",
	floor,
	times,
	format,
	label,
	title,
	svgClassName,
}: {
	values: number[];
	className?: string;
	color?: string;
	floor?: number;
	times?: number[]; // epoch ms per value
	format?: (v: number) => string;
	label?: string; // aria-label
	title?: string; // native tooltip fallback
	svgClassName?: string; // size override (default h-6 w-24)
}) {
	const [idx, setIdx] = useState<number | null>(null);
	const ref = useRef<HTMLSpanElement>(null);
	const drag = useRef<{ id: number; moved: boolean; x: number } | null>(null);
	const [pinned, setPinned] = useState(false);
	const interactive = !!(times && format && times.length === values.length);

	// A tap pins the value; tapping anywhere else dismisses it.
	useEffect(() => {
		if (!pinned) return;
		const off = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) {
				setPinned(false);
				setIdx(null);
			}
		};
		document.addEventListener("pointerdown", off);
		return () => document.removeEventListener("pointerdown", off);
	}, [pinned]);

	if (values.length < 2) return null;
	const max = Math.max(...values);
	const min = floor ?? Math.min(...values);
	const span = max - min || 1;
	const n = values.length;
	const xp = (i: number) => (i / (n - 1)) * 100;
	const yv = (v: number) => 28 - ((v - min) / span) * 24; // viewBox units (0..30)
	const pts = values.map((v, i) => `${xp(i)},${yv(v)}`).join(" ");

	const svg = (
		<svg viewBox="0 0 100 30" preserveAspectRatio="none" className={cn("h-6 w-24", svgClassName, !interactive && className)} aria-hidden="true">
			<polyline points={`0,30 ${pts} 100,30`} fill={color} fillOpacity={0.12} stroke="none" />
			<polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
		</svg>
	);
	if (!interactive) return svg;

	const pick = (clientX: number) => {
		const r = ref.current?.getBoundingClientRect();
		if (!r || r.width === 0) return;
		const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
		setIdx(Math.round(f * (n - 1)));
	};
	const x = idx == null ? 0 : xp(idx);
	const when = idx == null ? "" : new Date(times![idx]).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	const tipPos = x < 22 ? "left-0" : x > 78 ? "right-0" : "-translate-x-1/2";

	return (
		<span
			ref={ref}
			role="img"
			aria-label={label}
			title={idx == null ? title : undefined}
			className={cn("relative inline-flex cursor-crosshair select-none touch-pan-y", className)}
			onPointerMove={(e) => {
				if (e.pointerType === "mouse") return pick(e.clientX);
				const d = drag.current;
				if (d && d.id === e.pointerId) {
					if (Math.abs(e.clientX - d.x) > 4) d.moved = true;
					pick(e.clientX);
				}
			}}
			onPointerLeave={(e) => {
				if (e.pointerType === "mouse") setIdx(null);
			}}
			onPointerDown={(e) => {
				if (e.pointerType === "mouse") return;
				drag.current = { id: e.pointerId, moved: false, x: e.clientX };
				setPinned(false);
				pick(e.clientX);
			}}
			onPointerUp={(e) => {
				if (e.pointerType === "mouse") return;
				const d = drag.current;
				drag.current = null;
				if (d?.moved) setIdx(null); // scrub ends on release
				else setPinned(true); // quick tap: keep it until a tap elsewhere
			}}
			onPointerCancel={() => {
				// The browser took over (vertical page scroll), so get out of the way.
				drag.current = null;
				setPinned(false);
				setIdx(null);
			}}
		>
			{svg}
			{idx != null && (
				<>
					<span className="pointer-events-none absolute inset-y-0 w-px bg-current opacity-40" style={{ left: `${x}%` }} />
					<span
						className="pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ring-2 ring-background"
						style={{ left: `${x}%`, top: `${(yv(values[idx]) / 30) * 100}%` }}
					/>
					<span className={cn("pointer-events-none absolute bottom-full z-20 mb-1.5", tipPos)} style={x < 22 || x > 78 ? undefined : { left: `${x}%` }}>
						<span className="block whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-[11px] font-medium tabular-nums text-popover-foreground shadow-md">
							{when} · {format!(values[idx])}
						</span>
					</span>
				</>
			)}
		</span>
	);
}
