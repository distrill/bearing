import type { FastifyInstance } from "fastify";
import type { BearingConfig } from "../config.js";
import {
  fetchAllIssues,
  fetchAllTeams,
  fetchWorkflowStates,
  updateIssueStatus,
  createIssue,
  fetchViewerId,
} from "../linear.js";
import { cached, invalidatePrefix } from "../cache.js";

export async function linearRoutes(
  app: FastifyInstance,
  config: BearingConfig,
) {
  app.get("/api/issues", async (_request, reply) => {
    const { refresh } = _request.query as { refresh?: string };

    if (!config.linear.apiKeys.length) {
      return reply.code(503).send({ error: "No Linear API keys configured" });
    }

    if (refresh !== undefined) {
      invalidatePrefix("issues");
      invalidatePrefix("linear-viewer-ids");
    }

    const [issues, viewerIds] = await Promise.all([
      cached("issues", () => fetchAllIssues(config.linear.apiKeys)),
      cached("linear-viewer-ids", () =>
        Promise.all(config.linear.apiKeys.map(fetchViewerId)),
      ),
    ]);
    return { issues, viewerIds };
  });

  app.get("/api/issues/workflow-states/:teamKey", async (request, reply) => {
    const { teamKey } = request.params as { teamKey: string };

    if (!config.linear.apiKeys.length) {
      return reply.code(503).send({ error: "No Linear API keys configured" });
    }

    for (const apiKey of config.linear.apiKeys) {
      try {
        const states = await fetchWorkflowStates(apiKey, teamKey);
        if (states.length > 0) return { states };
      } catch { /* try next key */ }
    }

    return reply.code(404).send({ error: "No workflow states found" });
  });

  app.patch("/api/issues/:issueId/status", async (request, reply) => {
    const { issueId } = request.params as { issueId: string };
    const { stateId } = request.body as { stateId: string };

    if (!config.linear.apiKeys.length) {
      return reply.code(503).send({ error: "No Linear API keys configured" });
    }

    for (const apiKey of config.linear.apiKeys) {
      try {
        const status = await updateIssueStatus(apiKey, issueId, stateId);
        invalidatePrefix("issues");
        return { status };
      } catch { /* try next key */ }
    }

    return reply.code(500).send({ error: "Failed to update issue status" });
  });

  app.get("/api/teams", async (_request, reply) => {
    if (!config.linear.apiKeys.length) {
      return reply.code(503).send({ error: "No Linear API keys configured" });
    }

    const teams = await cached("teams", () =>
      fetchAllTeams(config.linear.apiKeys),
    );
    return { teams };
  });

  app.post("/api/issues", async (request, reply) => {
    const { teamId, title } = request.body as { teamId: string; title: string };

    if (!config.linear.apiKeys.length) {
      return reply.code(503).send({ error: "No Linear API keys configured" });
    }

    for (const apiKey of config.linear.apiKeys) {
      try {
        const issue = await createIssue(apiKey, teamId, title);
        invalidatePrefix("issues");
        return { issue };
      } catch { /* try next key */ }
    }

    return reply.code(500).send({ error: "Failed to create issue" });
  });
}
