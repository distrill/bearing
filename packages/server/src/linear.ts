import type { LinearIssue, LinearStatus, LinearUser } from "@bearing/shared";

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";

const ASSIGNED_ISSUES_QUERY = `
query($first: Int!) {
  organization {
    name
  }
  viewer {
    assignedIssues(
      first: $first
      orderBy: updatedAt
    ) {
      nodes {
        id
        identifier
        title
        url
        priority
        priorityLabel
        createdAt
        updatedAt
        state {
          id
          name
          color
          type
        }
        team {
          name
          key
        }
        assignee {
          id
          name
          displayName
          avatarUrl
        }
        labels {
          nodes {
            id
            name
            color
          }
        }
        history(first: 1) {
          nodes {
            actor {
              ... on User {
                id
              }
            }
          }
        }
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
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(LINEAR_GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Linear API error: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL error: ${json.errors[0].message}`);
  }

  return json.data;
}

interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number;
  priorityLabel: string;
  createdAt: string;
  updatedAt: string;
  state: {
    id: string;
    name: string;
    color: string;
    type: string;
  };
  team: {
    name: string;
    key: string;
  };
  assignee: {
    id: string;
    name: string;
    displayName: string;
    avatarUrl: string | null;
  } | null;
  labels: {
    nodes: Array<{ id: string; name: string; color: string }>;
  };
  history: {
    nodes: Array<{ actor: { id: string } | null }>;
  };
}

interface AssignedIssuesResult {
  organization: {
    name: string;
  };
  viewer: {
    assignedIssues: {
      nodes: RawIssue[];
    };
  };
}

function toLinearIssue(raw: RawIssue, workspace: string): LinearIssue {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    url: raw.url,
    priority: raw.priority,
    priorityLabel: raw.priorityLabel,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    status: raw.state as LinearStatus,
    workspace,
    teamName: raw.team.name,
    teamKey: raw.team.key,
    assignee: raw.assignee as LinearUser | null,
    labels: raw.labels.nodes,
    linkedPrNumber: null,
    lastActorId: raw.history.nodes[0]?.actor?.id ?? null,
  };
}

async function fetchIssuesForKey(apiKey: string): Promise<LinearIssue[]> {
  const data = await graphql<AssignedIssuesResult>(
    apiKey,
    ASSIGNED_ISSUES_QUERY,
    { first: 50 },
  );
  const workspace = data.organization.name;
  return data.viewer.assignedIssues.nodes.map((raw) => toLinearIssue(raw, workspace));
}

const WORKFLOW_STATES_QUERY = `
query($teamKey: String!) {
  workflowStates(filter: { team: { key: { eq: $teamKey } } }) {
    nodes {
      id
      name
      color
      type
      position
    }
  }
}
`;

interface RawWorkflowState {
  id: string;
  name: string;
  color: string;
  type: string;
  position: number;
}

interface WorkflowStatesResult {
  workflowStates: {
    nodes: RawWorkflowState[];
  };
}

const UPDATE_ISSUE_STATE_MUTATION = `
mutation($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
    issue {
      id
      state {
        id
        name
        color
        type
      }
    }
  }
}
`;

interface UpdateIssueStateResult {
  issueUpdate: {
    success: boolean;
    issue: {
      id: string;
      state: { id: string; name: string; color: string; type: string };
    };
  };
}

export async function fetchWorkflowStates(
  apiKey: string,
  teamKey: string,
): Promise<LinearStatus[]> {
  const data = await graphql<WorkflowStatesResult>(
    apiKey,
    WORKFLOW_STATES_QUERY,
    { teamKey },
  );
  return data.workflowStates.nodes
    .sort((a, b) => a.position - b.position)
    .map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      type: s.type as LinearStatus["type"],
    }));
}

export async function updateIssueStatus(
  apiKey: string,
  issueId: string,
  stateId: string,
): Promise<LinearStatus> {
  const data = await graphql<UpdateIssueStateResult>(
    apiKey,
    UPDATE_ISSUE_STATE_MUTATION,
    { issueId, stateId },
  );
  if (!data.issueUpdate.success) {
    throw new Error("Failed to update issue state");
  }
  const s = data.issueUpdate.issue.state;
  return {
    id: s.id,
    name: s.name,
    color: s.color,
    type: s.type as LinearStatus["type"],
  };
}

const TEAMS_QUERY = `
query {
  organization {
    name
  }
  teams {
    nodes {
      id
      name
      key
    }
  }
}
`;

interface TeamsResult {
  organization: { name: string };
  teams: { nodes: Array<{ id: string; name: string; key: string }> };
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
  workspace: string;
}

export async function fetchTeams(apiKey: string): Promise<LinearTeam[]> {
  const data = await graphql<TeamsResult>(apiKey, TEAMS_QUERY);
  const workspace = data.organization.name;
  return data.teams.nodes.map((t) => ({ ...t, workspace }));
}

export async function fetchAllTeams(apiKeys: string[]): Promise<LinearTeam[]> {
  const results = await Promise.all(apiKeys.map(fetchTeams));
  return results.flat();
}

const VIEWER_ID_QUERY = `
query {
  viewer {
    id
  }
}
`;

interface CreateIssueResult {
  issueCreate: {
    success: boolean;
    issue: RawIssue;
  };
}

export async function createIssue(
  apiKey: string,
  teamId: string,
  title: string,
): Promise<LinearIssue> {
  const viewerData = await graphql<{ viewer: { id: string } }>(apiKey, VIEWER_ID_QUERY);
  const viewerId = viewerData.viewer.id;

  const data = await graphql<CreateIssueResult>(
    apiKey,
    `mutation($teamId: String!, $title: String!, $assigneeId: String) {
      issueCreate(input: { teamId: $teamId, title: $title, assigneeId: $assigneeId }) {
        success
        issue {
          id
          identifier
          title
          url
          priority
          priorityLabel
          createdAt
          updatedAt
          state { id name color type }
          team { name key }
          assignee { id name displayName avatarUrl }
          labels { nodes { id name color } }
        }
      }
    }`,
    { teamId, title, assigneeId: viewerId },
  );

  if (!data.issueCreate.success) {
    throw new Error("Failed to create issue");
  }

  const orgData = await graphql<{ organization: { name: string } }>(
    apiKey,
    `query { organization { name } }`,
  );

  return toLinearIssue(data.issueCreate.issue, orgData.organization.name);
}

export async function fetchViewerId(apiKey: string): Promise<string> {
  const data = await graphql<{ viewer: { id: string } }>(apiKey, VIEWER_ID_QUERY);
  return data.viewer.id;
}

// --- Stats ---

const COMPLETED_ISSUES_QUERY = `
query($first: Int!, $after: DateTimeOrDuration!) {
  issues(
    first: $first
    filter: {
      assignee: { isMe: { eq: true } }
      completedAt: { gte: $after }
    }
  ) {
    nodes {
      id
      completedAt
      team { key }
    }
  }
}
`;

interface CompletedIssueRaw {
  id: string;
  completedAt: string;
  team: { key: string };
}

interface CompletedIssuesResult {
  issues: {
    nodes: CompletedIssueRaw[];
  };
}

export async function fetchCompletedIssuesForStats(
  apiKeys: string[],
  teamKeys: string[],
): Promise<CompletedIssueRaw[]> {
  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const teamSet = new Set(teamKeys);

  const results = await Promise.all(
    apiKeys.map(async (key) => {
      const data = await graphql<CompletedIssuesResult>(
        key,
        COMPLETED_ISSUES_QUERY,
        { first: 100, after: cutoff },
      );
      return data.issues.nodes;
    }),
  );

  return results.flat().filter((i) => teamSet.has(i.team.key));
}

export async function fetchAllIssues(apiKeys: string[]): Promise<LinearIssue[]> {
  const results = await Promise.all(apiKeys.map(fetchIssuesForKey));
  const issues = results.flat();
  issues.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return issues;
}
