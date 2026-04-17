import type { PullRequestsResponse, LinearIssuesResponse, LinearStatus } from "@bearing/shared";
import type { GitHubUser } from "@bearing/shared";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function del<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export function fetchPRs(filter: "review_requested" | "authored" | "suggested", refresh = false) {
  const params = new URLSearchParams({ filter });
  if (refresh) params.set("refresh", "1");
  return get<PullRequestsResponse>(`/api/prs?${params}`);
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export function fetchIssues(refresh = false) {
  const qs = refresh ? "?refresh=1" : "";
  return get<LinearIssuesResponse>(`/api/issues${qs}`);
}

export function fetchWorkflowStates(teamKey: string) {
  return get<{ states: LinearStatus[] }>(`/api/issues/workflow-states/${encodeURIComponent(teamKey)}`);
}

export function updateIssueStatus(issueId: string, stateId: string) {
  return patch<{ status: LinearStatus }>(`/api/issues/${encodeURIComponent(issueId)}/status`, { stateId });
}

export function fetchViewer() {
  return get<GitHubUser>("/api/me");
}

// Tags

export interface TagDefinition {
  name: string;
  color: string;
}

export interface PrTagAssignment {
  tag: string;
  owner: string;
  repo: string;
  number: number;
}

export interface IssueTagAssignment {
  tag: string;
  issue_id: string;
}

export interface TagAssignments {
  prTags: PrTagAssignment[];
  issueTags: IssueTagAssignment[];
}

export function fetchTags() {
  return get<{ tags: TagDefinition[] }>("/api/tags");
}

export function createTag(name: string, color: string) {
  return post<{ ok: boolean }>("/api/tags", { name, color });
}

export function updateTag(oldName: string, name: string, color: string) {
  return put<{ ok: boolean }>(`/api/tags/${encodeURIComponent(oldName)}`, { name, color });
}

export function deleteTag(name: string) {
  return del<{ ok: boolean }>(`/api/tags/${encodeURIComponent(name)}`, {});
}

export function fetchTagAssignments() {
  return get<TagAssignments>("/api/tags/assignments");
}

export function tagPr(tag: string, owner: string, repo: string, number: number) {
  return post<{ ok: boolean }>("/api/tags/pr", { tag, owner, repo, number });
}

export function untagPr(tag: string, owner: string, repo: string, number: number) {
  return del<{ ok: boolean }>("/api/tags/pr", { tag, owner, repo, number });
}

export function tagIssue(tag: string, issue_id: string) {
  return post<{ ok: boolean }>("/api/tags/issue", { tag, issue_id });
}

export function untagIssue(tag: string, issue_id: string) {
  return del<{ ok: boolean }>("/api/tags/issue", { tag, issue_id });
}
