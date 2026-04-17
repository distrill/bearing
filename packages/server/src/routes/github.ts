import type { FastifyInstance } from "fastify";
import type { BearingConfig } from "../config.js";
import { searchPRs, getSuggestedPRs, getViewer, getPRDetail } from "../github.js";
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

  app.get("/api/prs/:owner/:repo/:number/detail", async (request, reply) => {
    if (!config.github.token) {
      return reply.code(503).send({ error: "GitHub token not configured" });
    }

    const { owner, repo, number } = request.params as {
      owner: string;
      repo: string;
      number: string;
    };

    const detail = await cached(
      `pr-detail:${owner}/${repo}#${number}`,
      () => getPRDetail(config.github.token, owner, repo, parseInt(number, 10)),
    );

    return detail;
  });

  app.get("/api/github-image", async (request, reply) => {
    const { url } = request.query as { url?: string };
    if (!url || !config.github.token) {
      return reply.code(400).send({ error: "Missing url parameter" });
    }

    const allowed =
      url.startsWith("https://github.com/") ||
      url.startsWith("https://user-images.githubusercontent.com/") ||
      url.startsWith("https://private-user-images.githubusercontent.com/");
    if (!allowed) {
      return reply.code(403).send({ error: "URL not allowed" });
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.github.token}` },
      redirect: "follow",
    });

    if (!res.ok) {
      return reply.code(res.status).send({ error: "Failed to fetch image" });
    }

    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const buffer = Buffer.from(await res.arrayBuffer());

    return reply
      .header("content-type", contentType)
      .header("cache-control", "public, max-age=3600")
      .send(buffer);
  });

  app.get("/api/me", async (_request, reply) => {
    if (!config.github.token) {
      return reply.code(503).send({ error: "GitHub token not configured" });
    }

    return cached("viewer", () => getViewer(config.github.token));
  });
}
