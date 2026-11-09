import type { GuestType, SystemKind } from "./types";

/** A Proxmox guest as Richter knows it from its auto-created guest monitor. */
export interface GuestRef {
	/** The PVE node (system) the guest runs on. */
	host_id: string;
	name: string;
	type: GuestType;
}

/** Tags that pin a system's type by hand, overriding detection. */
const TAG_KIND: Record<string, SystemKind> = {
	physical: "physical",
	"bare-metal": "physical",
	baremetal: "physical",
	hypervisor: "physical",
	vm: "vm",
	qemu: "vm",
	lxc: "lxc",
};

const VIRTUAL_CPU = /\b(qemu|kvm|virtual|vmware|xen|hyper-v|bochs)\b/i;

/** "smtp-probe (LXC 212)" -> "smtp-probe": guest monitors are named by guestMonitorName(). */
export const guestNameFromMonitor = (name: string) => name.replace(/\s*\((?:LXC|VM) \d+\)\s*$/, "").trim();

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * Physical host, VM or LXC container, decided in this order:
 *  1. a tag (`physical`, `bare-metal`, `hypervisor`, `vm`, `qemu`, `lxc`) pins it by hand;
 *  2. a system that Proxmox guests report under is a hypervisor, so physical;
 *  3. a system whose name or hostname matches a Proxmox guest takes that guest's type;
 *  4. a virtual CPU model (QEMU, KVM, VMware, ...) means VM; a Proxmox kernel on a system
 *     that isn't a known node means an LXC container (containers share the host kernel);
 *  5. otherwise physical.
 */
export function classifySystem(
	s: { id: string; name: string; tags: string[]; info?: { h?: string; k?: string; m?: string } | null; details?: { hostname?: string; kernel?: string; cpuModel?: string } | null },
	ctx: { hosts: Set<string>; guestsByName: Map<string, GuestType> },
): SystemKind {
	for (const t of s.tags) {
		const k = TAG_KIND[norm(t)];
		if (k) return k;
	}
	if (ctx.hosts.has(s.id)) return "physical";
	const host = norm(s.info?.h ?? s.details?.hostname);
	for (const n of [norm(s.name), host, host.split(".")[0]]) {
		const g = n && ctx.guestsByName.get(n);
		if (g) return g === "lxc" ? "lxc" : "vm";
	}
	if (VIRTUAL_CPU.test(s.info?.m ?? s.details?.cpuModel ?? "")) return "vm";
	if (/-pve$/.test(s.info?.k ?? s.details?.kernel ?? "")) return "lxc";
	return "physical";
}

export function systemKindContext(guests: GuestRef[]) {
	const hosts = new Set(guests.map((g) => g.host_id));
	const guestsByName = new Map<string, GuestType>();
	for (const g of guests) {
		const n = norm(g.name);
		if (n && !guestsByName.has(n)) guestsByName.set(n, g.type);
	}
	return { hosts, guestsByName };
}
