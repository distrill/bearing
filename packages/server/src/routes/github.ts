import type { FastifyInstance } from "fastify";
import type { BearingConfig } from "../config.js";
import { searchPRs, getSuggestedPRs, getViewer, getPRDetail, submitReview, mergePR, closePR, fetchUserRepos, fetchGitHubStats, makeDays } from "../github.js";
import { fetchCompletedIssuesForStats } from "../linear.js";
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

  app.post("/api/prs/:owner/:repo/:number/review", async (request, reply) => {
    if (!config.github.token) {
      return reply.code(503).send({ error: "GitHub token not configured" });
    }

    const { owner, repo, number } = request.params as {
      owner: string;
      repo: string;
      number: string;
    };
    const { body, event, comments } = request.body as {
      body: string;
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      comments?: Array<{ path: string; line: number; start_line?: number; side: "LEFT" | "RIGHT"; body: string }>;
    };

    if (!["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(event)) {
      return reply.code(400).send({ error: "Invalid event type" });
    }

    await submitReview(
      config.github.token,
      owner,
      repo,
      parseInt(number, 10),
      body,
      event,
      comments,
    );

    invalidatePrefix(`pr-detail:${owner}/${repo}#${number}`);

    return { ok: true };
  });

  app.post("/api/prs/:owner/:repo/:number/merge", async (request, reply) => {
    if (!config.github.token) {
      return reply.code(503).send({ error: "GitHub token not configured" });
    }

    const { owner, repo, number } = request.params as {
      owner: string;
      repo: string;
      number: string;
    };
    const { method, commitMessage } = request.body as { method: "merge" | "squash" | "rebase"; commitMessage?: string };

    if (!["merge", "squash", "rebase"].includes(method)) {
      return reply.code(400).send({ error: "Invalid merge method" });
    }

    await mergePR(config.github.token, owner, repo, parseInt(number, 10), method, commitMessage);
    invalidatePrefix(`pr-detail:${owner}/${repo}#${number}`);
    invalidatePrefix("prs:");

    return { ok: true };
  });

  app.post("/api/prs/:owner/:repo/:number/close", async (request, reply) => {
    if (!config.github.token) {
      return reply.code(503).send({ error: "GitHub token not configured" });
    }

    const { owner, repo, number } = request.params as {
      owner: string;
      repo: string;
      number: string;
    };

    await closePR(config.github.token, owner, repo, parseInt(number, 10));
    invalidatePrefix(`pr-detail:${owner}/${repo}#${number}`);
    invalidatePrefix("prs:");

    return { ok: true };
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

  app.get("/api/repos", async (_request, reply) => {
    if (!config.github.token) {
      return reply.code(503).send({ error: "GitHub token not configured" });
    }

    const repos = await cached("repos", () => fetchUserRepos(config.github.token));
    return { repos };
  });

  app.get("/api/stats", async (request, reply) => {
    if (!config.github.token) {
      return reply.code(503).send({ error: "GitHub token not configured" });
    }

    const { repos, teams } = request.query as { repos?: string; teams?: string };
    const repoList = repos ? repos.split(",").filter(Boolean) : [];
    const teamList = teams ? teams.split(",").filter(Boolean) : [];

    if (repoList.length === 0 && teamList.length === 0) {
      return {
        days: [],
        prsOpened: [],
        prsMerged: [],
        prsReviewed: [],
        linesAuthored: [],
        issuesClosed: [],
      };
    }

    const cacheKey = `stats:${repoList.join(",")}:${teamList.join(",")}`;

    return cached(cacheKey, async () => {
      let ghStats = {
        days: [] as string[],
        prsOpened: [] as number[],
        prsMerged: [] as number[],
        prsReviewed: [] as number[],
        linesAuthored: [] as number[],
      };

      if (repoList.length > 0) {
        ghStats = await fetchGitHubStats(config.github.token, repoList);
      }

      let issuesClosed = new Array(14).fill(0);
      const days = ghStats.days.length > 0 ? ghStats.days : makeDays(14);

      if (teamList.length > 0 && config.linear.apiKeys.length > 0) {
        const completed = await fetchCompletedIssuesForStats(config.linear.apiKeys, teamList);
        const dayIndex = new Map(days.map((d: string, i: number) => [d, i]));
        for (const issue of completed) {
          const day = issue.completedAt.slice(0, 10);
          const idx = dayIndex.get(day);
          if (idx !== undefined) issuesClosed[idx]++;
        }
      }

      return {
        days,
        prsOpened: ghStats.prsOpened.length > 0 ? ghStats.prsOpened : new Array(14).fill(0),
        prsMerged: ghStats.prsMerged.length > 0 ? ghStats.prsMerged : new Array(14).fill(0),
        prsReviewed: ghStats.prsReviewed.length > 0 ? ghStats.prsReviewed : new Array(14).fill(0),
        linesAuthored: ghStats.linesAuthored.length > 0 ? ghStats.linesAuthored : new Array(14).fill(0),
        issuesClosed,
      };
    });
  });
}
