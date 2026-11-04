import { cn } from "@/lib/utils";
import { meterColor } from "@/lib/status";

/** Beszel-style usage meter: percentage label + thin colored bar. */
export function Meter({ value, className, label }: { value: number | null | undefined; className?: string; label?: string }) {
	if (value == null || !Number.isFinite(value)) return <span className="text-muted-foreground">–</span>;
	const pct = Math.max(0, Math.min(100, value));
	return (
		<div className={cn("flex min-w-24 items-center gap-2", className)}>
			<span className="w-11 shrink-0 text-right text-xs tabular-nums">{label ?? `${value.toFixed(1)}%`}</span>
			<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
				<div className={cn("h-full rounded-full transition-[width] duration-500", meterColor(pct))} style={{ width: `${pct}%` }} />
			</div>
		</div>
	);
}
