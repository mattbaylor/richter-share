import type { EventRecord, Settings } from "@shared/types";
import { Download, ExternalLink, History, Info, KeyRound, ShieldCheck, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { admin, errorMessage, request } from "@/api";
import { Logo } from "@/components/logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm";
import { CopyField } from "@/components/ui/copy";
import { ErrorState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import { useAction, useToast } from "@/components/ui/toast";
import { formatDateTime, timeAgo } from "@/lib/format";
import { useApi, useDocumentTitle } from "@/lib/hooks";
import { cn, downloadJson } from "@/lib/utils";
import { AccessCard } from "./AccessCard";
import { useCanEdit, useMe } from "@/dashboard/role";

const KIND_CLS: Record<string, string> = {
	down: "bg-red-500",
	up: "bg-emerald-500",
	alert: "bg-amber-500",
	connect: "bg-sky-500",
};
const kindDot = (kind: string) => KIND_CLS[Object.keys(KIND_CLS).find((k) => kind.includes(k)) ?? ""] ?? "bg-zinc-400";

export function SettingsPage() {
	useDocumentTitle("Settings · Richter");
	const settings = useApi<Settings>("/api/admin/settings");
	const me = { data: useMe() };
	const canEdit = useCanEdit();
	const events = useApi<EventRecord[]>("/api/admin/events?limit=100", { refreshMs: 60_000 });
	const toast = useToast();
	const confirm = useConfirm();
	const { run, busy } = useAction();
	const [title, setTitle] = useState("");
	const [tz, setTz] = useState("");
	const fileRef = useRef<HTMLInputElement>(null);

	// Fill the General form once, when settings first load. Later data changes (saves, imports) must not
	// overwrite unsaved typing; the save handler stores the server's values itself.
	const filled = useRef(false);
	useEffect(() => {
		if (settings.data && !filled.current) {
			filled.current = true;
			setTitle(settings.data.site_title);
			setTz(settings.data.timezone);
		}
	}, [settings.data]);

	const zones = useMemo(() => {
		try {
			return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
		} catch {
			return ["UTC"];
		}
	}, []);

	const s = settings.data;
	const dirty = s != null && (title !== s.site_title || tz !== s.timezone);

	const importFile = async (file: File) => {
		let json: unknown;
		try {
			json = JSON.parse(await file.text());
		} catch {
			return toast.error("Not a valid JSON file");
		}
		const ok = await confirm({
			title: "Import backup?",
			description: "Monitors, status pages, channels and systems from the file are merged into this instance. Systems need their agents re-pointed with new tokens.",
			confirmLabel: "Import",
		});
		if (!ok) return;
		const r = await run("import", () => admin.post<{ ok: boolean; counts?: Record<string, number> }>("/import", json));
		if (r)
			toast.success(
				"Import complete",
				r.counts
					? Object.entries(r.counts)
							.map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`)
							.join(", ")
					: undefined,
			);
	};

	return (
		<>
			<PageHeader title="Settings" />
			{settings.error && !s && <ErrorState error={settings.error} onRetry={settings.reload} />}
			<div className="grid gap-4 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>General</CardTitle>
						<CardDescription>Used in notifications and as the dashboard title.</CardDescription>
					</CardHeader>
					<CardContent>
						{!s ? (
							<Skeleton className="h-32" />
						) : (
							<form
								className="space-y-4"
								inert={!canEdit || undefined}
								onSubmit={async (e) => {
									e.preventDefault();
									const r = await run("save", () => admin.put<Settings>("/settings", { site_title: title.trim(), timezone: tz }), "Settings saved");
									if (r) {
										settings.setData(r);
										setTitle(r.site_title);
										setTz(r.timezone);
									}
								}}
							>
								<Field label="Site title">
									<Input value={title} onChange={(e) => setTitle(e.target.value)} />
								</Field>
								<Field label="Timezone" hint={`Used for daily rollups shown in notifications. Your browser: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`}>
									<Select value={tz} onChange={(e) => setTz(e.target.value)}>
										{!zones.includes(tz) && <option value={tz}>{tz}</option>}
										{zones.map((z) => (
											<option key={z}>{z}</option>
										))}
									</Select>
								</Field>
								{canEdit && (
									<div className="flex justify-end">
										<Button type="submit" disabled={!dirty} loading={busy === "save"}>
											Save
										</Button>
									</div>
								)}
							</form>
						)}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<KeyRound className="size-4" /> Hub &amp; URLs
						</CardTitle>
						<CardDescription>The agent's KEY is the hub public key. Agents and heartbeat pings use the public URL.</CardDescription>
					</CardHeader>
					<CardContent className="space-y-3">
						{!s ? (
							<Skeleton className="h-32" />
						) : (
							<>
								<Field label="Hub public key (KEY)">
									<CopyField value={s.hub_public_key} />
								</Field>
								<Field label="Public URL" hint="Status pages, badges, feed, pings and agent WebSocket">
									<div className="flex gap-2">
										<CopyField value={s.public_url} className="flex-1" />
										<Button variant="outline" size="icon" asChild>
											<a href={s.public_url} target="_blank" rel="noreferrer" aria-label="Open public URL">
												<ExternalLink />
											</a>
										</Button>
									</div>
								</Field>
								<Field label="Dashboard URL" hint="Protected by Cloudflare Access">
									<CopyField value={s.dashboard_url} />
								</Field>
							</>
						)}
					</CardContent>
				</Card>

				{canEdit && <Card>
					<CardHeader>
						<CardTitle>Backup</CardTitle>
						<CardDescription>Export monitors, status pages, channels, maintenance, announcements and systems (without tokens) as JSON.</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-wrap gap-2">
						<Button
							variant="outline"
							loading={busy === "export"}
							onClick={async () => {
								const data = await run("export", () => request<unknown>("/api/admin/export"));
								if (data) downloadJson(`richter-backup-${new Date().toISOString().slice(0, 10)}.json`, data);
							}}
						>
							<Download /> Export JSON
						</Button>
						<Button variant="outline" loading={busy === "import"} onClick={() => fileRef.current?.click()}>
							<Upload /> Import JSON
						</Button>
						<input
							ref={fileRef}
							type="file"
							accept="application/json,.json"
							className="hidden"
							onChange={(e) => {
								const f = e.target.files?.[0];
								e.target.value = "";
								if (f) importFile(f).catch((err) => toast.error("Import failed", errorMessage(err)));
							}}
						/>
					</CardContent>
				</Card>}

				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<Info className="size-4" /> About
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3 text-sm">
						<div className="flex items-center gap-3">
							<Logo className="size-9" />
							<div>
								<p className="font-semibold">Richter</p>
								<p className="text-xs text-muted-foreground">Serverless system monitor on Cloudflare Workers, D1 and Durable Objects. Compatible with the Beszel agent (WebSocket mode).</p>
							</div>
						</div>
						<div className="flex items-center gap-2 rounded-md border bg-muted/30 p-2.5">
							<ShieldCheck className="size-4 text-emerald-500" />
							<span className="text-muted-foreground">Signed in via Cloudflare Access as</span>
							{me.data ? <span className="font-medium">{me.data.email}</span> : <Skeleton className="h-4 w-32" />}
							{me.data && <Badge className="ml-auto">{me.data.role === "full" ? "Full access" : "Read-only"}</Badge>}
						</div>
					</CardContent>
				</Card>

				<AccessCard />

				<Card className="lg:col-span-2">
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							<History className="size-4" /> Recent events
						</CardTitle>
						<CardDescription>Status changes, alerts and agent connections (kept 90 days).</CardDescription>
					</CardHeader>
					<CardContent>
						{events.loading && !events.data ? (
							<div className="space-y-2">
								{Array.from({ length: 5 }, (_, i) => (
									<Skeleton key={i} className="h-8" />
								))}
							</div>
						) : (events.data ?? []).length === 0 ? (
							<p className="py-6 text-center text-sm text-muted-foreground">No events yet.</p>
						) : (
							<ol className="max-h-[420px] divide-y overflow-y-auto">
								{events.data!.map((e) => (
									<li key={e.id} className="flex items-start gap-3 py-2 text-sm">
										<span className={cn("mt-1.5 size-2 shrink-0 rounded-full", kindDot(e.kind))} />
										<span className="flex-1">{e.message}</span>
										<Badge className="hidden sm:inline-flex">{e.kind}</Badge>
										<span className="w-20 shrink-0 text-right text-xs text-muted-foreground" title={formatDateTime(e.ts)}>
											{timeAgo(e.ts)}
										</span>
									</li>
								))}
							</ol>
						)}
					</CardContent>
				</Card>
			</div>
		</>
	);
}
