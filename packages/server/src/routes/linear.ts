import type { FastifyInstance } from "fastify";
import type { BearingConfig } from "../config.js";
import {
  fetchAllIssues,
  fetchWorkflowStates,
  updateIssueStatus,
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
    }

    const issues = await cached("issues", () =>
      fetchAllIssues(config.linear.apiKeys),
    );
    return { issues };
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
}
