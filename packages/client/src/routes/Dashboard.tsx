import { useState, useEffect, useCallback, useRef } from "react";
import type { PullRequest, LinearIssue, LinearStatus } from "@bearing/shared";
import {
  fetchPRs,
  fetchIssues,
  fetchViewer,
  fetchTagAssignments,
  fetchWorkflowStates,
  updateIssueStatus,
  tagPr,
  untagPr,
  tagIssue,
  untagIssue,
  type TagDefinition,
  type TagAssignments,
} from "../lib/api";
import { timeAgo } from "../lib/time";

type PrRole = "reviewer" | "author" | "suggested";
type TaggedPullRequest = PullRequest & { role: PrRole };

function prKey(pr: PullRequest) {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

function prStatus(pr: PullRequest): string {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.draft) return "draft";
  if (pr.reviewDecision === "APPROVED") return "approved";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes requested";
  if (pr.reviewDecision === "REVIEW_REQUIRED") return "review required";
  return "open";
}

const PR_STATUS_COLORS: Record<string, string> = {
  open: "#e0def4",
  draft: "#6e6a86",
  "review required": "#908caa",
  "changes requested": "#f6c177",
  approved: "#9ccfd8",
  merged: "#c4a7e7",
  closed: "#eb6f92",
};

const TERMINAL_PR_STATUSES = new Set(["merged", "closed"]);

function dedupeAndTag(
  review: PullRequest[],
  authored: PullRequest[],
  suggested: PullRequest[],
): TaggedPullRequest[] {
  const seen = new Set<string>();
  const tagged: TaggedPullRequest[] = [];

  for (const pr of review) {
    seen.add(prKey(pr));
    tagged.push({ ...pr, role: "reviewer" });
  }
  for (const pr of authored) {
    const k = prKey(pr);
    if (!seen.has(k)) {
      seen.add(k);
      tagged.push({ ...pr, role: "author" });
    }
  }
  for (const pr of suggested) {
    const k = prKey(pr);
    if (!seen.has(k)) {
      seen.add(k);
      tagged.push({ ...pr, role: "suggested" });
    }
  }

  const roleOrder: Record<PrRole, number> = { reviewer: 0, author: 1, suggested: 2 };
  tagged.sort((a, b) => {
    const ra = roleOrder[a.role];
    const rb = roleOrder[b.role];
    if (ra !== rb) return ra - rb;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  return tagged;
}

function loadSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

function saveSet(key: string, set: Set<string>) {
  localStorage.setItem(key, JSON.stringify([...set]));
}

function usePersistedSet(key: string): [Set<string>, (next: Set<string>) => void] {
  const [value, setValue] = useState(() => loadSet(key));
  const set = useCallback((next: Set<string>) => {
    setValue(next);
    saveSet(key, next);
  }, [key]);
  return [value, set];
}

function loadMap(key: string): Map<string, number> {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return new Map(JSON.parse(raw) as [string, number][]);
  } catch { /* ignore */ }
  return new Map();
}

function saveMap(key: string, map: Map<string, number>) {
  localStorage.setItem(key, JSON.stringify([...map]));
}

function useLastTouched() {
  const key = "bearing:lastTouched";
  const [map, setMap] = useState(() => loadMap(key));

  const touch = useCallback((id: string) => {
    setMap((prev) => {
      const next = new Map(prev);
      next.set(id, Date.now());
      saveMap(key, next);
      return next;
    });
  }, []);

  const needsAttention = useCallback((id: string, updatedAt: string) => {
    const touched = map.get(id);
    if (!touched) return true;
    return new Date(updatedAt).getTime() > touched;
  }, [map]);

  useEffect(() => {
    function handleReset() {
      localStorage.removeItem(key);
      setMap(new Map());
    }
    window.addEventListener("bearing:resetAttention", handleReset);
    return () => window.removeEventListener("bearing:resetAttention", handleReset);
  }, []);

  return { touch, needsAttention };
}

function usePersistedBool(key: string, fallback: boolean): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) return raw === "true";
    } catch { /* ignore */ }
    return fallback;
  });
  const set = useCallback((next: boolean) => {
    setValue(next);
    localStorage.setItem(key, String(next));
  }, [key]);
  return [value, set];
}

interface DashboardProps {
  refreshKey?: number;
  tags?: TagDefinition[];
  issueSearch: string;
  prSearch: string;
  onClearIssueSearch: () => void;
  onClearPrSearch: () => void;
}

export function Dashboard({ refreshKey = 0, tags = [], issueSearch, prSearch, onClearIssueSearch, onClearPrSearch }: DashboardProps) {
  const [reviewPrs, setReviewPrs] = useState<PullRequest[]>([]);
  const [authoredPrs, setAuthoredPrs] = useState<PullRequest[]>([]);
  const [suggestedPrs, setSuggestedPrs] = useState<PullRequest[]>([]);
  const [issues, setIssues] = useState<LinearIssue[]>([]);
  const [linearViewerIds, setLinearViewerIds] = useState<string[]>([]);
  const [ghViewer, setGhViewer] = useState<string | null>(null);
  const [prsLoading, setPrsLoading] = useState(true);
  const [issuesLoading, setIssuesLoading] = useState(true);
  const [pendingUpdate, setPendingUpdate] = useState<{
    reviewPrs: PullRequest[];
    authoredPrs: PullRequest[];
    suggestedPrs: PullRequest[];
    issues: LinearIssue[];
    viewerIds: string[];
  } | null>(null);
  const [assignments, setAssignments] = useState<TagAssignments>({
    prTags: [],
    issueTags: [],
  });
  const [filterTags, setFilterTags] = usePersistedSet("bearing:filterTags");
  const [untouchedOnly, setUntouchedOnly] = usePersistedBool("bearing:untouchedOnly", false);
  const { touch, needsAttention } = useLastTouched();

  const prNeedsAttention = useCallback(
    (pr: TaggedPullRequest) => {
      if (!ghViewer) return false;
      switch (pr.role) {
        case "reviewer":
          return pr.requestedReviewers.some(
            (r) => r.login.toLowerCase() === ghViewer.toLowerCase(),
          );
        case "author":
          return (
            pr.reviewDecision !== null &&
            pr.reviewDecision !== "REVIEW_REQUIRED"
          );
        case "suggested":
          return pr.reviewDecision === "REVIEW_REQUIRED";
        default:
          return false;
      }
    },
    [ghViewer],
  );

  const issueNeedsAttention = useCallback(
    (issue: LinearIssue) => {
      if (!needsAttention(issue.id, issue.updatedAt)) return false;
      if (issue.lastActorId && linearViewerIds.includes(issue.lastActorId))
        return false;
      return true;
    },
    [needsAttention, linearViewerIds],
  );
  const workflowStatesCache = useRef(new Map<string, LinearStatus[]>());
  const getWorkflowStates = useCallback(async (teamKey: string) => {
    const cached = workflowStatesCache.current.get(teamKey);
    if (cached) return cached;
    const { states } = await fetchWorkflowStates(teamKey);
    workflowStatesCache.current.set(teamKey, states);
    return states;
  }, []);

  useEffect(() => {
    setPrsLoading(true);
    setPendingUpdate(null);
    const isRefresh = refreshKey > 0;
    Promise.all([
      fetchPRs("review_requested", isRefresh)
        .then((r) => setReviewPrs(r.prs))
        .catch(() => setReviewPrs([])),
      fetchPRs("authored", isRefresh)
        .then((r) => setAuthoredPrs(r.prs))
        .catch(() => setAuthoredPrs([])),
      fetchPRs("suggested", isRefresh)
        .then((r) => setSuggestedPrs(r.prs))
        .catch(() => setSuggestedPrs([])),
    ]).finally(() => setPrsLoading(false));
  }, [refreshKey]);





  useEffect(() => {
    const isRefresh = refreshKey > 0;
    setIssuesLoading(true);
    fetchIssues(isRefresh)
      .then((r) => {
        setIssues(r.issues);
        setLinearViewerIds(r.viewerIds);
      })
      .catch(() => setIssues([]))
      .finally(() => setIssuesLoading(false));
  }, [refreshKey]);

  // Background polling
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const [review, authored, suggested, issueData] = await Promise.all([
          fetchPRs("review_requested").then((r) => r.prs).catch(() => null),
          fetchPRs("authored").then((r) => r.prs).catch(() => null),
          fetchPRs("suggested").then((r) => r.prs).catch(() => null),
          fetchIssues().catch(() => null),
        ]);

        if (!review || !authored || !suggested || !issueData) return;

        const fingerprint = (prs: PullRequest[]) =>
          prs.map((p) => `${p.owner}/${p.repo}#${p.number}:${p.updatedAt}:${p.reviewDecision}`).join("|");
        const issueFingerprint = (issues: LinearIssue[]) =>
          issues.map((i) => `${i.id}:${i.updatedAt}:${i.status.id}`).join("|");

        const changed =
          fingerprint(review) !== fingerprint(reviewPrs) ||
          fingerprint(authored) !== fingerprint(authoredPrs) ||
          fingerprint(suggested) !== fingerprint(suggestedPrs) ||
          issueFingerprint(issueData.issues) !== issueFingerprint(issues);

        if (changed) {
          setPendingUpdate({
            reviewPrs: review,
            authoredPrs: authored,
            suggestedPrs: suggested,
            issues: issueData.issues,
            viewerIds: issueData.viewerIds,
          });
        }
      } catch {
        // ignore background fetch errors
      }
    }, 60_000);

    return () => clearInterval(interval);
  }, [reviewPrs, authoredPrs, suggestedPrs, issues]);

  const applyPendingUpdate = useCallback(() => {
    if (!pendingUpdate) return;
    setReviewPrs(pendingUpdate.reviewPrs);
    setAuthoredPrs(pendingUpdate.authoredPrs);
    setSuggestedPrs(pendingUpdate.suggestedPrs);
    setIssues(pendingUpdate.issues);
    setLinearViewerIds(pendingUpdate.viewerIds);
    setPendingUpdate(null);
  }, [pendingUpdate]);

  useEffect(() => {
    if (pendingUpdate) {
      window.dispatchEvent(new Event("bearing:updateAvailable"));
    } else {
      window.dispatchEvent(new Event("bearing:updateCleared"));
    }
  }, [pendingUpdate]);

  useEffect(() => {
    function handleApply() {
      applyPendingUpdate();
    }
    window.addEventListener("bearing:applyUpdate", handleApply);
    return () => window.removeEventListener("bearing:applyUpdate", handleApply);
  }, [applyPendingUpdate]);

  useEffect(() => {
    fetchTagAssignments()
      .then(setAssignments)
      .catch(() => setAssignments({ prTags: [], issueTags: [] }));
    fetchViewer()
      .then((v) => setGhViewer(v.login))
      .catch(() => {});
  }, []);

  const reloadAssignments = useCallback(() => {
    fetchTagAssignments()
      .then(setAssignments)
      .catch(() => { });
  }, []);

  const [showSuggested, setShowSuggested] = usePersistedBool("bearing:showSuggested", true);
  const [filterWorkspaces, setFilterWorkspaces] = usePersistedSet("bearing:filterWorkspaces");
  const [filterRepos, setFilterRepos] = usePersistedSet("bearing:filterRepos");
  const [filterStatuses, setFilterStatuses] = usePersistedSet("bearing:filterStatuses");
  const [filterPrStatuses, setFilterPrStatuses] = usePersistedSet("bearing:filterPrStatuses2");

  const allPrs = dedupeAndTag(
    reviewPrs,
    authoredPrs,
    showSuggested ? suggestedPrs : [],
  );

  // Build lookup maps for tag assignments
  const prTagMap = new Map<string, string[]>();
  for (const a of assignments.prTags) {
    const key = `${a.owner}/${a.repo}#${a.number}`;
    const list = prTagMap.get(key);
    if (list) list.push(a.tag);
    else prTagMap.set(key, [a.tag]);
  }

  const issueTagMap = new Map<string, string[]>();
  for (const a of assignments.issueTags) {
    const list = issueTagMap.get(a.issue_id);
    if (list) list.push(a.tag);
    else issueTagMap.set(a.issue_id, [a.tag]);
  }

  const hasUntaggedPrs = allPrs.some((pr) => !prTagMap.has(prKey(pr)));
  const hasUntaggedIssues = issues.some((i) => !issueTagMap.has(i.id));
  const hasUntagged = hasUntaggedPrs || hasUntaggedIssues;

  // Unique workspaces, statuses, and repos for filter dropdowns
  const workspaces = [...new Set(issues.map((i) => i.workspace))].sort();
  const repos = [...new Set(allPrs.map((pr) => `${pr.owner}/${pr.repo}`))].sort();

  const TERMINAL_TYPES = new Set(["completed", "cancelled"]);
  const [allWorkflowStates, setAllWorkflowStates] = useState<LinearStatus[]>([]);
  const teamKeys = [...new Set(issues.map((i) => i.teamKey))];
  useEffect(() => {
    if (teamKeys.length === 0) return;
    Promise.all(teamKeys.map(getWorkflowStates)).then((results) => {
      const seen = new Map<string, LinearStatus>();
      for (const states of results) {
        for (const s of states) {
          if (!seen.has(s.name)) seen.set(s.name, s);
        }
      }
      setAllWorkflowStates([...seen.values()]);
    });
  }, [teamKeys.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const statusColorMap = new Map<string, string>();
  const statusTypeMap = new Map<string, string>();
  for (const s of allWorkflowStates) {
    statusColorMap.set(s.name, s.color);
    statusTypeMap.set(s.name, s.type);
  }
  const statuses = allWorkflowStates
    .map((s) => s.name)
    .sort((a, b) => {
      const aTerminal = TERMINAL_TYPES.has(statusTypeMap.get(a) ?? "");
      const bTerminal = TERMINAL_TYPES.has(statusTypeMap.get(b) ?? "");
      if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
      return a.localeCompare(b);
    });

  const prStatuses = ["open", "draft", "review required", "changes requested", "approved", "merged", "closed"];
  const prStatusColorMap = new Map(prStatuses.map((s) => [s, PR_STATUS_COLORS[s] ?? "#6e6a86"]));

  // Available tag filter values
  const allTagValues = tags.map((t) => t.name);
  if (hasUntagged) allTagValues.push("__untagged__");
  const allTagKey = allTagValues.join(",");

  // Initialize filters with all values when data first arrives
  useEffect(() => {
    if (workspaces.length > 0 && filterWorkspaces.size === 0)
      setFilterWorkspaces(new Set(workspaces));
  }, [workspaces.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (repos.length > 0 && filterRepos.size === 0)
      setFilterRepos(new Set(repos));
  }, [repos.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (allTagValues.length > 0 && filterTags.size === 0)
      setFilterTags(new Set(allTagValues));
  }, [allTagKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (statuses.length > 0 && filterStatuses.size === 0)
      setFilterStatuses(new Set(
        statuses.filter((s) => !TERMINAL_TYPES.has(statusTypeMap.get(s) ?? "")),
      ));
  }, [statuses.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (prStatuses.length > 0 && filterPrStatuses.size === 0)
      setFilterPrStatuses(new Set(
        prStatuses.filter((s) => !TERMINAL_PR_STATUSES.has(s)),
      ));
  }, [prStatuses.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply filters
  const untaggedActive = filterTags.has("__untagged__");
  let filteredPrs = allPrs;
  if (prSearch) {
    const q = prSearch.toLowerCase();
    filteredPrs = filteredPrs.filter((pr) => pr.title.toLowerCase().includes(q));
  }
  if (tags.length > 0)
    filteredPrs = filteredPrs.filter((pr) => {
      const t = prTagMap.get(prKey(pr));
      if (!t) return untaggedActive;
      return t.some((tag) => filterTags.has(tag));
    });
  filteredPrs = filteredPrs.filter((pr) => filterRepos.has(`${pr.owner}/${pr.repo}`));
  filteredPrs = filteredPrs.filter((pr) => filterPrStatuses.has(prStatus(pr)));
  if (untouchedOnly)
    filteredPrs = filteredPrs.filter((pr) => prNeedsAttention(pr));
  const roleOrder: Record<PrRole, number> = { reviewer: 0, author: 1, suggested: 2 };
  filteredPrs.sort((a, b) => {
    const aAttn = prNeedsAttention(a) ? 0 : 1;
    const bAttn = prNeedsAttention(b) ? 0 : 1;
    if (aAttn !== bAttn) return aAttn - bAttn;
    const aTerminal = TERMINAL_PR_STATUSES.has(prStatus(a));
    const bTerminal = TERMINAL_PR_STATUSES.has(prStatus(b));
    if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
    const ra = roleOrder[a.role];
    const rb = roleOrder[b.role];
    if (ra !== rb) return ra - rb;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  let filteredIssues = issues;
  if (issueSearch) {
    const q = issueSearch.toLowerCase();
    filteredIssues = filteredIssues.filter((i) => i.title.toLowerCase().includes(q));
  }
  if (tags.length > 0)
    filteredIssues = filteredIssues.filter((i) => {
      const t = issueTagMap.get(i.id);
      if (!t) return untaggedActive;
      return t.some((tag) => filterTags.has(tag));
    });
  filteredIssues = filteredIssues.filter((i) => filterWorkspaces.has(i.workspace));
  filteredIssues = filteredIssues.filter((i) => filterStatuses.has(i.status.name));
  if (untouchedOnly)
    filteredIssues = filteredIssues.filter((i) => issueNeedsAttention(i));
  filteredIssues.sort((a, b) => {
    const aAttn = issueNeedsAttention(a) ? 0 : 1;
    const bAttn = issueNeedsAttention(b) ? 0 : 1;
    if (aAttn !== bAttn) return aAttn - bAttn;
    const aTerminal = TERMINAL_TYPES.has(a.status.type);
    const bTerminal = TERMINAL_TYPES.has(b.status.type);
    if (aTerminal !== bTerminal) return aTerminal ? 1 : -1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Filter bar — spans both panels */}
      {tags.length > 0 && (
        <div className="flex items-center gap-2 px-4 h-9 border-b border-bearing-border shrink-0">
          <span className="text-[10px] font-mono text-bearing-muted">tags</span>
          {tags.map((t) => {
            const active = filterTags.has(t.name);
            return (
              <button
                key={t.name}
                onClick={() => {
                  const next = new Set(filterTags);
                  if (active) next.delete(t.name);
                  else next.add(t.name);
                  setFilterTags(next);
                }}
                className="text-[10px] font-mono"
                style={{
                  color: active ? t.color : undefined,
                  opacity: active ? 1 : 0.4,
                }}
              >
                [{t.name}]
              </button>
            );
          })}
          {hasUntagged && (
            <button
              onClick={() => {
                const next = new Set(filterTags);
                if (untaggedActive) next.delete("__untagged__");
                else next.add("__untagged__");
                setFilterTags(next);
              }}
              className="text-[10px] font-mono"
              style={{
                opacity: untaggedActive ? 1 : 0.4,
              }}
            >
              [untagged]
            </button>
          )}
          <span className="flex-1" />
          <button
            onClick={() => setUntouchedOnly(!untouchedOnly)}
            className={`text-[10px] font-mono ${untouchedOnly ? "text-bearing-accent" : "text-bearing-muted"}`}
          >
            [needs attention]
          </button>
        </div>
      )}

      <div className="flex-1 grid grid-cols-2 divide-x divide-bearing-border overflow-hidden">
        {/* Left panel: Linear Issues */}
        <div className="flex flex-col overflow-hidden">
          <div className="flex items-center px-4 h-9 border-b border-bearing-border">
            <span className="text-xs font-mono text-bearing-muted">issues</span>
            <div className="ml-auto flex items-center gap-2">
              {issueSearch && (
                <SearchChip term={issueSearch} onClear={onClearIssueSearch} />
              )}
              {statuses.length > 1 && (
                <MultiSelect
                  label="statuses"
                  options={statuses}
                  selected={filterStatuses}
                  onChange={setFilterStatuses}
                  colors={statusColorMap}
                />
              )}
              {workspaces.length > 1 && (
                <MultiSelect
                  label="workspaces"
                  options={workspaces}
                  selected={filterWorkspaces}
                  onChange={setFilterWorkspaces}
                />
              )}
              {!issuesLoading && (
                <span className="text-xs font-mono leading-none text-bearing-muted">
                  {filteredIssues.length}
                </span>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto pb-[33vh]">
            {issuesLoading ? (
              <Loading />
            ) : filteredIssues.length === 0 ? (
              <Empty text="No issues" />
            ) : (
              <ul>
                {filteredIssues.map((issue) => (
                  <IssueRow
                    key={issue.id}
                    issue={issue}
                    tags={tags}
                    appliedTags={issueTagMap.get(issue.id) ?? []}
                    attention={issueNeedsAttention(issue)}
                    onTouch={() => touch(issue.id)}
                    getWorkflowStates={getWorkflowStates}
                    onStatusChange={(newStatus) => {
                      setIssues((prev) =>
                        prev.map((i) =>
                          i.id === issue.id ? { ...i, status: newStatus } : i,
                        ),
                      );
                    }}
                    onToggleTag={async (tagName) => {
                      const applied = issueTagMap.get(issue.id) ?? [];
                      if (applied.includes(tagName)) {
                        await untagIssue(tagName, issue.id);
                      } else {
                        await tagIssue(tagName, issue.id);
                      }
                      reloadAssignments();
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Right panel: Pull Requests */}
        <div className="flex flex-col overflow-hidden">
          <div className="flex items-center px-4 h-9 border-b border-bearing-border">
            <span className="text-xs font-mono text-bearing-muted">
              pull requests
            </span>
            <div className="ml-auto flex items-center gap-2">
              {prSearch && (
                <SearchChip term={prSearch} onClear={onClearPrSearch} />
              )}
              {prStatuses.length > 1 && (
                <MultiSelect
                  label="statuses"
                  options={prStatuses}
                  selected={filterPrStatuses}
                  onChange={setFilterPrStatuses}
                  colors={prStatusColorMap}
                />
              )}
              {repos.length > 1 && (
                <MultiSelect
                  label="repos"
                  options={repos}
                  selected={filterRepos}
                  onChange={setFilterRepos}
                />
              )}
              <button
                onClick={() => setShowSuggested(!showSuggested)}
                className={`text-xs font-mono ${showSuggested
                  ? "text-bearing-purple"
                  : "text-bearing-muted"
                  }`}
              >
                [suggested]
              </button>
              {!prsLoading && (
                <span className="text-xs font-mono text-bearing-muted">
                  {filteredPrs.length}
                </span>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto pb-[33vh]">
            {prsLoading ? (
              <Loading />
            ) : filteredPrs.length === 0 ? (
              <Empty text="No pull requests" />
            ) : (
              <ul>
                {filteredPrs.map((pr) => (
                  <PrRow
                    key={prKey(pr)}
                    pr={pr}
                    tags={tags}
                    appliedTags={prTagMap.get(prKey(pr)) ?? []}
                    attention={prNeedsAttention(pr)}
                    onTouch={() => touch(prKey(pr))}
                    onToggleTag={async (tagName) => {
                      const applied = prTagMap.get(prKey(pr)) ?? [];
                      if (applied.includes(tagName)) {
                        await untagPr(tagName, pr.owner, pr.repo, pr.number);
                      } else {
                        await tagPr(tagName, pr.owner, pr.repo, pr.number);
                      }
                      reloadAssignments();
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function PrRow({
  pr,
  tags,
  appliedTags,
  attention,
  onTouch,
  onToggleTag,
}: {
  pr: TaggedPullRequest;
  tags: TagDefinition[];
  appliedTags: string[];
  attention: boolean;
  onTouch: () => void;
  onToggleTag: (tag: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <li className={`border-b border-bearing-border last:border-b-0 ${attention ? "border-l-2 border-l-bearing-accent" : ""}`}>
      <a
        href={`/review/${pr.owner}/${pr.repo}/${pr.number}`}
        onMouseDown={onTouch}
        className="group/pr block px-4 py-3 hover:bg-bearing-surface/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-sm text-bearing-text truncate">
              {pr.title}
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              <RoleTag role={pr.role} />
              <PrStatusTag status={prStatus(pr)} />
              {pr.role !== "author" && <Tag text={`@${pr.author.login}`} />}
            </div>
            <div className="flex items-center gap-2 mt-1 text-xs font-mono text-bearing-muted">
              <span>#{pr.number} {pr.owner}/{pr.repo}</span>
              {appliedTags.map((t) => {
                const def = tags.find((d) => d.name === t);
                return (
                  <ColorTag
                    key={t}
                    text={t}
                    color={def?.color ?? "#6e6a86"}
                    onRemove={() => onToggleTag(t)}
                  />
                );
              })}
              {tags.length > 0 && (
                <div className="relative">
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenuOpen((o) => !o);
                    }}
                    className="opacity-0 group-hover/pr:opacity-100 transition-opacity text-[10px] font-mono text-bearing-muted hover:text-bearing-text leading-none px-1"
                  >
                    +
                  </button>
                  {menuOpen && (
                    <TagMenu
                      tags={tags}
                      appliedTags={appliedTags}
                      onToggle={(t) => {
                        onToggleTag(t);
                        setMenuOpen(false);
                      }}
                      onClose={() => setMenuOpen(false)}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="shrink-0 flex flex-col items-end gap-1 text-xs font-mono text-bearing-muted">
            <span>{timeAgo(pr.updatedAt)}</span>
            <span className="opacity-40 group-hover/pr:opacity-100 transition-opacity">
              <span className="text-bearing-cyan">+{pr.additions}</span>{" "}
              <span className="text-bearing-red">-{pr.deletions}</span>
            </span>
            <button
              onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); onTouch(); window.open(pr.htmlUrl, "_blank"); }}
              className="opacity-0 group-hover/pr:opacity-100 transition-opacity hover:text-bearing-accent"
            >
              [github]
            </button>
          </div>
        </div>
      </a>
    </li>
  );
}

function IssueRow({
  issue,
  tags,
  appliedTags,
  attention,
  onTouch,
  getWorkflowStates,
  onStatusChange,
  onToggleTag,
}: {
  issue: LinearIssue;
  tags: TagDefinition[];
  appliedTags: string[];
  attention: boolean;
  onTouch: () => void;
  getWorkflowStates: (teamKey: string) => Promise<LinearStatus[]>;
  onStatusChange: (status: LinearStatus) => void;
  onToggleTag: (tag: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);

  return (
    <li className={`border-b border-bearing-border last:border-b-0 ${attention ? "border-l-2 border-l-bearing-accent" : ""}`}>
      <a
        href={issue.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onTouch}
        className="group/issue block px-4 py-3 hover:bg-bearing-surface/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <div className="relative shrink-0">
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setStatusOpen((o) => !o);
              }}
              className="w-2.5 h-2.5 rounded-full hover:ring-2 hover:ring-bearing-muted hover:ring-offset-1 hover:ring-offset-bearing-bg transition-all"
              style={{ backgroundColor: issue.status.color }}
              title={issue.status.name}
            />
            {statusOpen && (
              <StatusMenu
                teamKey={issue.teamKey}
                currentId={issue.status.id}
                getWorkflowStates={getWorkflowStates}
                onSelect={async (status) => {
                  setStatusOpen(false);
                  onStatusChange(status);
                  await updateIssueStatus(issue.id, status.id);
                }}
                onClose={() => setStatusOpen(false)}
              />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-bearing-text truncate">
              {issue.title}
            </div>
            <div className="flex items-center gap-2 mt-1 text-xs font-mono text-bearing-muted">
              <span>{issue.identifier}</span>
              <ColorTag text={issue.status.name} color={issue.status.color} />
              {issue.priorityLabel !== "No priority" && (
                <Tag text={issue.priorityLabel} />
              )}
              {appliedTags.map((t) => {
                const def = tags.find((d) => d.name === t);
                return (
                  <ColorTag
                    key={t}
                    text={t}
                    color={def?.color ?? "#6e6a86"}
                    onRemove={() => onToggleTag(t)}
                  />
                );
              })}
              {tags.length > 0 && (
                <div className="relative">
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setMenuOpen((o) => !o);
                    }}
                    className="opacity-0 group-hover/issue:opacity-100 transition-opacity text-[10px] font-mono text-bearing-muted hover:text-bearing-text leading-none px-1"
                  >
                    +
                  </button>
                  {menuOpen && (
                    <TagMenu
                      tags={tags}
                      appliedTags={appliedTags}
                      onToggle={(t) => {
                        onToggleTag(t);
                        setMenuOpen(false);
                      }}
                      onClose={() => setMenuOpen(false)}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
          <span className="shrink-0 text-xs font-mono text-bearing-muted">
            {timeAgo(issue.updatedAt)}
          </span>
        </div>
      </a>
    </li>
  );
}

function StatusMenu({
  teamKey,
  currentId,
  getWorkflowStates,
  onSelect,
  onClose,
}: {
  teamKey: string;
  currentId: string;
  getWorkflowStates: (teamKey: string) => Promise<LinearStatus[]>;
  onSelect: (status: LinearStatus) => void;
  onClose: () => void;
}) {
  const [states, setStates] = useState<LinearStatus[]>([]);

  useEffect(() => {
    getWorkflowStates(teamKey)
      .then(setStates)
      .catch(() => { });
  }, [teamKey, getWorkflowStates]);

  return (
    <>
      <div className="fixed inset-0 z-10" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }} />
      <div className="absolute left-0 top-full mt-1 z-20 bg-bearing-surface border border-bearing-border rounded shadow-lg py-1 min-w-[140px]">
        {states.length === 0 ? (
          <div className="px-3 py-1.5 text-xs font-mono text-bearing-muted">loading…</div>
        ) : (
          states.map((s) => {
            const current = s.id === currentId;
            return (
              <button
                key={s.id}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!current) onSelect(s);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-bearing-overlay text-left"
              >
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                <span className={current ? "text-bearing-text" : "text-bearing-muted"}>
                  {s.name}
                </span>
                {current && <span className="ml-auto text-bearing-muted">●</span>}
              </button>
            );
          })
        )}
      </div>
    </>
  );
}

function TagMenu({
  tags,
  appliedTags,
  onToggle,
  onClose,
}: {
  tags: TagDefinition[];
  appliedTags: string[];
  onToggle: (tag: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className="absolute left-0 top-full mt-1 z-20 bg-bearing-surface border border-bearing-border rounded shadow-lg py-1 min-w-[120px]">
        {tags.map((t) => {
          const applied = appliedTags.includes(t.name);
          return (
            <button
              key={t.name}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggle(t.name);
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-bearing-overlay text-left"
              style={{ color: applied ? t.color : undefined }}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: t.color }}
              />
              <span className={applied ? "" : "text-bearing-text"}>
                {t.name}
              </span>
              {applied && <span className="ml-auto text-bearing-muted">×</span>}
            </button>
          );
        })}
      </div>
    </>
  );
}

function RoleTag({ role }: { role: PrRole }) {
  const variants: Record<PrRole, TagVariant | undefined> = {
    reviewer: "accent",
    suggested: "purple",
    author: undefined,
  };
  return <Tag text={role} variant={variants[role]} />;
}

type TagVariant = "accent" | "purple" | "cyan" | "yellow" | "red" | "green";

function Tag({ text, variant }: { text: string; variant?: TagVariant }) {
  const base =
    "shrink-0 px-1.5 py-0.5 text-[10px] font-mono leading-none rounded border";
  const styles: Record<TagVariant, string> = {
    accent: "border-bearing-accent/30 text-bearing-accent",
    purple: "border-bearing-purple/30 text-bearing-purple",
    cyan: "border-bearing-cyan/30 text-bearing-cyan",
    yellow: "border-bearing-yellow/30 text-bearing-yellow",
    red: "border-bearing-red/30 text-bearing-red",
    green: "border-bearing-green/30 text-bearing-green",
  };
  const style = variant
    ? styles[variant]
    : "border-bearing-border text-bearing-muted";
  return <span className={`${base} ${style}`}>{text}</span>;
}

function ColorTag({ text, color, onRemove }: { text: string; color: string; onRemove?: () => void }) {
  if (onRemove) {
    return (
      <span
        className="group/tag shrink-0 inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono leading-none rounded border"
        style={{ borderColor: `${color}50`, color }}
      >
        {text}
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRemove(); }}
          className="hidden group-hover/tag:inline ml-1 hover:text-bearing-text"
        >
          ×
        </button>
      </span>
    );
  }
  return (
    <span
      className="shrink-0 px-1.5 py-0.5 text-[10px] font-mono leading-none rounded border"
      style={{ borderColor: `${color}50`, color }}
    >
      {text}
    </span>
  );
}

function PrStatusTag({ status }: { status: string }) {
  const config: Record<string, TagVariant | undefined> = {
    approved: "cyan",
    "changes requested": "yellow",
    merged: "purple",
    closed: "red",
    draft: undefined,
    open: undefined,
    "review required": undefined,
  };
  return <Tag text={status} variant={config[status]} />;
}

function SearchChip({ term, onClear }: { term: string; onClear: () => void }) {
  return (
    <button
      onClick={onClear}
      className="text-xs font-mono leading-none text-bearing-accent hover:text-bearing-text"
    >
      ["{term}" x]
    </button>
  );
}

function Loading() {
  return (
    <div className="flex items-center justify-center h-32 text-bearing-muted text-xs font-mono">
      loading…
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center h-32 text-bearing-muted text-xs font-mono">
      {text}
    </div>
  );
}

function MultiSelect({
  label,
  options,
  selected,
  onChange,
  colors,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  colors?: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`text-xs font-mono leading-none hover:text-bearing-text ${selected.size > 0 ? "text-bearing-accent" : "text-bearing-muted"
          }`}
      >
        [{label}{selected.size > 0 ? ` ${options.filter(o => selected.has(o)).length}/${options.length}` : ""}]
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 bg-bearing-surface border border-bearing-border rounded shadow-lg py-1 min-w-[180px]">
          {options.map((opt) => {
            const active = selected.has(opt);
            return (
              <button
                key={opt}
                onClick={() => {
                  const next = new Set(selected);
                  if (active) next.delete(opt);
                  else next.add(opt);
                  onChange(next);
                }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-bearing-overlay text-left ${active ? "text-bearing-accent" : "text-bearing-text"
                  }`}
              >
                {colors?.has(opt) ? (
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{
                      backgroundColor: active ? colors.get(opt) : "#6e6a86",
                    }}
                  />
                ) : (
                  <span className={`text-[10px] ${active ? "text-bearing-accent" : "text-bearing-muted"}`}>
                    {active ? "●" : "○"}
                  </span>
                )}
                {opt}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
