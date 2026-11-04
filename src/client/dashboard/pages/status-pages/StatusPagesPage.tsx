import type { StatusPage } from "@shared/types";
import { ExternalLink, Eye, Globe, LayoutDashboard, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "wouter";
import { admin, ApiError, errorMessage } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page";
import { CardsSkeleton } from "@/components/ui/skeleton";
import { useAction } from "@/components/ui/toast";
import { useApi, useDocumentTitle } from "@/lib/hooks";
import { useCanEdit } from "@/dashboard/role";

export const slugify = (s: string) =>
	s
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);

export function StatusPagesPage() {
	useDocumentTitle("Status pages · Richter");
	const { data, error, loading, reload } = useApi<StatusPage[]>("/api/admin/status-pages");
	const [creating, setCreating] = useState(false);
	const canEdit = useCanEdit();
	const confirm = useConfirm();
	const { run } = useAction();

	return (
		<>
			<PageHeader
				title="Status pages"
				description="Public pages with uptime bars, incidents, maintenance and announcements. Metrics are never exposed."
				actions={
					canEdit && (
						<Button onClick={() => setCreating(true)}>
							<Plus /> New status page
						</Button>
					)
				}
			/>
			{error && !data && <ErrorState error={error} onRetry={reload} />}
			{loading && !data ? (
				<CardsSkeleton count={3} />
			) : data && data.length === 0 ? (
				<Card>
					<EmptyState
						icon={LayoutDashboard}
						title="No status pages yet"
						action={
							canEdit && (
								<Button onClick={() => setCreating(true)}>
									<Plus /> Create a status page
								</Button>
							)
						}
					>
						Group monitors and systems on a public page your users can bookmark. Pages can live on your public host, under /s/slug, or on their own custom domain.
					</EmptyState>
				</Card>
			) : data ? (
				<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
					{data.map((p) => {
						const items = p.layout.reduce((n, g) => n + g.items.length, 0);
						return (
							<Card key={p.id} className="flex flex-col p-4">
								<div className="flex items-start gap-3">
									<div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border" style={{ background: p.accent_color ? `${p.accent_color}22` : undefined }}>
										{p.logo_url ? <img src={p.logo_url} alt="" className="size-full object-contain" /> : <LayoutDashboard className="size-5" style={{ color: p.accent_color ?? undefined }} />}
									</div>
									<div className="min-w-0 flex-1">
										<Link href={`/status-pages/${p.id}`} className="block truncate font-semibold hover:underline">
											{p.title}
										</Link>
										<p className="truncate text-xs text-muted-foreground">/s/{p.slug}</p>
									</div>
								</div>
								<div className="mt-3 flex flex-wrap gap-1.5">
									{p.published ? <Badge className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400">Published</Badge> : <Badge>Draft</Badge>}
									{p.is_default && (
										<Badge className="border-primary/40 text-primary">
											<Star className="size-3" /> Default
										</Badge>
									)}
									{p.custom_domain && (
										<Badge>
											<Globe className="size-3" /> {p.custom_domain}
										</Badge>
									)}
									<Badge>
										{p.layout.length} group{p.layout.length === 1 ? "" : "s"} · {items} item{items === 1 ? "" : "s"}
									</Badge>
								</div>
								<div className="mt-auto flex items-center gap-2 pt-4">
									<Button variant="outline" size="sm" asChild>
										<Link href={`/status-pages/${p.id}`}>
											{canEdit ? <Pencil /> : <Eye />} {canEdit ? "Edit" : "View"}
										</Link>
									</Button>
									<Button variant="outline" size="sm" asChild>
										<a href={p.url} target="_blank" rel="noreferrer">
											<ExternalLink /> Open
										</a>
									</Button>
									{canEdit && <Button
										variant="ghost"
										size="icon-sm"
										className="ml-auto text-muted-foreground hover:text-destructive"
										aria-label="Delete page"
										onClick={async () => {
											const ok = await confirm({ title: `Delete “${p.title}”?`, description: "The public URL stops working immediately.", confirmLabel: "Delete page", destructive: true });
											if (ok && (await run("del", () => admin.del(`/status-pages/${p.id}`), "Status page deleted"))) reload();
										}}
									>
										<Trash2 />
									</Button>}
								</div>
							</Card>
						);
					})}
				</div>
			) : null}
			<CreatePageDialog open={creating && canEdit} onOpenChange={setCreating} />
		</>
	);
}

function CreatePageDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
	const [, navigate] = useLocation();
	const [title, setTitle] = useState("");
	const [slug, setSlug] = useState("");
	const [slugTouched, setSlugTouched] = useState(false);
	const [errors, setErrors] = useState<{ title?: string; slug?: string }>({});
	const [saving, setSaving] = useState(false);
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (o) {
					setTitle("");
					setSlug("");
					setSlugTouched(false);
					setErrors({});
				}
				onOpenChange(o);
			}}
		>
			<DialogContent>
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						if (!title.trim()) return setErrors({ title: "Required" });
						if (!/^[a-z0-9-]+$/.test(slug)) return setErrors({ slug: "Lowercase letters, digits and dashes only" });
						setSaving(true);
						try {
							const p = await admin.post<StatusPage>("/status-pages", { title: title.trim(), slug });
							onOpenChange(false);
							navigate(`/status-pages/${p.id}`);
						} catch (err) {
							setErrors(err instanceof ApiError && err.field === "slug" ? { slug: err.message } : { title: errorMessage(err) });
						} finally {
							setSaving(false);
						}
					}}
				>
					<DialogHeader title="New status page" description="You can add groups, monitors and branding next." />
					<DialogBody className="space-y-4">
						<Field label="Title" error={errors.title}>
							<Input
								autoFocus
								value={title}
								onChange={(e) => {
									setTitle(e.target.value);
									if (!slugTouched) setSlug(slugify(e.target.value));
								}}
								placeholder="Acme Status"
							/>
						</Field>
						<Field label="Slug" error={errors.slug} hint={`Public at /s/${slug || "slug"}`}>
							<Input
								value={slug}
								onChange={(e) => {
									setSlugTouched(true);
									setSlug(e.target.value.toLowerCase());
								}}
								placeholder="acme"
							/>
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button variant="outline" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button type="submit" loading={saving}>
							Create page
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
