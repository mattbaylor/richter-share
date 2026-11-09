import type { SystemRecord } from "@shared/types";
import { BookOpen, Pencil } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { admin } from "@/api";
import { StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { useAction } from "@/components/ui/toast";
import { useApi, useLatest } from "@/lib/hooks";
import { linesToRefs, refsToLines } from "@shared/system-docs";

type LinkKey = "depends_on" | "works_with";

/**
 * What a system is for: a free-text description, the services it provides, and the systems (or
 * outside services) it depends on and works with. "Needed by" and "Works with" also list the systems
 * that point at this one, so a link only has to be written down on one side.
 */
export function SystemAbout({ system, canEdit, onSaved }: { system: SystemRecord; canEdit: boolean; onSaved: (s: SystemRecord) => void }) {
	const all = useApi<SystemRecord[]>("/api/admin/systems", { refreshMs: 60_000 });
	const [editing, setEditing] = useState(false);
	const byId = useMemo(() => new Map((all.data ?? []).map((s) => [s.id, s])), [all.data]);
	const others = (all.data ?? []).filter((s) => s.id !== system.id);
	const neededBy = others.filter((s) => s.depends_on.includes(system.id));
	const worksWith = uniq([...system.works_with, ...others.filter((s) => s.works_with.includes(system.id)).map((s) => s.id)]);
	const empty = !system.description && !system.provides.length && !system.depends_on.length && !worksWith.length && !neededBy.length;

	if (empty && !canEdit) return null;
	return (
		<Card className="mb-4 p-4">
			<div className="flex items-start justify-between gap-3">
				<h2 className="flex items-center gap-2 text-sm font-semibold">
					<BookOpen className="size-4 opacity-70" /> About this system
				</h2>
				{canEdit && (
					<Button size="sm" variant="outline" onClick={() => setEditing(true)}>
						<Pencil /> {empty ? "Describe" : "Edit"}
					</Button>
				)}
			</div>
			{empty ? (
				<p className="mt-2 text-sm text-muted-foreground">
					No description yet. Write down what this system does, what it needs and what it works with, so you don't have to remember it.
				</p>
			) : (
				<div className="mt-3 space-y-3 text-sm">
					{system.description && <p className="whitespace-pre-wrap leading-relaxed">{system.description}</p>}
					<dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
						<Row label="Provides" items={system.provides.map((p) => <span key={p}>{p}</span>)} />
						<Row label="Depends on" items={system.depends_on.map((x) => <Ref key={x} value={x} byId={byId} />)} />
						<Row label="Needed by" items={neededBy.map((s) => <Ref key={s.id} value={s.id} byId={byId} />)} />
						<Row label="Works with" items={worksWith.map((x) => <Ref key={x} value={x} byId={byId} />)} />
					</dl>
				</div>
			)}
			<EditAboutDialog system={system} systems={all.data ?? []} open={editing} onOpenChange={setEditing} onSaved={onSaved} />
		</Card>
	);
}

function Row({ label, items }: { label: string; items: React.ReactNode[] }) {
	if (!items.length) return null;
	return (
		<div className="min-w-0">
			<dt className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
			<dd>
				<ul className="space-y-0.5">
					{items.map((it, i) => (
						<li key={i} className="flex items-center gap-1.5">
							{it}
						</li>
					))}
				</ul>
			</dd>
		</div>
	);
}

/** A link to the system when the entry is a system id, otherwise the text itself. */
function Ref({ value, byId }: { value: string; byId: Map<string, SystemRecord> }) {
	const s = byId.get(value);
	if (!s) return <span className="text-muted-foreground">{value}</span>;
	return (
		<Link href={`/systems/${s.id}`} className="flex items-center gap-1.5 hover:underline">
			<StatusDot status={s.status} />
			{s.name}
		</Link>
	);
}

function uniq(xs: string[]): string[] {
	return [...new Set(xs)];
}

function EditAboutDialog({
	system,
	systems,
	open,
	onOpenChange,
	onSaved,
}: {
	system: SystemRecord;
	systems: SystemRecord[];
	open: boolean;
	onOpenChange: (o: boolean) => void;
	onSaved: (s: SystemRecord) => void;
}) {
	const { run, busy } = useAction();
	const [description, setDescription] = useState("");
	const [provides, setProvides] = useState("");
	const [links, setLinks] = useState<Record<LinkKey, string>>({ depends_on: "", works_with: "" });
	// Fill the form only when the dialog opens: the system is refetched every 15 s and must not overwrite typing.
	const latest = useLatest({ system, systems });
	useEffect(() => {
		if (!open) return;
		const { system: s, systems: all } = latest.current;
		setDescription(s.description ?? "");
		setProvides(s.provides.join("\n"));
		setLinks({ depends_on: refsToLines(s.depends_on, all), works_with: refsToLines(s.works_with, all) });
	}, [open, latest]);
	const names = systems.filter((s) => s.id !== system.id).map((s) => s.name);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent wide>
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						const r = await run(
							"save",
							() =>
								admin.patch<SystemRecord>(`/systems/${system.id}`, {
									description: description.trim() || null,
									provides: provides.split("\n").map((l) => l.trim()).filter(Boolean),
									depends_on: linesToRefs(links.depends_on, systems),
									works_with: linesToRefs(links.works_with, systems),
								}),
							"Description saved",
						);
						if (r) {
							onSaved(r);
							onOpenChange(false);
						}
					}}
				>
					<DialogHeader title={`About ${system.name}`} description="What it does and how it fits with everything else." />
					<DialogBody className="space-y-4">
						<Field label="What it does">
							<Textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Reverse proxy and SSO front door for the datacenter's public IP…" />
						</Field>
						<Field label="Provides" hint="One service per line, e.g. a hostname and what it serves.">
							<Textarea rows={3} value={provides} onChange={(e) => setProvides(e.target.value)} />
						</Field>
						<div className="grid gap-4 sm:grid-cols-2">
							<Field label="Depends on" hint="One per line. A system's name becomes a link; anything else (Cloudflare, Twingate…) is kept as text.">
								<Textarea rows={5} value={links.depends_on} onChange={(e) => setLinks((l) => ({ ...l, depends_on: e.target.value }))} />
							</Field>
							<Field label="Works with" hint="Systems it cooperates with but doesn't need. Same format.">
								<Textarea rows={5} value={links.works_with} onChange={(e) => setLinks((l) => ({ ...l, works_with: e.target.value }))} />
							</Field>
						</div>
						{names.length > 0 && <p className="text-xs text-muted-foreground">Systems: {names.join(", ")}</p>}
					</DialogBody>
					<DialogFooter>
						<Button variant="outline" onClick={() => onOpenChange(false)}>
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
