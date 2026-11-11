import type { Announcement, AnnouncementInput, Incident, Maintenance, MaintenanceInput, MonitorListItem, Severity, StatusPage, SystemRecord } from "@shared/types";
import { AlertTriangle, CalendarClock, CheckCircle2, Megaphone, Pencil, Plus, Repeat, Search, Trash2, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { admin } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { PageHeader, Table, Td, Th, Tr } from "@/components/ui/page";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Checkbox, SwitchRow } from "@/components/ui/switch";
import { Segmented, Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAction } from "@/components/ui/toast";
import { formatDateTime, formatDurationMs, fromLocalInput, timeAgo, toLocalInput } from "@/lib/format";
import { useApi, useDocumentTitle } from "@/lib/hooks";
import { renderMarkdown } from "@/lib/markdown";
import { SEVERITY_CLS } from "@/lib/status";
import { cn } from "@/lib/utils";
import { useCanEdit } from "@/dashboard/role";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function IncidentsPage() {
	useDocumentTitle("Incidents & maintenance · Richter");
	const [tab, setTab] = useState(() => (location.hash.slice(1) || "incidents") as string);
	useEffect(() => {
		history.replaceState(null, "", `#${tab}`);
	}, [tab]);
	return (
		<>
			<PageHeader title="Incidents & maintenance" description="Outage history, planned maintenance windows and status page announcements." />
			<Tabs value={tab} onValueChange={setTab}>
				<TabsList className="mb-4">
					<TabsTrigger value="incidents">
						<AlertTriangle /> Incidents
					</TabsTrigger>
					<TabsTrigger value="maintenance">
						<Wrench /> Maintenance
					</TabsTrigger>
					<TabsTrigger value="announcements">
						<Megaphone /> Announcements
					</TabsTrigger>
				</TabsList>
				<TabsContent value="incidents">
					<Incidents />
				</TabsContent>
				<TabsContent value="maintenance">
					<Maintenances />
				</TabsContent>
				<TabsContent value="announcements">
					<Announcements />
				</TabsContent>
			</Tabs>
		</>
	);
}

// ---- Incidents -----------------------------------------------------------------

function Incidents() {
	const { data, error, loading, reload } = useApi<Incident[]>("/api/admin/incidents", { refreshMs: 15_000 });
	if (error && !data) return <ErrorState error={error} onRetry={reload} />;
	if (loading && !data)
		return (
			<Card>
				<TableSkeleton rows={4} cols={4} />
			</Card>
		);
	const open = (data ?? []).filter((i) => !i.resolved_at);
	const recent = (data ?? []).filter((i) => i.resolved_at);
	return (
		<div className="space-y-6">
			<section>
				<h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
					Open incidents <Badge>{open.length}</Badge>
				</h2>
				{open.length === 0 ? (
					<Card className="flex items-center gap-3 p-4 text-sm">
						<CheckCircle2 className="size-5 text-emerald-500" />
						No open incidents. Everything that was down has recovered.
					</Card>
				) : (
					<div className="grid gap-3 md:grid-cols-2">
						{open.map((i) => (
							<Card key={i.id} className="border-red-500/40 p-4">
								<div className="flex items-center gap-2">
									<span className="relative flex size-2.5">
										<span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-60" />
										<span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
									</span>
									<Link href={`/monitors/${i.monitor_id}`} className="font-medium hover:underline">
										{i.monitor_name ?? i.monitor_id}
									</Link>
									<span className="ml-auto text-xs text-muted-foreground">down {formatDurationMs(Date.now() - i.started_at)}</span>
								</div>
								<p className="mt-2 text-sm">{i.cause ?? "No cause recorded"}</p>
								<p className="mt-1 text-xs text-muted-foreground">Since {formatDateTime(i.started_at)}</p>
							</Card>
						))}
					</div>
				)}
			</section>
			<section>
				<h2 className="mb-2 text-sm font-semibold">Recently resolved</h2>
				<Card className="overflow-hidden">
					{recent.length === 0 ? (
						<p className="px-4 py-8 text-center text-sm text-muted-foreground">No resolved incidents yet. Incidents open automatically when a monitor goes down (after retries).</p>
					) : (
						<Table>
							<thead className="border-b bg-muted/30">
								<tr>
									<Th className="pl-4">Monitor</Th>
									<Th>Cause</Th>
									<Th>Started</Th>
									<Th>Resolved</Th>
									<Th className="pr-4 text-right">Duration</Th>
								</tr>
							</thead>
							<tbody>
								{recent.map((i) => (
									<Tr key={i.id}>
										<Td className="pl-4 font-medium">
											<Link href={`/monitors/${i.monitor_id}`} className="hover:underline">
												{i.monitor_name ?? i.monitor_id}
											</Link>
										</Td>
										<Td className="max-w-sm truncate text-muted-foreground" title={i.cause ?? ""}>
											{i.cause ?? "–"}
										</Td>
										<Td className="whitespace-nowrap text-xs">{formatDateTime(i.started_at)}</Td>
										<Td className="whitespace-nowrap text-xs">{formatDateTime(i.resolved_at)}</Td>
										<Td className="pr-4 text-right text-xs tabular-nums">{formatDurationMs(i.resolved_at! - i.started_at)}</Td>
									</Tr>
								))}
							</tbody>
						</Table>
					)}
				</Card>
			</section>
		</div>
	);
}

// ---- Maintenance ---------------------------------------------------------------

function maintenanceState(m: Maintenance): { label: string; cls: string } {
	if (m.active) return { label: "Active", cls: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300" };
	if (m.next_start) return { label: `Starts ${timeAgo(m.next_start)}`, cls: "border-violet-500/40 text-violet-700 dark:text-violet-300" };
	return { label: "Ended", cls: "" };
}

function Maintenances() {
	const { data, error, loading, reload } = useApi<Maintenance[]>("/api/admin/maintenances", { refreshMs: 60_000 });
	const monitors = useApi<MonitorListItem[]>("/api/admin/monitors");
	const systems = useApi<SystemRecord[]>("/api/admin/systems");
	const [editing, setEditing] = useState<Maintenance | "new" | null>(null);
	const confirm = useConfirm();
	const canEdit = useCanEdit();
	const { run } = useAction();
	const nameOf = (kind: "m" | "s", id: string) => (kind === "m" ? monitors.data?.find((x) => x.id === id)?.name : systems.data?.find((x) => x.id === id)?.name) ?? "deleted";

	const sorted = useMemo(
		() => [...(data ?? [])].sort((a, b) => Number(b.active) - Number(a.active) || (a.next_start ?? Infinity) - (b.next_start ?? Infinity) || b.starts_at - a.starts_at),
		[data],
	);

	return (
		<>
			<div className="mb-3 flex items-center justify-between gap-3">
				<p className="text-sm text-muted-foreground">Covered monitors show “maintenance”, open no incidents and send no alerts. Uptime excludes maintenance time.</p>
				{canEdit && (
					<Button onClick={() => setEditing("new")}>
						<Plus /> Schedule maintenance
					</Button>
				)}
			</div>
			{error && !data && <ErrorState error={error} onRetry={reload} />}
			{loading && !data ? (
				<Card>
					<TableSkeleton rows={3} cols={4} />
				</Card>
			) : sorted.length === 0 ? (
				<Card>
					<EmptyState icon={CalendarClock} title="No maintenance scheduled">
						Plan a one-off window for an upgrade, or a repeating one (daily, weekly, monthly) for patch nights.
					</EmptyState>
				</Card>
			) : (
				<div className="space-y-3">
					{sorted.map((m) => {
						const st = maintenanceState(m);
						return (
							<Card key={m.id} className={cn("p-4", m.active && "border-sky-500/40")}>
								<div className="flex flex-wrap items-start gap-3">
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-center gap-2">
											<span className="font-medium">{m.title}</span>
											<Badge className={st.cls}>{st.label}</Badge>
											{m.repeat && (
												<Badge>
													<Repeat className="size-3" /> every {m.repeat.every}
													{m.repeat.until ? ` until ${formatDateTime(m.repeat.until)}` : ""}
												</Badge>
											)}
										</div>
										{m.description && <p className="mt-1 text-sm text-muted-foreground">{m.description}</p>}
										<p className="mt-1.5 text-xs text-muted-foreground">
											{formatDateTime(m.starts_at)} → {formatDateTime(m.ends_at)} ({formatDurationMs(m.ends_at - m.starts_at)})
										</p>
										<div className="mt-2 flex flex-wrap gap-1">
											{m.monitor_ids.map((id) => (
												<Badge key={id}>{nameOf("m", id)}</Badge>
											))}
											{m.system_ids.map((id) => (
												<Badge key={id}>⌁ {nameOf("s", id)}</Badge>
											))}
										</div>
									</div>
									{canEdit && <div className="flex gap-1">
										<Button variant="ghost" size="icon-sm" onClick={() => setEditing(m)} aria-label="Edit">
											<Pencil />
										</Button>
										<Button
											variant="ghost"
											size="icon-sm"
											className="hover:text-destructive"
											aria-label="Delete"
											onClick={async () => {
												if (await confirm({ title: `Delete “${m.title}”?`, confirmLabel: "Delete", destructive: true }))
													if (await run("del", () => admin.del(`/maintenances/${m.id}`), "Maintenance deleted")) reload();
											}}
										>
											<Trash2 />
										</Button>
									</div>}
								</div>
							</Card>
						);
					})}
				</div>
			)}
			<MaintenanceDialog
				value={editing}
				onClose={() => setEditing(null)}
				onSaved={() => {
					setEditing(null);
					reload();
				}}
				monitors={monitors.data ?? []}
				systems={systems.data ?? []}
			/>
		</>
	);
}

function MaintenanceDialog({
	value,
	onClose,
	onSaved,
	monitors,
	systems,
}: {
	value: Maintenance | "new" | null;
	onClose: () => void;
	onSaved: () => void;
	monitors: MonitorListItem[];
	systems: SystemRecord[];
}) {
	const { run, busy } = useAction();
	const [f, setF] = useState<MaintenanceInput>();
	const [error, setError] = useState<string>();
	const [q, setQ] = useState("");

	useEffect(() => {
		if (value == null) return;
		setError(undefined);
		setQ("");
		if (value === "new") {
			const start = Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 3_600_000;
			setF({ title: "", description: null, starts_at: start, ends_at: start + 3_600_000, repeat: null, monitor_ids: [], system_ids: [] });
		} else {
			const { id: _id, active: _a, next_start: _n, created_at: _c, ...rest } = value;
			setF(rest);
		}
	}, [value]);

	if (!f) return null;
	const set = <K extends keyof MaintenanceInput>(k: K, v: MaintenanceInput[K]) => setF((x) => x && { ...x, [k]: v });
	const query = q.trim().toLowerCase();
	const toggle = (key: "monitor_ids" | "system_ids", id: string) => set(key, f[key].includes(id) ? f[key].filter((x) => x !== id) : [...f[key], id]);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!f.title.trim()) return setError("Title is required");
		if (f.ends_at <= f.starts_at) return setError("End must be after start");
		if (f.repeat && f.ends_at - f.starts_at > 86_400_000) return setError("Repeating windows can last at most 24 hours");
		if (!f.monitor_ids.length && !f.system_ids.length) return setError("Pick at least one monitor or system");
		const body = { ...f, title: f.title.trim() };
		const r = await run("save", () => (value === "new" ? admin.post("/maintenances", body) : admin.patch(`/maintenances/${(value as Maintenance).id}`, body)), "Maintenance saved");
		if (r) onSaved();
	};

	return (
		<Dialog open={value != null} onOpenChange={(o) => !o && onClose()}>
			<DialogContent wide>
				<form onSubmit={submit} className="contents">
					<DialogHeader title={value === "new" ? "Schedule maintenance" : "Edit maintenance"} description={`Times are in your browser timezone (${TZ}).`} />
					<DialogBody className="space-y-4">
						<Field label="Title">
							<Input value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="Database upgrade" autoFocus />
						</Field>
						<Field label="Description" hint="Shown on status pages">
							<Textarea value={f.description ?? ""} onChange={(e) => set("description", e.target.value || null)} rows={2} />
						</Field>
						<div className="grid gap-4 sm:grid-cols-2">
							<Field label="Starts">
								<Input type="datetime-local" value={toLocalInput(f.starts_at)} onChange={(e) => set("starts_at", fromLocalInput(e.target.value) ?? f.starts_at)} />
							</Field>
							<Field label="Ends">
								<Input type="datetime-local" value={toLocalInput(f.ends_at)} onChange={(e) => set("ends_at", fromLocalInput(e.target.value) ?? f.ends_at)} />
							</Field>
						</div>
						<div className="grid gap-4 sm:grid-cols-2">
							<Field label="Repeat">
								<Segmented
									value={f.repeat?.every ?? "none"}
									onChange={(v) => set("repeat", v === "none" ? null : { every: v, until: f.repeat?.until ?? null })}
									options={[
										{ value: "none", label: "Once" },
										{ value: "day", label: "Daily" },
										{ value: "week", label: "Weekly" },
										{ value: "month", label: "Monthly" },
									]}
								/>
							</Field>
							{f.repeat && (
								<Field label="Repeat until" hint="Leave empty to repeat forever">
									<Input type="datetime-local" value={toLocalInput(f.repeat.until)} onChange={(e) => set("repeat", { ...f.repeat!, until: fromLocalInput(e.target.value) })} />
								</Field>
							)}
						</div>
						<div>
							<div className="mb-2 flex items-center justify-between gap-3">
								<span className="text-sm font-medium">
									Covered monitors &amp; systems <span className="text-muted-foreground">({f.monitor_ids.length + f.system_ids.length})</span>
								</span>
								<div className="relative w-48">
									<Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
									<Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className="h-8 pl-7 text-xs" />
								</div>
							</div>
							<div className="max-h-56 overflow-y-auto rounded-md border p-1">
								{monitors
									.filter((m) => !query || m.name.toLowerCase().includes(query))
									.map((m) => (
										<label key={m.id} className="flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-sm hover:bg-accent/50">
											<Checkbox checked={f.monitor_ids.includes(m.id)} onCheckedChange={() => toggle("monitor_ids", m.id)} />
											<span className="flex-1 truncate">{m.name}</span>
											<span className="text-xs text-muted-foreground">monitor</span>
										</label>
									))}
								{systems
									.filter((s) => !query || s.name.toLowerCase().includes(query))
									.map((s) => (
										<label key={s.id} className="flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-sm hover:bg-accent/50">
											<Checkbox checked={f.system_ids.includes(s.id)} onCheckedChange={() => toggle("system_ids", s.id)} />
											<span className="flex-1 truncate">{s.name}</span>
											<span className="text-xs text-muted-foreground">system</span>
										</label>
									))}
							</div>
						</div>
						{error && <p className="text-sm text-destructive">{error}</p>}
					</DialogBody>
					<DialogFooter>
						<Button variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" loading={busy === "save"}>
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

// ---- Announcements -------------------------------------------------------------

const SEVERITIES: Severity[] = ["info", "warning", "danger", "success"];

function isLive(a: Announcement, now = Date.now()) {
	return (a.starts_at == null || a.starts_at <= now) && (a.ends_at == null || a.ends_at > now);
}

function Announcements() {
	const { data, error, loading, reload } = useApi<Announcement[]>("/api/admin/announcements");
	const pages = useApi<StatusPage[]>("/api/admin/status-pages");
	const [editing, setEditing] = useState<Announcement | "new" | null>(null);
	const confirm = useConfirm();
	const canEdit = useCanEdit();
	const { run } = useAction();
	const pageName = (id: string | null) => (id == null ? "All pages" : (pages.data?.find((p) => p.id === id)?.title ?? "Deleted page"));

	return (
		<>
			<div className="mb-3 flex items-center justify-between gap-3">
				<p className="text-sm text-muted-foreground">Markdown notices shown at the top of status pages while active.</p>
				{canEdit && (
					<Button onClick={() => setEditing("new")}>
						<Plus /> New announcement
					</Button>
				)}
			</div>
			{error && !data && <ErrorState error={error} onRetry={reload} />}
			{loading && !data ? (
				<Card>
					<TableSkeleton rows={3} cols={3} />
				</Card>
			) : (data ?? []).length === 0 ? (
				<Card>
					<EmptyState icon={Megaphone} title="No announcements">
						Post a heads-up about an ongoing investigation, a planned migration, or good news. Bodies support Markdown.
					</EmptyState>
				</Card>
			) : (
				<div className="space-y-3">
					{[...data!]
						.sort((a, b) => b.created_at - a.created_at)
						.map((a) => (
							<div key={a.id} className={cn("rounded-lg border p-4", SEVERITY_CLS[a.severity])}>
								<div className="flex flex-wrap items-start gap-3">
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-center gap-2">
											<span className="font-semibold">{a.title}</span>
											<Badge className="border-current/30 text-current">{a.severity}</Badge>
											<Badge className="border-current/30 text-current">{isLive(a) ? "Live" : a.starts_at && a.starts_at > Date.now() ? "Scheduled" : "Expired"}</Badge>
											<Badge className="border-current/30 text-current">{pageName(a.status_page_id)}</Badge>
										</div>
										<div className="prose-md mt-2 text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(a.body) }} />
										<p className="mt-2 text-xs opacity-70">
											{a.starts_at ? `From ${formatDateTime(a.starts_at)}` : "From creation"} · {a.ends_at ? `until ${formatDateTime(a.ends_at)}` : "no end"}
										</p>
									</div>
									{canEdit && <div className="flex gap-1">
										<Button variant="ghost" size="icon-sm" onClick={() => setEditing(a)} aria-label="Edit">
											<Pencil />
										</Button>
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Delete"
											onClick={async () => {
												if (await confirm({ title: `Delete “${a.title}”?`, confirmLabel: "Delete", destructive: true }))
													if (await run("del", () => admin.del(`/announcements/${a.id}`), "Announcement deleted")) reload();
											}}
										>
											<Trash2 />
										</Button>
									</div>}
								</div>
							</div>
						))}
				</div>
			)}
			<AnnouncementDialog
				value={editing}
				pages={pages.data ?? []}
				onClose={() => setEditing(null)}
				onSaved={() => {
					setEditing(null);
					reload();
				}}
			/>
		</>
	);
}

function AnnouncementDialog({ value, pages, onClose, onSaved }: { value: Announcement | "new" | null; pages: StatusPage[]; onClose: () => void; onSaved: () => void }) {
	const { run, busy } = useAction();
	const [f, setF] = useState<AnnouncementInput>();
	const [error, setError] = useState<string>();
	const [mode, setMode] = useState<"write" | "preview">("write");

	useEffect(() => {
		if (value == null) return;
		setError(undefined);
		setMode("write");
		if (value === "new") setF({ status_page_id: null, title: "", body: "", severity: "info", pinned: true, starts_at: null, ends_at: null });
		else {
			const { id: _id, created_at: _c, updated_at: _u, ...rest } = value;
			setF(rest);
		}
	}, [value]);

	if (!f) return null;
	const set = <K extends keyof AnnouncementInput>(k: K, v: AnnouncementInput[K]) => setF((x) => x && { ...x, [k]: v });

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!f.title.trim()) return setError("Title is required");
		if (!f.body.trim()) return setError("Body is required");
		if (f.starts_at && f.ends_at && f.ends_at <= f.starts_at) return setError("End must be after start");
		const r = await run("save", () => (value === "new" ? admin.post("/announcements", f) : admin.patch(`/announcements/${(value as Announcement).id}`, f)), "Announcement saved");
		if (r) onSaved();
	};

	return (
		<Dialog open={value != null} onOpenChange={(o) => !o && onClose()}>
			<DialogContent wide>
				<form onSubmit={submit} className="contents">
					<DialogHeader title={value === "new" ? "New announcement" : "Edit announcement"} />
					<DialogBody className="space-y-4">
						<Field label="Title">
							<Input value={f.title} onChange={(e) => set("title", e.target.value)} autoFocus placeholder="Investigating elevated error rates" />
						</Field>
						<div className="grid gap-4 sm:grid-cols-2">
							<Field label="Severity">
								<Select value={f.severity} onChange={(e) => set("severity", e.target.value as Severity)}>
									{SEVERITIES.map((s) => (
										<option key={s} value={s}>
											{s[0].toUpperCase() + s.slice(1)}
										</option>
									))}
								</Select>
							</Field>
							<Field label="Show on">
								<Select value={f.status_page_id ?? ""} onChange={(e) => set("status_page_id", e.target.value || null)}>
									<option value="">All status pages</option>
									{pages.map((p) => (
										<option key={p.id} value={p.id}>
											{p.title}
										</option>
									))}
								</Select>
							</Field>
						</div>
						<div className="grid gap-1.5">
							<div className="flex items-center justify-between">
								<span className="text-sm font-medium">Body (Markdown)</span>
								<Segmented
									value={mode}
									onChange={setMode}
									options={[
										{ value: "write", label: "Write" },
										{ value: "preview", label: "Preview" },
									]}
								/>
							</div>
							{mode === "write" ? (
								<Textarea value={f.body} onChange={(e) => set("body", e.target.value)} rows={7} className="font-mono text-xs" placeholder={"We are investigating **elevated errors** on the API.\n\n- Dashboard is unaffected"} />
							) : (
								<div className={cn("min-h-[166px] rounded-md border p-3", SEVERITY_CLS[f.severity])}>
									<p className="font-semibold">{f.title || "Untitled"}</p>
									<div className="prose-md mt-1 text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(f.body || "_Nothing to preview_") }} />
								</div>
							)}
						</div>
						<div className="grid gap-4 sm:grid-cols-2">
							<Field label="Starts" hint="Empty = immediately">
								<Input type="datetime-local" value={toLocalInput(f.starts_at)} onChange={(e) => set("starts_at", fromLocalInput(e.target.value))} />
							</Field>
							<Field label="Ends" hint="Empty = until removed">
								<Input type="datetime-local" value={toLocalInput(f.ends_at)} onChange={(e) => set("ends_at", fromLocalInput(e.target.value))} />
							</Field>
						</div>
						<SwitchRow label="Pinned" description="Keep at the top of the page." checked={f.pinned} onCheckedChange={(v) => set("pinned", v)} />
						{error && <p className="text-sm text-destructive">{error}</p>}
					</DialogBody>
					<DialogFooter>
						<Button variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" loading={busy === "save"}>
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
