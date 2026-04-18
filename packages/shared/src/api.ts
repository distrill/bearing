import type { PullRequest, PullRequestFile, PullRequestReview, PullRequestCommit, ReviewComment, IssueComment, GitHubUser, CheckRun } from "./github.js";
import type { LinearIssue } from "./linear.js";

// GET /api/prs?filter=review_requested|authored
export interface PullRequestsResponse {
  prs: PullRequest[];
}

// GET /api/issues
export interface LinearIssuesResponse {
  issues: LinearIssue[];
  viewerIds: string[];
}

// GET /api/prs/:owner/:repo/:number/detail
export interface PRDetailResponse {
  title: string;
  number: number;
  body: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  htmlUrl: string;
  author: GitHubUser;
  owner: string;
  repo: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: PullRequestFile[];
  reviews: PullRequestReview[];
  comments: ReviewComment[];
  issueComments: IssueComment[];
  commits: PullRequestCommit[];
  checkRuns: CheckRun[];
  mergeable: boolean | null;
  mergeableState: string;
  allowedMergeMethods: ("merge" | "squash" | "rebase")[];
  truncated: string[];
}

// GET /api/repos
export interface ReposResponse {
  repos: { owner: string; name: string; fullName: string }[];
}

// GET /api/stats
export interface StatsResponse {
  days: string[];
  prsOpened: number[];
  prsMerged: number[];
  prsReviewed: number[];
  linesAuthored: number[];
  issuesClosed: number[];
}

// GET /api/health
export interface HealthResponse {
  status: "ok";
  github: boolean;
  linear: boolean;
}
