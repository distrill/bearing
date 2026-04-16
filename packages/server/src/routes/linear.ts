import type { FastifyInstance } from "fastify";
import type { BearingConfig } from "../config.js";

export async function linearRoutes(
  app: FastifyInstance,
  config: BearingConfig,
) {
  app.get("/api/issues", async (request, reply) => {
    if (!config.linear.apiKey) {
      return reply.code(503).send({ error: "Linear API key not configured" });
    }

    // TODO: implement Linear API calls
    return { issues: [] };
  });
}
