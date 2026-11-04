import type { AccessSettings, DashboardUser, Role } from "@shared/types";
import { AlertTriangle, RefreshCw, Trash2, UserPlus, Users } from "lucide-react";
import { useState } from "react";
import { admin } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm";
import { Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAction, useToast } from "@/components/ui/toast";
import { formatDateTime } from "@/lib/format";
import { useApi } from "@/lib/hooks";
import { useCanEdit, useMe } from "@/dashboard/role";

const ROLE_LABEL: Record<Role, string> = { full: "Full", read: "Read-only" };

/** Settings → Access: who can sign in to the dashboard (mirrored into the Cloudflare Access policy). */
export function AccessCard() {
	const canEdit = useCanEdit();
	const me = useMe();
	const access = useApi<AccessSettings>(canEdit ? "/api/admin/access?check=1" : "/api/admin/access");
	const confirm = useConfirm();
	const toast = useToast();
	const { run, busy } = useAction();
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<Role>("read");
	const a = access.data;
	const setUsers = (users: DashboardUser[]) => a && access.setData({ ...a, users });

	const expected = a ? [...a.users.map((u) => u.email)].sort().join(",") : "";
	const drift = a?.policy && !a.policy.error && (a.policy.emails ?? []).slice().sort().join(",") !== expected && a.users.length > 1;
	const editable = canEdit && a?.configured;

	return (
		<Card className="lg:col-span-2">
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Users className="size-4" /> Access
				</CardTitle>
				<CardDescription>
					People who can sign in to this dashboard with a Cloudflare Access one-time PIN. <strong>Full</strong> can change anything; <strong>Read-only</strong> can view
					everything except tokens and notification credentials.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				{a && !a.configured && canEdit && (
					<div className="flex gap-2.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
						<AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
						<div className="space-y-1">
							<p className="font-medium">Adding people needs an API token</p>
							<p className="text-muted-foreground">
								Set the Worker secret <code className="font-mono">CF_ACCESS_API_TOKEN</code> to a Cloudflare API token with <em>Account → Access: Apps and Policies → Edit</em> so
								Richter can update the Access policy. Until then only the owner can sign in.
							</p>
						</div>
					</div>
				)}
				{a?.policy?.error && canEdit && (
					<div className="flex gap-2.5 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm">
						<AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-500" />
						<p>Couldn't read the Access policy: {a.policy.error}</p>
					</div>
				)}
				{drift && canEdit && (
					<div className="flex flex-wrap items-center gap-2.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
						<AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
						<span className="flex-1">The Cloudflare Access policy doesn't match this list.</span>
						<Button
							size="sm"
							variant="outline"
							loading={busy === "sync"}
							onClick={async () => {
								if (await run("sync", () => admin.post("/access/sync"), "Access policy updated")) access.reload();
							}}
						>
							<RefreshCw /> Sync now
						</Button>
					</div>
				)}

				{editable && (
					<form
						className="flex flex-wrap gap-2"
						onSubmit={async (e) => {
							e.preventDefault();
							if (!email.trim()) return;
							const r = await run("add", () => admin.post<{ users: DashboardUser[] }>("/access", { email: email.trim(), role }), `Added ${email.trim()}`);
							if (r) {
								setUsers(r.users);
								setEmail("");
							}
						}}
					>
						<Input type="email" required placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="min-w-56 flex-1" aria-label="Email" />
						<Select value={role} onChange={(e) => setRole(e.target.value as Role)} className="w-36" aria-label="Role">
							<option value="read">Read-only</option>
							<option value="full">Full</option>
						</Select>
						<Button type="submit" loading={busy === "add"}>
							<UserPlus /> Add
						</Button>
					</form>
				)}

				{!a ? (
					<Skeleton className="h-24" />
				) : (
					<ul className="divide-y rounded-md border">
						{a.users.map((u) => (
							<li key={u.email} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="truncate font-medium">{u.email}</span>
										{u.owner && <Badge className="border-primary/40 text-primary">Owner</Badge>}
										{me && u.email === me.email.toLowerCase() && <Badge>You</Badge>}
									</div>
									{!u.owner && (
										<p className="text-xs text-muted-foreground">
											Added {formatDateTime(u.created_at)}
											{u.added_by ? ` by ${u.added_by}` : ""}
										</p>
									)}
								</div>
								{u.owner || !editable ? (
									<Badge>{ROLE_LABEL[u.role]}</Badge>
								) : (
									<>
										<Select
											value={u.role}
											className="h-8 w-32"
											aria-label={`Role for ${u.email}`}
											disabled={busy === `role-${u.email}`}
											onChange={async (e) => {
												const next = e.target.value as Role;
												const r = await run(`role-${u.email}`, () => admin.patch<{ users: DashboardUser[] }>(`/access/${encodeURIComponent(u.email)}`, { role: next }), `${u.email} is now ${ROLE_LABEL[next]}`);
												if (r) setUsers(r.users);
											}}
										>
											<option value="read">Read-only</option>
											<option value="full">Full</option>
										</Select>
										<Button
											variant="ghost"
											size="icon-sm"
											className="hover:text-destructive"
											aria-label={`Remove ${u.email}`}
											loading={busy === `del-${u.email}`}
											onClick={async () => {
												const ok = await confirm({
													title: `Remove ${u.email}?`,
													description: "They lose dashboard access right away and are taken off the Cloudflare Access policy.",
													confirmLabel: "Remove",
													destructive: true,
												});
												if (!ok) return;
												const r = await run(`del-${u.email}`, () => admin.del<{ users: DashboardUser[]; warning?: string }>(`/access/${encodeURIComponent(u.email)}`), `Removed ${u.email}`);
												if (r) {
													setUsers(r.users);
													if (r.warning) toast.error("Access policy not updated", r.warning);
												}
											}}
										>
											<Trash2 />
										</Button>
									</>
								)}
							</li>
						))}
					</ul>
				)}
				{access.error && <p className="text-sm text-destructive">{access.error.message}</p>}
			</CardContent>
		</Card>
	);
}
