import type { DayBar, PublicItem, PublicPage } from "@shared/types";
import { AlertTriangle, CheckCircle2, ExternalLink, Info, LogIn, Moon, Rss, Sun, Wrench, XCircle } from "lucide-react";
import { useRef, useState } from "react";
import { ApiError } from "@/api";
import { Sparkline } from "@/components/sparkline";
import { Logo } from "@/components/logo";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime, formatDayKey, formatDurationMs, formatMs, formatUptime, timeAgo } from "@/lib/format";
import { useApi, useDocumentTitle, useNow } from "@/lib/hooks";
import { renderMarkdown } from "@/lib/markdown";
import { type AnyStatus, dayBarColor, OVERALL, SEVERITY_CLS } from "@/lib/status";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const PILL: Record<AnyStatus, { label: string; cls: string }> = {
	up: { label: "Operational", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
	degraded: { label: "Degraded", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
	down: { label: "Outage", cls: "bg-red-500/15 text-red-700 dark:text-red-400" },
	maintenance: { label: "Maintenance", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-400" },
	paused: { label: "Paused", cls: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400" },
	pending: { label: "Pending", cls: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400" },
	running: { label: "Running", cls: "bg-violet-500/15 text-violet-700 dark:text-violet-400" },
};

const OVERALL_ICON = { operational: CheckCircle2, degraded: AlertTriangle, partial: AlertTriangle, major: XCircle, maintenance: Wrench };

export function StatusPageView({ path, slug, dashboardUrl }: { path: string; slug?: string; dashboardUrl?: string }) {
	const { data, error, loading } = useApi<PublicPage>(path, { refreshMs: 60_000 });
	const { theme, toggle } = useTheme();
	const now = useNow(1000);

	useDocumentTitle(data?.page.title, "Status");

	if (error && !data) {
		const notFound = error instanceof ApiError && error.status === 404;
		return (
			<div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
				<Logo className="size-10" />
				<h1 className="text-lg font-semibold">{notFound ? "Status page not found" : "Status unavailable"}</h1>
				<p className="max-w-sm text-sm text-muted-foreground">{notFound ? "This page does not exist or is not published." : error.message}</p>
			</div>
		);
	}

	if (loading || !data)
		return (
			<div className="mx-auto max-w-4xl space-y-6 px-4 py-10">
				<Skeleton className="h-12 w-64" />
				<Skeleton className="h-20" />
				<Skeleton className="h-64" />
				<Skeleton className="h-64" />
			</div>
		);

	const { page, overall } = data;
	const o = OVERALL[overall];
	const OIcon = OVERALL_ICON[overall];
	const feedSlug = slug ?? page.slug;
	// Reserve the sparkline column on every row once any row has one, so they all line up.
	const sparkCol = data.groups.some((g) => g.items.some((i) => (page.show_latency && (i.latency?.length ?? 0) > 1) || (i.cpu?.length ?? 0) > 1));
	const accentStyle = page.accent_color ? ({ "--primary": page.accent_color, "--ring": page.accent_color } as React.CSSProperties) : undefined;
	const activeMaint = data.maintenances.filter((m) => m.active);
	const upcomingMaint = data.maintenances.filter((m) => !m.active && m.next_start);

	return (
		<div className="status-page min-h-dvh" style={accentStyle}>
			{page.custom_css && <style>{page.custom_css}</style>}
			<div className="h-1 bg-primary" />
			<div className="mx-auto max-w-4xl px-4 pb-10 pt-8 sm:pt-12">
				<header className="status-header mb-8 flex items-start gap-4">
					{page.logo_url ? <img src={page.logo_url} alt="" className="size-12 shrink-0 rounded-lg object-contain" /> : <Logo className="size-12 shrink-0" />}
					<div className="min-w-0 flex-1">
						<h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{page.title}</h1>
						{page.description && <p className="mt-1 text-sm text-muted-foreground sm:text-base">{page.description}</p>}
					</div>
					{dashboardUrl && (
						<a
							href={dashboardUrl}
							className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<LogIn className="size-4" />
							Log in
						</a>
					)}
					<button
						type="button"
						onClick={toggle}
						className="flex size-9 shrink-0 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
					>
						{theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
					</button>
				</header>

				<div className={cn("status-banner mb-6 flex items-center gap-3 rounded-xl px-5 py-4 shadow-sm", o.cls)}>
					<OIcon className="size-6 shrink-0" />
					<span className="text-lg font-semibold">{o.label}</span>
					<span className="ml-auto hidden text-sm opacity-85 sm:inline">Updated {timeAgo(data.generated_at, now)}</span>
				</div>

				{data.announcements.length > 0 && (
					<section className="mb-6 space-y-3">
						{data.announcements.map((a) => (
							<article key={a.id} className={cn("status-announcement rounded-xl border p-4", SEVERITY_CLS[a.severity])}>
								<div className="flex items-start gap-2.5">
									{a.severity === "danger" ? <XCircle className="mt-0.5 size-5 shrink-0" /> : a.severity === "warning" ? <AlertTriangle className="mt-0.5 size-5 shrink-0" /> : a.severity === "success" ? <CheckCircle2 className="mt-0.5 size-5 shrink-0" /> : <Info className="mt-0.5 size-5 shrink-0" />}
									<div className="min-w-0 flex-1">
										<h2 className="font-semibold">{a.title}</h2>
										<div className="prose-md mt-1 text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(a.body) }} />
										<p className="mt-2 text-xs opacity-70">Posted {formatDateTime(a.created_at)}</p>
									</div>
								</div>
							</article>
						))}
					</section>
				)}

				{(activeMaint.length > 0 || upcomingMaint.length > 0) && (
					<section className="mb-6 space-y-3">
						{[...activeMaint, ...upcomingMaint].map((m) => (
							<article
								key={m.id}
								className={cn(
									"status-maintenance rounded-xl border p-4",
									m.active ? "border-sky-500/40 bg-sky-500/10" : "bg-card",
								)}
							>
								<div className="flex items-start gap-2.5">
									<Wrench className={cn("mt-0.5 size-5 shrink-0", m.active ? "text-sky-500" : "text-muted-foreground")} />
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-center gap-2">
											<h2 className="font-semibold">{m.title}</h2>
											<span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", m.active ? "bg-sky-500 text-white" : "bg-muted text-muted-foreground")}>
												{m.active ? "In progress" : "Scheduled"}
											</span>
										</div>
										{m.description && <p className="mt-1 text-sm text-muted-foreground">{m.description}</p>}
										<p className="mt-1.5 text-xs text-muted-foreground">
											{m.active ? `Until ${formatDateTime(m.ends_at)}` : `${formatDateTime(m.next_start)} · ${formatDurationMs(m.ends_at - m.starts_at)}`}
										</p>
									</div>
								</div>
							</article>
						))}
					</section>
				)}

				<div className="space-y-5">
					{data.groups.map((g) => (
						<section key={g.name} className="status-group overflow-hidden rounded-xl border bg-card shadow-xs">
							<h2 className="border-b bg-muted/30 px-4 py-3 text-sm font-semibold sm:px-5">{g.name}</h2>
							<div className="divide-y">
								{g.items.map((item) => (
									<ItemRow
										key={`${item.kind}:${item.id}`}
										item={item}
										showBars={page.show_uptime_bars}
										showLatency={page.show_latency}
										showTags={page.show_tags}
										sparkCol={sparkCol}
										mobileSpark={page.show_mobile_sparklines !== false}
									/>
								))}
								{g.items.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">Nothing here yet.</p>}
							</div>
						</section>
					))}
					{data.groups.length === 0 && <p className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">This status page has no components yet.</p>}
				</div>

				<section className="mt-10">
					<h2 className="mb-3 text-lg font-semibold">Past incidents</h2>
					{data.incidents.length === 0 ? (
						<p className="rounded-xl border bg-card px-5 py-4 text-sm text-muted-foreground">No incidents in the last 14 days.</p>
					) : (
						<ol className="status-incidents divide-y overflow-hidden rounded-xl border bg-card">
							{data.incidents.map((i) => (
								<li key={i.id} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-5 py-3">
									<span className={cn("mt-1.5 size-2 shrink-0 rounded-full", i.resolved_at ? "bg-emerald-500" : "bg-red-500")} />
									<div className="min-w-0 flex-1">
										<p className="font-medium">
											{i.name} <span className="font-normal text-muted-foreground">· {i.resolved_at ? "Resolved" : "Ongoing"}</span>
										</p>
										{i.cause && <p className="text-sm text-muted-foreground">{i.cause}</p>}
										<p className="mt-0.5 text-xs text-muted-foreground">
											{formatDateTime(i.started_at)}
											{i.resolved_at ? ` → ${formatDateTime(i.resolved_at)}` : ""}
										</p>
									</div>
									<span className="text-xs tabular-nums text-muted-foreground">{formatDurationMs((i.resolved_at ?? now) - i.started_at)}</span>
								</li>
							))}
						</ol>
					)}
				</section>

				<footer className="status-footer mt-10 flex flex-col items-center gap-2 border-t pt-6 text-center text-xs text-muted-foreground sm:flex-row sm:justify-between sm:text-left">
					<div className="space-y-1">
						{page.footer_text && <p className="text-sm text-foreground/80">{page.footer_text}</p>}
						<p>
							Powered by{" "}
							<span className="inline-flex items-center gap-1 font-medium text-foreground">
								<Logo className="size-3.5" /> Richter
							</span>
						</p>
					</div>
					<div className="flex items-center gap-4">
						<a href={`/feed.atom?page=${encodeURIComponent(feedSlug)}`} className="inline-flex items-center gap-1 hover:text-foreground">
							<Rss className="size-3.5" /> Atom feed
						</a>
						<span>Updated {timeAgo(data.generated_at, now)}</span>
					</div>
				</footer>
			</div>
		</div>
	);
}

/** Whether a row shows a sparkline: 24 h response time for monitors, 24 h CPU % for systems. */
const fmtPct = (v: number) => `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)}%`;

/** Sparkline data for a row. Every point already carries its own `ts` in the payload, so hover times
 *  come straight from it (this also stays right across gaps in the 15-minute CPU slots). */
function spark(item: PublicItem, showLatency: boolean): { values: number[]; times: number[]; format: (v: number) => string; label: string; title: string; aria: string; floor?: number } | null {
	if (showLatency && item.latency && item.latency.length > 1) {
		const avg = item.latency.reduce((a, x) => a + x.ms, 0) / item.latency.length;
		const last = item.latency[item.latency.length - 1].ms;
		return {
			values: item.latency.map((x) => x.ms),
			times: item.latency.map((x) => x.ts),
			format: (v) => formatMs(v),
			label: formatMs(avg),
			title: "Response time, last 24 hours",
			aria: `Response time, last 24 hours. Latest ${formatMs(last)}, average ${formatMs(avg)}`,
		};
	}
	if (item.cpu && item.cpu.length > 1) {
		const v = item.cpu_now ?? item.cpu[item.cpu.length - 1].pct;
		return {
			values: item.cpu.map((x) => x.pct),
			times: item.cpu.map((x) => x.ts),
			format: fmtPct,
			label: fmtPct(v),
			title: `CPU load, last 24 hours${item.cpu_now == null ? " (latest average)" : " (now)"}`,
			aria: `CPU load, last 24 hours. Latest ${fmtPct(v)}`,
			floor: 0,
		};
	}
	return null;
}

function ItemRow({
	item,
	showBars,
	showLatency,
	showTags,
	sparkCol,
	mobileSpark,
}: {
	item: PublicItem;
	showBars: boolean;
	showLatency: boolean;
	showTags: boolean;
	sparkCol: boolean;
	mobileSpark: boolean;
}) {
	const pill = PILL[item.status] ?? PILL.pending;
	const sp = spark(item, showLatency);
	return (
		<div className="status-item px-4 py-3.5 sm:px-5">
			{/* Long names wrap on phones (truncate on sm+); uptime and badge stay vertically centered beside them.
			    Name | sparkline | value, uptime, badge. On sm+ the outer columns are equal (1fr auto 1fr), so the
			    sparkline's center sits at the row's midpoint in every row. Phones show it on its own row below
			    (page setting show_mobile_sparklines) so names and bars keep the full width. */}
			<div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-x-4">
				<div className="flex min-w-0 items-center gap-2">
					{item.url ? (
						<a href={item.url} target="_blank" rel="noopener noreferrer" className="group inline-flex min-w-0 items-center gap-1 font-medium hover:text-primary">
							<span className="break-words leading-snug [overflow-wrap:anywhere] sm:truncate sm:leading-normal">{item.name}</span>
							<ExternalLink className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
						</a>
					) : (
						<span className="break-words leading-snug [overflow-wrap:anywhere] sm:truncate sm:leading-normal font-medium">{item.name}</span>
					)}
					{showTags &&
						item.tags?.map((t) => (
							<span key={t} className="hidden rounded-full border px-1.5 text-[10px] text-muted-foreground sm:inline">
								{t}
							</span>
						))}
				</div>
				{/* Sparkline + its latest value as one unit (8px apart), centered on the row midpoint; the value has a
				    fixed min-width and tabular digits so the pairs line up exactly across rows. */}
				<span className="status-spark hidden items-center justify-center gap-2 sm:flex">
					{sparkCol && (
						<>
							{sp ? <Sparkline values={sp.values} times={sp.times} format={sp.format} floor={sp.floor} label={sp.aria} title={sp.title} className="text-primary" /> : <span className="w-24" />}
							<span className="min-w-14 text-left text-xs tabular-nums text-muted-foreground" title={sp?.title}>
								{sp?.label}
							</span>
						</>
					)}
				</span>
				<div className="flex items-center justify-end gap-3">
					<span className="whitespace-nowrap text-sm tabular-nums text-muted-foreground sm:w-16 sm:text-right" title="Uptime, last 90 days">
						{formatUptime(item.uptime_90d)}
					</span>
					<span className="flex shrink-0 justify-end sm:w-[6.5rem]">
						<span className={cn("whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium", pill.cls)}>{pill.label}</span>
					</span>
				</div>
			</div>
			{mobileSpark && sp && (
				<div className="status-spark-mobile mt-1.5 flex items-center justify-center gap-2 sm:hidden">
					<Sparkline
						values={sp.values}
						times={sp.times}
						format={sp.format}
						floor={sp.floor}
						label={sp.aria}
						title={sp.title}
						className="text-primary"
						svgClassName="w-40"
					/>
					<span className="min-w-12 text-left text-xs tabular-nums text-muted-foreground" title={sp.title}>
						{sp.label}
					</span>
				</div>
			)}
			{showBars && item.bars.length > 0 && <UptimeBars bars={item.bars} />}
		</div>
	);
}

/** 90 daily bars (30 on phones) with a hover/tap tooltip. */
function UptimeBars({ bars }: { bars: DayBar[] }) {
	const [hover, setHover] = useState<{ i: number; x: number } | null>(null);
	const ref = useRef<HTMLDivElement>(null);
	const width = ref.current?.offsetWidth ?? 0;
	const b = hover ? bars[hover.i] : null;
	const show = (i: number, el: HTMLElement) => setHover({ i, x: el.offsetLeft + el.offsetWidth / 2 });
	const mobileStart = Math.max(0, bars.length - 30);

	return (
		<div className="mt-2.5">
			<div ref={ref} className="relative" onPointerLeave={() => setHover(null)}>
				<div className="flex h-8 items-stretch gap-[2px]">
					{bars.map((d, i) => (
						<span
							key={d.day}
							onPointerEnter={(e) => show(i, e.currentTarget)}
							onClick={(e) => show(i, e.currentTarget)}
							className={cn(
								"flex-1 rounded-[2px] transition-opacity hover:opacity-75",
								dayBarColor(d.uptime),
								i < mobileStart && "hidden sm:block",
								hover?.i === i && "opacity-75",
							)}
						/>
					))}
				</div>
				{b && hover && (
					<div
						className="pointer-events-none absolute bottom-full z-10 mb-2 w-48 rounded-lg border bg-popover p-2.5 text-xs text-popover-foreground shadow-xl"
						style={{
							left: Math.min(Math.max(hover.x, 96), Math.max(96, width - 96)),
							transform: "translateX(-50%)",
						}}
					>
						<p className="font-medium">{formatDayKey(b.day)}</p>
						<p className="mt-1 flex items-center gap-1.5">
							<span className={cn("size-2 rounded-full", dayBarColor(b.uptime))} />
							{b.uptime == null ? "No data" : `${formatUptime(b.uptime)} uptime`}
						</p>
						{b.incidents > 0 ? (
							<p className="mt-0.5 text-red-600 dark:text-red-400">
								{b.incidents} incident{b.incidents === 1 ? "" : "s"}
							</p>
						) : b.uptime != null ? (
							<p className="mt-0.5 text-muted-foreground">No incidents</p>
						) : null}
					</div>
				)}
			</div>
			<div className="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
				<span>
					<span className="sm:hidden">30 days ago</span>
					<span className="hidden sm:inline">{bars.length} days ago</span>
				</span>
				<span>Today</span>
			</div>
		</div>
	);
}
