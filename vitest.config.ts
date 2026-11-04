import { defineConfig } from "vitest/config";
export default defineConfig({
	test: { include: ["test/**/*.test.ts"] },
	resolve: {
		alias: {
			"cloudflare:sockets": new URL("./test/stub-sockets.ts", import.meta.url).pathname,
			"cloudflare:workers": new URL("./test/stub-workers.ts", import.meta.url).pathname,
		},
	},
});
