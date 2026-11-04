import type { SystemInstall, SystemRecord } from "@shared/types";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { admin, errorMessage } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { useLatest } from "@/lib/hooks";
import { splitList } from "@/lib/utils";
import { InstallInfo } from "./InstallInfo";

export function AddSystemDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (o: boolean) => void; onAdded: () => void }) {
	const [, navigate] = useLocation();
	const [name, setName] = useState("");
	const [tags, setTags] = useState("");
	const [error, setError] = useState<string>();
	const [saving, setSaving] = useState(false);
	const [created, setCreated] = useState<{ system: SystemRecord; install: SystemInstall }>();
	const [status, setStatus] = useState<SystemRecord["status"]>("pending");

	useEffect(() => {
		if (!open) {
			setName("");
			setTags("");
			setError(undefined);
			setCreated(undefined);
			setStatus("pending");
		}
	}, [open]);

	// Poll until the agent connects. onAdded via a ref: the systems list re-renders this every 15 s.
	const onAddedRef = useLatest(onAdded);
	useEffect(() => {
		if (!created || status === "up") return;
		const id = setInterval(async () => {
			try {
				const s = await admin.get<SystemRecord>(`/systems/${created.system.id}`);
				setStatus(s.status);
				if (s.status === "up") onAddedRef.current();
			} catch {
				/* keep polling */
			}
		}, 3000);
		return () => clearInterval(id);
	}, [created, status, onAddedRef]);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim()) return setError("Give the system a name");
		setSaving(true);
		setError(undefined);
		try {
			const r = await admin.post<{ system: SystemRecord; install: SystemInstall }>("/systems", { name: name.trim(), tags: splitList(tags) });
			setCreated(r);
			setStatus(r.system.status);
			onAdded();
		} catch (err) {
			setError(errorMessage(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent wide>
				{!created ? (
					<form onSubmit={submit} className="contents">
						<DialogHeader title="Add system" description="Register a server, then run the Beszel agent on it with the generated token." />
						<DialogBody className="space-y-4">
							<Field label="Name" error={error} htmlFor="sys-name">
								<Input id="sys-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="web-01" />
							</Field>
							<Field label="Tags" hint="Comma separated, e.g. prod, eu-west" htmlFor="sys-tags">
								<Input id="sys-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="prod, web" />
							</Field>
						</DialogBody>
						<DialogFooter>
							<Button variant="outline" onClick={() => onOpenChange(false)}>
								Cancel
							</Button>
							<Button type="submit" loading={saving}>
								Create &amp; show install
							</Button>
						</DialogFooter>
					</form>
				) : (
					<>
						<DialogHeader title={`Install the agent on ${created.system.name}`} description="Run one of these on the server. This dialog updates when the agent connects." />
						<DialogBody className="space-y-4">
							<InstallInfo install={created.install} />
							<div
								className={
									status === "up"
										? "flex items-center gap-2.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm"
										: "flex items-center gap-2.5 rounded-md border bg-muted/40 p-3 text-sm"
								}
							>
								{status === "up" ? (
									<>
										<CheckCircle2 className="size-5 text-emerald-500" />
										<span className="font-medium">Agent connected. Metrics will appear within a minute.</span>
									</>
								) : (
									<>
										<Loader2 className="size-5 animate-spin text-muted-foreground" />
										<span className="text-muted-foreground">Waiting for the agent to connect…</span>
									</>
								)}
							</div>
						</DialogBody>
						<DialogFooter>
							<Button variant="outline" onClick={() => onOpenChange(false)}>
								{status === "up" ? "Close" : "Do this later"}
							</Button>
							<Button
								onClick={() => {
									onOpenChange(false);
									navigate(`/systems/${created.system.id}`);
								}}
							>
								Open system
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
