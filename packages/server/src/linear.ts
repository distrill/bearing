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

export async function fetchAllIssues(apiKeys: string[]): Promise<LinearIssue[]> {
  const results = await Promise.all(apiKeys.map(fetchIssuesForKey));
  const issues = results.flat();
  issues.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  return issues;
}
