import { type ReactNode, useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import type { LinearTeam, StatsResponse } from "@bearing/shared";
import type { TagDefinition } from "../lib/api";
import { createTag, updateTag, deleteTag, fetchTeams, createLinearIssue, fetchRepos, fetchStats } from "../lib/api";

function fuzzyMatch(query: string, text: string): boolean {
  const t = text.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => t.includes(word));
}

type ShelfTab = "overview" | "tags" | "settings";

interface ShellProps {
  children: ReactNode;
  onRefresh?: () => void;
  tags?: TagDefinition[];
  onTagsChange?: () => void;
  onIssueCreated?: () => void;
  onSearch?: (scope: "issues" | "prs" | "both", term: string) => void;
  onClearSearch?: () => void;
}

export function Shell({ children, onRefresh, tags = [], onTagsChange, onIssueCreated, onSearch, onClearSearch }: ShellProps) {
  const [location] = useLocation();
  const isReview = location.startsWith("/review");
  const [shelfTab, setShelfTab] = useState<ShelfTab>("overview");
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    const onAvailable = () => setUpdateAvailable(true);
    const onCleared = () => setUpdateAvailable(false);
    window.addEventListener("bearing:updateAvailable", onAvailable);
    window.addEventListener("bearing:updateCleared", onCleared);
    return () => {
      window.removeEventListener("bearing:updateAvailable", onAvailable);
      window.removeEventListener("bearing:updateCleared", onCleared);
    };
  }, []);

  useEffect(() => {
    fetchTeams()
      .then((r) => setTeams(r.teams))
      .catch(() => {});
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <header className="flex items-center justify-between px-4 h-10 border-b border-bearing-border bg-bearing-surface shrink-0">
        <a href="/" className="font-mono text-sm font-medium tracking-wide text-bearing-text hover:text-bearing-pink">
          bearing
        </a>
        <span className="flex-1" />
        {updateAvailable && !isReview && (
          <button
            onClick={() => window.dispatchEvent(new Event("bearing:applyUpdate"))}
            className="text-xs font-mono text-bearing-accent hover:text-bearing-text"
          >
            [update available]
          </button>
        )}
        <span className="flex-1" />
        <div className="flex items-center gap-3">
          {onRefresh && !isReview && (
            <>
              <button
                onClick={() => window.dispatchEvent(new Event("bearing:resetAttention"))}
                className="text-xs font-mono text-bearing-muted hover:text-bearing-text"
              >
                [reset attention]
              </button>
              <button
                onClick={onRefresh}
                className="text-xs font-mono text-bearing-muted hover:text-bearing-text"
              >
                [refresh]
              </button>
            </>
          )}
          {isReview && (
            <a
              href="/"
              className="text-xs text-bearing-muted hover:text-bearing-text font-mono"
            >
              [← dashboard]
            </a>
          )}
        </div>
      </header>
      <div className="flex-1 relative overflow-hidden">
        <main className={`w-full mx-auto ${isReview ? "max-w-[1920px] h-full" : "max-w-screen-2xl h-full overflow-hidden"}`}>
          {children}
        </main>
        {paletteOpen && !isReview && (
          <CommandPalette
            teams={teams}
            onClose={() => setPaletteOpen(false)}
            onIssueCreated={onIssueCreated}
            onSearch={onSearch}
            onClearSearch={onClearSearch}
            onRefresh={onRefresh}
            onResetAttention={() => {
              window.dispatchEvent(new Event("bearing:resetAttention"));
            }}
          />
        )}
        {!isReview && <div className="absolute bottom-0 left-0 right-0 h-1/3 pointer-events-none">
          <div className="max-w-[1700px] w-full mx-auto h-full pointer-events-auto">
            <div className="h-full border-t border-x border-bearing-border rounded-t-lg bg-bearing-surface/90 backdrop-blur-sm flex flex-col">
              <div className="max-w-5xl mx-auto w-full flex flex-col flex-1 overflow-hidden my-3 border border-bearing-border rounded-lg">
                <div className="px-4 pt-3 pb-2 shrink-0 flex items-center gap-4 border-b border-bearing-border">
                  {(["overview", "tags", "settings"] as const).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setShelfTab(tab)}
                      className={`text-xs font-mono ${
                        shelfTab === tab
                          ? "text-bearing-text underline underline-offset-4"
                          : "text-bearing-muted hover:text-bearing-subtle"
                      }`}
                    >
                      [{tab}]
                    </button>
                  ))}
                </div>
                <div className="flex-1 overflow-y-auto px-4 pt-3 pb-4">
                  {shelfTab === "overview" && <OverviewPane />}
                  {shelfTab === "tags" && <TagsPane tags={tags} onTagsChange={onTagsChange} />}
                  {shelfTab === "settings" && <SettingsPane teams={teams} />}
                </div>
                <TrackingFooter teams={teams} />
              </div>
            </div>
          </div>
        </div>}
      </div>
    </div>
  );
}

function TrackingFooter({ teams }: { teams: LinearTeam[] }) {
  const repos = JSON.parse(localStorage.getItem("bearing:statsRepos") ?? "[]") as string[];
  const teamKeys = JSON.parse(localStorage.getItem("bearing:statsTeams") ?? "[]") as string[];
  if (repos.length === 0 && teamKeys.length === 0) return null;

  const teamNames = teamKeys.map((key) => {
    const t = teams.find((t) => t.key === key);
    return t ? t.name : key;
  });

  return (
    <div className="px-4 py-2 border-t border-bearing-border shrink-0 text-[10px] font-mono text-bearing-subtle flex items-center gap-3 flex-wrap">
      {repos.map((r) => (
        <span key={r} className="flex items-center gap-1">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" className="shrink-0 opacity-60">
            <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
          </svg>
          {r}
        </span>
      ))}
      {teamNames.map((name) => (
        <span key={name} className="flex items-center gap-1">
          <svg width="10" height="10" viewBox="0 0 100 100" fill="currentColor" className="shrink-0 opacity-60">
            <path d="M50 0C22.4 0 0 22.4 0 50s22.4 50 50 50 50-22.4 50-50S77.6 0 50 0zm0 90c-22.1 0-40-17.9-40-40s17.9-40 40-40 40 17.9 40 40-17.9 40-40 40z"/>
            <circle cx="50" cy="50" r="15"/>
          </svg>
          {name}
        </span>
      ))}
    </div>
  );
}

let statsCache: { data: StatsResponse; repos: string[]; teams: string[]; fetchedAt: number } | null = null;
const STATS_CACHE_TTL = 60_000;

function OverviewPane() {
  const [stats, setStats] = useState<StatsResponse | null>(statsCache?.data ?? null);
  const [loading, setLoading] = useState(!statsCache);
  const [hovered, setHovered] = useState<string | null>(null);

  const repos = JSON.parse(localStorage.getItem("bearing:statsRepos") ?? "[]") as string[];
  const teams = JSON.parse(localStorage.getItem("bearing:statsTeams") ?? "[]") as string[];

  useEffect(() => {
    if (repos.length === 0 && teams.length === 0) {
      setLoading(false);
      return;
    }

    const cacheKey = repos.join(",") + "|" + teams.join(",");
    const cachedKey = statsCache ? statsCache.repos.join(",") + "|" + statsCache.teams.join(",") : "";
    if (statsCache && cacheKey === cachedKey && Date.now() - statsCache.fetchedAt < STATS_CACHE_TTL) {
      setStats(statsCache.data);
      setLoading(false);
      return;
    }

    fetchStats(repos, teams)
      .then((data) => {
        statsCache = { data, repos, teams, fetchedAt: Date.now() };
        setStats(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return <div className="text-xs font-mono text-bearing-muted">loading…</div>;
  }

  if (!stats || stats.days.length === 0) {
    return (
      <div className="text-xs font-mono text-bearing-muted">
        configure repos and teams in [settings] to see stats
      </div>
    );
  }

  const sum7 = (arr: number[]) => arr.slice(-7).reduce((a, b) => a + b, 0);

  const statDefs = [
    { label: "prs opened", data: stats.prsOpened },
    { label: "prs merged", data: stats.prsMerged },
    { label: "prs reviewed", data: stats.prsReviewed },
    { label: "lines authored", data: stats.linesAuthored },
    { label: "tasks closed", data: stats.issuesClosed },
  ];

  const hoveredDef = hovered ? statDefs.find((s) => s.label === hovered) : null;

  return (
    <div onMouseLeave={() => setHovered(null)}>
      <div className="flex justify-between">
        {statDefs.map((s) => (
          <div
            key={s.label}
            onMouseEnter={() => setHovered(s.label)}
            className="cursor-default"
          >
            <div className="text-xs font-mono text-bearing-muted">{s.label}</div>
            <div className="text-2xl font-mono text-bearing-text leading-none mt-1">
              {s.label === "lines authored" ? sum7(s.data).toLocaleString() : String(sum7(s.data))}
            </div>
            <div className="mt-1.5"><Sparkline data={s.data} /></div>
          </div>
        ))}
      </div>
      {hoveredDef && (
        <div className="mt-5 pt-4 border-t border-bearing-border">
          <StatDetail label={hoveredDef.label} data={hoveredDef.data} days={stats.days} />
        </div>
      )}
    </div>
  );
}

const PALETTE = [
  { name: "red", hex: "#eb6f92" },
  { name: "yellow", hex: "#f6c177" },
  { name: "green", hex: "#31748f" },
  { name: "cyan", hex: "#9ccfd8" },
  { name: "purple", hex: "#c4a7e7" },
  { name: "pink", hex: "#ebbcba" },
] as const;

function TagsPane({ tags, onTagsChange }: { tags: TagDefinition[]; onTagsChange?: () => void }) {
  const [editing, setEditing] = useState<string | null>(null); // tag name being edited
  const [creating, setCreating] = useState(false);

  const handleCreate = async (name: string, color: string) => {
    await createTag(name, color);
    setCreating(false);
    onTagsChange?.();
  };

  const handleUpdate = async (oldName: string, name: string, color: string) => {
    await updateTag(oldName, name, color);
    setEditing(null);
    onTagsChange?.();
  };

  const handleDelete = async (name: string) => {
    await deleteTag(name);
    setEditing(null);
    onTagsChange?.();
  };

  return (
    <div className="space-y-2">
      {tags.map((tag) =>
        editing === tag.name ? (
          <TagForm
            key={tag.name}
            initial={tag}
            existingNames={tags.map((t) => t.name).filter((n) => n !== tag.name)}
            onSave={(name, color) => handleUpdate(tag.name, name, color)}
            onCancel={() => setEditing(null)}
            onDelete={() => handleDelete(tag.name)}
          />
        ) : (
          <div
            key={tag.name}
            className="group flex items-center gap-2 px-3 py-1.5 rounded border border-bearing-border hover:border-bearing-muted cursor-pointer"
            onClick={() => { setEditing(tag.name); setCreating(false); }}
          >
            <div
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: tag.color }}
            />
            <span className="text-xs font-mono text-bearing-text flex-1">
              {tag.name}
            </span>
            <span className="text-xs font-mono text-bearing-muted opacity-0 group-hover:opacity-100">
              [edit]
            </span>
          </div>
        ),
      )}

      {creating ? (
        <TagForm
          existingNames={tags.map((t) => t.name)}
          onSave={handleCreate}
          onCancel={() => setCreating(false)}
        />
      ) : (
        <button
          onClick={() => { setCreating(true); setEditing(null); }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono text-bearing-muted hover:text-bearing-text"
        >
          [+ new tag]
        </button>
      )}
    </div>
  );
}

function TagForm({
  initial,
  existingNames,
  onSave,
  onCancel,
  onDelete,
}: {
  initial?: TagDefinition;
  existingNames: string[];
  onSave: (name: string, color: string) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [color, setColor] = useState(initial?.color ?? PALETTE[0].hex);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const trimmed = name.trim().toLowerCase();
  const isDuplicate = existingNames.includes(trimmed);
  const canSave = trimmed.length > 0 && !isDuplicate;

  const handleSubmit = () => {
    if (canSave) onSave(trimmed, color);
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-2 rounded border border-bearing-accent/50 bg-bearing-overlay">
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleSubmit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="tag name"
        className="bg-transparent text-xs font-mono text-bearing-text placeholder:text-bearing-muted outline-none border-b border-bearing-border pb-1"
      />
      <div className="flex items-center gap-1.5">
        {PALETTE.map((c) => (
          <button
            key={c.hex}
            onClick={() => setColor(c.hex)}
            className={`w-5 h-5 rounded-full transition-all ${
              color === c.hex
                ? "ring-2 ring-bearing-text ring-offset-1 ring-offset-bearing-overlay scale-110"
                : "hover:scale-110"
            }`}
            style={{ backgroundColor: c.hex }}
            title={c.name}
          />
        ))}
      </div>
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleSubmit}
          disabled={!canSave}
          className="text-xs font-mono text-bearing-accent hover:text-bearing-text disabled:text-bearing-muted disabled:cursor-not-allowed"
        >
          [save]
        </button>
        <button
          onClick={onCancel}
          className="text-xs font-mono text-bearing-muted hover:text-bearing-text"
        >
          [cancel]
        </button>
        {onDelete && (
          <button
            onClick={onDelete}
            className="text-xs font-mono text-bearing-red hover:text-bearing-text ml-auto"
          >
            [delete]
          </button>
        )}
      </div>
    </div>
  );
}

function usePortalDropdown() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const toggle = useCallback(() => {
    if (btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.top - 4, left: rect.left });
    }
    setOpen((o) => !o);
  }, []);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        btnRef.current && !btnRef.current.contains(e.target as Node)
      ) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return { open, setOpen, toggle, btnRef, dropdownRef, pos };
}

function SettingsPane({ teams }: { teams: LinearTeam[] }) {
  const [defaultTeamId, setDefaultTeamId] = useState(() =>
    localStorage.getItem("bearing:defaultTeamId") ?? "",
  );
  const [availableRepos, setAvailableRepos] = useState<{ owner: string; name: string; fullName: string }[]>([]);
  const [statsRepos, setStatsRepos] = useState<string[]>(() =>
    JSON.parse(localStorage.getItem("bearing:statsRepos") ?? "[]"),
  );
  const [statsTeams, setStatsTeams] = useState<string[]>(() =>
    JSON.parse(localStorage.getItem("bearing:statsTeams") ?? "[]"),
  );

  const taskTeamDd = usePortalDropdown();
  const repoDd = usePortalDropdown();
  const teamDd = usePortalDropdown();

  const selectedTeam = teams.find((t) => t.id === defaultTeamId);
  const workspaces = [...new Set(teams.map((t) => t.workspace))].sort();

  useEffect(() => {
    fetchRepos()
      .then((r) => setAvailableRepos(r.repos))
      .catch(() => {});
  }, []);

  const handleTaskTeamChange = (teamId: string) => {
    const next = teamId === defaultTeamId ? "" : teamId;
    setDefaultTeamId(next);
    if (next) localStorage.setItem("bearing:defaultTeamId", next);
    else localStorage.removeItem("bearing:defaultTeamId");
    taskTeamDd.setOpen(false);
  };

  const toggleStatsRepo = (fullName: string) => {
    setStatsRepos((prev) => {
      const next = prev.includes(fullName)
        ? prev.filter((r) => r !== fullName)
        : [...prev, fullName];
      localStorage.setItem("bearing:statsRepos", JSON.stringify(next));
      return next;
    });
  };

  const toggleStatsTeam = (teamKey: string) => {
    setStatsTeams((prev) => {
      const next = prev.includes(teamKey)
        ? prev.filter((t) => t !== teamKey)
        : [...prev, teamKey];
      localStorage.setItem("bearing:statsTeams", JSON.stringify(next));
      return next;
    });
  };

  const repoOrgs = [...new Set(availableRepos.map((r) => r.owner))].sort();
  const uniqueTeamKeys = new Map<string, LinearTeam>();
  for (const t of teams) {
    if (!uniqueTeamKeys.has(t.key)) uniqueTeamKeys.set(t.key, t);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-xs font-mono text-bearing-muted">quick task team</span>
        <button
          ref={taskTeamDd.btnRef}
          onClick={taskTeamDd.toggle}
          className={`text-xs font-mono leading-none hover:text-bearing-text ${
            selectedTeam ? "text-bearing-accent" : "text-bearing-muted"
          }`}
        >
          [{selectedTeam ? selectedTeam.name : "none"}]
        </button>
        {taskTeamDd.open && createPortal(
          <div
            ref={taskTeamDd.dropdownRef}
            className="fixed z-50 bg-bearing-surface border border-bearing-border rounded shadow-lg py-1 min-w-[160px] max-h-[50vh] overflow-y-auto"
            style={{ bottom: `calc(100vh - ${taskTeamDd.pos.top}px)`, left: taskTeamDd.pos.left }}
          >
            {teams.length === 0 ? (
              <div className="px-3 py-1.5 text-xs font-mono text-bearing-muted">no teams loaded</div>
            ) : (
              workspaces.map((ws) => (
                <div key={ws}>
                  <div className="px-3 pt-2 pb-1 text-[10px] font-mono text-bearing-muted">{ws}</div>
                  {teams.filter((t) => t.workspace === ws).map((t) => {
                    const active = t.id === defaultTeamId;
                    return (
                      <button
                        key={t.id}
                        onClick={() => handleTaskTeamChange(t.id)}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-bearing-overlay text-left ${
                          active ? "text-bearing-accent" : "text-bearing-text"
                        }`}
                      >
                        <span className={`text-[10px] ${active ? "text-bearing-accent" : "text-bearing-muted"}`}>
                          {active ? "●" : "○"}
                        </span>
                        <span className="text-bearing-muted">{t.key}</span>
                        <span>{t.name}</span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>,
          document.body,
        )}
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs font-mono text-bearing-muted">stats repos</span>
        <button
          ref={repoDd.btnRef}
          onClick={repoDd.toggle}
          className={`text-xs font-mono leading-none hover:text-bearing-text ${
            statsRepos.length > 0 ? "text-bearing-accent" : "text-bearing-muted"
          }`}
        >
          [{statsRepos.length > 0 ? `${statsRepos.length} selected` : "none"}]
        </button>
        {repoDd.open && createPortal(
          <div
            ref={repoDd.dropdownRef}
            className="fixed z-50 bg-bearing-surface border border-bearing-border rounded shadow-lg py-1 min-w-[200px] max-h-[50vh] overflow-y-auto"
            style={{ bottom: `calc(100vh - ${repoDd.pos.top}px)`, left: repoDd.pos.left }}
          >
            {availableRepos.length === 0 ? (
              <div className="px-3 py-1.5 text-xs font-mono text-bearing-muted">loading…</div>
            ) : (
              repoOrgs.map((org) => (
                <div key={org}>
                  <div className="px-3 pt-2 pb-1 text-[10px] font-mono text-bearing-muted">{org}</div>
                  {availableRepos.filter((r) => r.owner === org).map((r) => {
                    const active = statsRepos.includes(r.fullName);
                    return (
                      <button
                        key={r.fullName}
                        onClick={() => toggleStatsRepo(r.fullName)}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-bearing-overlay text-left ${
                          active ? "text-bearing-accent" : "text-bearing-text"
                        }`}
                      >
                        <span className={`text-[10px] ${active ? "text-bearing-accent" : "text-bearing-muted"}`}>
                          {active ? "●" : "○"}
                        </span>
                        {r.name}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>,
          document.body,
        )}
      </div>

      <div className="flex items-center gap-3">
        <span className="text-xs font-mono text-bearing-muted">stats teams</span>
        <button
          ref={teamDd.btnRef}
          onClick={teamDd.toggle}
          className={`text-xs font-mono leading-none hover:text-bearing-text ${
            statsTeams.length > 0 ? "text-bearing-accent" : "text-bearing-muted"
          }`}
        >
          [{statsTeams.length > 0 ? `${statsTeams.length} selected` : "none"}]
        </button>
        {teamDd.open && createPortal(
          <div
            ref={teamDd.dropdownRef}
            className="fixed z-50 bg-bearing-surface border border-bearing-border rounded shadow-lg py-1 min-w-[160px] max-h-[50vh] overflow-y-auto"
            style={{ bottom: `calc(100vh - ${teamDd.pos.top}px)`, left: teamDd.pos.left }}
          >
            {teams.length === 0 ? (
              <div className="px-3 py-1.5 text-xs font-mono text-bearing-muted">no teams loaded</div>
            ) : (
              workspaces.map((ws) => (
                <div key={ws}>
                  <div className="px-3 pt-2 pb-1 text-[10px] font-mono text-bearing-muted">{ws}</div>
                  {teams.filter((t) => t.workspace === ws).map((t) => {
                    if (uniqueTeamKeys.get(t.key) !== t) return null;
                    const active = statsTeams.includes(t.key);
                    return (
                      <button
                        key={t.key}
                        onClick={() => toggleStatsTeam(t.key)}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-bearing-overlay text-left ${
                          active ? "text-bearing-accent" : "text-bearing-text"
                        }`}
                      >
                        <span className={`text-[10px] ${active ? "text-bearing-accent" : "text-bearing-muted"}`}>
                          {active ? "●" : "○"}
                        </span>
                        <span className="text-bearing-muted">{t.key}</span>
                        <span>{t.name}</span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>,
          document.body,
        )}
      </div>
    </div>
  );
}

interface Command {
  id: string;
  label: string;
  description: string;
  action: (args: { input: string; close: () => void }) => void | Promise<void>;
}

type PaletteMode = "commands" | "search-input" | "create-task";

function CommandPalette({
  teams,
  onClose,
  onIssueCreated,
  onSearch,
  onClearSearch,
  onRefresh,
  onResetAttention,
}: {
  teams: LinearTeam[];
  onClose: () => void;
  onIssueCreated?: () => void;
  onSearch?: (scope: "issues" | "prs" | "both", term: string) => void;
  onClearSearch?: () => void;
  onRefresh?: () => void;
  onResetAttention?: () => void;
}) {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<PaletteMode>("commands");
  const [searchScope, setSearchScope] = useState<"issues" | "prs" | "both">("both");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  const defaultTeamId = localStorage.getItem("bearing:defaultTeamId") ?? "";
  const defaultTeam = teams.find((t) => t.id === defaultTeamId);

  const startSearch = (scope: "issues" | "prs" | "both") => {
    setSearchScope(scope);
    setMode("search-input");
    setInput("");
  };

  const commands: Command[] = [
    {
      id: "search-issues",
      label: "search issues",
      description: "filter issues by title",
      action: () => startSearch("issues"),
    },
    {
      id: "search-prs",
      label: "search pull requests",
      description: "filter pull requests by title",
      action: () => startSearch("prs"),
    },
    {
      id: "search-all",
      label: "search all",
      description: "filter issues and pull requests",
      action: () => startSearch("both"),
    },
    {
      id: "clear-search",
      label: "clear search",
      description: "remove all search filters",
      action: () => { onClearSearch?.(); onClose(); },
    },
    {
      id: "create-task",
      label: "create task",
      description: defaultTeam
        ? `new issue in ${defaultTeam.key} · ${defaultTeam.workspace}`
        : "configure a default team in settings first",
      action: () => {
        if (defaultTeam) {
          setMode("create-task");
          setInput("");
        }
      },
    },
    {
      id: "refresh",
      label: "refresh",
      description: "reload all data",
      action: () => { onRefresh?.(); onClose(); },
    },
    {
      id: "reset-attention",
      label: "reset attention",
      description: "mark everything as unseen",
      action: ({ close }) => {
        window.dispatchEvent(new Event("bearing:resetAttention"));
        close();
      },
    },
  ];

  const filtered = input
    ? commands.filter((c) => fuzzyMatch(input, c.label))
    : commands;

  useEffect(() => {
    setSelectedIndex(0);
  }, [input, mode]);

  const handleCreateTask = async () => {
    if (!defaultTeam || !input.trim() || creating) return;
    setCreating(true);
    try {
      await createLinearIssue(defaultTeam.id, input.trim());
      onIssueCreated?.();
      onClose();
    } catch {
      setCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (mode !== "commands") {
        setMode("commands");
        setInput("");
      } else {
        onClose();
      }
      return;
    }

    if (mode === "create-task") {
      if (e.key === "Enter") {
        e.preventDefault();
        handleCreateTask();
      }
      return;
    }

    if (mode === "search-input") {
      if (e.key === "Enter" && input.trim()) {
        e.preventDefault();
        onSearch?.(searchScope, input.trim());
        onClose();
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && filtered[selectedIndex]) {
      e.preventDefault();
      filtered[selectedIndex].action({ input, close: onClose });
    }
  };

  const scopeLabel = searchScope === "both" ? "all" : searchScope === "prs" ? "pull requests" : "issues";

  const placeholder =
    mode === "create-task" ? "task title…"
    : mode === "search-input" ? `search ${scopeLabel}…`
    : "type a command…";

  const modePrefix =
    mode === "create-task" ? `${defaultTeam?.key} ›`
    : mode === "search-input" ? `search ${scopeLabel} ›`
    : null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <div className="fixed inset-x-0 top-[20%] z-50 flex justify-center">
        <div className="w-full max-w-lg bg-bearing-surface border border-bearing-border rounded-lg shadow-2xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-bearing-border">
            {modePrefix && (
              <span className="text-xs font-mono text-bearing-accent shrink-0">
                {modePrefix}
              </span>
            )}
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className="flex-1 bg-transparent text-sm font-mono text-bearing-text placeholder:text-bearing-muted outline-none"
            />
            {creating && (
              <span className="text-xs font-mono text-bearing-muted">creating…</span>
            )}
          </div>
          {mode === "commands" && filtered.length > 0 && (
            <div className="py-1">
              {filtered.map((cmd, i) => (
                <button
                  key={cmd.id}
                  onClick={() => cmd.action({ input, close: onClose })}
                  className={`w-full flex items-center justify-between px-4 py-2 text-left ${
                    i === selectedIndex ? "bg-bearing-overlay" : ""
                  }`}
                >
                  <span className="text-xs font-mono text-bearing-text">{cmd.label}</span>
                  <span className="text-xs font-mono text-bearing-muted">{cmd.description}</span>
                </button>
              ))}
            </div>
          )}
          {mode === "commands" && filtered.length === 0 && input && (
            <div className="px-4 py-3 text-xs font-mono text-bearing-muted">
              no commands match
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Sparkline({ data, width = 80, height = 20, color }: { data: number[]; width?: number | string; height?: number; color?: string }) {
  if (data.length === 0) return null;
  const max = Math.max(...data, 1);
  const viewW = 100;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * viewW;
    const y = height - (v / max) * height;
    return `${x},${y}`;
  }).join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${viewW} ${height}`}
      preserveAspectRatio="none"
      className="shrink-0 block"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        className={color ?? "text-bearing-accent"}
      />
    </svg>
  );
}

function StatDetail({ label, data, days }: { label: string; data: number[]; days: string[] }) {
  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
  const current7 = sum(data.slice(-7));
  const prev7 = sum(data.slice(0, 7));
  const delta = current7 - prev7;
  const avg = (current7 / 7).toFixed(1);
  const peakVal = Math.max(...data);
  const peakIdx = data.indexOf(peakVal);
  const peakDay = days[peakIdx];

  const cumulative = data.reduce<number[]>((acc, v) => {
    acc.push((acc.length > 0 ? acc[acc.length - 1] : 0) + v);
    return acc;
  }, []);

  const formatDay = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  return (
    <div className="flex justify-between gap-8">
      <div className="flex-1 max-w-[30%]">
        <div className="text-[10px] font-mono text-bearing-muted mb-2">{label} — 14 days</div>
        <Sparkline data={data} width="100%" height={40} />
      </div>
      <div className="flex-1 max-w-[30%]">
        <div className="text-[10px] font-mono text-bearing-muted mb-2">cumulative</div>
        <Sparkline data={cumulative} width="100%" height={40} color="text-bearing-purple" />
      </div>
      <div className="space-y-1.5 pt-4">
        <div className="text-xs font-mono text-bearing-muted">
          prev 7d{" "}
          <span className={delta > 0 ? "text-bearing-cyan" : delta < 0 ? "text-bearing-red" : "text-bearing-muted"}>
            {delta > 0 ? "+" : ""}{delta.toLocaleString()} {delta > 0 ? "↑" : delta < 0 ? "↓" : "—"}
          </span>
        </div>
        <div className="text-xs font-mono text-bearing-muted">
          avg <span className="text-bearing-text">{avg}</span>/d
        </div>
        <div className="text-xs font-mono text-bearing-muted">
          peak <span className="text-bearing-text">{peakVal.toLocaleString()}</span> {peakDay ? formatDay(peakDay) : ""}
        </div>
      </div>
    </div>
  );
}

