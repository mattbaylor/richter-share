import type { Env } from "./env";
import type { HubView, Live } from "./hub";

/** The single coordinator Durable Object that owns live monitor state. */
export function hub(env: Env) {
	return env.HUB.get(env.HUB.idFromName("hub"));
}

/** Hub live view, or null if the Hub is unreachable (callers then fall back to the D1 columns). */
export async function hubView(env: Env): Promise<HubView | null> {
	try {
		return await hub(env).view();
	} catch (e) {
		console.error("hub view failed", (e as Error).message);
		return null;
	}
}

/** Tell the Hub that monitors or maintenances changed in D1. Best effort: it also re-reads every 10 min. */
export async function hubReload(env: Env, opts: { reset?: Record<string, Partial<Live>>; reseed?: boolean } = {}): Promise<void> {
	try {
		await hub(env).reload(opts);
	} catch (e) {
		console.error("hub reload failed", (e as Error).message);
	}
}
