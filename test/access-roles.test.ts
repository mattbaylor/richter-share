import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeD1 } from "./fake-env";

vi.mock("../src/worker/hub-client", () => ({ hub: vi.fn(() => ({ monitorState: async () => null })), hubReload: vi.fn(async () => undefined), hubView: vi.fn(async () => null) }));
// Identity comes from a test header instead of a signed Access JWT.
vi.mock("../src/worker/access", () => ({ authenticate: vi.fn(async (req: Request) => ({ email: req.headers.get("x-test-email") ?? "dev@localhost" })) }));
import { MIGRATIONS } from "../src/worker/db";
import { admin } from "../src/worker/routes/admin";
import { invalidateRoles, MANAGED_POLICY } from "../src/worker/users";

const OWNER = "owner@example.com";
const READER = "reader@example.com";
const EDITOR = "editor@example.com";

describe("dashboard roles", () => {
	let d1: ReturnType<typeof fakeD1>;
	let token: string | undefined;
	let policies: { id: string; name: string; decision: string; precedence: number; include: { email: { email: string } }[] }[];
	const env = () => ({ DB: d1.db, DASHBOARD_HOST: "dash.example", OWNER_EMAIL: "Owner@Example.com", CF_ACCOUNT_ID: "acct", ACCESS_APP_ID: "app", CF_ACCESS_API_TOKEN: token }) as never;
	const req = (as: string, path: string, init: RequestInit = {}) =>
		admin.request(`http://localhost${path}`, { ...init, headers: { "x-test-email": as, "content-type": "application/json", ...(init.headers ?? {}) } }, env());
	const managed = () => policies.find((p) => p.name === MANAGED_POLICY)?.include.map((i) => i.email.email);

	beforeEach(() => {
		invalidateRoles();
		token = "tok";
		d1 = fakeD1();
		for (const m of MIGRATIONS) d1.sql.exec(m);
		d1.sql.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('schema_version', ?)").run(String(MIGRATIONS.length));
		d1.sql.exec(`INSERT INTO users(email, role, added_by, created_at) VALUES ('${READER}', 'read', '${OWNER}', 1), ('${EDITOR}', 'full', '${OWNER}', 2)`);
		d1.sql.exec(`INSERT INTO systems(id, name, token, status, created_at) VALUES ('s1', 'box', 'agent-secret', 'up', 0)`);
		d1.sql.exec(`INSERT INTO monitors(id, name, type, config, interval_s, retries, retry_interval_s, timeout_ms, push_token, next_check_at, created_at, status) VALUES
			('m1', 'api', 'http', '{"url":"https://u:pw@api.test/x?token=abc&q=1","method":"POST","headers":{"Authorization":"Bearer zzz"},"body":"{\\"k\\":1}"}', 60, 0, 60, 5000, NULL, 0, 0, 'up'),
			('m2', 'cron', 'push', '{}', 60, 0, 60, 5000, 'push-secret', 0, 0, 'up')`);
		d1.sql.exec(`INSERT INTO notifications(id, name, type, config, enabled, apply_default, created_at) VALUES ('p', 'Phone', 'pushover', '{"app_token":"a","user_key":"u"}', 1, 0, 0)`);
		policies = [{ id: "own", name: "Allow owner", decision: "allow", precedence: 1, include: [{ email: { email: OWNER } }] }];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit = {}) => {
				const u = String(url);
				expect(u.startsWith("https://api.cloudflare.com/client/v4/accounts/acct/access/apps/app/policies")).toBe(true);
				const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }));
				const id = u.split("/policies")[1].replace("/", "");
				if (!init.method || init.method === "GET") return ok(policies);
				const body = JSON.parse(String(init.body));
				if (init.method === "POST") policies.push({ ...body, id: "new" });
				if (init.method === "PUT") policies = policies.map((p) => (p.id === id ? { ...body, id } : p));
				return ok(body);
			}),
		);
	});
	afterEach(() => vi.unstubAllGlobals());

	it("/me reports role and owner", async () => {
		expect(await (await req("owner@EXAMPLE.com", "/me")).json()).toEqual({ email: "owner@EXAMPLE.com", role: "full", owner: true });
		expect(await (await req(READER, "/me")).json()).toEqual({ email: READER, role: "read", owner: false });
		expect(await (await req(EDITOR, "/me")).json()).toMatchObject({ role: "full", owner: false });
	});

	it("refuses identities that aren't on the list", async () => {
		const r = await req("stranger@example.com", "/monitors");
		expect(r.status).toBe(403);
		expect((await r.json()).error).toMatch(/isn't on this dashboard's user list/);
	});

	it("read-only users get 403 on every mutation, including the access list", async () => {
		const cases: [string, string, unknown?][] = [
			["POST", "/monitors", { name: "x", type: "http", config: { url: "https://x.test" } }],
			["PUT", "/monitors/m1", { name: "x" }],
			["PATCH", "/monitors/m1", { paused: true }],
			["DELETE", "/monitors/m1"],
			["POST", "/systems", { name: "x" }],
			["POST", "/systems/s1/rotate-token"],
			["DELETE", "/systems/s1"],
			["POST", "/notifications", { name: "x", type: "discord", config: {} }],
			["POST", "/notifications/p/test"],
			["DELETE", "/notifications/p"],
			["PUT", "/settings", { title: "x" }],
			["POST", "/import", {}],
			["POST", "/access", { email: "new@example.com", role: "full" }],
			["PATCH", `/access/${READER}`, { role: "full" }],
			["DELETE", `/access/${EDITOR}`],
			["POST", "/access/sync"],
		];
		for (const [method, path, body] of cases) {
			const r = await req(READER, path, { method, body: body ? JSON.stringify(body) : undefined });
			expect([method, path, r.status]).toEqual([method, path, 403]);
			expect(await r.json()).toMatchObject({ readonly: true });
		}
		// Nothing changed.
		expect(d1.sql.prepare("SELECT count(*) n FROM monitors").get()).toEqual({ n: 2 });
		expect(d1.sql.prepare("SELECT role FROM users WHERE email = ?").get(READER)).toEqual({ role: "read" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("read-only users can view but never see credentials", async () => {
		expect((await req(READER, "/systems")).status).toBe(200);
		expect((await req(READER, "/settings")).status).toBe(200);
		expect((await req(READER, "/export")).status).toBe(403);
		expect((await req(READER, "/systems/s1/install")).status).toBe(403);
		const mons = (await (await req(READER, "/monitors")).json()) as Record<string, any>[];
		const http = mons.find((m) => m.id === "m1")!;
		const push = mons.find((m) => m.id === "m2")!;
		expect(push.push_token).toBeNull();
		expect(push.ping_url).toBeNull();
		expect(http.config.headers).toEqual({ Authorization: "••••••" });
		expect(http.config.body).toBe("••••••");
		expect(http.config.url).not.toContain("pw");
		expect(http.config.url).not.toContain("abc");
		expect(http.config.url).toContain("q=1");
		const oneRes = await req(READER, "/monitors/m2");
		expect(oneRes.status).toBe(200);
		const one = await oneRes.text();
		expect(one).toContain('"name":"cron"');
		expect(one).not.toContain("push-secret");
		const chans = await (await req(READER, "/notifications")).text();
		expect(chans).not.toMatch(/"app_token":"a"|"user_key":"u"/);
		expect(chans).toContain("Phone");
		// Full users still see them.
		expect(await (await req(EDITOR, "/monitors/m2")).text()).toContain("push-secret");
		expect(await (await req(EDITOR, "/notifications")).text()).toContain('"app_token":"a"');
		expect((await req(EDITOR, "/export")).status).toBe(200);
	});

	it("adding a user updates the managed Access policy before D1; removing takes them out", async () => {
		const add = await req(EDITOR, "/access", { method: "POST", body: JSON.stringify({ email: " New@Example.com ", role: "read" }) });
		expect(add.status).toBe(201);
		expect(managed()?.sort()).toEqual([EDITOR, "new@example.com", OWNER, READER].sort());
		expect(policies.find((p) => p.name === MANAGED_POLICY)?.precedence).toBe(2);
		expect(policies.find((p) => p.id === "own")?.include).toEqual([{ email: { email: OWNER } }]);
		expect((await (await req("new@example.com", "/me")).json()).role).toBe("read");
		expect((await req(EDITOR, "/access", { method: "POST", body: JSON.stringify({ email: "new@example.com", role: "full" }) })).status).toBe(409);

		expect((await req(OWNER, "/access/new%40example.com", { method: "PATCH", body: JSON.stringify({ role: "full" }) })).status).toBe(200);
		expect((await (await req("new@example.com", "/me")).json()).role).toBe("full");

		const del = await req(OWNER, "/access/new%40example.com", { method: "DELETE" });
		expect(del.status).toBe(200);
		expect(managed()?.sort()).toEqual([EDITOR, OWNER, READER].sort());
		expect((await req("new@example.com", "/monitors")).status).toBe(403);
	});

	it("the owner can't be removed or demoted, and stays on the managed policy", async () => {
		expect((await req(EDITOR, `/access/${OWNER}`, { method: "DELETE" })).status).toBe(400);
		expect((await req(OWNER, `/access/${OWNER}`, { method: "PATCH", body: JSON.stringify({ role: "read" }) })).status).toBe(400);
		expect((await req(OWNER, "/access", { method: "POST", body: JSON.stringify({ email: OWNER, role: "read" }) })).status).toBe(400);
		await req(OWNER, `/access/${READER}`, { method: "DELETE" });
		await req(OWNER, `/access/${EDITOR}`, { method: "DELETE" });
		expect(managed()).toEqual([OWNER]);
		const list = (await (await req(OWNER, "/access")).json()) as { users: { email: string; owner: boolean; role: string }[] };
		expect(list.users).toEqual([expect.objectContaining({ email: OWNER, owner: true, role: "full" })]);
	});

	it("without the API token, adding fails clearly and writes nothing", async () => {
		token = undefined;
		expect(((await (await req(OWNER, "/access")).json()) as { configured: boolean }).configured).toBe(false);
		const r = await req(OWNER, "/access", { method: "POST", body: JSON.stringify({ email: "x@example.com", role: "read" }) });
		expect(r.status).toBe(409);
		expect((await r.json()).error).toMatch(/CF_ACCESS_API_TOKEN/);
		expect(d1.sql.prepare("SELECT count(*) n FROM users").get()).toEqual({ n: 2 });
	});

	it("an Access API failure on add leaves D1 untouched", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 })));
		const r = await req(OWNER, "/access", { method: "POST", body: JSON.stringify({ email: "x@example.com", role: "read" }) });
		expect(r.status).toBe(502);
		expect((await r.json()).error).toMatch(/Authentication error/);
		expect(d1.sql.prepare("SELECT count(*) n FROM users").get()).toEqual({ n: 2 });
	});
});
