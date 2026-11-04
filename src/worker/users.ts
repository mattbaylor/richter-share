import type { DashboardUser, Role } from "../shared/types";
import type { Env } from "./env";

/**
 * Dashboard users: who besides the owner may sign in through Cloudflare Access, and with which role.
 * The list lives in D1 (`users`); the Access application's managed allow policy mirrors it.
 */

export const normEmail = (e: string) => e.trim().toLowerCase();
export const ownerEmail = (env: Env) => normEmail(env.OWNER_EMAIL ?? "");

const TTL_MS = 30_000;
let cache: { at: number; roles: Map<string, Role> } | null = null;
/** Drop this isolate's role cache (after a change). Other isolates pick a change up within 30 s. */
export const invalidateRoles = () => void (cache = null);

/** Role of a verified Access identity, or null if it isn't on the list. The owner is always Full. */
export async function roleOf(env: Env, email: string): Promise<Role | null> {
	const e = normEmail(email);
	const owner = ownerEmail(env);
	if ((owner && e === owner) || e === "dev@localhost") return "full";
	if (!cache || Date.now() - cache.at > TTL_MS) {
		const rows = await env.DB.prepare("SELECT email, role FROM users").all<{ email: string; role: Role }>();
		cache = { at: Date.now(), roles: new Map(rows.results.map((r) => [r.email, r.role])) };
	}
	return cache.roles.get(e) ?? null;
}

export async function listUsers(env: Env): Promise<DashboardUser[]> {
	const rows = await env.DB.prepare("SELECT email, role, added_by, created_at FROM users ORDER BY created_at").all<Omit<DashboardUser, "owner">>();
	const owner = ownerEmail(env);
	const others = rows.results.filter((r) => r.email !== owner).map((r) => ({ ...r, owner: false }));
	if (!owner) return others; // OWNER_EMAIL unset: no built-in owner row
	return [{ email: owner, role: "full", owner: true, added_by: null, created_at: 0 }, ...others];
}

// ---------------------------------------------------------------- Access API

export const MANAGED_POLICY = "Richter users (managed)";

export class AccessApiError extends Error {
	constructor(
		message: string,
		readonly code: "not_configured" | "api",
	) {
		super(message);
	}
}

interface AccessPolicy {
	id: string;
	name: string;
	decision: string;
	precedence?: number;
	include: { email?: { email: string } }[];
}

export const accessConfigured = (env: Env) => !!(env.CF_ACCESS_API_TOKEN && env.CF_ACCOUNT_ID && env.ACCESS_APP_ID);

async function cfApi<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
	if (!accessConfigured(env)) throw new AccessApiError("The CF_ACCESS_API_TOKEN secret is not set, so the Access policy can't be updated.", "not_configured");
	const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/access/apps/${env.ACCESS_APP_ID}${path}`, {
		...init,
		headers: { authorization: `Bearer ${env.CF_ACCESS_API_TOKEN}`, "content-type": "application/json" },
		signal: AbortSignal.timeout(10_000),
	});
	const j = (await res.json().catch(() => null)) as { success?: boolean; result?: T; errors?: { code: number; message: string }[] } | null;
	if (!res.ok || !j?.success) {
		const msg = j?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
		throw new AccessApiError(`Cloudflare Access API: ${msg}`, "api");
	}
	return j.result as T;
}

const policyEmails = (p: AccessPolicy) => p.include.map((i) => i.email?.email).filter((e): e is string => !!e).map(normEmail);

/** Read the managed policy's emails (null if it doesn't exist yet). */
export async function managedPolicyEmails(env: Env): Promise<string[] | null> {
	const list = await cfApi<AccessPolicy[]>(env, "/policies");
	const p = list.find((x) => x.name === MANAGED_POLICY);
	return p ? policyEmails(p) : null;
}

/**
 * Make the app's managed allow policy include exactly `emails` plus the owner. The owner's own
 * policy (any other policy on the app) is never touched, so the owner can't be locked out.
 */
export async function syncAccessPolicy(env: Env, emails: string[]): Promise<void> {
	const owner = ownerEmail(env);
	const all = [...new Set([owner, ...emails.map(normEmail)].filter(Boolean))].sort();
	const list = await cfApi<AccessPolicy[]>(env, "/policies");
	const p = list.find((x) => x.name === MANAGED_POLICY);
	if (p && policyEmails(p).sort().join(",") === all.join(",")) return;
	const body = { name: MANAGED_POLICY, decision: "allow", include: all.map((email) => ({ email: { email } })), exclude: [], require: [] };
	if (p) await cfApi(env, `/policies/${p.id}`, { method: "PUT", body: JSON.stringify({ ...body, precedence: p.precedence }) });
	else await cfApi(env, "/policies", { method: "POST", body: JSON.stringify({ ...body, precedence: Math.max(0, ...list.map((x) => x.precedence ?? 0)) + 1 }) });
}
