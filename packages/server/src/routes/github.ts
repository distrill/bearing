import type { FastifyInstance } from "fastify";
import type { BearingConfig } from "../config.js";

export async function githubRoutes(
  app: FastifyInstance,
  config: BearingConfig,
) {
  app.get("/api/prs", async (request, reply) => {
    const { filter } = request.query as { filter?: string };

    if (!config.github.token) {
      return reply.code(503).send({ error: "GitHub token not configured" });
    }

    // TODO: implement GitHub API calls
    return { prs: [] };
  });
}
