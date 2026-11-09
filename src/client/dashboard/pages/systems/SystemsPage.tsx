import type { SystemKind, SystemRecord } from "@shared/types";
import { ArrowDown, ArrowUp, ArrowUpDown, Cpu, HardDrive, LayoutGrid, MemoryStick, Package, Palette, Plus, Search, Server, ShieldAlert, Table2, TerminalSquare, Thermometer, Wifi } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { StatusDot, TagChip } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ColumnsMenu, useHiddenColumns } from "@/components/ui/columns-menu";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Meter } from "@/components/ui/meter";
import { PageHeader, Table, Td, Th, Tr } from "@/components/ui/page";
import { CardsSkeleton, TableSkeleton } from "@/components/ui/skeleton";
import { Segmented } from "@/components/ui/tabs";
import { Tooltip } from "@/components/ui/tooltip";
import { formatDuration, formatNumber, formatRate, timeAgo } from "@/lib/format";
import { useApi, useDocumentTitle, useLocalStorage } from "@/lib/hooks";
import { STATUS_LABEL } from "@/lib/status";
import { cn } from "@/lib/utils";
import { AddSystemDialog } from "./AddSystemDialog";
import { useCanEdit } from "@/dashboard/role";

type SortKey = "name" | "cpu" | "mem" | "disk" | "gpu" | "net" | "load" | "temp" | "services" | "updates" | "agent" | "uptime";

const SORTERS: Record<SortKey, (s: SystemRecord) => number | string> = {
	name: (s) => s.name.toLowerCase(),
	cpu: (s) => s.info?.cpu ?? -1,
	mem: (s) => s.info?.mp ?? -1,
	disk: (s) => s.info?.dp ?? -1,
	gpu: (s) => s.info?.g ?? -1,
	net: (s) => s.info?.bb ?? -1,
	load: (s) => s.info?.la?.[0] ?? -1,
	temp: (s) => s.info?.dt ?? -1,
	// Like Beszel: failed services first, then by count.
	services: (s) => (s.info?.sv ? ((s.info.sv[1] ?? 0) > 0 ? 1e6 : 0) + s.info.sv[0] : -1),
	// Like Beszel: security > regular > up to date > not reported, then by count.
	updates: (s) => (s.info?.pu ? ((s.info.pu[1] ?? 0) > 0 ? 2e6 : s.info.pu[0] > 0 ? 1e6 : 0) + s.info.pu[0] : -1),
	agent: (s) => s.agent_version ?? "",
	uptime: (s) => s.info?.u ?? -1,
};

const isLive = (s: SystemRecord) => s.status === "up";

/** Row tint and swatch per system type, used when "Shade by type" is on. */
const KIND: Record<SystemKind, { label: string; row: string; stripe: string; card: string; swatch: string }> = {
	physical: { label: "Physical", row: "bg-amber-500/10 hover:bg-amber-500/15", stripe: "shadow-[inset_3px_0_0_var(--color-amber-500)]", card: "bg-amber-500/10 border-amber-500/30", swatch: "bg-amber-500" },
	vm: { label: "VM", row: "bg-sky-500/10 hover:bg-sky-500/15", stripe: "shadow-[inset_3px_0_0_var(--color-sky-500)]", card: "bg-sky-500/10 border-sky-500/30", swatch: "bg-sky-500" },
	lxc: { label: "LXC", row: "bg-violet-500/10 hover:bg-violet-500/15", stripe: "shadow-[inset_3px_0_0_var(--color-violet-500)]", card: "bg-violet-500/10 border-violet-500/30", swatch: "bg-violet-500" },
};
const KINDS = Object.keys(KIND) as SystemKind[];
type KindFilter = "all" | SystemKind;

type ColumnId = Exclude<SortKey, "name">;
interface Column {
	id: ColumnId;
	label: string;
	header: React.ReactNode;
	cell: (s: SystemRecord, live: boolean) => React.ReactNode;
	/** Dim the cell when the system is not up. */
	dim?: boolean;
	className?: string;
}

const muted = "whitespace-nowrap text-xs text-muted-foreground";
const dash = <span className="text-muted-foreground">—</span>;

const COLUMNS: Column[] = [
	{ id: "cpu", label: "CPU", header: <><Cpu className="size-3.5" /> CPU</>, cell: (s) => <Meter value={s.info?.cpu} />, dim: true },
	{ id: "mem", label: "Memory", header: <><MemoryStick className="size-3.5" /> Memory</>, cell: (s) => <Meter value={s.info?.mp} />, dim: true },
	{ id: "disk", label: "Disk", header: <><HardDrive className="size-3.5" /> Disk</>, cell: (s) => <Meter value={s.info?.dp} />, dim: true },
	{ id: "gpu", label: "GPU", header: "GPU", cell: (s) => <Meter value={s.info?.g} />, dim: true },
	{ id: "net", label: "Net", header: <><Wifi className="size-3.5" /> Net</>, cell: (s) => formatRate(s.info?.bb), dim: true, className: "whitespace-nowrap tabular-nums" },
	{
		id: "load",
		label: "Load avg",
		header: "Load avg",
		cell: (s) => (s.info?.la ? s.info.la.map((x) => formatNumber(x)).join(" ") : "–"),
		dim: true,
		className: "whitespace-nowrap tabular-nums",
	},
	{ id: "temp", label: "Temp", header: <><Thermometer className="size-3.5" /> Temp</>, cell: (s) => (s.info?.dt != null ? `${s.info.dt.toFixed(0)} °C` : "–"), dim: true, className: "whitespace-nowrap tabular-nums" },
	{ id: "services", label: "Services", header: <><TerminalSquare className="size-3.5" /> Services</>, cell: (s, live) => <ServicesCell system={s} live={live} /> },
	{ id: "updates", label: "Updates", header: <><Package className="size-3.5" /> Updates</>, cell: (s, live) => <UpdatesCell system={s} live={live} /> },
	{ id: "agent", label: "Agent", header: "Agent", cell: (s) => s.agent_version ?? s.info?.v ?? "–", className: muted },
	{ id: "uptime", label: "Uptime", header: "Uptime", cell: (s, live) => (live ? formatDuration(s.info?.u) : STATUS_LABEL[s.status]), className: muted },
];

const dot = (color: string) => <span className={cn("block size-2 shrink-0 rounded-full", color)} />;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Services column, like Beszel's: amber dot when any unit failed, plus the failed count. */
function ServicesCell({ system: s, live }: { system: SystemRecord; live: boolean }) {
	const sv = s.info?.sv;
	if (!sv?.length) return dash;
	const [total, failed = 0] = sv;
	return (
		<span className={cn("flex items-center gap-1.5 whitespace-nowrap tabular-nums", !live && "opacity-40")}>
			{dot(!live ? "bg-muted-foreground" : failed > 0 ? "bg-amber-500" : "bg-emerald-500")}
			{plural(total, "service")}
			{failed > 0 && <span className="font-medium text-red-600 dark:text-red-400">· {failed} failed</span>}
		</span>
	);
}

/** Updates column, like Beszel's: red dot for security updates, amber for others, green when up to date. */
function UpdatesCell({ system: s, live }: { system: SystemRecord; live: boolean }) {
	const pu = s.info?.pu;
	if (!pu?.length) return dash;
	const [total, security] = pu;
	const sec = security ?? 0;
	return (
		<span className={cn("flex items-center gap-1.5 whitespace-nowrap tabular-nums", !live && "opacity-40")}>
			{dot(!live ? "bg-muted-foreground" : sec > 0 ? "bg-red-500" : total > 0 ? "bg-amber-500" : "bg-emerald-500")}
			{total === 0 ? "Up to date" : plural(total, "update")}
			{sec > 0 && (
				<span className="inline-flex items-center gap-1 font-medium text-red-600 dark:text-red-400">
					<ShieldAlert className="size-3.5" /> {sec} security
				</span>
			)}
		</span>
	);
}

export function SystemsPage() {
	useDocumentTitle("Systems · Richter");
	const canEdit = useCanEdit();
	const { data, error, loading, reload } = useApi<SystemRecord[]>("/api/admin/systems", { refreshMs: 15_000 });
	const [, navigate] = useLocation();
	const [query, setQuery] = useState("");
	const [tags, setTags] = useState<string[]>([]);
	const [view, setView] = useLocalStorage<"table" | "grid">("richter-systems-view", "table");
	const [kind, setKind] = useLocalStorage<KindFilter>("richter-systems-kind", "all");
	const [shade, setShade] = useLocalStorage<boolean>("richter-systems-shade", false);
	const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "name", dir: 1 });
	const [adding, setAdding] = useState(false);
	const cols = useHiddenColumns("richter-systems-hidden-columns");

	const allTags = useMemo(() => [...new Set((data ?? []).flatMap((s) => s.tags))].sort(), [data]);
	const hasGpu = useMemo(() => (data ?? []).some((s) => s.info?.g != null), [data]);
	const available = COLUMNS.filter((c) => c.id !== "gpu" || hasGpu);
	const visible = available.filter((c) => cols.isVisible(c.id));

	const rows = useMemo(() => {
		const q = query.trim().toLowerCase();
		const list = (data ?? []).filter(
			(s) =>
				(!q || s.name.toLowerCase().includes(q) || s.info?.h?.toLowerCase().includes(q) || s.tags.some((t) => t.toLowerCase().includes(q))) &&
				tags.every((t) => s.tags.includes(t)) &&
				(kind === "all" || s.kind === kind),
		);
		const f = SORTERS[sort.key];
		return list.sort((a, b) => {
			const x = f(a);
			const y = f(b);
			return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
		});
	}, [data, query, tags, kind, sort]);

	const kindCounts = useMemo(() => {
		const c: Record<SystemKind, number> = { physical: 0, vm: 0, lxc: 0 };
		for (const s of data ?? []) if (s.kind) c[s.kind]++;
		return c;
	}, [data]);

	const counts = useMemo(() => {
		const c = { up: 0, down: 0, other: 0 };
		for (const s of data ?? []) c[s.status === "up" ? "up" : s.status === "down" ? "down" : "other"]++;
		return c;
	}, [data]);

	const header = (key: SortKey, label: React.ReactNode, className?: string) => (
		<Th key={key} className={className}>
			<button
				type="button"
				className="inline-flex items-center gap-1 hover:text-foreground"
				onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === "name" ? 1 : -1 }))}
			>
				{label}
				{sort.key === key ? sort.dir === 1 ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : <ArrowUpDown className="size-3 opacity-40" />}
			</button>
		</Th>
	);

	return (
		<>
			<PageHeader
				title="Systems"
				description={
					data && data.length > 0 ? (
						<span className="flex flex-wrap gap-x-3">
							<span>{data.length} total</span>
							<span className="text-emerald-600 dark:text-emerald-400">{counts.up} up</span>
							{counts.down > 0 && <span className="text-red-600 dark:text-red-400">{counts.down} down</span>}
							{counts.other > 0 && <span>{counts.other} paused/pending</span>}
						</span>
					) : (
						"Servers reporting through the Beszel agent."
					)
				}
				actions={
					canEdit && (
						<Button onClick={() => setAdding(true)}>
							<Plus /> Add system
						</Button>
					)
				}
			/>

			{error && !data && <ErrorState error={error} onRetry={reload} />}

			{(loading || (data && data.length > 0)) && (
				<div className="mb-4 flex flex-wrap items-center gap-2">
					<div className="relative w-full sm:w-64">
						<Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter systems…" className="pl-8" />
					</div>
					<Segmented
						value={kind}
						onChange={setKind}
						options={[
							{ value: "all", label: "All", title: "All system types" },
							...KINDS.map((k) => ({
								value: k,
								label: (
									<>
										{shade && <span className={cn("size-2 rounded-full", KIND[k].swatch)} />}
										{KIND[k].label}
										<span className="tabular-nums opacity-60">{kindCounts[k]}</span>
									</>
								),
								title: `${KIND[k].label} systems only`,
							})),
						]}
					/>
					<div className="flex flex-wrap gap-1.5">
						{allTags.map((t) => (
							<TagChip key={t} tag={t} active={tags.includes(t)} onClick={() => setTags((xs) => (xs.includes(t) ? xs.filter((x) => x !== t) : [...xs, t]))} />
						))}
					</div>
					<div className="ml-auto flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							aria-pressed={shade}
							title="Tint each row by system type: physical, VM or LXC"
							className={cn(shade && "border-primary/50 bg-primary/10 text-primary")}
							onClick={() => setShade(!shade)}
						>
							<Palette className="size-3.5" /> Shade by type
						</Button>
						{view === "table" && (
							<ColumnsMenu
								columns={available.map((c) => ({ id: c.id, label: c.label }))}
								isVisible={cols.isVisible}
								toggle={cols.toggle}
								reset={cols.reset}
							/>
						)}
						<Segmented
							value={view}
							onChange={setView}
							options={[
								{ value: "table", label: <Table2 />, title: "Table" },
								{ value: "grid", label: <LayoutGrid />, title: "Grid" },
							]}
						/>
					</div>
				</div>
			)}

			{loading && !data ? (
				view === "table" ? (
					<Card>
						<TableSkeleton rows={4} cols={8} />
					</Card>
				) : (
					<CardsSkeleton count={4} className="xl:grid-cols-4" />
				)
			) : data && data.length === 0 ? (
				<Card>
					<EmptyState
						icon={Server}
						title="No systems yet"
						action={
							canEdit && (
								<Button onClick={() => setAdding(true)}>
									<Plus /> Add your first system
								</Button>
							)
						}
					>
						Install the unmodified <code className="font-mono">henrygd/beszel-agent</code> on a server and it will stream CPU, memory, disk, network, temperature, GPU and Docker metrics here.
					</EmptyState>
				</Card>
			) : data && rows.length === 0 ? (
				<Card>
					<EmptyState icon={Search} title="No matching systems">
						Nothing matches the current search, type or tag filter.
					</EmptyState>
				</Card>
			) : data && view === "table" ? (
				<Card className="overflow-hidden">
					<Table>
						<thead className="border-b bg-muted/30">
							<tr>
								{header("name", "System", "pl-4")}
								{visible.map((c, i) => header(c.id, c.header, i === visible.length - 1 ? "pr-4" : undefined))}
							</tr>
						</thead>
						<tbody>
							{rows.map((s) => {
								const live = isLive(s);
								return (
									<Tr key={s.id} className={cn("cursor-pointer", shade && s.kind && KIND[s.kind].row)} onClick={() => navigate(`/systems/${s.id}`)}>
										<Td className={cn("pl-4", shade && s.kind && KIND[s.kind].stripe)}>
											<div className="flex items-center gap-2.5">
												<Tooltip content={`${STATUS_LABEL[s.status]} · last seen ${timeAgo(s.last_seen)}`}>
													<span>
														<StatusDot status={s.status} />
													</span>
												</Tooltip>
												<Link href={`/systems/${s.id}`} className="whitespace-nowrap font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
													{s.name}
												</Link>
												<span className="hidden gap-1 2xl:flex">
													{s.tags.map((t) => (
														<TagChip key={t} tag={t} />
													))}
												</span>
											</div>
										</Td>
										{visible.map((c, i) => (
											<Td key={c.id} className={cn(c.className, c.dim && !live && "opacity-40", i === visible.length - 1 && "pr-4")}>
												{c.cell(s, live)}
											</Td>
										))}
									</Tr>
								);
							})}
						</tbody>
					</Table>
				</Card>
			) : data ? (
				<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
					{rows.map((s) => (
						<SystemCard key={s.id} system={s} shade={shade} />
					))}
				</div>
			) : null}

			<AddSystemDialog open={adding && canEdit} onOpenChange={setAdding} onAdded={reload} />
		</>
	);
}

function SystemCard({ system: s, shade }: { system: SystemRecord; shade: boolean }) {
	const live = isLive(s);
	const row = (label: string, value: React.ReactNode) => (
		<div className="flex items-center justify-between gap-3 text-sm">
			<span className="w-16 shrink-0 text-xs text-muted-foreground">{label}</span>
			<div className="flex-1">{value}</div>
		</div>
	);
	return (
		<Link href={`/systems/${s.id}`}>
			<Card className={cn("h-full p-4 transition-colors hover:border-primary/40", shade && s.kind && KIND[s.kind].card)}>
				<div className="mb-3 flex items-center gap-2.5">
					<StatusDot status={s.status} pulse={s.status === "down"} />
					<span className="truncate font-semibold">{s.name}</span>
					{s.kind && <span className="rounded border px-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{KIND[s.kind].label}</span>}
					<span className="ml-auto text-xs text-muted-foreground">{live ? formatDuration(s.info?.u) : STATUS_LABEL[s.status]}</span>
				</div>
				<div className={cn("space-y-2", !live && "opacity-40")}>
					{row("CPU", <Meter value={s.info?.cpu} />)}
					{row("Memory", <Meter value={s.info?.mp} />)}
					{row("Disk", <Meter value={s.info?.dp} />)}
					{s.info?.g != null && row("GPU", <Meter value={s.info.g} />)}
				</div>
				<div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
					<span>Net {formatRate(s.info?.bb)}</span>
					<span>Load {s.info?.la ? formatNumber(s.info.la[0]) : "–"}</span>
					{s.info?.dt != null && <span>{s.info.dt.toFixed(0)} °C</span>}
					<span className="ml-auto">v{s.agent_version ?? "?"}</span>
				</div>
				{s.tags.length > 0 && (
					<div className="mt-2 flex flex-wrap gap-1">
						{s.tags.map((t) => (
							<TagChip key={t} tag={t} />
						))}
					</div>
				)}
			</Card>
		</Link>
	);
}
