import type { PullRequest } from "./github.js";
import type { LinearIssue } from "./linear.js";

// GET /api/prs?filter=review_requested|authored
export interface PullRequestsResponse {
  prs: PullRequest[];
}

// GET /api/issues
export interface LinearIssuesResponse {
  issues: LinearIssue[];
}

// GET /api/health
export interface HealthResponse {
  status: "ok";
  github: boolean;
  linear: boolean;
}
