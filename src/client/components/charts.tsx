import { useId, useState } from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export type Row = { t: number } & Record<string, number | null | undefined>;
export interface Series {
	key: string;
	name: string;
	color: string;
}

export function ChartCard({
	title,
	description,
	actions,
	className,
	children,
}: {
	title: React.ReactNode;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	className?: string;
	children: React.ReactNode;
}) {
	return (
		<Card className={cn("flex min-w-0 flex-col p-4", className)}>
			<div className="mb-3 flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="text-sm font-semibold">{title}</h3>
					{description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
				</div>
				{actions}
			</div>
			{children}
		</Card>
	);
}

interface TooltipItem {
	dataKey?: unknown;
	name?: unknown;
	value?: unknown;
	color?: string;
}

function ChartTooltip({
	active,
	payload,
	label,
	format,
	sortDesc,
}: {
	active?: boolean;
	payload?: readonly TooltipItem[];
	label?: unknown;
	format: (v: number) => string;
	sortDesc?: boolean;
}) {
	if (!active || !payload?.length) return null;
	const items = payload.filter((p) => typeof p.value === "number");
	if (sortDesc) items.sort((a, b) => (b.value as number) - (a.value as number));
	return (
		<div className="min-w-40 rounded-md border bg-popover/95 px-3 py-2 text-xs text-popover-foreground shadow-xl backdrop-blur">
			<p className="mb-1.5 font-medium text-muted-foreground">{typeof label === "number" ? formatDateTime(label) : String(label ?? "")}</p>
			<div className="space-y-1">
				{items.slice(0, 14).map((p) => (
					<div key={String(p.dataKey)} className="flex items-center gap-2">
						<span className="size-2 shrink-0 rounded-[2px]" style={{ background: p.color }} />
						<span className="flex-1 truncate">{String(p.name)}</span>
						<span className="ml-3 font-medium tabular-nums">{format(p.value as number)}</span>
					</div>
				))}
				{items.length > 14 && <p className="text-muted-foreground">+{items.length - 14} more</p>}
			</div>
		</div>
	);
}

/** Clickable legend: toggles series visibility. */
function Legend({ series, hidden, onToggle }: { series: Series[]; hidden: Set<string>; onToggle: (k: string) => void }) {
	return (
		<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
			{series.map((s) => (
				<button
					key={s.key}
					type="button"
					onClick={() => onToggle(s.key)}
					className={cn("flex items-center gap-1.5 text-xs transition-opacity", hidden.has(s.key) ? "opacity-35" : "opacity-100 hover:opacity-80")}
				>
					<span className="size-2 rounded-[2px]" style={{ background: s.color }} />
					{s.name}
				</button>
			))}
		</div>
	);
}

export interface TimeChartProps {
	data: Row[];
	series: Series[];
	format: (v: number) => string;
	xFormat: (t: number) => string;
	stacked?: boolean;
	lines?: boolean;
	legend?: boolean;
	domain?: [number | "auto" | "dataMin" | "dataMax", number | "auto" | "dataMin" | "dataMax"];
	syncId?: string;
	height?: number;
	yWidth?: number;
}

/** Time-series chart: gradient areas (or lines), synced tooltip, optional toggle legend. */
export function TimeChart({
	data,
	series,
	format,
	xFormat,
	stacked,
	lines,
	legend,
	domain = [0, "auto"],
	syncId,
	height = 190,
	yWidth = 70,
}: TimeChartProps) {
	const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
	const [hidden, setHidden] = useState<Set<string>>(new Set());
	const visible = series.filter((s) => !hidden.has(s.key));
	const toggle = (k: string) =>
		setHidden((h) => {
			const n = new Set(h);
			if (n.has(k)) n.delete(k);
			else n.add(k);
			return n;
		});

	const axes = (
		<>
			<CartesianGrid vertical={false} stroke="var(--chart-grid)" strokeDasharray="3 3" />
			<XAxis
				dataKey="t"
				type="number"
				scale="time"
				domain={["dataMin", "dataMax"]}
				tickFormatter={xFormat}
				minTickGap={48}
				tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
				tickLine={false}
				axisLine={false}
			/>
			<YAxis
				width={yWidth}
				domain={domain}
				tickFormatter={(v: number) => format(v)}
				tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
				tickLine={false}
				axisLine={false}
				tickCount={5}
				allowDataOverflow={false}
			/>
			<Tooltip
				content={(p) => <ChartTooltip active={p.active} payload={p.payload as readonly TooltipItem[]} label={p.label} format={format} sortDesc={stacked && series.length > 3} />}
				cursor={{ stroke: "var(--muted-foreground)", strokeOpacity: 0.4 }}
				isAnimationActive={false}
			/>
		</>
	);

	return (
		<div>
			<div style={{ height }}>
				<ResponsiveContainer width="100%" height="100%">
					{lines ? (
						<LineChart data={data} syncId={syncId} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
							{axes}
							{visible.map((s) => (
								<Line key={s.key} dataKey={s.key} name={s.name} stroke={s.color} type="monotone" dot={false} strokeWidth={1.5} isAnimationActive={false} connectNulls />
							))}
						</LineChart>
					) : (
						<AreaChart data={data} syncId={syncId} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
							<defs>
								{series.map((s, i) => (
									<linearGradient key={s.key} id={`${uid}-${i}`} x1="0" y1="0" x2="0" y2="1">
										<stop offset="5%" stopColor={s.color} stopOpacity={stacked ? 0.5 : 0.4} />
										<stop offset="95%" stopColor={s.color} stopOpacity={stacked ? 0.15 : 0.02} />
									</linearGradient>
								))}
							</defs>
							{axes}
							{series.map((s, i) =>
								hidden.has(s.key) ? null : (
									<Area
										key={s.key}
										dataKey={s.key}
										name={s.name}
										type="monotone"
										stroke={s.color}
										strokeWidth={1.5}
										fill={`url(#${uid}-${i})`}
										stackId={stacked ? "a" : undefined}
										isAnimationActive={false}
										connectNulls
									/>
								),
							)}
						</AreaChart>
					)}
				</ResponsiveContainer>
			</div>
			{legend && series.length > 1 && <Legend series={series} hidden={hidden} onToggle={toggle} />}
		</div>
	);
}
