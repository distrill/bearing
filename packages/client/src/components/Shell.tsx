import { type ReactNode, useState, useRef, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import type { LinearTeam } from "@bearing/shared";
import type { TagDefinition } from "../lib/api";
import { createTag, updateTag, deleteTag, fetchTeams, createLinearIssue } from "../lib/api";

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
        <div className="flex items-center gap-3">
          {onRefresh && (
            <>
              <button
                onClick={() => window.dispatchEvent(new Event("bearing:resetAttention"))}
                className="text-xs font-mono text-bearing-muted hover:text-bearing-text"
              >
                reset attention
              </button>
              <button
                onClick={onRefresh}
                className="text-xs font-mono text-bearing-muted hover:text-bearing-text"
              >
                refresh
              </button>
            </>
          )}
          {isReview && (
            <a
              href="/"
              className="text-xs text-bearing-muted hover:text-bearing-text font-mono"
            >
              ← dashboard
            </a>
          )}
        </div>
      </header>
      <div className={`flex-1 relative ${isReview ? "overflow-y-auto" : "overflow-hidden"}`}>
        <main className={`max-w-screen-2xl w-full mx-auto ${isReview ? "min-h-full" : "h-full overflow-hidden"}`}>
          {children}
        </main>
        {paletteOpen && (
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
                          ? "text-bearing-text"
                          : "text-bearing-muted hover:text-bearing-subtle"
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>
                <div className="flex-1 overflow-y-auto px-4 pt-3 pb-4">
                  {shelfTab === "overview" && <OverviewPane />}
                  {shelfTab === "tags" && <TagsPane tags={tags} onTagsChange={onTagsChange} />}
                  {shelfTab === "settings" && <SettingsPane teams={teams} />}
                </div>
              </div>
            </div>
          </div>
        </div>}
      </div>
    </div>
  );
}

function OverviewPane() {
  return (
    <div className="grid grid-cols-4 gap-6">
      <Stat label="review" value="—" />
      <Stat label="authored" value="—" />
      <Stat label="suggested" value="—" />
      <Stat label="issues" value="—" />
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
              edit
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
          + new tag
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
          save
        </button>
        <button
          onClick={onCancel}
          className="text-xs font-mono text-bearing-muted hover:text-bearing-text"
        >
          cancel
        </button>
        {onDelete && (
          <button
            onClick={onDelete}
            className="text-xs font-mono text-bearing-red hover:text-bearing-text ml-auto"
          >
            delete
          </button>
        )}
      </div>
    </div>
  );
}

function SettingsPane({ teams }: { teams: LinearTeam[] }) {
  const [defaultTeamId, setDefaultTeamId] = useState(() =>
    localStorage.getItem("bearing:defaultTeamId") ?? "",
  );
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(new Set());

  const workspaces = [...new Set(teams.map((t) => t.workspace))].sort();
  const selectedTeam = teams.find((t) => t.id === defaultTeamId);

  const toggleWorkspace = (ws: string) => {
    setExpandedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(ws)) next.delete(ws);
      else next.add(ws);
      return next;
    });
  };

  const handleChange = (teamId: string) => {
    setDefaultTeamId(teamId);
    if (teamId) {
      localStorage.setItem("bearing:defaultTeamId", teamId);
    } else {
      localStorage.removeItem("bearing:defaultTeamId");
    }
  };

  return (
    <div className="space-y-4">
      <SettingsSection
        label="quick task team"
        value={selectedTeam ? `${selectedTeam.key} · ${selectedTeam.workspace}` : "none"}
      >
        {teams.length === 0 ? (
          <div className="text-xs font-mono text-bearing-muted">no teams loaded</div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {workspaces.map((ws) => {
              const expanded = expandedWorkspaces.has(ws);
              return (
                <div key={ws}>
                  <button
                    onClick={() => toggleWorkspace(ws)}
                    className="flex items-center gap-1 text-[10px] font-mono text-bearing-muted hover:text-bearing-text py-0.5"
                  >
                    <span className="w-3 text-center">{expanded ? "▾" : "▸"}</span>
                    {ws}
                  </button>
                  {expanded &&
                    teams
                      .filter((t) => t.workspace === ws)
                      .map((t) => (
                        <button
                          key={t.id}
                          onClick={() => handleChange(t.id === defaultTeamId ? "" : t.id)}
                          className={`w-full flex items-center gap-2 pl-6 pr-3 py-1 text-xs font-mono rounded ${
                            t.id === defaultTeamId
                              ? "text-bearing-accent bg-bearing-overlay"
                              : "text-bearing-text hover:bg-bearing-overlay"
                          }`}
                        >
                          <span className="text-bearing-muted">{t.key}</span>
                          <span>{t.name}</span>
                          {t.id === defaultTeamId && <span className="ml-auto text-bearing-accent">●</span>}
                        </button>
                      ))}
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}

function SettingsSection({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between py-1 group"
      >
        <span className="text-xs font-mono text-bearing-muted">{label}</span>
        <span className="text-xs font-mono text-bearing-text">{value}</span>
      </button>
      {open && <div className="mt-1">{children}</div>}
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-2xl font-mono text-bearing-text">{value}</div>
      <div className="text-xs font-mono text-bearing-muted mt-1">{label}</div>
    </div>
  );
}
