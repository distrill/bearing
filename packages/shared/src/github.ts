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
  author: GitHubUser;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequestReview {
  id: number;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING";
  body: string;
  author: GitHubUser;
  submittedAt: string;
}
