import { type ReactNode, useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import type { TagDefinition } from "../lib/api";
import { createTag, updateTag, deleteTag } from "../lib/api";

type ShelfTab = "overview" | "tags" | "settings";

interface ShellProps {
  children: ReactNode;
  onRefresh?: () => void;
  tags?: TagDefinition[];
  onTagsChange?: () => void;
}

export function Shell({ children, onRefresh, tags = [], onTagsChange }: ShellProps) {
  const [location] = useLocation();
  const isReview = location.startsWith("/review");
  const [shelfTab, setShelfTab] = useState<ShelfTab>("overview");

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <header className="flex items-center justify-between px-4 h-10 border-b border-bearing-border bg-bearing-surface shrink-0">
        <a href="/" className="font-mono text-sm font-medium tracking-wide text-bearing-text hover:text-bearing-pink">
          bearing
        </a>
        <div className="flex items-center gap-3">
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="text-xs font-mono text-bearing-muted hover:text-bearing-text"
            >
              refresh
            </button>
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
      <div className="flex-1 overflow-hidden relative">
        <main className="h-full overflow-hidden max-w-screen-2xl w-full mx-auto">
          {children}
        </main>
        <div className="absolute bottom-0 left-0 right-0 h-1/3 pointer-events-none">
          <div className="max-w-[1700px] w-full mx-auto h-full pointer-events-auto">
            <div className="h-full border-t border-x border-bearing-border rounded-t-lg bg-bearing-surface/95 backdrop-blur-sm flex flex-col">
              <div className="flex items-center gap-4 px-6 pt-3 pb-2 shrink-0">
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
              <div className="flex-1 overflow-y-auto px-6 pb-4">
                {shelfTab === "overview" && <OverviewPane />}
                {shelfTab === "tags" && <TagsPane tags={tags} onTagsChange={onTagsChange} />}
                {shelfTab === "settings" && <SettingsPane />}
              </div>
            </div>
          </div>
        </div>
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

function SettingsPane() {
  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs font-mono text-bearing-muted">config</div>
        <div className="text-xs font-mono text-bearing-text mt-1">
          config.json
        </div>
      </div>
    </div>
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
