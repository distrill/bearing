import type {
  PullRequest,
  GitHubUser,
  ReviewDecision,
  PRDetailResponse,
} from "@bearing/shared";
import type { SuggestionsConfig } from "./config.js";

const GITHUB_GRAPHQL = "https://api.github.com/graphql";

const PR_SEARCH_QUERY = `
query($query: String!, $first: Int!) {
  search(query: $query, type: ISSUE, first: $first) {
    nodes {
      ... on PullRequest {
        databaseId
        number
        title
        url
        permalink
        state
        isDraft
        createdAt
        updatedAt
        mergedAt
        author {
          login
          avatarUrl
        }
        repository {
          name
          owner {
            login
          }
        }
        additions
        deletions
        reviewDecision
        reviewRequests(first: 10) {
          nodes {
            requestedReviewer {
              ... on User {
                login
                avatarUrl
              }
            }
          }
        }
        labels(first: 10) {
          nodes {
            name
            color
          }
        }
        body
      }
    }
  }
}
`;

const VIEWER_QUERY = `
query {
  viewer {
    login
    avatarUrl
    organizations(first: 20) {
      nodes {
        login
      }
    }
  }
}
`;

interface GraphQLResponse<T> {
  data: T;
  errors?: Array<{ message: string }>;
}

async function graphql<T>(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(GITHUB_GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors?.length) {
    throw new Error(`GitHub GraphQL error: ${json.errors[0].message}`);
  }

  return json.data;
}

// Matches Linear issue IDs like ABC-123, ENG-456
const LINEAR_ID_RE = /\b([A-Z]{2,10}-\d+)\b/;

function extractLinearIssueId(body: string | null): string | null {
  if (!body) return null;
  const match = body.match(LINEAR_ID_RE);
  return match ? match[1] : null;
}

interface SearchResult {
  search: {
    nodes: Array<RawPR>;
  };
}

interface RawPR {
  databaseId: number;
  number: number;
  title: string;
  url: string;
  permalink: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  author: { login: string; avatarUrl: string } | null;
  repository: { name: string; owner: { login: string } };
  additions: number;
  deletions: number;
  reviewDecision: ReviewDecision | null;
  reviewRequests: {
    nodes: Array<{
      requestedReviewer: { login: string; avatarUrl: string } | null;
    }>;
  };
  labels: { nodes: Array<{ name: string; color: string }> };
  body: string | null;
}

function mapState(
  state: "OPEN" | "CLOSED" | "MERGED",
): "open" | "closed" | "merged" {
  return state.toLowerCase() as "open" | "closed" | "merged";
}

function toPullRequest(raw: RawPR): PullRequest {
  return {
    id: raw.databaseId,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    htmlUrl: raw.permalink,
    state: mapState(raw.state),
    draft: raw.isDraft,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    mergedAt: raw.mergedAt,
    author: raw.author ?? { login: "ghost", avatarUrl: "" },
    repo: raw.repository.name,
    owner: raw.repository.owner.login,
    additions: raw.additions,
    deletions: raw.deletions,
    reviewDecision: raw.reviewDecision,
    requestedReviewers: raw.reviewRequests.nodes
      .map((n) => n.requestedReviewer)
      .filter((r): r is GitHubUser => r !== null),
    labels: raw.labels.nodes,
    linkedLinearIssueId: extractLinearIssueId(raw.body),
  };
}

interface ViewerResult {
  viewer: GitHubUser & {
    organizations: { nodes: Array<{ login: string }> };
  };
}

export async function getViewer(token: string): Promise<GitHubUser> {
  const data = await graphql<ViewerResult>(token, VIEWER_QUERY);
  return data.viewer;
}

async function getViewerOrgs(token: string): Promise<string[]> {
  const data = await graphql<ViewerResult>(token, VIEWER_QUERY);
  return data.viewer.organizations.nodes.map((o) => o.login);
}

export async function searchPRs(
  token: string,
  filter: "review_requested" | "authored",
): Promise<PullRequest[]> {
  if (filter === "review_requested") {
    const [requested, reviewed] = await Promise.all([
      graphql<SearchResult>(token, PR_SEARCH_QUERY, {
        query: "type:pr state:open review-requested:@me",
        first: 50,
      }),
      graphql<SearchResult>(token, PR_SEARCH_QUERY, {
        query: "type:pr state:open reviewed-by:@me -author:@me",
        first: 30,
      }),
    ]);

    const seen = new Set<number>();
    const prs: PullRequest[] = [];
    for (const raw of [...requested.search.nodes, ...reviewed.search.nodes]) {
      const pr = toPullRequest(raw);
      if (!seen.has(pr.id)) {
        seen.add(pr.id);
        prs.push(pr);
      }
    }
    prs.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    return prs;
  }

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const [openData, recentData] = await Promise.all([
    graphql<SearchResult>(token, PR_SEARCH_QUERY, {
      query: "type:pr state:open author:@me",
      first: 50,
    }),
    graphql<SearchResult>(token, PR_SEARCH_QUERY, {
      query: `type:pr author:@me -state:open updated:>${cutoff}`,
      first: 20,
    }),
  ]);

  const seen = new Set<number>();
  const prs: PullRequest[] = [];
  for (const raw of [...openData.search.nodes, ...recentData.search.nodes]) {
    const pr = toPullRequest(raw);
    if (!seen.has(pr.id)) {
      seen.add(pr.id);
      prs.push(pr);
    }
  }
  prs.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return prs;
}

export async function getSuggestedPRs(
  token: string,
  config: SuggestionsConfig,
): Promise<PullRequest[]> {
  const limit = config.limit ?? 5;

  const orgs = await getViewerOrgs(token);
  if (orgs.length === 0) return [];

  // Query per org, merge results
  const allPrs: PullRequest[] = [];
  for (const org of orgs) {
    const qualifier = `type:pr state:open review:required org:${org} -author:@me -review-requested:@me -reviewed-by:@me`;
    const data = await graphql<SearchResult>(token, PR_SEARCH_QUERY, {
      query: qualifier,
      first: 30,
    });
    allPrs.push(...data.search.nodes.map(toPullRequest));
  }

  const preferredAuthors = new Set(
    (config.preferAuthors ?? []).map((a) => a.toLowerCase()),
  );
  const hasTeams = (config.teams ?? []).length > 0;

  // Score and rank
  const scored = allPrs.map((pr) => {
    let score = 0;

    // Preferred author boost
    if (preferredAuthors.has(pr.author.login.toLowerCase())) {
      score += 10;
    }

    // Recency boost (updated in last 7 days)
    const daysOld =
      (Date.now() - new Date(pr.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysOld < 1) score += 5;
    else if (daysOld < 3) score += 3;
    else if (daysOld < 7) score += 1;

    // Smaller PRs are more reviewable
    const size = pr.additions + pr.deletions;
    if (size < 100) score += 3;
    else if (size < 300) score += 2;
    else if (size < 500) score += 1;

    // Not a draft
    if (!pr.draft) score += 2;

    // Needs review (no reviews yet)
    if (pr.reviewDecision === "REVIEW_REQUIRED") score += 2;

    return { pr, score };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((s) => s.pr);
}

// --- REST API for PR detail ---

async function restGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub REST API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

async function restPost<T>(token: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub REST API error: ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface InlineCommentPayload {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

export async function submitReview(
  token: string,
  owner: string,
  repo: string,
  number: number,
  body: string,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  comments?: InlineCommentPayload[],
): Promise<void> {
  await restPost(token, `/repos/${owner}/${repo}/pulls/${number}/reviews`, {
    body,
    event,
    ...(comments && comments.length > 0 ? { comments } : {}),
  });
}

interface RawRestPR {
  title: string;
  number: number;
  body: string | null;
  state: string;
  draft: boolean;
  merged: boolean;
  html_url: string;
  user: { login: string; avatar_url: string };
  created_at: string;
  updated_at: string;
  additions: number;
  deletions: number;
  changed_files: number;
}

interface RawRestFile {
  sha: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  previous_filename?: string;
}

interface RawRestReview {
  id: number;
  state: string;
  body: string | null;
  user: { login: string; avatar_url: string };
  submitted_at: string;
}

interface RawRestComment {
  id: number;
  body: string;
  path: string;
  line: number | null;
  original_line: number | null;
  side: string | null;
  user: { login: string; avatar_url: string };
  created_at: string;
  updated_at: string;
  in_reply_to_id?: number;
  pull_request_review_id?: number;
}

interface RawRestCommit {
  sha: string;
  commit: {
    message: string;
    author: { date: string };
  };
  author: { login: string; avatar_url: string } | null;
}

interface RawRestIssueComment {
  id: number;
  body: string;
  user: { login: string; avatar_url: string };
  created_at: string;
}

export async function getPRDetail(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<PRDetailResponse> {
  const base = `/repos/${owner}/${repo}/pulls/${number}`;

  const [pr, files, reviews, comments, issueComments, commits] = await Promise.all([
    restGet<RawRestPR>(token, base),
    restGet<RawRestFile[]>(token, `${base}/files?per_page=100`),
    restGet<RawRestReview[]>(token, `${base}/reviews`),
    restGet<RawRestComment[]>(token, `${base}/comments?per_page=100`),
    restGet<RawRestIssueComment[]>(
      token,
      `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
    ),
    restGet<RawRestCommit[]>(token, `${base}/commits?per_page=100`),
  ]);

  return {
    title: pr.title,
    number: pr.number,
    body: pr.body ?? "",
    state: pr.merged ? "merged" : (pr.state as "open" | "closed"),
    draft: pr.draft,
    htmlUrl: pr.html_url,
    author: { login: pr.user.login, avatarUrl: pr.user.avatar_url },
    owner,
    repo,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    files: files.map((f) => ({
      sha: f.sha,
      filename: f.filename,
      status: f.status as PRDetailResponse["files"][number]["status"],
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
      previousFilename: f.previous_filename,
    })),
    reviews: reviews.map((r) => ({
      id: r.id,
      state: r.state as PRDetailResponse["reviews"][number]["state"],
      body: r.body ?? "",
      author: { login: r.user.login, avatarUrl: r.user.avatar_url },
      submittedAt: r.submitted_at,
    })),
    comments: comments.map((c) => ({
      id: c.id,
      body: c.body,
      path: c.path,
      line: c.line ?? c.original_line ?? null,
      side: (c.side as "LEFT" | "RIGHT") ?? "RIGHT",
      author: { login: c.user.login, avatarUrl: c.user.avatar_url },
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      inReplyToId: c.in_reply_to_id ?? null,
      reviewId: c.pull_request_review_id ?? null,
    })),
    issueComments: issueComments.map((c) => ({
      id: c.id,
      body: c.body,
      author: { login: c.user.login, avatarUrl: c.user.avatar_url },
      createdAt: c.created_at,
    })),
    commits: commits.map((c) => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.author
        ? { login: c.author.login, avatarUrl: c.author.avatar_url }
        : { login: "unknown", avatarUrl: "" },
      committedAt: c.commit.author.date,
    })),
  };
}
