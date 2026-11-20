import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { resolve } from "node:path";

/**
 * The packaged app runs under a strict policy. The dev server cannot: React
 * Refresh injects an inline module script, and HMR needs a websocket back to
 * the Vite server. Keeping the production policy tight matters more than the
 * dev one, so the two are set separately rather than loosening both.
 */
function cspPlugin(): Plugin {
  const PRODUCTION = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";
  const DEVELOPMENT =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: http:";

  return {
    name: "wl2go:csp",
    transformIndexHtml(html, ctx) {
      return html.replace("__CSP__", ctx.server ? DEVELOPMENT : PRODUCTION);
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, "src/main/index.ts") },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, "src/preload/index.ts") },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react(), cspPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") },
    },
  },
});
