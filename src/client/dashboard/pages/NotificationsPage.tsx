import { NOTIFICATION_FIELDS, type NotificationChannel, type NotificationLogEntry, type NotificationType } from "@shared/types";
import { Bell, CheckCircle2, Eye, EyeOff, History, Pencil, Plus, Send, Trash2, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { admin, ApiError, errorMessage } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { PageHeader, Table, Td, Th, Tr } from "@/components/ui/page";
import { TableSkeleton } from "@/components/ui/skeleton";
import { Switch, SwitchRow } from "@/components/ui/switch";
import { useAction, useToast } from "@/components/ui/toast";
import { formatDateTime } from "@/lib/format";
import { useApi, useDocumentTitle } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { useCanEdit } from "@/dashboard/role";

const TYPE_LABEL: Record<NotificationType, string> = {
	discord: "Discord",
	slack: "Slack",
	telegram: "Telegram",
	ntfy: "ntfy",
	gotify: "Gotify",
	pushover: "Pushover",
	webhook: "Webhook",
};
const TYPES = Object.keys(NOTIFICATION_FIELDS) as NotificationType[];

export function NotificationsPage() {
	useDocumentTitle("Notifications · Richter");
	const { data, error, loading, reload, setData } = useApi<NotificationChannel[]>("/api/admin/notifications");
	const [editing, setEditing] = useState<NotificationChannel | "new" | null>(null);
	const confirm = useConfirm();
	const toast = useToast();
	const { run, busy } = useAction();
	const [logGen, setLogGen] = useState(0);
	const canEdit = useCanEdit();

	const patch = async (c: NotificationChannel, body: Partial<NotificationChannel>) => {
		setData((xs) => xs?.map((x) => (x.id === c.id ? { ...x, ...body } : x)));
		const r = await run(`patch-${c.id}`, () => admin.patch<NotificationChannel>(`/notifications/${c.id}`, body));
		if (!r) reload();
	};

	return (
		<>
			<PageHeader
				title="Notifications"
				description="Channels that receive monitor and system alerts. Default channels are pre-selected on new monitors and systems."
				actions={
					canEdit && (
						<Button onClick={() => setEditing("new")}>
							<Plus /> Add channel
						</Button>
					)
				}
			/>
			{error && !data && <ErrorState error={error} onRetry={reload} />}
			{loading && !data ? (
				<Card>
					<TableSkeleton rows={3} cols={5} />
				</Card>
			) : data && data.length === 0 ? (
				<Card>
					<EmptyState
						icon={Bell}
						title="No notification channels"
						action={
							canEdit && (
								<Button onClick={() => setEditing("new")}>
									<Plus /> Add a channel
								</Button>
							)
						}
					>
						Send alerts to Discord, Slack, Telegram, ntfy, Gotify, Pushover or any webhook when a monitor goes down or a server crosses a threshold.
					</EmptyState>
				</Card>
			) : data ? (
				<Card className="overflow-hidden">
					<Table>
						<thead className="border-b bg-muted/30">
							<tr>
								<Th className="pl-4">Name</Th>
								<Th>Type</Th>
								<Th>Enabled</Th>
								<Th>Default</Th>
								{canEdit && <Th className="pr-4 text-right">Actions</Th>}
							</tr>
						</thead>
						<tbody>
							{data.map((c) => (
								<Tr key={c.id}>
									<Td className="pl-4 font-medium">{c.name}</Td>
									<Td>
										<Badge>{TYPE_LABEL[c.type] ?? c.type}</Badge>
									</Td>
									<Td>
										<Switch checked={c.enabled} onCheckedChange={(v) => patch(c, { enabled: v })} aria-label="Enabled" disabled={!canEdit} />
									</Td>
									<Td>
										<Switch checked={c.apply_default} onCheckedChange={(v) => patch(c, { apply_default: v })} aria-label="Default" disabled={!canEdit} />
									</Td>
									{canEdit && <Td className="pr-4">
										<div className="flex justify-end gap-1">
											<Button
												variant="outline"
												size="sm"
												loading={busy === `test-${c.id}`}
												onClick={async () => {
													const r = await run(`test-${c.id}`, () => admin.post<{ ok: boolean; error?: string }>(`/notifications/${c.id}/test`));
													if (r) setLogGen((g) => g + 1);
													if (r?.ok) toast.success("Test notification sent", `Check ${c.name}.`);
													else if (r) toast.error("Test failed", r.error);
												}}
											>
												<Send /> Send test
											</Button>
											<Button variant="ghost" size="icon-sm" onClick={() => setEditing(c)} aria-label="Edit">
												<Pencil />
											</Button>
											<Button
												variant="ghost"
												size="icon-sm"
												className="hover:text-destructive"
												aria-label="Delete"
												onClick={async () => {
													if (await confirm({ title: `Delete “${c.name}”?`, description: "Monitors and systems using it will stop notifying through it.", confirmLabel: "Delete", destructive: true }))
														if (await run("del", () => admin.del(`/notifications/${c.id}`), "Channel deleted")) reload();
												}}
											>
												<Trash2 />
											</Button>
										</div>
									</Td>}
								</Tr>
							))}
						</tbody>
					</Table>
				</Card>
			) : null}
			<NotificationLog gen={logGen} />
			<ChannelDialog
				value={editing}
				onClose={() => setEditing(null)}
				onSaved={() => {
					setEditing(null);
					reload();
				}}
			/>
		</>
	);
}

interface Draft {
	name: string;
	type: NotificationType;
	config: Record<string, string>;
	enabled: boolean;
	apply_default: boolean;
	apply_existing?: boolean;
}

function ChannelDialog({ value, onClose, onSaved }: { value: NotificationChannel | "new" | null; onClose: () => void; onSaved: () => void }) {
	const toast = useToast();
	const [d, setD] = useState<Draft>();
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [reveal, setReveal] = useState<Record<string, boolean>>({});
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (value == null) return;
		setErrors({});
		setReveal({});
		setD(value === "new" ? { name: "", type: "discord", config: {}, enabled: true, apply_default: false } : { name: value.name, type: value.type, config: { ...value.config }, enabled: value.enabled, apply_default: value.apply_default });
	}, [value]);

	if (!d) return null;
	const fields = NOTIFICATION_FIELDS[d.type] ?? [];

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		const errs: Record<string, string> = {};
		if (!d.name.trim()) errs.name = "Required";
		for (const f of fields) if (f.required && !d.config[f.key]?.trim()) errs[f.key] = "Required";
		setErrors(errs);
		if (Object.keys(errs).length) return;
		// Only send keys that belong to this type, without empty strings.
		const config = Object.fromEntries(fields.filter((f) => d.config[f.key]?.trim()).map((f) => [f.key, d.config[f.key].trim()]));
		setSaving(true);
		try {
			const body = { ...d, name: d.name.trim(), config };
			if (value === "new") await admin.post("/notifications", body);
			else await admin.patch(`/notifications/${(value as NotificationChannel).id}`, body);
			toast.success("Channel saved");
			onSaved();
		} catch (err) {
			if (err instanceof ApiError && err.field) setErrors({ [err.field.replace(/^config\./, "")]: err.message });
			toast.error("Could not save channel", errorMessage(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={value != null} onOpenChange={(o) => !o && onClose()}>
			<DialogContent>
				<form onSubmit={submit} className="contents">
					<DialogHeader title={value === "new" ? "Add notification channel" : `Edit ${d.name}`} />
					<DialogBody className="space-y-4">
						<div className="grid gap-4 sm:grid-cols-2">
							<Field label="Name" error={errors.name}>
								<Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Ops Discord" autoFocus />
							</Field>
							<Field label="Type">
								<Select value={d.type} onChange={(e) => setD({ ...d, type: e.target.value as NotificationType })} disabled={value !== "new"}>
									{TYPES.map((t) => (
										<option key={t} value={t}>
											{TYPE_LABEL[t] ?? t}
										</option>
									))}
								</Select>
							</Field>
						</div>
						{fields.map((f) => {
							const v = d.config[f.key] ?? "";
							const setV = (val: string) => setD({ ...d, config: { ...d.config, [f.key]: val } });
							return (
								<Field key={`${d.type}-${f.key}`} label={`${f.label}${f.required ? "" : " (optional)"}`} error={errors[f.key]}>
									{f.key === "body_template" ? (
										<Textarea value={v} onChange={(e) => setV(e.target.value)} placeholder={f.placeholder} rows={3} className="font-mono text-xs" />
									) : (
										<div className="relative">
											<Input
												type={f.secret && !reveal[f.key] ? "password" : "text"}
												value={v}
												onChange={(e) => setV(e.target.value)}
												placeholder={f.placeholder}
												autoComplete="off"
												className={f.secret ? "pr-9" : undefined}
											/>
											{f.secret && (
												<button
													type="button"
													onClick={() => setReveal((r) => ({ ...r, [f.key]: !r[f.key] }))}
													className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
													aria-label={reveal[f.key] ? "Hide" : "Show"}
												>
													{reveal[f.key] ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
												</button>
											)}
										</div>
									)}
								</Field>
							);
						})}
						{d.type === "webhook" && (
							<p className="text-xs text-muted-foreground">
								Template variables: <code className="font-mono">{"{{name}} {{status}} {{message}} {{url}} {{time}}"}</code>. Without a template the JSON event is posted.
							</p>
						)}
						<div className="divide-y rounded-lg border px-3">
							<SwitchRow label="Enabled" checked={d.enabled} onCheckedChange={(v) => setD({ ...d, enabled: v })} />
							<SwitchRow label="Default channel" description="Pre-selected on new monitors and systems." checked={d.apply_default} onCheckedChange={(v) => setD({ ...d, apply_default: v })} />
							<SwitchRow label="Apply to all existing" description="Attach this channel to every current monitor and system on save." checked={!!d.apply_existing} onCheckedChange={(v) => setD({ ...d, apply_existing: v })} />
						</div>
					</DialogBody>
					<DialogFooter>
						<Button variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" loading={saving}>
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

const LOG_PAGE = 50;

/** Every send to every channel (alerts and tests), newest first, kept 90 days. */
function NotificationLog({ gen }: { gen: number }) {
	const [entries, setEntries] = useState<NotificationLogEntry[]>();
	const [more, setMore] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<Error>();

	const load = useCallback(async (before?: number) => {
		setLoading(true);
		try {
			const r = await admin.get<{ entries: NotificationLogEntry[]; more: boolean }>(`/notification-log?limit=${LOG_PAGE}${before ? `&before=${before}` : ""}`);
			setEntries((xs) => (before && xs ? [...xs, ...r.entries] : r.entries));
			setMore(r.more);
			setError(undefined);
		} catch (e) {
			setError(e as Error);
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load, gen]);

	return (
		<Card className="mt-6 overflow-hidden">
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2">
					<History className="size-4 text-muted-foreground" /> Notification log
				</CardTitle>
				<CardDescription>Every notification sent to each channel, including tests. Kept for 90 days.</CardDescription>
			</CardHeader>
			{error && !entries ? (
				<ErrorState error={error} onRetry={() => load()} />
			) : !entries ? (
				<TableSkeleton rows={4} cols={5} />
			) : entries.length === 0 ? (
				<p className="border-t px-4 py-8 text-center text-sm text-muted-foreground">No notifications sent yet.</p>
			) : (
				<>
					<div className="overflow-x-auto border-t">
						<Table>
							<thead className="border-b bg-muted/30">
								<tr>
									<Th className="pl-4">Time</Th>
									<Th>Channel</Th>
									<Th>Notification</Th>
									<Th>About</Th>
									<Th className="pr-4">Result</Th>
								</tr>
							</thead>
							<tbody>
								{entries.map((e) => (
									<Tr key={e.id}>
										<Td className="whitespace-nowrap pl-4 align-top text-xs tabular-nums text-muted-foreground">{formatDateTime(e.ts)}</Td>
										<Td className="align-top">
											<div className="whitespace-nowrap font-medium">{e.channel_name}</div>
											<Badge className="mt-1">{TYPE_LABEL[e.channel_type as NotificationType] ?? e.channel_type}</Badge>
										</Td>
										<Td className="min-w-56 max-w-md align-top">
											<div className="font-medium">{e.title}</div>
											<div className="line-clamp-2 text-xs text-muted-foreground" title={e.body}>
												{e.body}
											</div>
										</Td>
										<Td className="whitespace-nowrap align-top">
											<LogTarget e={e} />
										</Td>
										<Td className="pr-4 align-top">
											{e.ok ? (
												<span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-emerald-600 dark:text-emerald-400">
													<CheckCircle2 className="size-3.5" /> Sent
												</span>
											) : (
												<div className="max-w-xs">
													<span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-destructive">
														<XCircle className="size-3.5" /> Failed
													</span>
													{e.error && (
														<div className="line-clamp-2 break-all font-mono text-[11px] text-muted-foreground" title={e.error}>
															{e.error}
														</div>
													)}
												</div>
											)}
										</Td>
									</Tr>
								))}
							</tbody>
						</Table>
					</div>
					{more && (
						<div className="flex justify-center border-t p-3">
							<Button variant="outline" size="sm" loading={loading} onClick={() => load(entries[entries.length - 1]?.id)}>
								Load more
							</Button>
						</div>
					)}
				</>
			)}
		</Card>
	);
}

function LogTarget({ e }: { e: NotificationLogEntry }) {
	if (e.target_kind === "test") return <span className="text-xs text-muted-foreground">Test send</span>;
	const kind = e.target_kind === "monitor" ? "Monitor" : "System";
	const href = e.target_id ? `/${e.target_kind}s/${e.target_id}` : null;
	return (
		<div>
			{href ? (
				<Link href={href} className={cn("font-medium hover:text-primary hover:underline")}>
					{e.target_name}
				</Link>
			) : (
				<span className="font-medium">{e.target_name}</span>
			)}
			<div className="text-xs text-muted-foreground">{kind}</div>
		</div>
	);
}
