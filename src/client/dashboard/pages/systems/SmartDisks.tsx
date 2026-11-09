import type { SmartDevice, SmartSnapshot } from "@shared/types";
import { HardDrive } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Table, Td, Th, Tr } from "@/components/ui/page";
import { formatBytes, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

const RED = "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400";
const STATUS_CLS: Record<string, string> = {
	PASSED: "text-emerald-600 dark:text-emerald-400",
	WARNING: "font-medium text-amber-600 dark:text-amber-400",
	FAILED: "font-medium text-red-600 dark:text-red-400",
};

const bad = (d: SmartDevice) => d.status === "FAILED" || d.status === "WARNING";

function hoursText(h?: number): string {
	if (!h) return "–";
	const y = h / 8766;
	return y >= 1 ? `${y.toFixed(1)} y` : `${Math.round(h / 24)} d`;
}

/** S.M.A.R.T. health of the system's disks (Beszel GetSmartData), refreshed about hourly. */
export function SmartDisks({ snap }: { snap: SmartSnapshot | null | undefined }) {
	if (!snap?.devices.length) return null;
	const failing = snap.devices.filter(bad).length;
	return (
		<section id="smart" className="mt-8 scroll-mt-4">
			<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
				<h2 className="flex items-center gap-2 text-lg font-semibold">
					<HardDrive className="size-5 text-muted-foreground" /> Disk health
					<Badge>{snap.devices.length}</Badge>
					{failing > 0 && <Badge className={RED}>{failing} failing</Badge>}
				</h2>
				{snap.checked_at && <span className="text-xs text-muted-foreground">S.M.A.R.T. checked {timeAgo(snap.checked_at)}</span>}
			</div>
			<Card className="overflow-hidden">
				<div className="overflow-x-auto">
					<Table>
						<thead className="border-b">
							<tr>
								<Th className="pl-4">Disk</Th>
								<Th>Model</Th>
								<Th>Capacity</Th>
								<Th>Health</Th>
								<Th>Temp</Th>
								<Th>Powered on</Th>
								<Th className="pr-4">Attention</Th>
							</tr>
						</thead>
						<tbody>
							{snap.devices.map((d) => (
								<Tr key={d.key} className={cn(bad(d) && "bg-red-500/5")}>
									<Td className="pl-4">
										<span className="font-medium">{d.name}</span>
										{d.type && <span className="text-xs text-muted-foreground"> · {d.type}</span>}
									</Td>
									<Td className="text-xs" title={[d.serial && `S/N ${d.serial}`, d.firmware && `FW ${d.firmware}`].filter(Boolean).join(" · ") || undefined}>
										{d.model ?? "–"}
									</Td>
									<Td className="text-xs">{d.capacity ? formatBytes(d.capacity, 0) : "–"}</Td>
									<Td className={cn("text-xs", STATUS_CLS[d.status] ?? "text-muted-foreground")}>{d.status}</Td>
									<Td className="text-xs">{d.temp ? `${d.temp} °C` : "–"}</Td>
									<Td className="text-xs">{hoursText(d.hours)}</Td>
									<Td className="pr-4 text-xs">
										{d.flags?.length ? (
											<span className="text-amber-600 dark:text-amber-400">
												{d.flags.map((f) => `${f.name}${f.raw ? ` ${f.raw}` : ""}${f.when_failed ? ` (${f.when_failed})` : ""}`).join(", ")}
											</span>
										) : (
											<span className="text-muted-foreground">–</span>
										)}
									</Td>
								</Tr>
							))}
						</tbody>
					</Table>
				</div>
			</Card>
		</section>
	);
}
