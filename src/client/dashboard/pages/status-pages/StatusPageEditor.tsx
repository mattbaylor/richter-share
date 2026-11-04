import {
	closestCenter,
	type CollisionDetection,
	DndContext,
	type DragEndEvent,
	type DragOverEvent,
	KeyboardSensor,
	PointerSensor,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { MonitorListItem, StatusPage, StatusPageInput, SystemRecord } from "@shared/types";
import { Activity, ArrowLeft, ExternalLink, GripVertical, Link2, Link2Off, Plus, Search, Server, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { admin, ApiError, errorMessage } from "@/api";
import { StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogBody, DialogContent, DialogHeader } from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Field, Input, Textarea } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page";
import { Skeleton } from "@/components/ui/skeleton";
import { SwitchRow } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { useApi, useDocumentTitle } from "@/lib/hooks";
import { MONITOR_TYPE_LABEL } from "@/lib/status";
import { cn } from "@/lib/utils";
import { useCanEdit } from "@/dashboard/role";

interface EItem {
	uid: string;
	kind: "monitor" | "system";
	id: string;
	/** Website monitors: whether the public item links to the site (default true). */
	link?: boolean;
}
interface EGroup {
	uid: string;
	name: string;
	items: EItem[];
}
type Settings = Omit<StatusPageInput, "layout">;

let uidSeq = 0;
const uid = (p: string) => `${p}${++uidSeq}`;

function toEditor(p: StatusPage): EGroup[] {
	return p.layout.map((g) => ({ uid: uid("g"), name: g.name, items: g.items.map((i) => ({ uid: uid("i"), kind: i.kind, id: i.id, link: i.link !== false })) }));
}
function fromEditor(groups: EGroup[]): StatusPage["layout"] {
	return groups.map((g) => ({ name: g.name.trim() || "Untitled group", items: g.items.map(({ kind, id, link }) => (kind === "monitor" && link === false ? { kind, id, link: false } : { kind, id })) }));
}
function settingsOf(p: StatusPage): Settings {
	return {
		slug: p.slug,
		title: p.title,
		description: p.description,
		logo_url: p.logo_url,
		custom_domain: p.custom_domain,
		footer_text: p.footer_text,
		accent_color: p.accent_color,
		custom_css: p.custom_css,
		published: p.published,
		is_default: p.is_default,
		show_uptime_bars: p.show_uptime_bars,
		show_latency: p.show_latency,
		show_tags: p.show_tags,
		show_system_uptime: p.show_system_uptime,
		show_system_cpu: p.show_system_cpu ?? true,
		show_mobile_sparklines: p.show_mobile_sparklines ?? true,
	};
}

export function StatusPageEditor({ id }: { id: string }) {
	const toast = useToast();
	const canEdit = useCanEdit();
	const page = useApi<StatusPage>(`/api/admin/status-pages/${id}`);
	const monitors = useApi<MonitorListItem[]>("/api/admin/monitors");
	const systems = useApi<SystemRecord[]>("/api/admin/systems");
	const [settings, setSettings] = useState<Settings>();
	const [groups, setGroups] = useState<EGroup[]>([]);
	const [saved, setSaved] = useState("");
	const [saving, setSaving] = useState(false);
	const [fieldError, setFieldError] = useState<{ field?: string; message: string }>();
	const [picker, setPicker] = useState<string | null>(null);
	useDocumentTitle(settings ? `${settings.title} · Status page · Richter` : undefined);

	useEffect(() => {
		if (!page.data || settings) return;
		const s = settingsOf(page.data);
		const g = toEditor(page.data);
		setSettings(s);
		setGroups(g);
		setSaved(JSON.stringify([s, fromEditor(g)]));
	}, [page.data, settings]);

	const dirty = settings != null && JSON.stringify([settings, fromEditor(groups)]) !== saved;
	useEffect(() => {
		if (!dirty) return;
		const h = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener("beforeunload", h);
		return () => window.removeEventListener("beforeunload", h);
	}, [dirty]);

	const lookup = useMemo(() => {
		const m: Lookup = new Map((monitors.data ?? []).map((x) => [`monitor:${x.id}`, { name: x.name, status: x.status, hint: MONITOR_TYPE_LABEL[x.type], linkable: x.type === "http" }]));
		for (const s of systems.data ?? []) m.set(`system:${s.id}`, { name: s.name, status: s.status, hint: "System" });
		return m;
	}, [monitors.data, systems.data]);

	if (page.error && !page.data) return <ErrorState error={page.error} onRetry={page.reload} />;
	if (!settings || !page.data)
		return (
			<div className="space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-96" />
			</div>
		);

	const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setSettings((s) => s && { ...s, [k]: v });
	const str = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(k, (e.target.value || null) as never);

	const save = async () => {
		if (!settings.title.trim()) return setFieldError({ field: "title", message: "Title is required" });
		if (!/^[a-z0-9-]+$/.test(settings.slug)) return setFieldError({ field: "slug", message: "Lowercase letters, digits and dashes only" });
		setSaving(true);
		setFieldError(undefined);
		try {
			const layout = fromEditor(groups);
			const p = await admin.patch<StatusPage>(`/status-pages/${id}`, { ...settings, layout });
			page.setData(p);
			const s = settingsOf(p);
			setSettings(s);
			setSaved(JSON.stringify([s, fromEditor(groups)]));
			toast.success("Status page saved");
		} catch (e) {
			setFieldError({ field: e instanceof ApiError ? e.field : undefined, message: errorMessage(e) });
			toast.error("Could not save", errorMessage(e));
		} finally {
			setSaving(false);
		}
	};

	const err = (f: string) => (fieldError?.field === f ? fieldError.message : undefined);

	return (
		<>
			<Link href="/status-pages" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
				<ArrowLeft className="size-4" /> Status pages
			</Link>
			<PageHeader
				title={settings.title || "Untitled page"}
				description={
					<a href={page.data.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
						{page.data.url} <ExternalLink className="size-3.5" />
					</a>
				}
				actions={
					<>
						{dirty && <span className="text-xs text-amber-600 dark:text-amber-400">Unsaved changes</span>}
						<Button variant="outline" asChild title={settings.published ? undefined : "Draft pages are only visible after publishing"}>
							<a href={page.data.url} target="_blank" rel="noreferrer">
								<ExternalLink /> Open public page
							</a>
						</Button>
						{canEdit && (
							<Button onClick={save} loading={saving} disabled={!dirty}>
								Save
							</Button>
						)}
					</>
				}
			/>
			{fieldError && !fieldError.field && <p className="mb-3 text-sm text-destructive">{fieldError.message}</p>}

			<Tabs defaultValue="layout" className="min-w-0">
				<TabsList className="mb-3">
					<TabsTrigger value="layout">Layout</TabsTrigger>
					<TabsTrigger value="settings">Settings</TabsTrigger>
					<TabsTrigger value="appearance">Appearance</TabsTrigger>
				</TabsList>

				<TabsContent value="layout">
<fieldset disabled={!canEdit} className="min-w-0">
					<LayoutEditor groups={groups} setGroups={setGroups} lookup={lookup} onPick={setPicker} />
				</fieldset>
</TabsContent>

				<TabsContent value="settings">
<fieldset disabled={!canEdit} className="min-w-0">
					<Card className="space-y-4 p-4">
						<div className="grid gap-4 sm:grid-cols-2">
							<Field label="Title" error={err("title")}>
								<Input value={settings.title} onChange={(e) => set("title", e.target.value)} />
							</Field>
							<Field label="Slug" error={err("slug")} hint={`/s/${settings.slug}`}>
								<Input value={settings.slug} onChange={(e) => set("slug", e.target.value.toLowerCase())} />
							</Field>
						</div>
						<Field label="Description">
							<Textarea value={settings.description ?? ""} onChange={str("description")} rows={2} placeholder="Shown under the title" />
						</Field>
						<Field
							label="Custom domain"
							error={err("custom_domain")}
							hint={
								<>
									Serves this page at <code>/</code> on its own hostname. Attach the hostname to the Worker as a custom domain out-of-band (see the README).
								</>
							}
						>
							<Input value={settings.custom_domain ?? ""} onChange={str("custom_domain")} placeholder="status.example.com" />
						</Field>
						<Field label="Footer text">
							<Input value={settings.footer_text ?? ""} onChange={str("footer_text")} placeholder="Questions? ops@example.com" />
						</Field>
						<div className="divide-y rounded-lg border px-3">
							<SwitchRow label="Published" description="Unpublished pages return 404 publicly." checked={!!settings.published} onCheckedChange={(v) => set("published", v)} />
							<SwitchRow label="Default page" description="Shown at / on the public host." checked={!!settings.is_default} onCheckedChange={(v) => set("is_default", v)} />
							<SwitchRow label="Uptime bars" description="90 daily bars per item." checked={!!settings.show_uptime_bars} onCheckedChange={(v) => set("show_uptime_bars", v)} />
							<SwitchRow label="Latency sparklines" description="24h response time for monitors." checked={!!settings.show_latency} onCheckedChange={(v) => set("show_latency", v)} />
							<SwitchRow label="Tags" description="Show monitor tags next to names." checked={!!settings.show_tags} onCheckedChange={(v) => set("show_tags", v)} />
							<SwitchRow
								label="System uptime"
								description="90-day uptime % (and bars, if on) for systems, like monitors."
								checked={!!settings.show_system_uptime}
								onCheckedChange={(v) => set("show_system_uptime", v)}
							/>
							<SwitchRow
								label="System CPU"
								description="24h CPU load sparkline and current % for systems."
								checked={settings.show_system_cpu !== false}
								onCheckedChange={(v) => set("show_system_cpu", v)}
							/>
							<SwitchRow
								label="Sparklines on mobile"
								description="On phones, show sparklines on their own row under each name. Off hides them there."
								checked={settings.show_mobile_sparklines !== false}
								onCheckedChange={(v) => set("show_mobile_sparklines", v)}
							/>
						</div>
					</Card>
				</fieldset>
</TabsContent>

				<TabsContent value="appearance">
<fieldset disabled={!canEdit} className="min-w-0">
					<Card className="space-y-4 p-4">
						<Field label="Logo URL" hint="Square image, shown left of the title">
							<div className="flex items-center gap-3">
								<Input value={settings.logo_url ?? ""} onChange={str("logo_url")} placeholder="https://example.com/logo.svg" />
								{settings.logo_url && <img src={settings.logo_url} alt="" className="size-9 rounded border object-contain" />}
							</div>
						</Field>
						<Field label="Accent color">
							<div className="flex items-center gap-2">
								<input
									type="color"
									value={settings.accent_color || "#7c3aed"}
									onChange={(e) => set("accent_color", e.target.value)}
									className="h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1"
								/>
								<Input value={settings.accent_color ?? ""} onChange={str("accent_color")} placeholder="#7c3aed" className="w-36 font-mono" />
								{settings.accent_color && (
									<Button variant="ghost" size="sm" onClick={() => set("accent_color", null)}>
										Reset
									</Button>
								)}
							</div>
						</Field>
						<Field label="Custom CSS" hint="Injected into the public page. Target classes like .status-header, .status-group, .status-item.">
							<Textarea value={settings.custom_css ?? ""} onChange={str("custom_css")} rows={8} className="font-mono text-xs" placeholder={".status-header h1 { letter-spacing: -0.02em; }"} />
						</Field>
					</Card>
				</fieldset>
</TabsContent>
			</Tabs>

			<ItemPicker
				open={picker != null}
				onOpenChange={(o) => !o && setPicker(null)}
				monitors={monitors.data ?? []}
				systems={systems.data ?? []}
				selected={new Set(groups.find((g) => g.uid === picker)?.items.map((i) => `${i.kind}:${i.id}`) ?? [])}
				onToggle={(kind, itemId) =>
					setGroups((gs) =>
						gs.map((g) => {
							if (g.uid !== picker) return g;
							const has = g.items.some((i) => i.kind === kind && i.id === itemId);
							return { ...g, items: has ? g.items.filter((i) => !(i.kind === kind && i.id === itemId)) : [...g.items, { uid: uid("i"), kind, id: itemId }] };
						}),
					)
				}
			/>
		</>
	);
}

// ---- Drag & drop layout --------------------------------------------------------

type ItemInfo = { name: string; status: MonitorListItem["status"] | SystemRecord["status"]; hint: string; linkable?: boolean };
type Lookup = Map<string, ItemInfo>;

function LayoutEditor({
	groups,
	setGroups,
	lookup,
	onPick,
}: {
	groups: EGroup[];
	setGroups: React.Dispatch<React.SetStateAction<EGroup[]>>;
	lookup: Lookup;
	onPick: (groupUid: string) => void;
}) {
	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
	const groupOf = (itemUid: string) => groups.find((g) => g.items.some((i) => i.uid === itemUid));

	// Groups only collide with groups; items collide with items and group drop zones.
	const collision: CollisionDetection = (args) => {
		const type = args.active.data.current?.type;
		return closestCenter({
			...args,
			droppableContainers: args.droppableContainers.filter((c) => (type === "group" ? c.data.current?.type === "group" : c.data.current?.type !== "group")),
		});
	};

	const onDragOver = ({ active, over }: DragOverEvent) => {
		if (!over || active.data.current?.type !== "item") return;
		const from = groupOf(String(active.id));
		const toUid = over.data.current?.type === "container" ? (over.data.current.group as string) : groupOf(String(over.id))?.uid;
		if (!from || !toUid || from.uid === toUid) return;
		setGroups((gs) => {
			const item = from.items.find((i) => i.uid === active.id)!;
			return gs.map((g) => {
				if (g.uid === from.uid) return { ...g, items: g.items.filter((i) => i.uid !== active.id) };
				if (g.uid === toUid) {
					const idx = g.items.findIndex((i) => i.uid === over.id);
					const items = [...g.items];
					items.splice(idx < 0 ? items.length : idx, 0, item);
					return { ...g, items };
				}
				return g;
			});
		});
	};

	const onDragEnd = ({ active, over }: DragEndEvent) => {
		if (!over || active.id === over.id) return;
		if (active.data.current?.type === "group") {
			setGroups((gs) => arrayMove(gs, gs.findIndex((g) => g.uid === active.id), gs.findIndex((g) => g.uid === over.id)));
			return;
		}
		const g = groupOf(String(active.id));
		if (!g) return;
		const from = g.items.findIndex((i) => i.uid === active.id);
		const to = g.items.findIndex((i) => i.uid === over.id);
		if (from < 0 || to < 0) return;
		setGroups((gs) => gs.map((x) => (x.uid === g.uid ? { ...x, items: arrayMove(x.items, from, to) } : x)));
	};

	return (
		<div className="space-y-3">
			{groups.length === 0 && (
				<Card>
					<EmptyState icon={Activity} title="This page is empty">
						Add a group, then pick monitors and systems to show in it. Drag to reorder groups and items, or move items between groups.
					</EmptyState>
				</Card>
			)}
			<DndContext sensors={sensors} collisionDetection={collision} onDragOver={onDragOver} onDragEnd={onDragEnd}>
				<SortableContext items={groups.map((g) => g.uid)} strategy={verticalListSortingStrategy}>
					{groups.map((g) => (
						<SortableGroup
							key={g.uid}
							group={g}
							lookup={lookup}
							onRename={(name) => setGroups((gs) => gs.map((x) => (x.uid === g.uid ? { ...x, name } : x)))}
							onRemove={() => setGroups((gs) => gs.filter((x) => x.uid !== g.uid))}
							onRemoveItem={(itemUid) => setGroups((gs) => gs.map((x) => (x.uid === g.uid ? { ...x, items: x.items.filter((i) => i.uid !== itemUid) } : x)))}
							onToggleLink={(itemUid) =>
								setGroups((gs) => gs.map((x) => (x.uid === g.uid ? { ...x, items: x.items.map((i) => (i.uid === itemUid ? { ...i, link: i.link === false } : i)) } : x)))
							}
							onPick={() => onPick(g.uid)}
						/>
					))}
				</SortableContext>
			</DndContext>
			<Button variant="outline" className="w-full border-dashed" onClick={() => setGroups((gs) => [...gs, { uid: uid("g"), name: gs.length ? "New group" : "Services", items: [] }])}>
				<Plus /> Add group
			</Button>
		</div>
	);
}

function SortableGroup({
	group,
	lookup,
	onRename,
	onRemove,
	onRemoveItem,
	onToggleLink,
	onPick,
}: {
	group: EGroup;
	lookup: Lookup;
	onRename: (name: string) => void;
	onRemove: () => void;
	onRemoveItem: (uid: string) => void;
	onToggleLink: (uid: string) => void;
	onPick: () => void;
}) {
	const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: group.uid, data: { type: "group" } });
	const drop = useDroppable({ id: `drop:${group.uid}`, data: { type: "container", group: group.uid } });
	return (
		<div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }} className={cn(isDragging && "relative z-10 opacity-80")}>
			<Card className={cn("overflow-hidden", isDragging && "shadow-xl ring-1 ring-primary/40")}>
				<div className="flex items-center gap-2 border-b bg-muted/30 px-2 py-2">
					<button ref={setActivatorNodeRef} type="button" {...attributes} {...listeners} className="cursor-grab rounded p-1 text-muted-foreground hover:bg-accent active:cursor-grabbing" aria-label="Drag group">
						<GripVertical className="size-4" />
					</button>
					<Input value={group.name} onChange={(e) => onRename(e.target.value)} className="h-8 flex-1 border-transparent bg-transparent font-medium shadow-none hover:border-input" />
					<Button variant="ghost" size="sm" onClick={onPick}>
						<Plus /> Items
					</Button>
					<Button variant="ghost" size="icon-sm" onClick={onRemove} className="text-muted-foreground hover:text-destructive" aria-label="Remove group">
						<Trash2 />
					</Button>
				</div>
				<div ref={drop.setNodeRef} className={cn("min-h-12 p-1.5", drop.isOver && "bg-primary/5")}>
					<SortableContext items={group.items.map((i) => i.uid)} strategy={verticalListSortingStrategy}>
						{group.items.map((i) => (
							<SortableItem key={i.uid} item={i} info={lookup.get(`${i.kind}:${i.id}`)} onRemove={() => onRemoveItem(i.uid)} onToggleLink={() => onToggleLink(i.uid)} />
						))}
					</SortableContext>
					{group.items.length === 0 && (
						<button type="button" onClick={onPick} className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed py-3 text-xs text-muted-foreground hover:text-foreground">
							<Plus className="size-3.5" /> Add monitors or systems, or drop items here
						</button>
					)}
				</div>
			</Card>
		</div>
	);
}

function SortableItem({ item, info, onRemove, onToggleLink }: { item: EItem; info?: ItemInfo; onRemove: () => void; onToggleLink: () => void }) {
	const linked = item.link !== false;
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.uid, data: { type: "item" } });
	return (
		<div
			ref={setNodeRef}
			style={{ transform: CSS.Translate.toString(transform), transition }}
			className={cn("group flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-accent/50", isDragging && "relative z-10 bg-accent shadow-lg")}
		>
			<button type="button" {...attributes} {...listeners} className="cursor-grab rounded p-0.5 text-muted-foreground active:cursor-grabbing" aria-label="Drag item">
				<GripVertical className="size-4" />
			</button>
			{info ? <StatusDot status={info.status} /> : <span className="size-2.5 rounded-full bg-red-500/40" />}
			{item.kind === "system" ? <Server className="size-3.5 text-muted-foreground" /> : <Activity className="size-3.5 text-muted-foreground" />}
			<span className={cn("flex-1 truncate text-sm", !info && "text-muted-foreground line-through")}>{info?.name ?? `Deleted ${item.kind}`}</span>
			<span className="text-xs text-muted-foreground">{info?.hint}</span>
			{info?.linkable && (
				<button
					type="button"
					role="switch"
					aria-checked={linked}
					onClick={onToggleLink}
					title={linked ? "Link to site: on. The public page links to the site and shows its address." : "Link to site: off. The site's address is never shown publicly."}
					className={cn(
						"inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
						linked ? "text-muted-foreground hover:text-foreground" : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
					)}
				>
					{linked ? <Link2 className="size-3.5" /> : <Link2Off className="size-3.5" />}
					{linked ? "Link to site" : "No link"}
				</button>
			)}
			<button type="button" onClick={onRemove} className="rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100 focus:opacity-100" aria-label="Remove item">
				<X className="size-4" />
			</button>
		</div>
	);
}

function ItemPicker({
	open,
	onOpenChange,
	monitors,
	systems,
	selected,
	onToggle,
}: {
	open: boolean;
	onOpenChange: (o: boolean) => void;
	monitors: MonitorListItem[];
	systems: SystemRecord[];
	selected: Set<string>;
	onToggle: (kind: "monitor" | "system", id: string) => void;
}) {
	const [q, setQ] = useState("");
	useEffect(() => {
		if (open) setQ("");
	}, [open]);
	const query = q.trim().toLowerCase();
	const entries = [
		...monitors.map((m) => ({ kind: "monitor" as const, id: m.id, name: m.name, status: m.status, hint: MONITOR_TYPE_LABEL[m.type] })),
		...systems.map((s) => ({ kind: "system" as const, id: s.id, name: s.name, status: s.status, hint: "System (status + uptime only)" })),
	].filter((e) => !query || e.name.toLowerCase().includes(query) || e.hint.toLowerCase().includes(query));
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader title="Add items" description="Click to add or remove. Systems only show status and uptime publicly." />
				<div className="border-b px-5 py-3">
					<div className="relative">
						<Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search monitors and systems…" className="pl-8" />
					</div>
				</div>
				<DialogBody className="max-h-[50vh] p-2">
					{entries.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">Nothing matches “{q}”.</p>}
					{entries.map((e) => {
						const on = selected.has(`${e.kind}:${e.id}`);
						return (
							<button
								key={`${e.kind}:${e.id}`}
								type="button"
								onClick={() => onToggle(e.kind, e.id)}
								className={cn("flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm hover:bg-accent", on && "bg-primary/10")}
							>
								<StatusDot status={e.status} />
								{e.kind === "system" ? <Server className="size-4 text-muted-foreground" /> : <Activity className="size-4 text-muted-foreground" />}
								<span className="flex-1 truncate font-medium">{e.name}</span>
								<span className="text-xs text-muted-foreground">{e.hint}</span>
								<span className={cn("ml-2 text-xs font-medium", on ? "text-primary" : "text-muted-foreground")}>{on ? "Added" : "Add"}</span>
							</button>
						);
					})}
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
