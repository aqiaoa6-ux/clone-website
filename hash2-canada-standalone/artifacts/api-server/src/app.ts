import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();
app.set("trust proxy", 1);

app.use(pinoHttp({
  logger,
  serializers: {
    req(req) { return { id: req.id, method: req.method, url: req.url?.split("?")[0] }; },
    res(res) { return { statusCode: res.statusCode }; },
  },
}));

app.get("/healthz", (_req, res) => {
  res.json({
    status: "ok",
    commit: process.env.RENDER_GIT_COMMIT ?? process.env.SOURCE_VERSION ?? null,
    build: process.env.RENDER_SERVICE_ID ?? null,
    nodeEnv: process.env.NODE_ENV ?? null,
  });
});

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

app.use("/api", (req, res) => {
  res.status(404).json({ error: "接口不存在" });
});

app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error({ err }, "Unhandled error");
  const url = req.originalUrl ?? "";
  if (url.startsWith("/api")) {
    res.status(500).json({ error: "服务器错误", message: err instanceof Error ? err.message : "unknown" });
    return;
  }
  next(err);
});

{
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(dirname, "..", "..", "lottery-bot", "dist", "public");

  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
    app.get(/^(?!\/api).*/, (req, res, next) => {
      if (req.method !== "GET") return next();
      res.sendFile(path.join(publicDir, "index.html"));
    });
  }
}

export default app;
