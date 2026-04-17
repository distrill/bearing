import type {
  PullRequest,
  GitHubUser,
  ReviewDecision,
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
  const qualifier =
    filter === "review_requested"
      ? "type:pr state:open review-requested:@me"
      : "type:pr state:open author:@me";

  const data = await graphql<SearchResult>(token, PR_SEARCH_QUERY, {
    query: qualifier,
    first: 50,
  });

  const prs = data.search.nodes.map(toPullRequest);
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
