import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { basicAuthPlugin } from "./server/basic-auth";

/** The dashboard talks to the factory API (server/) through this proxy, in dev and preview. */
const api = `http://127.0.0.1:${process.env.API_PORT ?? 8787}`;
const proxy = { "/api": api, "/artifacts": api };

/** Set DASHBOARD_PASSWORD to require a login (user "factory"), e.g. when sharing through a tunnel. */
const password = process.env.DASHBOARD_PASSWORD;
/** Hostnames allowed besides localhost; quick tunnels use *.trycloudflare.com. */
const allowedHosts = password ? [".trycloudflare.com"] : [];

export default defineConfig({
  plugins: [react(), basicAuthPlugin(password)],
  server: { port: 5173, strictPort: true, proxy, allowedHosts },
  preview: { port: 4173, strictPort: true, proxy, allowedHosts },
  test: {
    environment: "jsdom",
    // Browsers have Temporal; Node 24 does not, so the tests load a polyfill.
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}", "server/**/*.test.ts", "shared/**/*.test.ts", "cli/**/*.test.ts"],
  },
});
