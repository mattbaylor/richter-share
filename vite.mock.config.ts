// Standalone SPA config for UI development without the Worker (no Cloudflare plugin).
//   VITE_MOCK=1 npx vite --config vite.mock.config.ts --port 5199
// Dashboard at /, public status page at /s/main (or any path with ?mode=public).
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: { alias: { "@shared": "/src/shared", "@": "/src/client" } },
	build: { outDir: "dist/client-standalone", emptyOutDir: true },
});
