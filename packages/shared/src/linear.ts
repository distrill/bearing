export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  status: LinearStatus;
  priority: number;
  priorityLabel: string;
  assignee: LinearUser | null;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  teamName: string;
  teamKey: string;
  labels: LinearLabel[];
  linkedPrNumber: number | null;
}

export interface LinearStatus {
  id: string;
  name: string;
  color: string;
  type: "backlog" | "unstarted" | "started" | "completed" | "cancelled";
}

export interface LinearUser {
  id: string;
  name: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface LinearLabel {
  id: string;
  name: string;
  color: string;
}

export interface LinearComment {
  id: string;
  body: string;
  user: LinearUser;
  createdAt: string;
  updatedAt: string;
}
