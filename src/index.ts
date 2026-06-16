import * as functions from "@google-cloud/functions-framework";
import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import type { Request, Response } from "express";
import type { IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";

// ─── Configuration ──────────────────────────────────────────────────────────

/** Headers injected by GCF/infrastructure that should NOT be forwarded upstream. */
const STRIPPED_REQUEST_HEADERS: readonly string[] = [
  "x-api-key",
  "x-target-host",
  "connection",
  "x-cloud-trace-context",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-port",
  "forwarded",
  "function-execution-id",
  "x-appengine-timeout-ms",
  "x-appengine-default-namespace",
  "traceparent",
  "authorization",
  "cookie",
];

/** Response headers that should NOT be sent back to the client. */
const STRIPPED_RESPONSE_HEADERS: readonly string[] = [
  "x-powered-by",
  "server",
  "set-cookie",
  "x-aspnet-version",
  "x-runtime-version",
];

const CONFIG = {
  API_KEY: process.env.API_KEY || "",
  PROXY_TIMEOUT: parseInt(process.env.PROXY_TIMEOUT || "30000", 10),
  VERIFY_SSL: process.env.VERIFY_SSL !== "false",
  MAX_BODY_SIZE: parseInt(process.env.MAX_BODY_SIZE || "10485760", 10), // 10MB
  DEBUG: process.env.DEBUG === "true",
} as const;

// ─── Types ───────────────────────────────────────────────────────────────────

interface RequestContext {
  requestId: string;
  method: string;
  startTime: number;
  target: string;
}

// ─── Utility Functions ───────────────────────────────────────────────────────

/** Returns a validated target URL string, or null if invalid/blocked. */
function resolveTarget(req: Request): string | null {
  const raw = req.headers["x-target-host"] as string | undefined;
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Returns an error message, or null if auth passes. */
function validateAuth(req: Request): string | null {
  if (!CONFIG.API_KEY) return "Server misconfigured";

  const key = req.headers["x-api-key"] as string | undefined;
  if (!key) return "Missing X-API-Key header";
  if (key !== CONFIG.API_KEY) return "Invalid API key";

  return null;
}

function log(
  severity: "INFO" | "WARNING" | "ERROR",
  ctx: RequestContext,
  extra?: Record<string, unknown>,
): void {
  const fn =
    severity === "ERROR"
      ? console.error
      : severity === "WARNING"
        ? console.warn
        : console.log;
  fn(
    JSON.stringify({
      severity,
      requestId: ctx.requestId,
      method: ctx.method,
      target: ctx.target,
      durationMs: Date.now() - ctx.startTime,
      ...extra,
    }),
  );
}

// ─── Proxy Middleware ────────────────────────────────────────────────────────

const proxyMiddleware = createProxyMiddleware<Request, Response>({
  target: "",
  router: (req) => resolveTarget(req) ?? "",
  changeOrigin: true,
  secure: CONFIG.VERIFY_SSL,
  timeout: CONFIG.PROXY_TIMEOUT,

  on: {
    proxyReq: (proxyReq, req: Request) => {
      const target = resolveTarget(req);
      if (target) {
        const { host } = new URL(target);
        proxyReq.setHeader("host", host);
        proxyReq.setHeader("x-forwarded-proto", req.protocol || "https");
        proxyReq.setHeader("x-forwarded-host", req.hostname || "");
      }

      for (const h of STRIPPED_REQUEST_HEADERS) proxyReq.removeHeader(h);

      if (req.body) fixRequestBody(proxyReq, req);
    },

    proxyRes: (proxyRes, _req, res: Response) => {
      const filtered = Object.fromEntries(
        Object.entries(proxyRes.headers as IncomingHttpHeaders).filter(
          ([k]) => !STRIPPED_RESPONSE_HEADERS.includes(k.toLowerCase()),
        ),
      );
      for (const [k, v] of Object.entries(filtered)) {
        if (v !== undefined) res.setHeader(k, v);
      }
    },

    error: (err: Error, _req, res: Response | Socket) => {
      console.error(
        JSON.stringify({
          severity: "ERROR",
          message: err.message,
          code: (err as NodeJS.ErrnoException).code,
        }),
      );
      if ("headersSent" in res && !res.headersSent) {
        (res as Response).status(502).json({
          error: "Bad Gateway",
          details: CONFIG.DEBUG ? err.message : undefined,
        });
      } else if ("destroy" in res) {
        res.destroy();
      }
    },
  },
});

// ─── Entry Point ─────────────────────────────────────────────────────────────

functions.http("proxy", (req: Request, res: Response) => {
  const ctx: RequestContext = {
    requestId: (req.headers["x-request-id"] as string) || randomUUID(),
    method: req.method || "UNKNOWN",
    startTime: Date.now(),
    target: "",
  };

  try {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key, X-Target-Host",
      "Access-Control-Max-Age": "3600",
      "X-Request-Id": ctx.requestId,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "X-XSS-Protection": "1; mode=block",
    });

    if (req.method === "OPTIONS") return res.status(204).send("");

    const authError = validateAuth(req);
    if (authError) {
      log("WARNING", ctx, { statusCode: 401, error: authError });
      return res.status(401).json({ error: authError });
    }

    const target = resolveTarget(req);
    if (!target) {
      log("WARNING", ctx, {
        statusCode: 400,
        error: "Missing or invalid X-Target-Host",
      });
      return res
        .status(400)
        .json({ error: "Missing or invalid X-Target-Host header" });
    }

    ctx.target = target;

    const contentLength = parseInt(req.headers["content-length"] || "0", 10);
    if (contentLength > CONFIG.MAX_BODY_SIZE) {
      log("WARNING", ctx, { statusCode: 413, error: "Payload too large" });
      return res.status(413).json({ error: "Payload too large" });
    }

    res.on("finish", () => log("INFO", ctx, { statusCode: res.statusCode }));

    proxyMiddleware(req, res, (err?: unknown) => {
      if (err && !res.headersSent) {
        const msg = err instanceof Error ? err.message : String(err);
        log("ERROR", ctx, { statusCode: 500, error: msg });
        res.status(500).json({ error: "Internal server error" });
      }
    });
  } catch (err) {
    log("ERROR", ctx, {
      statusCode: 500,
      error: err instanceof Error ? err.message : "Unknown error",
    });
    if (!res.headersSent)
      res.status(500).json({ error: "Internal server error" });
  }
});
