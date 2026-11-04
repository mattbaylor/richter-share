import type { MonitorListItem, MonitorStatus, SystemRecord } from "@shared/types";
import { Activity, ChevronRight, FolderOpen, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { StatusBadge, StatusDot, TagChip } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ColumnsMenu, useHiddenColumns } from "@/components/ui/columns-menu";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page";
import { TableSkeleton } from "@/components/ui/skeleton";
import { formatMs, formatUptime } from "@/lib/format";
import { useApi, useDocumentTitle, useLocalStorage } from "@/lib/hooks";
import { MONITOR_TYPE_LABEL } from "@/lib/status";
import { cn } from "@/lib/utils";
import { HeartbeatBar, monitorTarget, uptimeColor } from "./shared";
import { useCanEdit } from "@/dashboard/role";

type StatusFilter = "all" | "up" | "down" | "degraded" | "paused";

const MONITOR_COLUMNS = [
	{ id: "target", label: "Type & target" },
	{ id: "tags", label: "Tags" },
	{ id: "heartbeats", label: "Recent checks" },
	{ id: "latency", label: "Latency" },
	{ id: "uptime", label: "Uptime (24h)" },
	{ id: "status", label: "Status" },
];

export function MonitorsPage() {
	useDocumentTitle("Monitors · Richter");
	const canEdit = useCanEdit();
	const { data, error, loading, reload } = useApi<MonitorListItem[]>("/api/admin/monitors", { refreshMs: 60_000 });
	const systems = useApi<SystemRecord[]>("/api/admin/systems");
	const [query, setQuery] = useState("");
	const [status, setStatus] = useState<StatusFilter>("all");
	const [tags, setTags] = useState<string[]>([]);
	const [collapsed, setCollapsed] = useLocalStorage<string[]>("richter-collapsed-groups", []);
	const cols = useHiddenColumns("richter-monitors-hidden-columns");

	const sysName = useMemo(() => {
		const map = new Map((systems.data ?? []).map((s) => [s.id, s.name]));
		return (id: string) => map.get(id);
	}, [systems.data]);

	const allTags = useMemo(() => [...new Set((data ?? []).flatMap((m) => m.tags))].sort(), [data]);

	const matches = (m: MonitorListItem) => {
		const q = query.trim().toLowerCase();
		if (q && !m.name.toLowerCase().includes(q) && !monitorTarget(m, sysName).toLowerCase().includes(q) && !m.tags.some((t) => t.includes(q))) return false;
		if (!tags.every((t) => m.tags.includes(t))) return false;
		if (status === "all") return true;
		if (status === "paused") return m.paused;
		return m.status === status;
	};

	const tree = useMemo(() => {
		const list = data ?? [];
		const byParent = new Map<string, MonitorListItem[]>();
		for (const m of list) if (m.parent_id) byParent.set(m.parent_id, [...(byParent.get(m.parent_id) ?? []), m]);
		const ids = new Set(list.map((m) => m.id));
		const top = list.filter((m) => !m.parent_id || !ids.has(m.parent_id));
		return { top, children: (id: string) => byParent.get(id) ?? [] };
	}, [data]);

	const counts = useMemo(() => {
		const c: Partial<Record<MonitorStatus, number>> = {};
		for (const m of data ?? []) if (m.type !== "group") c[m.status] = (c[m.status] ?? 0) + 1;
		return c;
	}, [data]);

	const filtering = query.trim() !== "" || status !== "all" || tags.length > 0;
	const rows: { m: MonitorListItem; depth: number; childCount?: number }[] = [];
	for (const m of tree.top) {
		if (m.type === "group") {
			const kids = tree.children(m.id).filter(matches);
			if (!kids.length && !matches(m)) continue;
			rows.push({ m, depth: 0, childCount: tree.children(m.id).length });
			if (!collapsed.includes(m.id) || filtering) for (const k of kids) rows.push({ m: k, depth: 1 });
		} else if (matches(m)) rows.push({ m, depth: 0 });
	}

	return (
		<>
			<PageHeader
				title="Monitors"
				description={
					data && data.length > 0 ? (
						<span className="flex flex-wrap gap-x-3">
							<span className="text-emerald-600 dark:text-emerald-400">{counts.up ?? 0} up</span>
							{(counts.down ?? 0) > 0 && <span className="text-red-600 dark:text-red-400">{counts.down} down</span>}
							{(counts.degraded ?? 0) > 0 && <span className="text-amber-600 dark:text-amber-400">{counts.degraded} degraded</span>}
							{(counts.paused ?? 0) > 0 && <span>{counts.paused} paused</span>}
						</span>
					) : (
						"Uptime checks from Cloudflare's edge, heartbeats and Beszel mirrors."
					)
				}
				actions={
					canEdit && (
						<Button asChild>
							<Link href="/monitors/new">
								<Plus /> New monitor
							</Link>
						</Button>
					)
				}
			/>

			{error && !data && <ErrorState error={error} onRetry={reload} />}

			{data && data.length > 0 && (
				<div className="mb-4 flex flex-wrap items-center gap-2">
					<div className="relative w-full sm:w-64">
						<Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter monitors…" className="pl-8" />
					</div>
					<Select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className="w-36">
						<option value="all">All statuses</option>
						<option value="up">Up</option>
						<option value="down">Down</option>
						<option value="degraded">Degraded</option>
						<option value="paused">Paused</option>
					</Select>
					<div className="flex flex-wrap gap-1.5">
						{allTags.map((t) => (
							<TagChip key={t} tag={t} active={tags.includes(t)} onClick={() => setTags((xs) => (xs.includes(t) ? xs.filter((x) => x !== t) : [...xs, t]))} />
						))}
					</div>
					<div className="ml-auto">
						<ColumnsMenu columns={MONITOR_COLUMNS} isVisible={cols.isVisible} toggle={cols.toggle} reset={cols.reset} />
					</div>
				</div>
			)}

			{loading && !data ? (
				<Card>
					<TableSkeleton rows={6} cols={4} />
				</Card>
			) : data && data.length === 0 ? (
				<Card>
					<EmptyState
						icon={Activity}
						title="No monitors yet"
						action={
							canEdit && (
								<Button asChild>
									<Link href="/monitors/new">
										<Plus /> Create a monitor
									</Link>
								</Button>
							)
						}
					>
						Watch websites (HTTP, keyword, JSON), TCP ports, DNS records, domain expiry, cron jobs via heartbeat pings, or mirror a Beszel system on a status page.
					</EmptyState>
				</Card>
			) : data && rows.length === 0 ? (
				<Card>
					<EmptyState icon={Search} title="No matching monitors">
						Try a different search, status or tag.
					</EmptyState>
				</Card>
			) : data ? (
				<Card className="divide-y overflow-hidden">
					{rows.map(({ m, depth, childCount }) => (
						<MonitorRow
							key={m.id}
							m={m}
							depth={depth}
							childCount={childCount}
							target={monitorTarget(m, sysName)}
							collapsed={collapsed.includes(m.id) && !filtering}
							show={cols.isVisible}
							onToggle={() => setCollapsed(collapsed.includes(m.id) ? collapsed.filter((x) => x !== m.id) : [...collapsed, m.id])}
						/>
					))}
				</Card>
			) : null}
		</>
	);
}

function MonitorRow({
	m,
	depth,
	childCount,
	target,
	collapsed,
	onToggle,
	show,
}: {
	m: MonitorListItem;
	depth: number;
	childCount?: number;
	target: string;
	collapsed: boolean;
	onToggle: () => void;
	show: (column: string) => boolean;
}) {
	const [, navigate] = useLocation();
	const isGroup = m.type === "group";
	return (
		<div
			role="link"
			tabIndex={0}
			onClick={() => navigate(`/monitors/${m.id}`)}
			onKeyDown={(e) => e.key === "Enter" && navigate(`/monitors/${m.id}`)}
			className={cn("flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 transition-colors hover:bg-muted/40 md:flex-nowrap", isGroup && "bg-muted/20")}
		>
			<div className={cn("flex min-w-0 flex-1 items-center gap-3", depth > 0 && "pl-7")}>
				{isGroup ? (
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							onToggle();
						}}
						className="-ml-1 rounded p-0.5 text-muted-foreground hover:bg-accent"
						aria-label={collapsed ? "Expand group" : "Collapse group"}
					>
						<ChevronRight className={cn("size-4 transition-transform", !collapsed && "rotate-90")} />
					</button>
				) : (
					<StatusDot status={m.status} pulse={m.status === "down"} />
				)}
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						{isGroup && <FolderOpen className="size-4 text-muted-foreground" />}
						<span className={cn("truncate font-medium", m.paused && "text-muted-foreground")}>{m.name}</span>
						{show("tags") && m.tags.map((t) => (
							<TagChip key={t} tag={t} />
						))}
					</div>
					{(isGroup || show("target")) && <p className="truncate text-xs text-muted-foreground">
						{isGroup ? `${childCount ?? 0} monitor${childCount === 1 ? "" : "s"}` : `${MONITOR_TYPE_LABEL[m.type]} · ${target}`}
					</p>}
				</div>
			</div>
			{isGroup ? (
				show("status") && <StatusBadge status={m.status} />
			) : (
				<>
					{show("heartbeats") && <HeartbeatBar checks={m.recent} className="hidden sm:flex" />}
					<div className="flex w-full items-center justify-between gap-4 md:w-auto md:justify-end">
						{show("latency") && (
							<span className="w-20 text-right text-xs tabular-nums text-muted-foreground" title="Last latency">
								{formatMs(m.last_latency_ms)}
							</span>
						)}
						{show("uptime") && (
							<span className={cn("w-16 text-right text-sm font-medium tabular-nums", uptimeColor(m.uptime_24h))} title="Uptime (24h)">
								{formatUptime(m.uptime_24h)}
							</span>
						)}
						{show("status") && <StatusBadge status={m.status} className="w-[6.5rem] justify-center" />}
					</div>
				</>
			)}
		</div>
	);
}
