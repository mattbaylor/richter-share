import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeD1 } from "./fake-env";

// ensureSchema remembers per isolate that it has migrated, so load a fresh copy of db.ts for each test.
async function load() {
	vi.resetModules();
	return import("../src/worker/db");
}

describe("ensureSchema", () => {
	let d1: ReturnType<typeof fakeD1>;
	beforeEach(() => {
		d1 = fakeD1();
	});
	const version = () => (d1.sql.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() as { value: string }).value;

	it("migrates a new database to the latest version", async () => {
		const { ensureSchema, MIGRATIONS } = await load();
		await ensureSchema(d1.db as never);
		expect(version()).toBe(String(MIGRATIONS.length));
	});

	it("does not re-run migrations when reading the version fails for another reason", async () => {
		const { ensureSchema, MIGRATIONS } = await load();
		await ensureSchema(d1.db as never);
		const db = d1.db as unknown as { prepare(q: string): unknown };
		const realPrepare = db.prepare.bind(db);
		let failed = false;
		const flaky = {
			...db,
			batch: (d1.db as unknown as { batch: (...a: unknown[]) => unknown }).batch,
			prepare(q: string) {
				const st = realPrepare(q) as { first: (...a: unknown[]) => Promise<unknown> };
				if (!failed && q.includes("schema_version") && q.startsWith("SELECT")) {
					failed = true;
					return { ...st, first: async () => { throw new Error("D1_ERROR: Network connection lost."); } };
				}
				return st;
			},
		};
		const fresh = await load();
		await expect(fresh.ensureSchema(flaky as never)).rejects.toThrow(/Network connection lost/);
		expect(version()).toBe(String(MIGRATIONS.length));
		// The next attempt reads the version normally and has nothing to do.
		await fresh.ensureSchema(flaky as never);
		expect(version()).toBe(String(MIGRATIONS.length));
	});
});
