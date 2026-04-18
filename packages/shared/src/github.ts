export interface PullRequest {
  id: number;
  number: number;
  title: string;
  url: string;
  htmlUrl: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  author: GitHubUser;
  repo: string;
  owner: string;
  additions: number;
  deletions: number;
  reviewDecision: ReviewDecision | null;
  requestedReviewers: GitHubUser[];
  labels: Label[];
  linkedLinearIssueId: string | null;
}

export interface GitHubUser {
  login: string;
  avatarUrl: string;
}

export interface Label {
  name: string;
  color: string;
}

export type ReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED";

export interface ReviewComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  startLine: number | null;
  side: "LEFT" | "RIGHT";
  author: GitHubUser;
  createdAt: string;
  updatedAt: string;
  inReplyToId: number | null;
  reviewId: number | null;
}

export interface PullRequestReview {
  id: number;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING" | "DISMISSED";
  body: string;
  author: GitHubUser;
  submittedAt: string;
}

export interface PullRequestCommit {
  sha: string;
  message: string;
  author: GitHubUser;
  committedAt: string;
}

export interface CheckRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null;
  htmlUrl: string;
}

export interface IssueComment {
  id: number;
  body: string;
  author: GitHubUser;
  createdAt: string;
}

export interface PullRequestFile {
  sha: string;
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  patch?: string;
  previousFilename?: string;
}
