import type { FastifyInstance } from "fastify";
import type { BearingConfig } from "../config.js";
import { searchPRs, getSuggestedPRs, getViewer } from "../github.js";
import { cached, invalidatePrefix } from "../cache.js";

export async function githubRoutes(
  app: FastifyInstance,
  config: BearingConfig,
) {
  app.get("/api/prs", async (request, reply) => {
    const { filter = "review_requested", refresh } = request.query as {
      filter?: string;
      refresh?: string;
    };

    if (!config.github.token) {
      return reply.code(503).send({ error: "GitHub token not configured" });
    }

    if (
      filter !== "review_requested" &&
      filter !== "authored" &&
      filter !== "suggested"
    ) {
      return reply
        .code(400)
        .send({
          error:
            'filter must be "review_requested", "authored", or "suggested"',
        });
    }

    if (filter === "suggested") {
      if (!config.github.suggestions) {
        return { prs: [] };
      }
      if (refresh !== undefined) {
        invalidatePrefix("prs:");
      }
      const prs = await cached("prs:suggested", () =>
        getSuggestedPRs(config.github.token, config.github.suggestions!),
      );
      return { prs };
    }

    if (refresh !== undefined) {
      invalidatePrefix("prs:");
    }

    const prs = await cached(`prs:${filter}`, () =>
      searchPRs(config.github.token, filter),
    );
    return { prs };
  });

  app.get("/api/me", async (_request, reply) => {
    if (!config.github.token) {
      return reply.code(503).send({ error: "GitHub token not configured" });
    }

    return cached("viewer", () => getViewer(config.github.token));
  });
}
