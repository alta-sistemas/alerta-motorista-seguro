import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { createCorsMiddleware } from "./cors";
import { clearLegacySessionCookie } from "./cookies";
import { registerAlertApi } from "./alertApi";

function alertRateLimit(windowMs = 60_000, max = 120) {
  const buckets = new Map<string, { startedAt: number; count: number }>();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = `${req.ip}:${req.path}`;
    const current = buckets.get(key);
    const now = Date.now();
    if (!current || now - current.startedAt >= windowMs) buckets.set(key, { startedAt: now, count: 1 });
    else current.count += 1;
    const bucket = buckets.get(key)!;
    if (bucket.count > max) return res.status(429).json({ ok: false, error: "Muitas tentativas. Aguarde um minuto." });
    if (buckets.size > 10_000) for (const [bucketKey, value] of buckets) if (now - value.startedAt >= windowMs) buckets.delete(bucketKey);
    return next();
  };
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.use(createCorsMiddleware());
  app.use(clearLegacySessionCookie());

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  app.use("/api/alert", alertRateLimit());

  registerStorageProxy(app);
  registerOAuthRoutes(app);
  registerAlertApi(app);

  app.get("/", (_req, res) => {
    res.json({
      name: "Alerta API",
      ok: true,
      health: "/api/health",
    });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, timestamp: Date.now() });
  });

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    }),
  );

  const port = parseInt(process.env.PORT || "3000");
  server.listen(port, () => {
    console.log("[api] server listening");
  });
}

startServer().catch(() => {
  console.error("[api] server failed to start");
});
