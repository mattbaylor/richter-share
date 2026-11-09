import type { SystemCheckNowResult, SystemRecord } from "@shared/types";
import { RefreshCw } from "lucide-react";
import { admin } from "@/api";
import { Button } from "@/components/ui/button";
import { useAction, useToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { refreshAll } from "@/lib/hooks";

const HINT = "Ask the agent for fresh data now and re-run this system's monitors";

/**
 * "Check now" for one system: fresh data from its agent plus an immediate run of the monitors tied
 * to it, then everything on screen reloads. `compact` is the icon-only form for table rows.
 */
export function CheckNowButton({ system, onChecked, compact }: { system: SystemRecord; onChecked?: (s: SystemRecord) => void; compact?: boolean }) {
	const { run, busy } = useAction();
	const toast = useToast();
	if (system.status === "paused") return null;
	const click = async (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation(); // rows and cards navigate on click
		const r = await run("check", () => admin.post<SystemCheckNowResult>(`/systems/${system.id}/check-now`));
		if (!r) return;
		onChecked?.(r.system);
		refreshAll();
		if (r.connected && r.fresh) toast.success(r.message);
		else if (r.connected) toast.info("No reply yet", r.message);
		else toast.error("Agent not connected", r.message);
	};
	if (compact)
		return (
			<Tooltip content={`Check ${system.name} now`}>
				<Button variant="ghost" size="icon-sm" aria-label={`Check ${system.name} now`} className="size-7 text-muted-foreground hover:text-foreground" disabled={busy === "check"} onClick={click}>
					<RefreshCw className={busy === "check" ? "animate-spin" : undefined} />
				</Button>
			</Tooltip>
		);
	return (
		<Tooltip content={HINT}>
			<Button variant="outline" size="sm" disabled={busy === "check"} onClick={click}>
				<RefreshCw className={busy === "check" ? "animate-spin" : undefined} /> {busy === "check" ? "Checking…" : "Check now"}
			</Button>
		</Tooltip>
	);
}
