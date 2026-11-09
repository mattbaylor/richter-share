import { describe, expect, it } from "vitest";
import { classifySystem, guestNameFromMonitor, systemKindContext } from "../src/shared/system-kind";

const ctx = systemKindContext([
	{ host_id: "pve02", name: guestNameFromMonitor("richter-probe (LXC 212)"), type: "lxc" },
	{ host_id: "pve02", name: guestNameFromMonitor("gitlab (VM 207)"), type: "qemu" },
]);
const sys = (id: string, name: string, extra: { tags?: string[]; h?: string; k?: string; m?: string } = {}) => ({
	id,
	name,
	tags: extra.tags ?? [],
	info: { h: extra.h, k: extra.k, m: extra.m },
});

describe("classifySystem", () => {
	it("strips the guest monitor suffix", () => {
		expect(guestNameFromMonitor("web (VM 101)")).toBe("web");
		expect(guestNameFromMonitor("smtp-probe (LXC 212)")).toBe("smtp-probe");
		expect(guestNameFromMonitor("renamed by hand")).toBe("renamed by hand");
	});
	it("treats Proxmox nodes as physical even with a pve kernel", () => {
		expect(classifySystem(sys("pve02", "pve02", { k: "6.8.12-9-pve" }), ctx)).toBe("physical");
	});
	it("matches guests by name or hostname", () => {
		expect(classifySystem(sys("a", "Richter-Probe"), ctx)).toBe("lxc");
		expect(classifySystem(sys("b", "GitLab server", { h: "gitlab.lan" }), ctx)).toBe("vm");
	});
	it("falls back to CPU model and kernel", () => {
		expect(classifySystem(sys("c", "vps", { m: "QEMU Virtual CPU version 2.5+" }), ctx)).toBe("vm");
		expect(classifySystem(sys("d", "ct", { k: "6.8.12-9-pve" }), ctx)).toBe("lxc");
		expect(classifySystem(sys("e", "nas", { m: "Intel Celeron N5105" }), ctx)).toBe("physical");
	});
	it("lets a tag override detection", () => {
		expect(classifySystem(sys("pve02", "pve02", { tags: ["VM"] }), ctx)).toBe("vm");
		expect(classifySystem(sys("d", "ct", { k: "6.8.12-9-pve", tags: ["bare-metal"] }), ctx)).toBe("physical");
	});
});
