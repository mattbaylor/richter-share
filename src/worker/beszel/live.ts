import type { SystemInfo } from "../../shared/types";
import { parseJson } from "../db";
import type { Env } from "../env";

/**
 * systems.info / last_seen in D1 are refreshed only every ~12 minutes; the AgentConnection
 * holds the live values. Overlay them (falling back to D1 if an object is unreachable).
 */
export async function liveSystems<T extends { id: string; status: string; info: string | null; last_seen: number | null }>(
	env: Env,
	rows: T[],
): Promise<(T & { infoObj: SystemInfo })[]> {
	return Promise.all(
		rows.map(async (r) => {
			let info = r.info;
			let last_seen = r.last_seen;
			if (r.status !== "pending") {
				try {
					const l = await env.AGENT.get(env.AGENT.idFromName(r.id)).live();
					if (l.last_seen && (!last_seen || l.last_seen > last_seen)) {
						last_seen = l.last_seen;
						if (l.info) info = JSON.stringify(l.info);
					}
				} catch (e) {
					console.error("agent live failed", (e as Error).message);
				}
			}
			return { ...r, info, last_seen, infoObj: parseJson<SystemInfo>(info, {}) };
		}),
	);
}
