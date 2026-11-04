import { classifyVersionChange, type VersionChange } from "@shared/package-updates";
import type { PackageSnapshot, PackageUpdate, ServicesSnapshot, SystemdService, SystemInfo } from "@shared/types";
import { ArrowUpDown, Cog, GitCompareArrows, Package, PackageCheck, PackageOpen, Search, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, Td, Th, Tr } from "@/components/ui/page";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const RED = "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400";
const AMBER = "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400";
const GREEN = "border-emerald-500/40 text-emerald-600 dark:text-emerald-400";

export function scrollTo(id: string) {
	document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Header chips from the live Info.PackageUpdates ([total, security]) and Info.Services ([total, failed]). */
export function UpdateChips({ info, onSelect = scrollTo }: { info: SystemInfo | null | undefined; onSelect?: (section: "packages" | "services") => void }) {
	const pu = info?.pu;
	const sv = info?.sv;
	if (!pu?.length && !sv?.length) return null;
	const total = pu?.[0] ?? 0;
	const security = pu && pu.length > 1 ? pu[1] : undefined;
	return (
		<>
			{pu?.length ? (
				<button type="button" onClick={() => onSelect("packages")} title="Pending package updates">
					<Badge className={cn("cursor-pointer", security ? RED : total ? AMBER : GREEN)}>
						{security ? <ShieldAlert className="size-3" /> : <Package className="size-3" />}
						{total ? `${total} update${total === 1 ? "" : "s"}` : "up to date"}
						{security != null && total > 0 && ` · ${security} security`}
					</Badge>
				</button>
			) : null}
			{sv?.length ? (
				<button type="button" onClick={() => onSelect("services")} title="systemd services">
					<Badge className={cn("cursor-pointer", sv[1] ? RED : undefined)}>
						<Cog className="size-3" />
						{sv[0]} services{sv[1] ? ` · ${sv[1]} failed` : ""}
					</Badge>
				</button>
			) : null}
		</>
	);
}

type ChangeRow = PackageUpdate & { change: VersionChange };
type PkgSort = "security" | "name" | "change";

/** Beszel's order (ascending puts major first) and badge colors for each version change. */
const CHANGE_RANK: Record<VersionChange, number> = { major: 0, minor: 1, patch: 2, revision: 3, other: 4 };
const CHANGE_BADGE: Record<VersionChange, string> = {
	major: "border-transparent bg-red-200 text-red-800",
	minor: "border-transparent bg-yellow-200 text-yellow-800",
	patch: "border-transparent bg-green-200 text-green-800",
	revision: "border-transparent bg-secondary text-secondary-foreground",
	other: "text-foreground",
};
const CHANGE_LABEL: Record<VersionChange, string> = { major: "Major", minor: "Minor", patch: "Patch", revision: "Revision", other: "Other" };

function ChangeBadge({ change }: { change: VersionChange }) {
	return <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold", CHANGE_BADGE[change])}>{CHANGE_LABEL[change]}</span>;
}

/** The red security marker Beszel shows per package: ShieldAlert icon plus "Security". */
function SecurityMark() {
	return (
		<span className="flex items-center gap-1.5 text-red-600 dark:text-red-400">
			<ShieldAlert className="size-4" />
			Security
		</span>
	);
}

export function Packages({ systemId, info }: { systemId: string; info: SystemInfo | null | undefined }) {
	const enabled = !!info?.pu?.length;
	const snap = useApi<PackageSnapshot>(enabled ? `/api/admin/systems/${systemId}/packages` : null, { refreshMs: 300_000 });
	const [filter, setFilter] = useState("");
	// Security first by default (then biggest change); click a header to sort like Beszel's table.
	const [sort, setSort] = useState<{ key: PkgSort; dir: 1 | -1 }>({ key: "security", dir: 1 });
	const d = snap.data;
	const all = useMemo<ChangeRow[]>(() => (d?.packages ?? []).map((p) => ({ ...p, change: classifyVersionChange(p.c, p.a) })), [d]);
	const rows = useMemo(() => {
		// Beszel's filter: every space-separated term must appear in name, versions or change label.
		const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
		const list = all.filter((p) => {
			const hay = `${p.n} ${p.c ?? ""} ${p.a ?? ""} ${CHANGE_LABEL[p.change]}${p.s ? " security" : ""}`.toLowerCase();
			return terms.every((t) => hay.includes(t));
		});
		const byName = (a: ChangeRow, b: ChangeRow) => a.n.localeCompare(b.n);
		const byChange = (a: ChangeRow, b: ChangeRow) => CHANGE_RANK[a.change] - CHANGE_RANK[b.change];
		const bySec = (a: ChangeRow, b: ChangeRow) => Number(!!b.s) - Number(!!a.s);
		const cmp =
			sort.key === "name"
				? (a: ChangeRow, b: ChangeRow) => byName(a, b) * sort.dir
				: sort.key === "change"
					? (a: ChangeRow, b: ChangeRow) => byChange(a, b) * sort.dir || bySec(a, b) || byName(a, b)
					: (a: ChangeRow, b: ChangeRow) => bySec(a, b) * sort.dir || byChange(a, b) || byName(a, b);
		return list.sort(cmp);
	}, [all, filter, sort]);
	if (!enabled || !d || (!d.packages.length && !d.checked_at)) return null;
	const sec = all.filter((p) => p.s).length;
	const head = (key: PkgSort, label: string, Icon: React.ElementType, className?: string) => (
		<Th className={className}>
			<button
				type="button"
				className={cn("inline-flex items-center gap-1.5 hover:text-foreground", sort.key === key && "text-foreground")}
				onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}
			>
				<Icon className="size-3.5" />
				{label}
				<ArrowUpDown className="size-3 opacity-50" />
			</button>
		</Th>
	);
	const cols = d.security_known ? 5 : 4;
	return (
		<section id="packages" className="mt-8 scroll-mt-4">
			<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
				<div>
					<h2 className="flex items-center gap-2 text-lg font-semibold">
						<Package className="size-5 text-muted-foreground" /> Package updates
					</h2>
					<p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
						{d.manager && <span className="font-mono">{d.manager}</span>}
						{d.manager && <span className="text-primary/40">|</span>}
						<span>Total: {all.length}</span>
						{d.security_known ? (
							<>
								<span className="text-primary/40">|</span>
								<span className={cn(sec > 0 && "inline-flex items-center gap-1 font-semibold text-red-600 dark:text-red-400")}>
									{sec > 0 && <ShieldAlert className="size-3.5" />}Security: {sec}
								</span>
							</>
						) : (
							<>
								<span className="text-primary/40">|</span>
								<span>security status not reported</span>
							</>
						)}
						{d.checked_at ? (
							<>
								<span className="text-primary/40">|</span>
								<span title={new Date(d.checked_at).toLocaleString()}>Checked {timeAgo(d.checked_at)}</span>
							</>
						) : null}
					</p>
				</div>
				{all.length > 0 && (
					<div className="relative w-full sm:w-64">
						<Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className="pl-8" />
					</div>
				)}
			</div>
			{sec > 0 && (
				<div className="mb-3 flex items-center gap-2 rounded-md border border-red-500/50 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-600 dark:text-red-400">
					<ShieldAlert className="size-4 shrink-0" />
					{sec} security update{sec === 1 ? "" : "s"} pending
				</div>
			)}
			<Card className="overflow-hidden">
				<div className="max-h-[28rem] overflow-auto">
					<Table>
						<thead className="sticky top-0 z-10 border-b bg-card">
							<tr>
								{head("name", "Package", Package, "pl-4")}
								<Th>
									<span className="inline-flex items-center gap-1.5">
										<PackageCheck className="size-3.5" /> Current
									</span>
								</Th>
								<Th>
									<span className="inline-flex items-center gap-1.5">
										<PackageOpen className="size-3.5" /> Available
									</span>
								</Th>
								{d.security_known && head("security", "Security", ShieldAlert)}
								{head("change", "Change", GitCompareArrows, "w-0 pr-4")}
							</tr>
						</thead>
						<tbody>
							{rows.map((p) => (
								<Tr key={p.n}>
									<Td className="pl-4 whitespace-nowrap">{p.n}</Td>
									<Td className="max-w-64 truncate whitespace-nowrap font-mono text-xs text-muted-foreground">{p.c || "-"}</Td>
									<Td className="max-w-64 truncate whitespace-nowrap font-mono text-xs">{p.a ?? "-"}</Td>
									{d.security_known && <Td className="whitespace-nowrap">{p.s ? <SecurityMark /> : null}</Td>}
									<Td className="pr-4">
										<ChangeBadge change={p.change} />
									</Td>
								</Tr>
							))}
							{rows.length === 0 && (
								<tr>
									<Td colSpan={cols} className="h-24 text-center text-sm text-muted-foreground">
										{all.length ? "No results." : "Up to date"}
									</Td>
								</tr>
							)}
						</tbody>
					</Table>
				</div>
			</Card>
		</section>
	);
}

const STATE: Record<number, { label: string; cls: string }> = {
	0: { label: "active", cls: "text-emerald-600 dark:text-emerald-400" },
	1: { label: "inactive", cls: "text-muted-foreground" },
	2: { label: "failed", cls: "text-red-600 dark:text-red-400 font-semibold" },
	3: { label: "activating", cls: "text-sky-600 dark:text-sky-400" },
	4: { label: "deactivating", cls: "text-amber-600 dark:text-amber-400" },
	5: { label: "reloading", cls: "text-sky-600 dark:text-sky-400" },
};
const SUB = ["dead", "running", "exited", "failed", "other"];
const ORDER = [2, 3, 5, 4, 0, 1]; // failed first, then transitional, active, inactive

export function Services({ systemId, info }: { systemId: string; info: SystemInfo | null | undefined }) {
	const enabled = !!info?.sv?.length;
	const snap = useApi<ServicesSnapshot>(enabled ? `/api/admin/systems/${systemId}/services` : null, { refreshMs: 300_000 });
	const [filter, setFilter] = useState("");
	const sorted = useMemo(
		() => [...(snap.data?.services ?? [])].sort((a: SystemdService, b: SystemdService) => ORDER.indexOf(a.s) - ORDER.indexOf(b.s) || a.n.localeCompare(b.n)),
		[snap.data],
	);
	if (!enabled || !snap.data || !sorted.length) return null;
	const q = filter.trim().toLowerCase();
	const rows = sorted.filter((s) => !q || s.n.toLowerCase().includes(q) || STATE[s.s]?.label === q);
	const failed = sorted.filter((s) => s.s === 2).length;
	return (
		<section id="services" className="mt-8 scroll-mt-4">
			<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
				<h2 className="flex items-center gap-2 text-lg font-semibold">
					<Cog className="size-5 text-muted-foreground" /> Services
					<Badge>{sorted.length}</Badge>
					{failed > 0 && <Badge className={RED}>{failed} failed</Badge>}
				</h2>
				<div className="flex flex-wrap items-center gap-3">
					{snap.data.updated_at && <span className="text-xs text-muted-foreground">changed {timeAgo(snap.data.updated_at)}</span>}
					<div className="relative w-full sm:w-56">
						<Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter services…" className="pl-8" />
					</div>
				</div>
			</div>
			<Card className="overflow-hidden">
				<div className="max-h-[28rem] overflow-y-auto">
					<Table>
						<thead className="sticky top-0 border-b bg-card">
							<tr>
								<Th className="pl-4">Service</Th>
								<Th>State</Th>
								<Th className="pr-4">Sub-state</Th>
							</tr>
						</thead>
						<tbody>
							{rows.map((s) => (
								<Tr key={s.n} className={cn(s.s === 2 && "bg-red-500/5")}>
									<Td className="pl-4 font-medium">{s.n}</Td>
									<Td className={cn("text-xs", STATE[s.s]?.cls)}>{STATE[s.s]?.label ?? "unknown"}</Td>
									<Td className="pr-4 text-xs text-muted-foreground">{SUB[s.ss] ?? "other"}</Td>
								</Tr>
							))}
							{rows.length === 0 && (
								<tr>
									<Td colSpan={3} className="py-6 text-center text-sm text-muted-foreground">
										No services match “{filter}”.
									</Td>
								</tr>
							)}
						</tbody>
					</Table>
				</div>
			</Card>
		</section>
	);
}
