import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadConfig, hasGitHubToken, hasLinearKey } from "./config.js";
import { initDb } from "./db.js";
import { githubRoutes } from "./routes/github.js";
import { linearRoutes } from "./routes/linear.js";

const config = loadConfig();
const db = initDb();

const app = Fastify({ logger: true });

await app.register(cors, { origin: "http://localhost:5173" });

app.get("/api/health", async () => {
  return {
    status: "ok",
    github: hasGitHubToken(config),
    linear: hasLinearKey(config),
  };
});

await githubRoutes(app, config);
await linearRoutes(app, config);

try {
  await app.listen({ port: 3001, host: "127.0.0.1" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
