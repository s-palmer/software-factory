/**
 * HTTP Basic auth for sharing the dev dashboard through a public tunnel.
 * Enabled only when DASHBOARD_PASSWORD is set; covers every request Vite serves, including the proxied /api.
 */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

export const DASHBOARD_USER = "factory";

/** Constant-time check of an `Authorization: Basic ...` header. */
export function isAuthorized(header: string | undefined, user: string, password: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  const given = Buffer.from(header.slice(6), "base64");
  const expected = Buffer.from(`${user}:${password}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function basicAuthPlugin(password: string | undefined): Plugin {
  const middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (password && isAuthorized(req.headers.authorization, DASHBOARD_USER, password)) return next();
    res.statusCode = 401;
    res.setHeader("WWW-Authenticate", 'Basic realm="Software Factory", charset="UTF-8"');
    res.end("Authentication required");
  };
  return {
    name: "factory-basic-auth",
    apply: () => Boolean(password),
    configureServer: (server) => void server.middlewares.use(middleware),
    configurePreviewServer: (server) => void server.middlewares.use(middleware),
  };
}
