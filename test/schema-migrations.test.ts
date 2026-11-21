import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeD1 } from "./fake-env";

type Db = ReturnType<typeof fakeD1>["db"];

/** More failed reads than ensureSchema retries. */
const VERSION_READS_TO_EXHAUST = 99;

/** Fresh module per test: ensureSchema caches "migrated" per isolate. */
async function load() {
	vi.resetModules();
	return import("../src/worker/db");
}

/** A D1 fully migrated to the latest version, like production before 2026-11-17. */
async function current() {
	const { ensureSchema, MIGRATIONS } = await load();
	const d1 = fakeD1();
	await ensureSchema(d1.db as never);
	expect(version(d1)).toBe(MIGRATIONS.length);
	return d1;
}

const version = (d1: ReturnType<typeof fakeD1>) =>
	Number((d1.sql.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() as { value: string }).value);
const hasTable = (d1: ReturnType<typeof fakeD1>, name: string) =>
	!!d1.sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/** Wrap a fake D1 so chosen calls throw like a transient D1 error ("Network connection lost" etc.). */
function flaky(db: Db, plan: { failFirstReads?: number; failBatches?: number[] }) {
	let reads = 0;
	let batches = 0;
	const failReads = plan.failFirstReads ?? 0;
	return {
		prepare(q: string) {
			const st = db.prepare(q);
			if (!/schema_version/.test(q) || !/^\s*SELECT/i.test(q)) return st;
			return {
				...st,
				bind: st.bind.bind(st),
				async first<T>() {
					if (reads++ < failReads) throw new Error("D1_ERROR: Network connection lost.");
					return st.first<T>();
				},
			};
		},
		async batch(list: never[]) {
			if ((plan.failBatches ?? []).includes(batches++)) throw new Error("D1_ERROR: Network connection lost.");
			return db.batch(list);
		},
	};
}

describe("ensureSchema", () => {
	beforeEach(() => vi.useRealTimers());

	it("migrates a fresh database to the latest version", async () => {
		const { ensureSchema, MIGRATIONS } = await load();
		const d1 = fakeD1();
		await ensureSchema(d1.db as never);
		expect(version(d1)).toBe(MIGRATIONS.length);
		expect(hasTable(d1, "checks")).toBe(false);
		expect(hasTable(d1, "check_buckets")).toBe(true);
	});

	it("is a no-op on a current database", async () => {
		const d1 = await current();
		const { ensureSchema, MIGRATIONS } = await load();
		d1.stats.statements.length = 0;
		await ensureSchema(d1.db as never);
		expect(version(d1)).toBe(MIGRATIONS.length);
		expect(d1.stats.statements.filter((s) => !/^\s*SELECT/i.test(s))).toEqual([]);
	});

	// The 2026-11-17 outage: the version read failed, the runner took that as version 0, migration 1's
	// batch also failed, the "did another isolate migrate?" recheck saw 13 and moved on to migration 2,
	// whose batch succeeded and wrote schema_version = 2 over 13. Migration 3 then failed forever on `checks`.
	it("never lowers schema_version when the version read and a batch fail transiently", async () => {
		const d1 = await current();
		const { ensureSchema, MIGRATIONS } = await load();
		const db = flaky(d1.db, { failFirstReads: 1, failBatches: [0] });
		await ensureSchema(db as never).catch(() => undefined);
		expect(version(d1)).toBe(MIGRATIONS.length);
		// And the next request still works.
		const again = await load();
		await again.ensureSchema(d1.db as never);
		expect(version(d1)).toBe(MIGRATIONS.length);
	});

	it("never lowers schema_version when only the version read fails", async () => {
		const d1 = await current();
		const { ensureSchema, MIGRATIONS } = await load();
		await ensureSchema(flaky(d1.db, { failFirstReads: VERSION_READS_TO_EXHAUST }) as never).catch(() => undefined);
		expect(version(d1)).toBe(MIGRATIONS.length);
	});

	it("does not treat a failed version read as a fresh database", async () => {
		const d1 = await current();
		const { ensureSchema } = await load();
		d1.stats.statements.length = 0;
		const db = flaky(d1.db, { failFirstReads: VERSION_READS_TO_EXHAUST });
		await expect(ensureSchema(db as never)).rejects.toThrow(/Network connection lost/);
		expect(d1.stats.statements.filter((s) => !/^\s*SELECT/i.test(s))).toEqual([]);
	});

	it("retries a transiently failed version read", async () => {
		const d1 = await current();
		const { ensureSchema, MIGRATIONS } = await load();
		d1.stats.statements.length = 0;
		await ensureSchema(flaky(d1.db, { failFirstReads: 2 }) as never);
		expect(version(d1)).toBe(MIGRATIONS.length);
		expect(d1.stats.statements.filter((s) => !/^\s*SELECT/i.test(s))).toEqual([]);
	});

	it("recovers the exact production state: schema_version 2 with `checks` already dropped", async () => {
		const d1 = await current();
		d1.sql.prepare("UPDATE settings SET value = '2' WHERE key = 'schema_version'").run();
		const { ensureSchema, MIGRATIONS } = await load();
		// Migration 3 now copes with `checks` being gone; the later ALTERs are already applied, so
		// the runner must stop with an error rather than loop — but it must not lower the version.
		await expect(ensureSchema(d1.db as never)).rejects.toThrow(/duplicate column/);
		expect(version(d1)).toBe(3);
		expect(version(d1)).toBeLessThan(MIGRATIONS.length);
		expect(hasTable(d1, "checks")).toBe(false);
	});

	it("migration 3 runs on a database where `checks` is already gone", async () => {
		const { MIGRATIONS } = await load();
		const d1 = fakeD1();
		d1.sql.exec(MIGRATIONS[0]);
		d1.sql.exec(MIGRATIONS[1]);
		d1.sql.exec("DROP TABLE checks");
		expect(() => d1.sql.exec(MIGRATIONS[2])).not.toThrow();
		expect(hasTable(d1, "checks")).toBe(false);
		expect(hasTable(d1, "monitor_daily")).toBe(true);
	});

	it("a concurrent isolate's migration is skipped, not re-applied", async () => {
		const { ensureSchema, MIGRATIONS } = await load();
		const d1 = fakeD1();
		d1.sql.exec(MIGRATIONS[0]);
		d1.sql.prepare("INSERT INTO settings(key, value) VALUES ('schema_version', '1')").run();
		// Our batch for migration 2 fails because "another isolate" applied migrations 2..N meanwhile.
		let first = true;
		const db = {
			prepare: d1.db.prepare,
			async batch(list: never[]) {
				if (first) {
					first = false;
					for (let i = 1; i < MIGRATIONS.length; i++) d1.sql.exec(MIGRATIONS[i]);
					d1.sql.prepare("UPDATE settings SET value = ? WHERE key = 'schema_version'").run(String(MIGRATIONS.length));
					throw new Error("D1_ERROR: table system_packages already exists");
				}
				return d1.db.batch(list);
			},
		};
		await ensureSchema(db as never);
		expect(version(d1)).toBe(MIGRATIONS.length);
	});
});
