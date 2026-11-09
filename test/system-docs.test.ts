import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeD1 } from "./fake-env";

vi.mock("../src/worker/hub-client", () => ({ hub: vi.fn(), hubReload: vi.fn(async () => undefined), hubView: vi.fn(async () => ({})) }));
vi.mock("../src/worker/notify", () => ({ notify: vi.fn(async () => undefined) }));
import { linesToRefs, refsToLines } from "../src/shared/system-docs";
import { MIGRATIONS } from "../src/worker/db";
import { admin } from "../src/worker/routes/admin";

/** Per-system documentation: description, provides, depends_on, works_with. */
describe("system docs", () => {
	let d1: ReturnType<typeof fakeD1>;
	const patch = async (id: string, body: unknown) => {
		const r = await admin.request(`http://localhost/systems/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, { DB: d1.db } as never);
		expect(r.status).toBe(200);
		return r.json() as Promise<Record<string, unknown>>;
	};

	beforeEach(() => {
		d1 = fakeD1();
		for (const m of MIGRATIONS) d1.sql.exec(m);
		d1.sql.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES ('schema_version', ?)").run(String(MIGRATIONS.length));
		for (const id of ["rtr", "web"]) d1.sql.prepare("INSERT INTO systems(id, name, token, status, created_at) VALUES (?, ?, ?, 'up', 0)").run(id, id, `t-${id}`);
	});

	it("a new system has empty docs", async () => {
		const s = await patch("web", {});
		expect(s).toMatchObject({ description: null, provides: [], depends_on: [], works_with: [] });
	});

	it("saves docs, cleaning blanks, duplicates and self-links, and leaves unsent fields alone", async () => {
		const s = await patch("web", {
			description: "  Blog  ",
			provides: ["blog.example.com", " ", "blog.example.com"],
			depends_on: ["rtr", "web", "Cloudflare DNS", "rtr"],
			works_with: [],
		});
		expect(s).toMatchObject({ description: "Blog", provides: ["blog.example.com"], depends_on: ["rtr", "Cloudflare DNS"], works_with: [] });
		const t = await patch("web", { name: "web1" });
		expect(t).toMatchObject({ name: "web1", description: "Blog", depends_on: ["rtr", "Cloudflare DNS"] });
		const u = await patch("web", { description: "" });
		expect(u.description).toBeNull();
	});

	it("the editor turns system names into ids and back", () => {
		const systems = [
			{ id: "id1", name: "rtr" },
			{ id: "id2", name: "Edge" },
		];
		expect(linesToRefs("RTR\n\n edge \nCloudflare\nid1", systems)).toEqual(["id1", "id2", "Cloudflare"]);
		expect(refsToLines(["id2", "Cloudflare"], systems)).toBe("Edge\nCloudflare");
	});
});
