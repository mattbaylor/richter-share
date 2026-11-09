import type { NotificationChannel, SystemAlert, SystemAlertMetric, SystemRecord } from "@shared/types";
import { Globe, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLatest } from "@/lib/hooks";
import { Link } from "wouter";
import { admin, request } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox, CheckRow, Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAction } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

interface MetricDef {
	metric: SystemAlertMetric;
	label: string;
	description: string;
	unit?: string;
	min?: number;
	max?: number;
	step?: number;
	def?: number;
	/** Event alert: notifies on change, no averaging window. */
	event?: boolean;
	/** No threshold input (Status, SystemdFailed). */
	noThreshold?: boolean;
}

const METRICS: MetricDef[] = [
	{
		metric: "Status",
		label: "Agent offline",
		description: "Notify when the agent has been disconnected for the set minutes, and again when it reconnects. Shorter disconnects send nothing. Separate from the status page's “Consider down after”.",
		noThreshold: true,
	},
	{ metric: "CPU", label: "CPU usage", description: "Average CPU usage exceeds the threshold.", unit: "%", min: 1, max: 100, def: 80 },
	{ metric: "Memory", label: "Memory usage", description: "Average memory usage exceeds the threshold.", unit: "%", min: 1, max: 100, def: 80 },
	{ metric: "Disk", label: "Disk usage", description: "Usage of any filesystem exceeds the threshold.", unit: "%", min: 1, max: 100, def: 80 },
	{ metric: "Temperature", label: "Temperature", description: "Hottest sensor exceeds the threshold.", unit: "°C", min: 1, max: 120, def: 80 },
	{ metric: "LoadAvg5", label: "Load average (5m)", description: "5-minute load average exceeds the threshold.", unit: "", min: 0.1, max: 64, step: 0.1, def: 4 },
	{ metric: "Bandwidth", label: "Bandwidth", description: "Combined sent + received exceeds the threshold.", unit: "MB/s", min: 1, max: 1000, def: 50 },
	{ metric: "GPU", label: "GPU usage", description: "Average GPU usage exceeds the threshold.", unit: "%", min: 1, max: 100, def: 80 },
	{
		metric: "Steal",
		label: "CPU steal",
		description: "Average CPU steal time exceeds the threshold: the hypervisor is giving this VM's CPU time to other guests. Useful on VMs only.",
		unit: "%",
		min: 1,
		max: 100,
		def: 10,
	},
	{
		metric: "SecurityUpdates",
		label: "Security updates",
		description: "Pending security updates reach the threshold. Notifies again if more arrive, and when they clear. apt, dnf and zypper only.",
		unit: "pkgs",
		min: 1,
		max: 50,
		def: 1,
		event: true,
	},
	{
		metric: "PackageUpdates",
		label: "Package updates",
		description: "Pending package updates reach the threshold, and when they drop below it.",
		unit: "pkgs",
		min: 1,
		max: 200,
		def: 10,
		event: true,
	},
	{
		metric: "SystemdFailed",
		label: "Failed systemd services",
		description: "Any systemd service enters the failed state, and when all recover. Checked about every 10 minutes.",
		event: true,
		noThreshold: true,
	},
	{
		metric: "SmartFailed",
		label: "Disk health (S.M.A.R.T.)",
		description: "Any disk's S.M.A.R.T. check reports FAILED or WARNING, and when all pass again. Checked hourly; needs smartctl access for the agent, which the Proxmox VE node install command sets up.",
		event: true,
		noThreshold: true,
	},
];

type Value = { on: boolean; threshold: number; minutes: number; triggered?: boolean };
type Draft = Record<SystemAlertMetric, Value>;

const defMinutes = (m: SystemAlertMetric) => (m === "Status" ? 1 : 10);

function draftFrom(alerts: SystemAlert[]): Draft {
	const d = {} as Draft;
	for (const m of METRICS) {
		const existing = alerts.find((x) => x.metric === m.metric);
		d[m.metric] = { on: !!existing, threshold: existing?.threshold ?? m.def ?? 0, minutes: existing?.minutes ?? defMinutes(m.metric), triggered: existing?.triggered };
	}
	return d;
}

const toAlert = (m: MetricDef, v: Value): SystemAlert => ({
	metric: m.metric,
	threshold: m.noThreshold ? null : v.threshold,
	minutes: m.event ? 1 : Math.min(60, Math.max(1, Math.round(v.minutes))),
});

/** One alert's switch, threshold and window (shared by both tabs). */
function AlertRow({ m, v, onChange }: { m: MetricDef; v: Value; onChange: (patch: Partial<Value>) => void }) {
	return (
		<div className={cn("rounded-lg border p-3 transition-colors", v.on && "border-primary/40 bg-primary/5")}>
			<label className="flex cursor-pointer items-start justify-between gap-3">
				<span>
					<span className="flex items-center gap-2 text-sm font-medium">
						{m.label}
						{v.triggered && <span className="rounded bg-red-500/15 px-1.5 text-[10px] font-semibold uppercase text-red-600 dark:text-red-400">triggered</span>}
					</span>
					<span className="text-xs text-muted-foreground">{m.description}</span>
				</span>
				<Switch checked={v.on} onCheckedChange={(on) => onChange({ on })} aria-label={m.label} />
			</label>
			{v.on && !(m.event && m.noThreshold) && (
				<div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]">
					{!m.noThreshold ? (
						<div className="flex items-center gap-3">
							<span className="w-20 shrink-0 text-xs text-muted-foreground">Threshold</span>
							<input
								type="range"
								min={m.min}
								max={m.max}
								step={m.step ?? 1}
								value={v.threshold}
								onChange={(e) => onChange({ threshold: Number(e.target.value) })}
								className="flex-1 accent-[var(--primary)]"
							/>
							<span className="flex items-center gap-1">
								<Input
									type="number"
									min={m.min}
									max={m.max}
									step={m.step ?? 1}
									value={v.threshold}
									onChange={(e) => onChange({ threshold: Number(e.target.value) })}
									className="h-8 w-20"
								/>
								<span className="w-9 text-xs text-muted-foreground">{m.unit}</span>
							</span>
						</div>
					) : (
						<span className="self-center text-xs text-muted-foreground">Alert after offline for</span>
					)}
					{!m.event && (
						<div className="flex items-center gap-2">
							<span className="text-xs text-muted-foreground">{m.metric === "Status" ? "" : "Average over"}</span>
							<Input type="number" min={1} max={60} value={v.minutes} onChange={(e) => onChange({ minutes: Number(e.target.value) })} className="h-8 w-20" />
							<span className="text-xs text-muted-foreground">min</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

/**
 * Alerts for one system, plus an "All systems" tab like Beszel's alerts sheet: there each switch
 * starts off; turning one on adds that alert to every system that lacks it (or overwrites it on all
 * with "Overwrite existing alerts"), editing it re-applies to those systems, and turning it off
 * removes it from them again. Global changes apply immediately; the system tab saves on "Save".
 */
export function AlertsDialog({ systemId, systemName, open, onOpenChange }: { systemId: string; systemName: string; open: boolean; onOpenChange: (o: boolean) => void }) {
	const [tab, setTab] = useState<"system" | "all">("system");
	const [gen, setGen] = useState(0); // bumped by global changes so the system tab reloads
	useEffect(() => {
		if (open) setTab("system");
	}, [open]);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent wide>
				<DialogHeader title="Alerts" description="Threshold alerts fire when the average over the window exceeds the value, and resolve when it drops below. Update and service alerts notify when their state changes." />
				<Tabs value={tab} onValueChange={(v) => setTab(v as "system" | "all")} className="contents">
					<div className="px-6 pb-1">
						<TabsList className="w-full">
							<TabsTrigger value="system" className="flex-1">
								<Server />
								<span className="max-w-48 truncate">{systemName}</span>
							</TabsTrigger>
							<TabsTrigger value="all" className="flex-1">
								<Globe />
								All systems
							</TabsTrigger>
						</TabsList>
					</div>
					<TabsContent value="system" className="contents">
						{open && tab === "system" && <SystemTab key={gen} systemId={systemId} onClose={() => onOpenChange(false)} />}
					</TabsContent>
					<TabsContent value="all" className="contents">
						{open && tab === "all" && <AllSystemsTab onChanged={() => setGen((g) => g + 1)} onClose={() => onOpenChange(false)} />}
					</TabsContent>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}

function SystemTab({ systemId, onClose }: { systemId: string; onClose: () => void }) {
	const { run, busy } = useAction();
	const [draft, setDraft] = useState<Draft>();
	const [channels, setChannels] = useState<NotificationChannel[]>([]);
	const [selected, setSelected] = useState<string[]>([]);
	const [systems, setSystems] = useState<SystemRecord[]>([]);
	const [copyFrom, setCopyFrom] = useState("");
	const closeRef = useLatest(onClose);

	// Load once per system (the tab remounts when opened). Not on parent re-renders: the system page
	// polls every 15 s and passes a new onClose each time, which used to reload and wipe unsaved edits.
	useEffect(() => {
		let live = true;
		Promise.all([
			request<{ alerts: SystemAlert[]; notification_ids: string[] }>(`/api/admin/systems/${systemId}/alerts`),
			request<NotificationChannel[]>("/api/admin/notifications"),
			request<SystemRecord[]>("/api/admin/systems").catch(() => [] as SystemRecord[]),
		]).then(
			([a, ch, sys]) => {
				if (!live) return;
				setDraft(draftFrom(a.alerts));
				setChannels(ch);
				setSelected(a.notification_ids);
				setSystems(sys.filter((s) => s.id !== systemId));
			},
			() => live && closeRef.current(),
		);
		return () => {
			live = false;
		};
	}, [systemId, closeRef]);

	const update = (metric: SystemAlertMetric, patch: Partial<Value>) => setDraft((d) => d && { ...d, [metric]: { ...d[metric], ...patch } });

	// Beszel's "Copy from": take another system's alerts as they are (ones it lacks are switched off); saved with "Save".
	const copy = async (id: string) => {
		setCopyFrom(id);
		if (!id) return;
		const a = await run("copy", () => request<{ alerts: SystemAlert[] }>(`/api/admin/systems/${id}/alerts`));
		if (a) setDraft((d) => {
			const next = draftFrom(a.alerts);
			for (const m of METRICS) next[m.metric].triggered = d?.[m.metric].triggered;
			return next;
		});
	};

	const save = async () => {
		if (!draft) return;
		const alerts = METRICS.filter((m) => draft[m.metric].on).map((m) => toAlert(m, draft[m.metric]));
		const r = await run("save", () => admin.put(`/systems/${systemId}/alerts`, { alerts, notification_ids: selected }), "Alerts saved");
		if (r) onClose();
	};

	return (
		<>
			<DialogBody className="space-y-2">
				{!draft ? (
					Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-16" />)
				) : (
					<>
						{systems.length > 0 && (
							<div className="flex items-center justify-end gap-2 pb-1">
								<span className="text-xs text-muted-foreground">Copy from</span>
								<Select value={copyFrom} onChange={(e) => copy(e.target.value)} className="h-8 w-48" aria-label="Copy alerts from system">
									<option value="">Choose a system…</option>
									{systems.map((s) => (
										<option key={s.id} value={s.id}>
											{s.name}
										</option>
									))}
								</Select>
							</div>
						)}
						{METRICS.map((m) => (
							<AlertRow key={m.metric} m={m} v={draft[m.metric]} onChange={(p) => update(m.metric, p)} />
						))}
						<div className="pt-3">
							<p className="mb-1 text-sm font-medium">Notify these channels</p>
							{channels.length === 0 ? (
								<p className="text-xs text-muted-foreground">
									No channels yet.{" "}
									<Link href="/notifications" className="text-primary hover:underline">
										Add one under Notifications
									</Link>
									.
								</p>
							) : (
								<div className="grid gap-0.5 sm:grid-cols-2">
									{channels.map((c) => (
										<CheckRow
											key={c.id}
											label={c.name}
											description={`${c.type}${c.enabled ? "" : " · disabled"}`}
											checked={selected.includes(c.id)}
											onCheckedChange={(on) => setSelected((s) => (on ? [...s, c.id] : s.filter((x) => x !== c.id)))}
										/>
									))}
								</div>
							)}
						</div>
					</>
				)}
			</DialogBody>
			<DialogFooter>
				<Button variant="outline" onClick={onClose}>
					Cancel
				</Button>
				<Button onClick={save} loading={busy === "save"} disabled={!draft}>
					Save alerts
				</Button>
			</DialogFooter>
		</>
	);
}

type GlobalValue = Value & { applied?: string[] };

function AllSystemsTab({ onChanged, onClose }: { onChanged: () => void; onClose: () => void }) {
	const { run } = useAction();
	const [draft, setDraft] = useState<Record<SystemAlertMetric, GlobalValue>>(() => draftFrom([]));
	const [overwrite, setOverwrite] = useState(false);
	const queue = useRef<Partial<Record<SystemAlertMetric, Promise<unknown>>>>({});
	const timers = useRef<Partial<Record<SystemAlertMetric, ReturnType<typeof setTimeout>>>>({});
	const applied = useRef<Partial<Record<SystemAlertMetric, string[]>>>({});
	const overwriteRef = useRef(overwrite);
	overwriteRef.current = overwrite;
	useEffect(() => () => Object.values(timers.current).forEach((t) => clearTimeout(t)), []);

	// Per-alert requests run in order, so a quick on → off never removes before it was added.
	const enqueue = (metric: SystemAlertMetric, fn: () => Promise<unknown>) => {
		queue.current[metric] = (queue.current[metric] ?? Promise.resolve()).then(fn).then(onChanged, () => undefined);
	};

	const apply = (m: MetricDef, v: Value, first: boolean) =>
		enqueue(m.metric, async () => {
			const body = { ...toAlert(m, v), overwrite: overwriteRef.current, system_ids: first ? undefined : applied.current[m.metric] };
			const r = await run(`bulk-${m.metric}`, () => admin.post<{ system_ids: string[] }>("/alerts/bulk", body), first ? `${m.label} alert updated on all systems` : undefined);
			if (r && first) applied.current[m.metric] = overwriteRef.current ? undefined : r.system_ids;
		});

	const remove = (m: MetricDef) =>
		enqueue(m.metric, async () => {
			const ids = overwriteRef.current ? undefined : (applied.current[m.metric] ?? []);
			await run(`bulk-${m.metric}`, () => request("/api/admin/alerts/bulk", { method: "DELETE", body: { metric: m.metric, system_ids: ids } }), `${m.label} alert removed`);
			applied.current[m.metric] = undefined;
		});

	const update = (m: MetricDef, patch: Partial<Value>) => {
		const v = { ...draft[m.metric], ...patch };
		setDraft((d) => ({ ...d, [m.metric]: v }));
		clearTimeout(timers.current[m.metric]);
		if (patch.on === true) apply(m, v, true);
		else if (patch.on === false) remove(m);
		else if (v.on) timers.current[m.metric] = setTimeout(() => apply(m, v, false), 400);
	};

	return (
		<>
			<DialogBody className="space-y-2">
				<label className="flex cursor-pointer items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/5 p-3">
					<Checkbox checked={overwrite} onCheckedChange={(c) => setOverwrite(c === true)} className="mt-0.5" />
					<span>
						<span className="block text-sm font-medium">Overwrite existing alerts</span>
						<span className="text-xs text-muted-foreground">
							When checked, switching an alert on replaces that alert's settings on every system, and switching it off removes it from every system. Otherwise only systems
							without it get it (and lose it again when switched off).
						</span>
					</span>
				</label>
				<p className="px-1 text-xs text-muted-foreground">Changes apply to all systems right away. Each system keeps its own notification channels (set them on its own tab).</p>
				{METRICS.map((m) => (
					<AlertRow key={m.metric} m={m} v={draft[m.metric]} onChange={(p) => update(m, p)} />
				))}
			</DialogBody>
			<DialogFooter>
				<Button onClick={onClose}>Done</Button>
			</DialogFooter>
		</>
	);
}
