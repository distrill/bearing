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
  start_line?: number;
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
  mergeable: boolean | null;
  mergeable_state: string;
  head: { sha: string };
}

interface RawRestCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
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
  start_line: number | null;
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
    restGet<RawRestReview[]>(token, `${base}/reviews?per_page=100`),
    restGet<RawRestComment[]>(token, `${base}/comments?per_page=100`),
    restGet<RawRestIssueComment[]>(
      token,
      `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100`,
    ),
    restGet<RawRestCommit[]>(token, `${base}/commits?per_page=100`),
  ]);

  const repoData = await restGet<{
    allow_merge_commit: boolean;
    allow_squash_merge: boolean;
    allow_rebase_merge: boolean;
  }>(token, `/repos/${owner}/${repo}`);

  const checkRunsData = await restGet<{ check_runs: RawRestCheckRun[] }>(
    token,
    `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
  );

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
      startLine: c.start_line ?? null,
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
    checkRuns: checkRunsData.check_runs.map((cr) => ({
      id: cr.id,
      name: cr.name,
      status: cr.status as "queued" | "in_progress" | "completed",
      conclusion: cr.conclusion as any,
      htmlUrl: cr.html_url,
    })),
    mergeable: pr.mergeable,
    mergeableState: pr.mergeable_state,
    allowedMergeMethods: [
      ...(repoData.allow_merge_commit ? ["merge" as const] : []),
      ...(repoData.allow_squash_merge ? ["squash" as const] : []),
      ...(repoData.allow_rebase_merge ? ["rebase" as const] : []),
    ],
    truncated: [
      ...(files.length >= 100 ? ["files"] : []),
      ...(reviews.length >= 100 ? ["reviews"] : []),
      ...(comments.length >= 100 ? ["comments"] : []),
      ...(issueComments.length >= 100 ? ["issueComments"] : []),
      ...(commits.length >= 100 ? ["commits"] : []),
      ...(checkRunsData.check_runs.length >= 100 ? ["checkRuns"] : []),
    ],
  };
}

async function restPut<T>(token: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: "PUT",
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

export async function mergePR(
  token: string,
  owner: string,
  repo: string,
  number: number,
  method: "merge" | "squash" | "rebase",
  commitMessage?: string,
): Promise<void> {
  await restPut(token, `/repos/${owner}/${repo}/pulls/${number}/merge`, {
    merge_method: method,
    ...(commitMessage ? { commit_message: commitMessage } : {}),
  });
}

async function restPatch<T>(token: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: "PATCH",
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

// --- Stats ---

interface RepoInfo {
  owner: string;
  name: string;
  fullName: string;
}

export async function fetchUserRepos(token: string): Promise<RepoInfo[]> {
  const repos = await restGet<Array<{
    name: string;
    full_name: string;
    owner: { login: string };
  }>>(token, "/user/repos?sort=pushed&per_page=50&affiliation=owner,collaborator,organization_member");

  return repos.map((r) => ({
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
  }));
}

const STATS_PR_QUERY = `
query($query: String!, $first: Int!) {
  search(query: $query, type: ISSUE, first: $first) {
    nodes {
      ... on PullRequest {
        number
        title
        state
        createdAt
        mergedAt
        additions
        deletions
        repository { name owner { login } }
        reviews(first: 50) {
          nodes {
            author { login }
            submittedAt
          }
        }
      }
    }
  }
}
`;

interface StatsPRNode {
  number: number;
  title: string;
  state: string;
  createdAt: string;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  repository: { name: string; owner: { login: string } };
  reviews: { nodes: Array<{ author: { login: string } | null; submittedAt: string }> };
}

interface StatsSearchResult {
  search: {
    nodes: StatsPRNode[];
  };
}

export interface PRSummary {
  number: number;
  title: string;
  repo: string;
  state: string;
  additions: number;
  deletions: number;
}

export interface DailyStats {
  days: string[];
  prsOpened: number[];
  prsMerged: number[];
  prsReviewed: number[];
  linesAuthored: number[];
  authoredPRs?: PRSummary[];
  reviewedPRs?: PRSummary[];
}

function dateBucket(iso: string): string {
  return iso.slice(0, 10);
}

export function makeDays(count: number): string[] {
  const days: string[] = [];
  const now = new Date();
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

export async function fetchGitHubStats(
  token: string,
  repos: string[],
  startDate?: string,
  endDate?: string,
): Promise<DailyStats> {
  const useRange = startDate && endDate;
  const days = useRange ? makeDaysRange(startDate, endDate) : makeDays(14);
  const numDays = days.length;
  const cutoff = days[0];
  const repoFilter = repos.map((r) => `repo:${r}`).join(" ");
  const dateRange = useRange ? `${cutoff}..${endDate}` : `>=${cutoff}`;

  const [authored, merged, reviewed] = await Promise.all([
    graphql<StatsSearchResult>(token, STATS_PR_QUERY, {
      query: `type:pr author:@me ${repoFilter} created:${dateRange}`,
      first: 100,
    }),
    graphql<StatsSearchResult>(token, STATS_PR_QUERY, {
      query: `type:pr author:@me ${repoFilter} merged:${dateRange}`,
      first: 100,
    }),
    graphql<StatsSearchResult>(token, STATS_PR_QUERY, {
      query: `type:pr reviewed-by:@me ${repoFilter} -author:@me updated:${dateRange}`,
      first: 100,
    }),
  ]);

  const viewerData = await graphql<ViewerResult>(token, VIEWER_QUERY);
  const viewerLogin = viewerData.viewer.login.toLowerCase();

  const prsOpened = new Array(numDays).fill(0);
  const prsMerged = new Array(numDays).fill(0);
  const prsReviewed = new Array(numDays).fill(0);
  const linesAuthored = new Array(numDays).fill(0);

  const dayIndex = new Map(days.map((d, i) => [d, i]));

  const authoredSet = new Map<string, StatsPRNode>();

  for (const pr of authored.search.nodes) {
    const idx = dayIndex.get(dateBucket(pr.createdAt));
    if (idx !== undefined) prsOpened[idx]++;
    const k = `${pr.repository.owner.login}/${pr.repository.name}#${pr.number}`;
    if (!authoredSet.has(k)) authoredSet.set(k, pr);
  }

  for (const pr of merged.search.nodes) {
    if (!pr.mergedAt) continue;
    const idx = dayIndex.get(dateBucket(pr.mergedAt));
    if (idx !== undefined) {
      prsMerged[idx]++;
      linesAuthored[idx] += pr.additions;
    }
    const k = `${pr.repository.owner.login}/${pr.repository.name}#${pr.number}`;
    if (!authoredSet.has(k)) authoredSet.set(k, pr);
  }

  const reviewedSet = new Map<string, StatsPRNode>();
  const reviewedPRDays = new Set<string>();
  for (const pr of reviewed.search.nodes) {
    for (const review of pr.reviews.nodes) {
      if (!review.author || review.author.login.toLowerCase() !== viewerLogin) continue;
      const day = dateBucket(review.submittedAt);
      const key = `${pr.repository.owner.login}/${pr.repository.name}#${pr.number}:${day}`;
      if (reviewedPRDays.has(key)) continue;
      reviewedPRDays.add(key);
      const idx = dayIndex.get(day);
      if (idx !== undefined) prsReviewed[idx]++;
    }
    const k = `${pr.repository.owner.login}/${pr.repository.name}#${pr.number}`;
    if (!reviewedSet.has(k)) reviewedSet.set(k, pr);
  }

  const toSummary = (pr: StatsPRNode): PRSummary => ({
    number: pr.number,
    title: pr.title,
    repo: `${pr.repository.owner.login}/${pr.repository.name}`,
    state: pr.state.toLowerCase(),
    additions: pr.additions,
    deletions: pr.deletions,
  });

  return {
    days, prsOpened, prsMerged, prsReviewed, linesAuthored,
    authoredPRs: [...authoredSet.values()].map(toSummary),
    reviewedPRs: [...reviewedSet.values()].map(toSummary),
  };
}

function makeDaysRange(start: string, end: string): string[] {
  const days: string[] = [];
  const d = new Date(start + "T00:00:00");
  const endDate = new Date(end + "T00:00:00");
  while (d <= endDate) {
    days.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

export async function closePR(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<void> {
  await restPatch(token, `/repos/${owner}/${repo}/pulls/${number}`, {
    state: "closed",
  });
}
