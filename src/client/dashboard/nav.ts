import { Activity, Bell, CalendarClock, LayoutDashboard, Server, Settings } from "lucide-react";

export const NAV = [
	{ href: "/systems", label: "Systems", icon: Server },
	{ href: "/monitors", label: "Monitors", icon: Activity },
	{ href: "/status-pages", label: "Status pages", icon: LayoutDashboard },
	{ href: "/incidents", label: "Incidents & maintenance", short: "Incidents", icon: CalendarClock },
	{ href: "/notifications", label: "Notifications", icon: Bell },
	{ href: "/settings", label: "Settings", icon: Settings },
] as const;
