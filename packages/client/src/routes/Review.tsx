import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { useParams } from "wouter";
import type {
  PRDetailResponse,
  PullRequestFile,
  PullRequestReview,
  ReviewComment,
  IssueComment,
} from "@bearing/shared";
import { fetchPRDetail } from "../lib/api";
import { parsePatch, type DiffHunk, type DiffLine } from "../lib/diff";
import {
  getHighlighter,
  langFromFilename,
  type Highlighter,
  type ThemedToken,
  type BundledLanguage,
} from "../lib/highlight";
import { timeAgo } from "../lib/time";
import MarkdownBase from "react-markdown";
import rehypeRaw from "rehype-raw";

function proxyGitHubImage(src: string): string {
  if (
    src.startsWith("https://github.com/") ||
    src.startsWith("https://user-images.githubusercontent.com/") ||
    src.startsWith("https://private-user-images.githubusercontent.com/")
  ) {
    return `/api/github-image?url=${encodeURIComponent(src)}`;
  }
  return src;
}

function MarkdownImage({
  src,
  alt,
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [lightbox, setLightbox] = useState(false);
  const proxied = src ? proxyGitHubImage(src) : undefined;

  useEffect(() => {
    if (!lightbox) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [lightbox]);

  return (
    <>
      <img
        {...props}
        src={proxied}
        alt={alt ?? ""}
        className="max-h-48 w-auto rounded border border-bearing-border cursor-pointer hover:border-bearing-muted transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          setLightbox(true);
        }}
      />
      {lightbox && (
        <>
          <div
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-pointer"
            onClick={() => setLightbox(false)}
          >
            <img
              src={proxied}
              alt={alt ?? ""}
              className="max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </>
      )}
    </>
  );
}

const markdownComponents = {
  img: MarkdownImage,
};

function Markdown({ children }: { children: string }) {
  return (
    <MarkdownBase rehypePlugins={[rehypeRaw]} components={markdownComponents}>
      {children}
    </MarkdownBase>
  );
}

// --- Reviewed state persistence ---

interface ReviewedState {
  [filename: string]: string;
}

function reviewedKey(owner: string, repo: string, number: string) {
  return `bearing:reviewed:${owner}/${repo}#${number}`;
}

function loadReviewed(
  owner: string,
  repo: string,
  number: string,
): ReviewedState {
  try {
    const raw = localStorage.getItem(reviewedKey(owner, repo, number));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveReviewed(
  owner: string,
  repo: string,
  number: string,
  state: ReviewedState,
) {
  localStorage.setItem(reviewedKey(owner, repo, number), JSON.stringify(state));
}

// --- Comment threading ---

interface CommentThread {
  root: ReviewComment;
  replies: ReviewComment[];
}

function buildThreads(comments: ReviewComment[]): CommentThread[] {
  const threads: CommentThread[] = [];
  const replyMap = new Map<number, ReviewComment[]>();

  for (const c of comments) {
    if (c.inReplyToId) {
      const replies = replyMap.get(c.inReplyToId) ?? [];
      replies.push(c);
      replyMap.set(c.inReplyToId, replies);
    }
  }

  for (const c of comments) {
    if (!c.inReplyToId) {
      threads.push({
        root: c,
        replies: (replyMap.get(c.id) ?? []).sort(
          (a, b) =>
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        ),
      });
    }
  }

  return threads;
}

// --- Highlighter hook ---

function useHighlighter(): Highlighter | null {
  const [hl, setHl] = useState<Highlighter | null>(null);
  useEffect(() => {
    getHighlighter()
      .then(setHl)
      .catch(() => {});
  }, []);
  return hl;
}

// --- Main component ---

export function Review() {
  const { owner, repo, number } = useParams<{
    owner: string;
    repo: string;
    number: string;
  }>();

  const [data, setData] = useState<PRDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [reviewed, setReviewed] = useState<ReviewedState>(() =>
    loadReviewed(owner!, repo!, number!),
  );
  const [stickyBodyExpanded, setStickyBodyExpanded] = useState(false);
  const [viewMode, setViewMode] = useState<"unified" | "split">(
    () => (localStorage.getItem("bearing:viewMode") as "unified" | "split") ?? "unified",
  );
  const setAndPersistViewMode = useCallback((mode: "unified" | "split") => {
    setViewMode(mode);
    localStorage.setItem("bearing:viewMode", mode);
  }, []);
  const [headerPinned, setHeaderPinned] = useState(false);
  const headerSentinelRef = useRef<HTMLDivElement>(null);
  const highlighter = useHighlighter();

  useEffect(() => {
    const el = headerSentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const pinned = !entry.isIntersecting;
        setHeaderPinned(pinned);
        if (!pinned) setStickyBodyExpanded(false);
      },
      { threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [data]);

  useEffect(() => {
    if (!owner || !repo || !number) return;
    setLoading(true);
    setError(null);
    fetchPRDetail(owner, repo, parseInt(number, 10))
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [owner, repo, number]);

  const toggleCollapse = useCallback((filename: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  }, []);

  const toggleReviewed = useCallback(
    (filename: string, sha: string) => {
      setReviewed((prev) => {
        const next = { ...prev };
        if (next[filename] === sha) {
          delete next[filename];
        } else {
          next[filename] = sha;
        }
        saveReviewed(owner!, repo!, number!, next);
        return next;
      });
    },
    [owner, repo, number],
  );

  const collapseAll = useCallback(() => {
    if (!data) return;
    setCollapsed(new Set(data.files.map((f) => f.filename)));
  }, [data]);

  const expandAll = useCallback(() => {
    setCollapsed(new Set());
  }, []);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-bearing-muted text-xs font-mono">
        loading…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="h-full flex items-center justify-center text-bearing-red text-xs font-mono">
        {error ?? "Failed to load PR"}
      </div>
    );
  }

  const threads = buildThreads(data.comments);
  const reviewedCount = data.files.filter(
    (f) => reviewed[f.filename] === f.sha,
  ).length;

  return (
    <div className="relative">
      {/* Sticky bar — appears when header scrolls out */}
      {headerPinned && (
        <div className="sticky top-0 z-20">
          <div className="bg-bearing-surface border-x border-b border-bearing-border rounded-b-lg">
            <div className="flex items-center gap-2 px-6 h-10">
              <span className="text-xs font-mono text-bearing-muted truncate">
                {data.title}
              </span>
              <span className="flex-1" />
              <span className="text-xs font-mono text-bearing-muted shrink-0">
                {reviewedCount}/{data.files.length}
              </span>
              {data.body && (
                <button
                  onClick={() => setStickyBodyExpanded((v) => !v)}
                  className="text-[10px] font-mono text-bearing-muted hover:text-bearing-text shrink-0"
                >
                  {stickyBodyExpanded ? "▾" : "▸"} description
                </button>
              )}
            </div>
            {stickyBodyExpanded && data.body && (
              <div className="px-6 pb-4 max-h-64 overflow-y-auto prose-bearing border-t border-bearing-border/50">
                <Markdown>{data.body}</Markdown>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="px-4 pt-4 pb-8 space-y-3">
        {/* Header */}
        <div className="border border-bearing-border rounded-lg bg-bearing-surface px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-bearing-muted">
              {owner}/{repo} #{number}
            </span>
            <span className="flex-1" />
            <span className="text-xs font-mono text-bearing-muted">
              {reviewedCount}/{data.files.length} reviewed
            </span>
            <a
              href={data.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-mono text-bearing-muted hover:text-bearing-accent"
            >
              github →
            </a>
          </div>
          <h1 className="text-lg text-bearing-text mt-1.5">{data.title}</h1>
          <div className="flex items-center gap-3 mt-1.5 text-xs font-mono text-bearing-muted">
            <span>@{data.author.login}</span>
            <span>
              <span className="text-bearing-cyan">+{data.additions}</span>{" "}
              <span className="text-bearing-red">-{data.deletions}</span>
            </span>
            <span>{data.changedFiles} files</span>
            <span>{timeAgo(data.updatedAt)}</span>
          </div>

        </div>

        {/* PR Body */}
        {data.body && (
          <div className="border border-bearing-border rounded-lg bg-bearing-surface px-5 py-4 prose-bearing">
            <Markdown>{data.body}</Markdown>
          </div>
        )}
        <div ref={headerSentinelRef} />

        {/* Commits */}
        {data.commits.length > 0 && (
          <div className="border border-bearing-border rounded-lg bg-bearing-surface overflow-hidden">
            <div className="px-5 py-2 border-b border-bearing-border/50">
              <span className="text-xs font-mono text-bearing-muted">
                {data.commits.length} commit{data.commits.length !== 1 ? "s" : ""}
              </span>
            </div>
            {data.commits.map((commit, i) => (
              <div
                key={commit.sha}
                className={`flex items-baseline gap-3 px-5 py-2.5 ${i > 0 ? "border-t border-bearing-border/50" : ""}`}
              >
                <span className="text-xs font-mono text-bearing-muted/50 shrink-0">
                  {commit.sha.slice(0, 7)}
                </span>
                <span className="text-sm font-mono text-bearing-text truncate">
                  {commit.message.split("\n")[0]}
                </span>
                <span className="flex-1" />
                <span className="text-xs font-mono text-bearing-muted shrink-0">
                  @{commit.author.login}
                </span>
                <span className="text-[10px] font-mono text-bearing-muted/50 shrink-0">
                  {timeAgo(commit.committedAt)}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* File controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={expandAll}
            className="text-[10px] font-mono text-bearing-muted hover:text-bearing-text"
          >
            expand all
          </button>
          <button
            onClick={collapseAll}
            className="text-[10px] font-mono text-bearing-muted hover:text-bearing-text"
          >
            collapse all
          </button>
          <span className="flex-1" />
          <button
            onClick={() =>
              setAndPersistViewMode(viewMode === "unified" ? "split" : "unified")
            }
            className="text-[10px] font-mono text-bearing-muted hover:text-bearing-text"
          >
            {viewMode === "unified" ? "split" : "unified"}
          </button>
        </div>

        {/* Files */}
        {data.files.map((file) => (
          <FileSection
            key={file.filename}
            file={file}
            collapsed={collapsed.has(file.filename)}
            reviewed={reviewed[file.filename] === file.sha}
            threads={threads.filter((t) => t.root.path === file.filename)}
            highlighter={highlighter}
            viewMode={viewMode}
            onToggleCollapse={() => toggleCollapse(file.filename)}
            onToggleReviewed={() => toggleReviewed(file.filename, file.sha)}
          />
        ))}

        {/* Activity timeline */}
        {(data.reviews.length > 0 || data.issueComments.length > 0) && (
          <ActivityTimeline
            reviews={data.reviews}
            issueComments={data.issueComments}
          />
        )}
      </div>
    </div>
  );
}

// --- Sub-components ---

type TimelineEntry =
  | { kind: "review"; review: PullRequestReview; time: number }
  | { kind: "comment"; comment: IssueComment; time: number };

function ActivityTimeline({
  reviews,
  issueComments,
}: {
  reviews: PullRequestReview[];
  issueComments: IssueComment[];
}) {
  const hasContent = (r: PullRequestReview) =>
    r.body.trim() || (r.state !== "COMMENTED" && r.state !== "PENDING");

  const entries: TimelineEntry[] = [
    ...reviews
      .filter((r) => r.state !== "PENDING" && hasContent(r))
      .map((r) => ({
        kind: "review" as const,
        review: r,
        time: new Date(r.submittedAt).getTime(),
      })),
    ...issueComments
      .filter((c) => c.body.trim())
      .map((c) => ({
        kind: "comment" as const,
        comment: c,
        time: new Date(c.createdAt).getTime(),
      })),
  ].sort((a, b) => a.time - b.time);

  if (entries.length === 0) return null;

  const REVIEW_STATE_COLOR: Record<string, string> = {
    APPROVED: "text-bearing-cyan",
    CHANGES_REQUESTED: "text-bearing-yellow",
    DISMISSED: "text-bearing-muted",
    COMMENTED: "text-bearing-subtle",
  };

  const REVIEW_STATE_LABEL: Record<string, string> = {
    APPROVED: "approved",
    CHANGES_REQUESTED: "changes requested",
    DISMISSED: "dismissed",
    COMMENTED: "commented",
  };

  return (
    <div className="border border-bearing-border rounded-lg bg-bearing-surface overflow-hidden">
      {entries.map((entry, i) => (
        <div
          key={entry.kind === "review" ? `r${entry.review.id}` : `c${entry.comment.id}`}
          className={`px-5 py-4 ${i > 0 ? "border-t border-bearing-border/50" : ""}`}
        >
          {entry.kind === "review" ? (
            <>
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs font-mono ${REVIEW_STATE_COLOR[entry.review.state] ?? "text-bearing-muted"}`}
                >
                  @{entry.review.author.login}{" "}
                  {REVIEW_STATE_LABEL[entry.review.state] ?? entry.review.state.toLowerCase()}
                </span>
                <span className="text-[10px] font-mono text-bearing-muted/50">
                  {timeAgo(entry.review.submittedAt)}
                </span>
              </div>
              {entry.review.body.trim() && (
                <div className="mt-2 prose-bearing">
                  <Markdown>{entry.review.body}</Markdown>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-bearing-accent">
                  @{entry.comment.author.login}
                </span>
                <span className="text-[10px] font-mono text-bearing-muted/50">
                  {timeAgo(entry.comment.createdAt)}
                </span>
              </div>
              <div className="mt-2 prose-bearing">
                <Markdown>{entry.comment.body}</Markdown>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}


function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="shrink-0 text-[10px] font-mono text-bearing-muted/0 group-hover/file:text-bearing-muted hover:!text-bearing-text transition-colors"
    >
      {copied ? "copied" : label}
    </button>
  );
}

const FILE_STATUS_COLOR: Record<string, string> = {
  added: "text-bearing-cyan",
  removed: "text-bearing-red",
  modified: "text-bearing-yellow",
  renamed: "text-bearing-purple",
  copied: "text-bearing-purple",
};

function FileSection({
  file,
  collapsed,
  reviewed,
  threads,
  highlighter,
  viewMode,
  onToggleCollapse,
  onToggleReviewed,
}: {
  file: PullRequestFile;
  collapsed: boolean;
  reviewed: boolean;
  threads: CommentThread[];
  highlighter: Highlighter | null;
  viewMode: "unified" | "split";
  onToggleCollapse: () => void;
  onToggleReviewed: () => void;
}) {
  const hunks = file.patch ? parsePatch(file.patch) : [];
  const lang = langFromFilename(file.filename) ?? undefined;
  const renamedPrefix =
    file.status === "renamed" && file.previousFilename
      ? `${file.previousFilename} → `
      : "";

  return (
    <div>
      <div
        className={`group/file flex items-center gap-2 px-4 py-2 cursor-pointer sticky top-9 z-10 bg-bearing-surface border border-bearing-border rounded-t-lg ${collapsed ? "rounded-b-lg" : "border-b-0"} ${reviewed ? "opacity-60" : ""}`}
        onClick={onToggleCollapse}
      >
        <span className="text-xs text-bearing-muted shrink-0">
          {collapsed ? "▸" : "▾"}
        </span>
        <span
          className={`text-[10px] font-mono shrink-0 ${FILE_STATUS_COLOR[file.status] ?? "text-bearing-muted"}`}
        >
          {file.status}
        </span>
        <span className="text-sm font-mono text-bearing-text truncate">
          {renamedPrefix}
          {file.filename}
        </span>
        <CopyButton text={file.filename.includes("/") ? file.filename.slice(file.filename.lastIndexOf("/") + 1) : file.filename} label="name" />
        <CopyButton text={file.filename} label="path" />
        <span className="flex-1" />
        <span className="text-xs font-mono text-bearing-muted shrink-0">
          <span className="text-bearing-cyan">+{file.additions}</span>{" "}
          <span className="text-bearing-red">-{file.deletions}</span>
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleReviewed();
          }}
          className={`text-[10px] font-mono px-2 py-0.5 rounded border shrink-0 ${
            reviewed
              ? "border-bearing-cyan/30 text-bearing-cyan"
              : "border-bearing-border text-bearing-muted hover:text-bearing-text hover:border-bearing-muted"
          }`}
        >
          {reviewed ? "reviewed" : "review"}
        </button>
      </div>

      {!collapsed && (
        <div className="overflow-x-auto border border-t-0 border-bearing-border rounded-b-lg bg-bearing-surface">
          {hunks.length === 0 && !file.patch ? (
            <div className="px-4 py-3 text-xs font-mono text-bearing-muted">
              Binary file or no diff available
            </div>
          ) : (
            hunks.map((hunk, i) =>
              viewMode === "split" ? (
                <SplitHunkView
                  key={i}
                  hunk={hunk}
                  lang={lang}
                  path={file.filename}
                  threads={threads}
                  highlighter={highlighter}
                />
              ) : (
                <HunkView
                  key={i}
                  hunk={hunk}
                  lang={lang}
                  path={file.filename}
                  threads={threads}
                  highlighter={highlighter}
                />
              ),
            )
          )}
        </div>
      )}
    </div>
  );
}

function HunkView({
  hunk,
  lang,
  path,
  threads,
  highlighter,
}: {
  hunk: DiffHunk;
  lang: BundledLanguage | undefined;
  path: string;
  threads: CommentThread[];
  highlighter: Highlighter | null;
}) {
  return (
    <div>
      <div className="px-4 py-1 bg-bearing-overlay/50 text-xs font-mono text-bearing-purple border-y border-bearing-border/30">
        @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
        {hunk.header && (
          <span className="text-bearing-muted ml-2">{hunk.header}</span>
        )}
      </div>

      <table className="w-full border-collapse font-mono text-[13px] leading-[20px]">
        <tbody>
          {hunk.lines.map((line, i) => {
            const lineThreads = threads.filter((t) => {
              if (t.root.line === null) return false;
              if (t.root.side === "LEFT")
                return line.oldLine === t.root.line;
              return line.newLine === t.root.line;
            });

            return (
              <Fragment key={i}>
                <DiffLineRow
                  line={line}
                  lang={lang}
                  highlighter={highlighter}
                />
                {lineThreads.map((thread) => (
                  <tr key={thread.root.id}>
                    <td colSpan={4} className="p-0">
                      <ThreadView thread={thread} />
                    </td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const LINE_BG: Record<string, string> = {
  addition: "bg-[#9ccfd8]/[0.06]",
  deletion: "bg-[#eb6f92]/[0.06]",
  context: "",
};

const GUTTER_BG: Record<string, string> = {
  addition: "bg-[#9ccfd8]/[0.10]",
  deletion: "bg-[#eb6f92]/[0.10]",
  context: "",
};

const PREFIX_CHAR: Record<string, string> = {
  addition: "+",
  deletion: "-",
  context: " ",
};

const PREFIX_COLOR: Record<string, string> = {
  addition: "text-bearing-cyan",
  deletion: "text-bearing-red",
  context: "text-bearing-muted/40",
};

function DiffLineRow({
  line,
  lang,
  highlighter,
}: {
  line: DiffLine;
  lang: BundledLanguage | undefined;
  highlighter: Highlighter | null;
}) {
  let tokens: ThemedToken[] | null = null;
  if (highlighter && line.content) {
    try {
      const result = highlighter.codeToTokens(line.content, {
        lang,
        theme: "rose-pine",
      });
      tokens = result.tokens[0] ?? null;
    } catch {
      // unsupported lang, fall back to plain text
    }
  }

  return (
    <tr className={LINE_BG[line.type]}>
      <td
        className={`w-[1px] whitespace-nowrap text-right px-2 py-0 text-xs text-bearing-muted/40 select-none ${GUTTER_BG[line.type]}`}
      >
        {line.oldLine ?? ""}
      </td>
      <td
        className={`w-[1px] whitespace-nowrap text-right px-2 py-0 text-xs text-bearing-muted/40 select-none border-r border-bearing-border/20 ${GUTTER_BG[line.type]}`}
      >
        {line.newLine ?? ""}
      </td>
      <td
        className={`w-[1px] px-1 py-0 select-none ${PREFIX_COLOR[line.type]}`}
      >
        {PREFIX_CHAR[line.type]}
      </td>
      <td className="py-0 pr-4">
        <pre className="whitespace-pre">
          {tokens ? (
            tokens.map((token, i) => (
              <span key={i} style={{ color: token.color }}>
                {token.content}
              </span>
            ))
          ) : (
            <span className="text-bearing-text">{line.content || "\u00a0"}</span>
          )}
        </pre>
      </td>
    </tr>
  );
}

// --- Split (side-by-side) view ---

interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.type === "context") {
      rows.push({ left: line, right: line });
      i++;
    } else if (line.type === "deletion") {
      const dels: DiffLine[] = [];
      while (i < lines.length && lines[i].type === "deletion") {
        dels.push(lines[i]);
        i++;
      }
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i].type === "addition") {
        adds.push(lines[i]);
        i++;
      }
      const max = Math.max(dels.length, adds.length);
      for (let j = 0; j < max; j++) {
        rows.push({
          left: dels[j] ?? null,
          right: adds[j] ?? null,
        });
      }
    } else {
      rows.push({ left: null, right: line });
      i++;
    }
  }

  return rows;
}

function SplitHunkView({
  hunk,
  lang,
  path,
  threads,
  highlighter,
}: {
  hunk: DiffHunk;
  lang: BundledLanguage | undefined;
  path: string;
  threads: CommentThread[];
  highlighter: Highlighter | null;
}) {
  const splitRows = toSplitRows(hunk.lines);

  return (
    <div>
      <div className="px-4 py-1 bg-bearing-overlay/50 text-xs font-mono text-bearing-purple border-y border-bearing-border/30">
        @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
        {hunk.header && (
          <span className="text-bearing-muted ml-2">{hunk.header}</span>
        )}
      </div>

      <table className="w-full border-collapse font-mono text-[13px] leading-[20px] table-fixed">
        <tbody>
          {splitRows.map((row, i) => {
            const leftThreads = row.left
              ? threads.filter((t) => {
                  if (t.root.line === null) return false;
                  if (t.root.side === "LEFT")
                    return row.left!.oldLine === t.root.line;
                  return false;
                })
              : [];
            const rightThreads = row.right
              ? threads.filter((t) => {
                  if (t.root.line === null) return false;
                  if (t.root.side !== "LEFT")
                    return row.right!.newLine === t.root.line;
                  return false;
                })
              : [];
            const hasThreads =
              leftThreads.length > 0 || rightThreads.length > 0;

            return (
              <Fragment key={i}>
                <SplitDiffRow
                  left={row.left}
                  right={row.right}
                  lang={lang}
                  highlighter={highlighter}
                />
                {hasThreads && (
                  <tr>
                    <td colSpan={3} className="p-0 align-top border-r border-bearing-border/30">
                      {leftThreads.map((thread) => (
                        <ThreadView key={thread.root.id} thread={thread} />
                      ))}
                    </td>
                    <td colSpan={3} className="p-0 align-top">
                      {rightThreads.map((thread) => (
                        <ThreadView key={thread.root.id} thread={thread} />
                      ))}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SplitDiffRow({
  left,
  right,
  lang,
  highlighter,
}: {
  left: DiffLine | null;
  right: DiffLine | null;
  lang: BundledLanguage | undefined;
  highlighter: Highlighter | null;
}) {
  return (
    <tr>
      <SplitHalf line={left} side="left" lang={lang} highlighter={highlighter} />
      <SplitHalf
        line={right}
        side="right"
        lang={lang}
        highlighter={highlighter}
      />
    </tr>
  );
}

function SplitHalf({
  line,
  side,
  lang,
  highlighter,
}: {
  line: DiffLine | null;
  side: "left" | "right";
  lang: BundledLanguage | undefined;
  highlighter: Highlighter | null;
}) {
  if (!line) {
    return (
      <>
        <td className="w-[1px] px-2 py-0 bg-bearing-overlay/30 select-none" />
        <td className="w-[1px] px-1 py-0 bg-bearing-overlay/30 select-none" />
        <td
          className={`w-1/2 py-0 bg-bearing-overlay/30 ${side === "left" ? "border-r border-bearing-border/30" : ""}`}
        />
      </>
    );
  }

  const type = line.type === "context" ? "context" : line.type;
  const lineNum = side === "left" ? line.oldLine : line.newLine;
  const bg = LINE_BG[type];
  const gutterBg = GUTTER_BG[type];

  let tokens: ThemedToken[] | null = null;
  if (highlighter && line.content) {
    try {
      const result = highlighter.codeToTokens(line.content, {
        lang,
        theme: "rose-pine",
      });
      tokens = result.tokens[0] ?? null;
    } catch {
      // fall back
    }
  }

  const prefix =
    type === "deletion" ? "-" : type === "addition" ? "+" : " ";
  const prefixColor = PREFIX_COLOR[type];

  return (
    <>
      <td
        className={`w-[1px] whitespace-nowrap text-right px-2 py-0 text-xs text-bearing-muted/40 select-none ${gutterBg}`}
      >
        {lineNum ?? ""}
      </td>
      <td className={`w-[1px] px-1 py-0 select-none ${prefixColor} ${bg}`}>
        {prefix}
      </td>
      <td
        className={`w-1/2 py-0 pr-2 ${bg} ${side === "left" ? "border-r border-bearing-border/30" : ""}`}
      >
        <pre className="whitespace-pre overflow-hidden text-ellipsis">
          {tokens ? (
            tokens.map((token, i) => (
              <span key={i} style={{ color: token.color }}>
                {token.content}
              </span>
            ))
          ) : (
            <span className="text-bearing-text">
              {line.content || "\u00a0"}
            </span>
          )}
        </pre>
      </td>
    </>
  );
}

function ThreadView({ thread }: { thread: CommentThread }) {
  const all = [thread.root, ...thread.replies];

  return (
    <div className="mx-4 my-2 border border-bearing-border rounded-lg overflow-hidden bg-bearing-surface">
      {all.map((comment, i) => (
        <div
          key={comment.id}
          className={`px-3 py-2 ${i > 0 ? "border-t border-bearing-border/50" : ""}`}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono font-medium text-bearing-accent">
              @{comment.author.login}
            </span>
            <span className="text-[10px] font-mono text-bearing-muted">
              {timeAgo(comment.createdAt)}
            </span>
          </div>
          <div className="prose-bearing">
            <Markdown>{comment.body}</Markdown>
          </div>
        </div>
      ))}
    </div>
  );
}
