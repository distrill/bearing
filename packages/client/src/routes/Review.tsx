import React, { useState, useEffect, useCallback, useRef, useMemo, Fragment, memo } from "react";
import { useParams } from "wouter";
import type {
  PRDetailResponse,
  PullRequestFile,
  PullRequestReview,
  ReviewComment,
  IssueComment,
  CheckRun,
} from "@bearing/shared";
import { fetchPRDetail, submitReview, fetchViewer, mergePR, closePR } from "../lib/api";
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
import remarkGfm from "remark-gfm";

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
    <MarkdownBase remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={markdownComponents}>
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

// --- Hidden participants persistence ---

function hiddenKey(owner: string, repo: string, number: string) {
  return `bearing:hidden:${owner}/${repo}#${number}`;
}

function loadHidden(owner: string, repo: string, number: string): Set<string> {
  try {
    const raw = localStorage.getItem(hiddenKey(owner, repo, number));
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveHidden(owner: string, repo: string, number: string, hidden: Set<string>) {
  localStorage.setItem(hiddenKey(owner, repo, number), JSON.stringify([...hidden]));
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

// --- Highlight cache + lazy highlighting ---

const highlightCache = new Map<string, ThemedToken[]>();

function getCachedTokens(
  highlighter: Highlighter,
  content: string,
  lang: BundledLanguage | undefined,
): ThemedToken[] | null {
  const key = `${lang ?? ""}:${content}`;
  const cached = highlightCache.get(key);
  if (cached) return cached;
  try {
    const result = highlighter.codeToTokens(content, { lang, theme: "rose-pine" });
    const tokens = result.tokens[0] ?? null;
    if (tokens) highlightCache.set(key, tokens);
    return tokens;
  } catch {
    return null;
  }
}

function useLazyVisible(ref: React.RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return visible;
}

// --- Pending inline comments ---

interface PendingComment {
  id: number;
  path: string;
  line: number;
  startLine?: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

let pendingIdCounter = 0;

function isTestFile(filename: string): boolean {
  const name = filename.includes("/") ? filename.slice(filename.lastIndexOf("/") + 1) : filename;
  const dir = filename.toLowerCase();
  return /\.(test|spec|e2e)\.[^.]+$/.test(name)
    || /__(tests|mocks|snapshots)__/.test(dir)
    || dir.includes("/test/") || dir.includes("/tests/")
    || dir.startsWith("test/") || dir.startsWith("tests/");
}

// --- Main component ---

export function Review() {
  const { owner, repo, number } = useParams<{
    owner: string;
    repo: string;
    number: string;
  }>();

  const [data, setData] = useState<PRDetailResponse | null>(null);
  const [viewerLogin, setViewerLogin] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [reviewed, setReviewed] = useState<ReviewedState>(() =>
    loadReviewed(owner!, repo!, number!),
  );
  const [stickyBodyExpanded, setStickyBodyExpanded] = useState(false);
  const [descCollapsed, setDescCollapsed] = useState(false);
  const [commitsCollapsed, setCommitsCollapsed] = useState(false);
  const [viewMode, setViewMode] = useState<"unified" | "split">(
    () => (localStorage.getItem("bearing:viewMode") as "unified" | "split") ?? "unified",
  );
  const setAndPersistViewMode = useCallback((mode: "unified" | "split") => {
    setViewMode(mode);
    localStorage.setItem("bearing:viewMode", mode);
  }, []);
  const [headerPinned, setHeaderPinned] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem("bearing:sidebarOpen") !== "false",
  );
  const [fileSidebarOpen, setFileSidebarOpen] = useState(
    () => localStorage.getItem("bearing:fileSidebarOpen") !== "false",
  );
  const [hideTests, setHideTests] = useState(
    () => localStorage.getItem("bearing:hideTests") === "true",
  );
  const [hiddenParticipants, setHiddenParticipants] = useState<Set<string>>(() =>
    loadHidden(owner!, repo!, number!),
  );
  const [pendingComments, setPendingComments] = useState<PendingComment[]>([]);
  const [activeCommentLine, setActiveCommentLine] = useState<{ path: string; line: number; startLine?: number; side: "LEFT" | "RIGHT" } | null>(null);
  const hoveredThreadRef = useRef<number | null>(null);
  const hoveredFileRef = useRef<string | null>(null);
  const headerSentinelRef = useRef<HTMLDivElement>(null);
  const descSentinelRef = useRef<HTMLDivElement>(null);
  const [descriptionScrolled, setDescriptionScrolled] = useState(false);
  const mainScrollRef = useRef<HTMLDivElement>(null);
  const highlighter = useHighlighter();

  const hoverThread = useCallback((id: number | null) => {
    if (hoveredThreadRef.current != null) {
      document.querySelectorAll(`[data-thread-id="${hoveredThreadRef.current}"]`)
        .forEach((el) => el.classList.remove("bearing-highlighted"));
    }
    hoveredThreadRef.current = id;
    if (id != null) {
      document.querySelectorAll(`[data-thread-id="${id}"]`)
        .forEach((el) => el.classList.add("bearing-highlighted"));
    }
  }, []);

  const hoverFile = useCallback((filename: string | null) => {
    if (hoveredFileRef.current != null) {
      document.querySelectorAll(`[data-file="${CSS.escape(hoveredFileRef.current)}"]`)
        .forEach((el) => el.classList.remove("bearing-highlighted"));
    }
    hoveredFileRef.current = filename;
    if (filename != null) {
      document.querySelectorAll(`[data-file="${CSS.escape(filename)}"]`)
        .forEach((el) => el.classList.add("bearing-highlighted"));
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((v) => {
      localStorage.setItem("bearing:sidebarOpen", String(!v));
      return !v;
    });
  }, []);

  const expandFile = useCallback((filename: string) => {
    setCollapsed((prev) => {
      if (!prev.has(filename)) return prev;
      const next = new Set(prev);
      next.delete(filename);
      return next;
    });
  }, []);

  const addPendingComment = useCallback((path: string, line: number, side: "LEFT" | "RIGHT", body: string, startLine?: number) => {
    setPendingComments((prev) => [...prev, { id: ++pendingIdCounter, path, line, side, body, startLine }]);
    setActiveCommentLine(null);
  }, []);

  const removePendingComment = useCallback((id: number) => {
    setPendingComments((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const scrollToThread = useCallback(
    (threadId: number, filename: string) => {
      expandFile(filename);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = document.getElementById(`thread-${threadId}`);
          el?.scrollIntoView({ behavior: "smooth", block: "center" });
        });
      });
    },
    [expandFile],
  );

  useEffect(() => {
    const root = mainScrollRef.current;
    if (!root) return;

    const observers: IntersectionObserver[] = [];

    const titleEl = headerSentinelRef.current;
    if (titleEl) {
      const titleObserver = new IntersectionObserver(
        ([entry]) => {
          const pinned = !entry.isIntersecting && entry.boundingClientRect.top < entry.rootBounds!.top;
          setHeaderPinned(pinned);
          if (!pinned) setStickyBodyExpanded(false);
        },
        { threshold: 0, root },
      );
      titleObserver.observe(titleEl);
      observers.push(titleObserver);
    }

    const descEl = descSentinelRef.current;
    if (descEl) {
      const descObserver = new IntersectionObserver(
        ([entry]) => {
          const scrolled = !entry.isIntersecting && entry.boundingClientRect.top < entry.rootBounds!.top;
          setDescriptionScrolled(scrolled);
          if (!scrolled) setStickyBodyExpanded(false);
        },
        { threshold: 0, root },
      );
      descObserver.observe(descEl);
      observers.push(descObserver);
    }

    return () => observers.forEach((o) => o.disconnect());
  }, [data]);

  useEffect(() => {
    fetchViewer().then((v) => setViewerLogin(v.login)).catch(() => {});
  }, []);

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
          setCollapsed((c) => {
            const s = new Set(c);
            s.add(filename);
            return s;
          });
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

  const visibleFiles = hideTests ? data.files.filter((f) => !isTestFile(f.filename)) : data.files;
  const testFileCount = data.files.length - data.files.filter((f) => !isTestFile(f.filename)).length;

  const reviewedCount = data.files.filter(
    (f) => reviewed[f.filename] === f.sha,
  ).length;

  return (
    <div className="h-full flex">
      {/* File list sidebar */}
      {fileSidebarOpen && (
      <div className="w-[26rem] shrink-0 border-r border-bearing-border overflow-y-auto bg-bearing-bg">
        <div className="px-3 py-2 border-b border-bearing-border/50 flex items-center gap-2">
          <span className="text-xs font-mono text-bearing-muted">
            {reviewedCount}/{data.files.length} files reviewed
          </span>
          <span className="flex-1" />
          {testFileCount > 0 && (
            <button
              onClick={() => {
                setHideTests((v) => {
                  localStorage.setItem("bearing:hideTests", String(!v));
                  return !v;
                });
              }}
              className={`text-[10px] font-mono shrink-0 ${hideTests ? "text-bearing-accent" : "text-bearing-muted"} hover:text-bearing-text`}
            >
              {hideTests ? `[show tests (${testFileCount})]` : "[hide tests]"}
            </button>
          )}
        </div>
        <div className="py-1">
          {(() => {
            const nameCount = new Map<string, number>();
            for (const f of visibleFiles) {
              const name = f.filename.includes("/")
                ? f.filename.slice(f.filename.lastIndexOf("/") + 1)
                : f.filename;
              nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
            }

            return visibleFiles.map((file) => {
              const isReviewed = reviewed[file.filename] === file.sha;
              const shortName = file.filename.includes("/")
                ? file.filename.slice(file.filename.lastIndexOf("/") + 1)
                : file.filename;
              const dir = file.filename.includes("/")
                ? file.filename.slice(0, file.filename.lastIndexOf("/"))
                : "";
              const isDuplicate = (nameCount.get(shortName) ?? 0) > 1;

              return (
                <button
                  key={file.filename}
                  onClick={() => {
                    expandFile(file.filename);
                    requestAnimationFrame(() => {
                      const el = document.getElementById(`file-${file.filename}`);
                      el?.scrollIntoView({ behavior: "smooth", block: "start" });
                    });
                  }}
                  className={`group/fitem w-full text-left px-3 py-1.5 flex items-start gap-2 hover:bg-bearing-surface/50 ${isReviewed ? "opacity-50" : ""}`}
                  onMouseEnter={() => hoverFile(file.filename)}
                  onMouseLeave={() => hoverFile(null)}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1 ${
                      isReviewed ? "bg-bearing-cyan" : "bg-bearing-border"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="text-xs font-mono text-bearing-text truncate block">
                      {shortName}
                    </span>
                    {dir && (
                      <span className="text-[10px] font-mono text-bearing-muted/50 group-hover/fitem:text-bearing-muted truncate block transition-colors">
                        {dir}
                      </span>
                    )}
                  </span>
                  <span
                    className={`text-[10px] font-mono shrink-0 mt-0.5 ${FILE_STATUS_COLOR[file.status] ?? "text-bearing-muted"}`}
                  >
                    {file.status[0]}
                  </span>
                </button>
              );
            });
          })()}
        </div>
      </div>
      )}

      {/* Main content */}
      <div ref={mainScrollRef} className="flex-1 overflow-y-auto min-w-0 relative">
        {/* Sticky bar — appears when header scrolls out */}
        {headerPinned && (
          <div className="sticky top-0 z-20">
            <div className="bg-bearing-surface border-x border-b border-bearing-border rounded-b-lg border-l-4" style={{ borderLeftColor: getPRStatusColor(data.state, data.draft, data.reviews) }}>
              <div className="flex items-center gap-2 px-6 h-10">
                <span className="text-xs font-mono text-bearing-text truncate">
                  {data.title}
                </span>
                <PRStatusBadge state={data.state} draft={data.draft} reviews={data.reviews} />
                <span className="flex-1" />
                <span className="text-xs font-mono text-bearing-muted shrink-0">
                  {reviewedCount}/{data.files.length}
                </span>
                {descriptionScrolled && data.body && (
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
        <div ref={headerSentinelRef} className="border border-bearing-border rounded-lg bg-bearing-surface px-5 py-4 border-l-4" style={{ borderLeftColor: getPRStatusColor(data.state, data.draft, data.reviews) }}>
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
          <div className="flex items-center gap-2 mt-1.5">
            <h1 className="text-lg text-bearing-text">{data.title}</h1>
            <PRStatusBadge state={data.state} draft={data.draft} reviews={data.reviews} />
          </div>
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

        {data.truncated.length > 0 && (
          <div className="px-4 py-2 rounded-lg border border-bearing-yellow/30 bg-bearing-yellow/5 text-[10px] font-mono text-bearing-yellow">
            truncated: {data.truncated.join(", ")} (100 item limit)
          </div>
        )}

        {/* PR Body */}
        {data.body && (
          <div className="border border-bearing-border rounded-lg bg-bearing-surface overflow-hidden">
            <div
              className="px-5 py-2 cursor-pointer flex items-center gap-2"
              onClick={() => setDescCollapsed((v) => !v)}
            >
              <span className="text-xs text-bearing-muted shrink-0">{descCollapsed ? "▸" : "▾"}</span>
              <span className="text-xs font-mono text-bearing-muted">description</span>
            </div>
            {!descCollapsed && (
              <div className="px-5 pb-4 prose-bearing border-t border-bearing-border/50">
                <Markdown>{data.body}</Markdown>
              </div>
            )}
          </div>
        )}

        {/* Commits */}
        {data.commits.length > 0 && (
          <div ref={descSentinelRef} className="border border-bearing-border rounded-lg bg-bearing-surface overflow-hidden">
            <div
              className="px-5 py-2 cursor-pointer flex items-center gap-2"
              onClick={() => setCommitsCollapsed((v) => !v)}
            >
              <span className="text-xs text-bearing-muted shrink-0">{commitsCollapsed ? "▸" : "▾"}</span>
              <span className="text-xs font-mono text-bearing-muted">
                {data.commits.length} commit{data.commits.length !== 1 ? "s" : ""}
              </span>
            </div>
            {!commitsCollapsed && data.commits.map((commit, i) => (
              <div
                key={commit.sha}
                className={`flex items-baseline gap-3 px-5 py-2.5 border-t border-bearing-border/50`}
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
            onClick={() => {
              setFileSidebarOpen((v) => {
                localStorage.setItem("bearing:fileSidebarOpen", String(!v));
                return !v;
              });
            }}
            className={`text-[10px] font-mono ${fileSidebarOpen ? "text-bearing-accent" : "text-bearing-muted"} hover:text-bearing-text`}
          >
            [files]
          </button>
          <button
            onClick={expandAll}
            className="text-[10px] font-mono text-bearing-muted hover:text-bearing-text"
          >
            [expand all]
          </button>
          <button
            onClick={collapseAll}
            className="text-[10px] font-mono text-bearing-muted hover:text-bearing-text"
          >
            [collapse all]
          </button>
          <span className="flex-1" />
          <button
            onClick={() =>
              setAndPersistViewMode(viewMode === "unified" ? "split" : "unified")
            }
            className="text-[10px] font-mono text-bearing-muted hover:text-bearing-text"
          >
            [{viewMode === "unified" ? "split" : "unified"}]
          </button>
          <button
            onClick={toggleSidebar}
            className={`text-[10px] font-mono ${sidebarOpen ? "text-bearing-accent" : "text-bearing-muted"} hover:text-bearing-text`}
          >
            [comments]
          </button>
        </div>

        {/* Files */}
        <div className="border border-bearing-border/40 rounded-lg p-3 space-y-2">
        {visibleFiles.map((file) => (
          <FileSection
            key={file.filename}
            file={file}
            collapsed={collapsed.has(file.filename)}
            reviewed={reviewed[file.filename] === file.sha}
            threads={threads.filter((t) => t.root.path === file.filename && !hiddenParticipants.has(t.root.author.login))}
            highlighter={highlighter}
            viewMode={viewMode}
            pendingComments={pendingComments.filter((c) => c.path === file.filename)}
            activeCommentLine={activeCommentLine?.path === file.filename ? activeCommentLine : null}
            onLineClick={(line, side, shiftKey) => {
              if (shiftKey && activeCommentLine && activeCommentLine.path === file.filename && activeCommentLine.side === side) {
                const startLine = Math.min(activeCommentLine.line, line);
                const endLine = Math.max(activeCommentLine.line, line);
                setActiveCommentLine({ path: file.filename, line: endLine, startLine, side });
              } else {
                setActiveCommentLine({ path: file.filename, line, side });
              }
            }}
            onAddComment={(line, side, body, startLine) => addPendingComment(file.filename, line, side, body, startLine)}
            onCancelComment={() => setActiveCommentLine(null)}
            onRemovePendingComment={removePendingComment}
            onToggleCollapse={() => toggleCollapse(file.filename)}
            onToggleReviewed={() => toggleReviewed(file.filename, file.sha)}
            onHoverThread={hoverThread}
          />
        ))}
        </div>

        {/* Signals + Merge */}
        {(data.checkRuns.length > 0 || (data.state === "open" && data.allowedMergeMethods.length > 0)) && (
          <SignalsCard
            checkRuns={data.checkRuns}
            mergeable={data.mergeable}
            mergeableState={data.mergeableState}
            showMerge={data.state === "open" && data.allowedMergeMethods.length > 0}
            allowedMergeMethods={data.allowedMergeMethods}
            owner={owner!}
            repo={repo!}
            number={parseInt(number!, 10)}
            onMerged={() => {
              fetchPRDetail(owner!, repo!, parseInt(number!, 10)).then(setData);
            }}
          />
        )}

        {/* Activity timeline — shown when sidebar is closed */}
        {!sidebarOpen &&
          (data.reviews.length > 0 || data.issueComments.length > 0) && (
            <ActivityTimeline
              reviews={data.reviews}
              issueComments={data.issueComments}
            />
          )}
        </div>
      </div>

      {/* Comment sidebar */}
      {sidebarOpen && (
        <div className="w-[26rem] shrink-0 border-l border-bearing-border bg-bearing-bg flex flex-col">
          <CommentSidebar
            reviews={data.reviews}
            threads={threads}
            issueComments={data.issueComments}
            files={data.files}
            onHoverComment={hoverThread}
            onClickThread={scrollToThread}
            owner={owner!}
            repo={repo!}
            number={parseInt(number!, 10)}
            isAuthor={viewerLogin != null && viewerLogin === data.author.login}
            pendingComments={pendingComments}
            hiddenParticipants={hiddenParticipants}
            onToggleParticipant={(login) => {
              setHiddenParticipants((prev) => {
                const next = new Set(prev);
                if (next.has(login)) next.delete(login);
                else next.add(login);
                saveHidden(owner!, repo!, number!, next);
                return next;
              });
            }}
            onToggleBots={(botLogins, allHidden) => {
              setHiddenParticipants((prev) => {
                const next = new Set(prev);
                if (allHidden) {
                  for (const l of botLogins) next.delete(l);
                } else {
                  for (const l of botLogins) next.add(l);
                }
                saveHidden(owner!, repo!, number!, next);
                return next;
              });
            }}
            onReviewSubmitted={() => {
              setPendingComments([]);
              setActiveCommentLine(null);
              fetchPRDetail(owner!, repo!, parseInt(number!, 10)).then(setData);
            }}
          />
        </div>
      )}
    </div>
  );
}

// --- Sub-components ---

// --- Comment Sidebar ---

type SidebarEntry =
  | {
      kind: "review-group";
      review: PullRequestReview;
      inlineThreads: CommentThread[];
      time: number;
    }
  | { kind: "issue-comment"; comment: IssueComment; time: number }
  | { kind: "orphan-thread"; thread: CommentThread; time: number };

function buildSidebarEntries(
  reviews: PullRequestReview[],
  threads: CommentThread[],
  issueComments: IssueComment[],
  files: PullRequestFile[],
): SidebarEntry[] {
  const fileOrder = new Map(files.map((f, i) => [f.filename, i]));

  const threadsByReview = new Map<number, CommentThread[]>();
  const orphanThreads: CommentThread[] = [];

  for (const t of threads) {
    const rid = t.root.reviewId;
    if (rid != null) {
      const list = threadsByReview.get(rid) ?? [];
      list.push(t);
      threadsByReview.set(rid, list);
    } else {
      orphanThreads.push(t);
    }
  }

  for (const list of threadsByReview.values()) {
    list.sort((a, b) => {
      const fa = fileOrder.get(a.root.path) ?? 999;
      const fb = fileOrder.get(b.root.path) ?? 999;
      if (fa !== fb) return fa - fb;
      return (a.root.line ?? 0) - (b.root.line ?? 0);
    });
  }

  const hasContent = (r: PullRequestReview) =>
    r.body.trim() || (r.state !== "COMMENTED" && r.state !== "PENDING");

  const entries: SidebarEntry[] = [
    ...reviews
      .filter((r) => r.state !== "PENDING" && (hasContent(r) || threadsByReview.has(r.id)))
      .map((r) => ({
        kind: "review-group" as const,
        review: r,
        inlineThreads: threadsByReview.get(r.id) ?? [],
        time: new Date(r.submittedAt).getTime(),
      })),
    ...issueComments
      .filter((c) => c.body.trim())
      .map((c) => ({
        kind: "issue-comment" as const,
        comment: c,
        time: new Date(c.createdAt).getTime(),
      })),
    ...orphanThreads.map((t) => ({
      kind: "orphan-thread" as const,
      thread: t,
      time: new Date(t.root.createdAt).getTime(),
    })),
  ];

  entries.sort((a, b) => a.time - b.time);
  return entries;
}

const SIDEBAR_STATE_COLOR: Record<string, string> = {
  APPROVED: "text-bearing-cyan",
  CHANGES_REQUESTED: "text-bearing-yellow",
  DISMISSED: "text-bearing-muted",
  COMMENTED: "text-bearing-subtle",
};

const SIDEBAR_STATE_LABEL: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  DISMISSED: "dismissed",
  COMMENTED: "commented",
};

type TimelineSidebarEntry =
  | { kind: "issue-comment"; comment: IssueComment; time: number }
  | { kind: "review"; review: PullRequestReview; inlineThreads: CommentThread[]; time: number }
  | { kind: "orphan-thread"; thread: CommentThread; time: number };

function CommentSidebar({
  issueComments,
  reviews,
  threads,
  files,
  onHoverComment,
  onClickThread,
  owner,
  repo,
  number,
  isAuthor,
  pendingComments,
  hiddenParticipants,
  onToggleParticipant,
  onToggleBots,
  onReviewSubmitted,
}: {
  reviews: PullRequestReview[];
  threads: CommentThread[];
  issueComments: IssueComment[];
  files: PullRequestFile[];
  onHoverComment: (id: number | null) => void;
  onClickThread: (threadId: number, filename: string) => void;
  owner: string;
  repo: string;
  number: number;
  isAuthor: boolean;
  pendingComments: PendingComment[];
  hiddenParticipants: Set<string>;
  onToggleParticipant: (login: string) => void;
  onToggleBots: (botLogins: string[], allHidden: boolean) => void;
  onReviewSubmitted: () => void;
}) {
  const fileOrder = new Map(files.map((f, i) => [f.filename, i]));

  const threadsByReview = new Map<number, CommentThread[]>();
  const orphanThreads: CommentThread[] = [];
  for (const t of threads) {
    const rid = t.root.reviewId;
    if (rid != null) {
      const list = threadsByReview.get(rid) ?? [];
      list.push(t);
      threadsByReview.set(rid, list);
    } else {
      orphanThreads.push(t);
    }
  }
  for (const list of threadsByReview.values()) {
    list.sort((a, b) => {
      const fa = fileOrder.get(a.root.path) ?? 999;
      const fb = fileOrder.get(b.root.path) ?? 999;
      if (fa !== fb) return fa - fb;
      return (a.root.line ?? 0) - (b.root.line ?? 0);
    });
  }

  const allEntries: TimelineSidebarEntry[] = [
    ...issueComments
      .filter((c) => c.body.trim())
      .map((c) => ({
        kind: "issue-comment" as const,
        comment: c,
        time: new Date(c.createdAt).getTime(),
      })),
    ...reviews
      .filter((r) => r.state !== "PENDING" && (r.body.trim() || r.state !== "COMMENTED" || threadsByReview.has(r.id)))
      .map((r) => ({
        kind: "review" as const,
        review: r,
        inlineThreads: threadsByReview.get(r.id) ?? [],
        time: new Date(r.submittedAt).getTime(),
      })),
    ...orphanThreads.map((t) => ({
      kind: "orphan-thread" as const,
      thread: t,
      time: new Date(t.root.createdAt).getTime(),
    })),
  ].sort((a, b) => a.time - b.time);

  const participants = new Map<string, number>();
  for (const entry of allEntries) {
    const login =
      entry.kind === "issue-comment" ? entry.comment.author.login
      : entry.kind === "review" ? entry.review.author.login
      : entry.thread.root.author.login;
    participants.set(login, (participants.get(login) ?? 0) + 1);
  }

  const entries = allEntries.filter((entry) => {
    const login =
      entry.kind === "issue-comment" ? entry.comment.author.login
      : entry.kind === "review" ? entry.review.author.login
      : entry.thread.root.author.login;
    return !hiddenParticipants.has(login);
  });

  return (
    <div className="flex flex-col h-full">
      {allEntries.length > 0 && (
      <div className="px-3 py-2 border-b border-bearing-border/50 flex flex-wrap gap-1.5">
        {(() => {
          const botLogins = [...participants.keys()].filter((l) => l.endsWith("[bot]") || l.endsWith("-bot"));
          if (botLogins.length === 0) return null;
          const allHidden = botLogins.every((l) => hiddenParticipants.has(l));
          return (
            <button
              onClick={() => onToggleBots(botLogins, allHidden)}
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
                allHidden
                  ? "border-bearing-border/30 text-bearing-muted/40 line-through"
                  : "border-bearing-border text-bearing-accent hover:border-bearing-muted"
              }`}
            >
              bots
            </button>
          );
        })()}
        {[...participants.entries()].map(([login, count]) => (
          <button
            key={login}
            onClick={() => onToggleParticipant(login)}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border transition-colors ${
              hiddenParticipants.has(login)
                ? "border-bearing-border/30 text-bearing-muted/40 line-through"
                : "border-bearing-border text-bearing-accent hover:border-bearing-muted"
            }`}
          >
            @{login} <span className="text-bearing-muted/50">{count}</span>
          </button>
        ))}
      </div>
      )}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
      {allEntries.length === 0 && (
        <div className="text-xs font-mono text-bearing-muted">no comments</div>
      )}
      {entries.map((entry) => {
        if (entry.kind === "issue-comment") {
          return (
            <div
              key={`c${entry.comment.id}`}
              className="px-3 py-3 rounded-lg border border-bearing-border/50 bg-bearing-surface"
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-mono text-bearing-accent">
                  @{entry.comment.author.login}
                </span>
                <span className="text-[10px] font-mono text-bearing-muted/50">
                  {timeAgo(entry.comment.createdAt)}
                </span>
              </div>
              <div className="prose-bearing text-xs">
                <Markdown>{entry.comment.body}</Markdown>
              </div>
            </div>
          );
        }

        if (entry.kind === "orphan-thread") {
          return (
            <SidebarInlineComment
              key={`t${entry.thread.root.id}`}
              thread={entry.thread}
              onHoverComment={onHoverComment}
              onClickThread={onClickThread}
            />
          );
        }

        return (
          <div
            key={`r${entry.review.id}`}
            className="px-3 py-3 rounded-lg border border-bearing-border/50 bg-bearing-surface"
          >
            <div className="flex items-center gap-2 mb-1">
              <span className={`text-xs font-mono ${SIDEBAR_STATE_COLOR[entry.review.state] ?? "text-bearing-muted"}`}>
                @{entry.review.author.login}
              </span>
              <span className={`text-[10px] font-mono ${SIDEBAR_STATE_COLOR[entry.review.state] ?? "text-bearing-muted/50"}`}>
                {SIDEBAR_STATE_LABEL[entry.review.state] ?? entry.review.state.toLowerCase()}
              </span>
              <span className="text-[10px] font-mono text-bearing-muted/50">
                {timeAgo(entry.review.submittedAt)}
              </span>
            </div>
            {entry.review.body.trim() && (
              <div className="prose-bearing text-xs">
                <Markdown>{entry.review.body}</Markdown>
              </div>
            )}
            {entry.inlineThreads.length > 0 && (
              <div className={`space-y-2 ${entry.review.body.trim() ? "mt-3" : "mt-1"}`}>
                {entry.inlineThreads.map((thread) => (
                  <SidebarInlineComment
                    key={thread.root.id}
                    thread={thread}
                    onHoverComment={onHoverComment}
                    onClickThread={onClickThread}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
      </div>
      <ReviewForm owner={owner} repo={repo} number={number} isAuthor={isAuthor} pendingComments={pendingComments} onSubmitted={onReviewSubmitted} />

    </div>
  );
}

function ReviewForm({
  owner,
  repo,
  number,
  isAuthor,
  pendingComments,
  onSubmitted,
}: {
  owner: string;
  repo: string;
  number: number;
  isAuthor: boolean;
  pendingComments: PendingComment[];
  onSubmitted: () => void;
}) {
  const [body, setBody] = useState("");
  const [event, setEvent] = useState<"APPROVE" | "REQUEST_CHANGES" | "COMMENT">("COMMENT");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    const hasComments = pendingComments.length > 0;
    if (event === "COMMENT" && !body.trim() && !hasComments) return;
    setSubmitting(true);
    try {
      const comments = pendingComments.map((c) => ({
        path: c.path,
        line: c.line,
        ...(c.startLine != null ? { start_line: c.startLine } : {}),
        side: c.side,
        body: c.body,
      }));
      await submitReview(owner, repo, number, body, event, comments);
      setBody("");
      onSubmitted();
    } catch (err) {
      console.error("Failed to submit review:", err);
    } finally {
      setSubmitting(false);
    }
  }, [owner, repo, number, body, event, pendingComments, onSubmitted]);

  const canSubmit = pendingComments.length > 0 || event !== "COMMENT" || body.trim();

  return (
    <div className="border-t border-bearing-border p-3 shrink-0">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSubmit && !submitting) {
            e.preventDefault();
            handleSubmit();
          }
        }}
        placeholder="Leave a review…"
        className="w-full bg-bearing-overlay border border-bearing-border rounded-lg px-3 py-2 text-xs font-mono text-bearing-text placeholder:text-bearing-muted/50 resize-none focus:outline-none focus:border-bearing-accent"
        rows={3}
        disabled={submitting}
      />
      <div className="flex items-center gap-2 mt-2">
        <Picker
          value={event}
          options={isAuthor ? ["COMMENT"] : ["COMMENT", "APPROVE", "REQUEST_CHANGES"]}
          labels={{ COMMENT: "comment", APPROVE: "approve", REQUEST_CHANGES: "request changes" }}
          colorMap={{ APPROVE: "text-bearing-cyan", REQUEST_CHANGES: "text-bearing-yellow" }}
          onChange={setEvent}
          popDirection="up"
        />
        {pendingComments.length > 0 && (
          <span className="text-[10px] font-mono text-bearing-yellow">
            {pendingComments.length} inline
          </span>
        )}
        <span className="flex-1" />
        <button
          onClick={handleSubmit}
          disabled={submitting || !canSubmit}
          className="text-[10px] font-mono px-3 py-1 rounded border border-bearing-accent/50 text-bearing-accent hover:border-bearing-accent disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? "submitting…" : "submit"}
        </button>
      </div>
    </div>
  );
}

function SidebarInlineComment({
  thread,
  onHoverComment,
  onClickThread,
}: {
  thread: CommentThread;
  onHoverComment: (id: number | null) => void;
  onClickThread: (threadId: number, filename: string) => void;
}) {
  const { root } = thread;
  const shortName = root.path.includes("/")
    ? root.path.slice(root.path.lastIndexOf("/") + 1)
    : root.path;

  return (
    <div
      data-thread-id={root.id}
      className="rounded border border-bearing-border/30 bg-bearing-overlay/40 px-2.5 py-2 cursor-pointer hover:border-bearing-muted transition-colors"
      onMouseEnter={() => onHoverComment(root.id)}
      onMouseLeave={() => onHoverComment(null)}
      onClick={() => onClickThread(root.id, root.path)}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-[10px] font-mono text-bearing-muted truncate">
          {shortName}
          {root.line != null && `:${root.line}`}
        </span>
      </div>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-mono text-bearing-accent">
          @{root.author.login}
        </span>
        <span className="text-[10px] font-mono text-bearing-muted/50">
          {timeAgo(root.createdAt)}
        </span>
      </div>
      <div className="prose-bearing text-xs">
        <Markdown>{root.body}</Markdown>
      </div>
      {thread.replies.map((reply) => (
        <div key={reply.id} className="mt-2 pt-2 border-t border-bearing-border/30">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono text-bearing-accent">
              @{reply.author.login}
            </span>
            <span className="text-[10px] font-mono text-bearing-muted/50">
              {timeAgo(reply.createdAt)}
            </span>
          </div>
          <div className="prose-bearing text-xs">
            <Markdown>{reply.body}</Markdown>
          </div>
        </div>
      ))}
    </div>
  );
}

function SidebarReviewGroup({
  entry,
  onHoverComment,
  onClickThread,
}: {
  entry: Extract<SidebarEntry, { kind: "review-group" }>;
  onHoverComment: (id: number | null) => void;
  onClickThread: (threadId: number, filename: string) => void;
}) {
  const { review, inlineThreads } = entry;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span
          className={`text-xs font-mono ${SIDEBAR_STATE_COLOR[review.state] ?? "text-bearing-muted"}`}
        >
          @{review.author.login}{" "}
          {SIDEBAR_STATE_LABEL[review.state] ?? review.state.toLowerCase()}
        </span>
        <span className="text-[10px] font-mono text-bearing-muted/50">
          {timeAgo(review.submittedAt)}
        </span>
      </div>

      {inlineThreads.length > 0 && (
        <div className="space-y-1.5 mb-2">
          {inlineThreads.map((thread) => (
            <SidebarThreadCard
              key={thread.root.id}
              thread={thread}
              onHoverComment={onHoverComment}
              onClick={() => onClickThread(thread.root.id, thread.root.path)}
            />
          ))}
        </div>
      )}

      {review.body.trim() && (
        <div className="prose-bearing text-xs">
          <Markdown>{review.body}</Markdown>
        </div>
      )}
    </div>
  );
}

function SidebarThreadCard({
  thread,
  onHoverComment,
  onClick,
}: {
  thread: CommentThread;
  onHoverComment: (id: number | null) => void;
  onClick: () => void;
}) {
  const filename = thread.root.path;
  const shortName = filename.includes("/")
    ? filename.slice(filename.lastIndexOf("/") + 1)
    : filename;

  return (
    <div
      data-thread-id={thread.root.id}
      className="rounded border border-bearing-border/50 hover:border-bearing-muted bg-bearing-overlay/50 px-2.5 py-2 cursor-pointer transition-colors"
      onMouseEnter={() => onHoverComment(thread.root.id)}
      onMouseLeave={() => onHoverComment(null)}
      onClick={onClick}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-[10px] font-mono text-bearing-muted truncate">
          {shortName}
          {thread.root.line != null && `:${thread.root.line}`}
        </span>
        {thread.replies.length > 0 && (
          <span className="text-[10px] font-mono text-bearing-muted/50">
            +{thread.replies.length}
          </span>
        )}
      </div>
      <div className="text-xs font-mono text-bearing-text line-clamp-2">
        {thread.root.body}
      </div>
    </div>
  );
}

function getPRStatusColor(
  state: "open" | "closed" | "merged",
  draft: boolean,
  reviews: PullRequestReview[],
): string {
  if (state === "merged") return "#c4a7e7";
  if (state === "closed") return "#eb6f92";
  if (draft) return "#6e6a86";

  const latestByAuthor = new Map<string, PullRequestReview>();
  for (const r of reviews) {
    if (r.state === "PENDING" || r.state === "COMMENTED" || r.state === "DISMISSED") continue;
    const existing = latestByAuthor.get(r.author.login);
    if (!existing || new Date(r.submittedAt) > new Date(existing.submittedAt)) {
      latestByAuthor.set(r.author.login, r);
    }
  }

  if ([...latestByAuthor.values()].some((r) => r.state === "CHANGES_REQUESTED")) return "#f6c177";
  if ([...latestByAuthor.values()].some((r) => r.state === "APPROVED")) return "#9ccfd8";
  return "#f6c177";
}

function PRStatusBadge({
  state,
  draft,
  reviews,
}: {
  state: "open" | "closed" | "merged";
  draft: boolean;
  reviews: PullRequestReview[];
}) {
  if (state === "merged") {
    return <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-bearing-purple/20 text-bearing-purple border border-bearing-purple/30 shrink-0">merged</span>;
  }
  if (state === "closed") {
    return <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-bearing-red/20 text-bearing-red border border-bearing-red/30 shrink-0">closed</span>;
  }
  if (draft) {
    return <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-bearing-muted/10 text-bearing-muted border border-bearing-border shrink-0">draft</span>;
  }

  const latestByAuthor = new Map<string, PullRequestReview>();
  for (const r of reviews) {
    if (r.state === "PENDING" || r.state === "COMMENTED" || r.state === "DISMISSED") continue;
    const existing = latestByAuthor.get(r.author.login);
    if (!existing || new Date(r.submittedAt) > new Date(existing.submittedAt)) {
      latestByAuthor.set(r.author.login, r);
    }
  }

  const hasChangesRequested = [...latestByAuthor.values()].some((r) => r.state === "CHANGES_REQUESTED");
  const hasApproval = [...latestByAuthor.values()].some((r) => r.state === "APPROVED");

  if (hasChangesRequested) {
    return <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-bearing-yellow/20 text-bearing-yellow border border-bearing-yellow/30 shrink-0">changes requested</span>;
  }
  if (hasApproval) {
    return <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-bearing-cyan/20 text-bearing-cyan border border-bearing-cyan/30 shrink-0">approved</span>;
  }

  return <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-bearing-yellow/10 text-bearing-yellow/70 border border-bearing-yellow/20 shrink-0">review pending</span>;
}

// --- Signals Card ---

function SignalsGroup({
  label,
  runs,
  color,
}: {
  label: string;
  runs: CheckRun[];
  color: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (runs.length === 0) return null;

  return (
    <div className="border-t border-bearing-border/50">
      <div
        className="px-5 py-2 cursor-pointer flex items-center gap-2"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-xs text-bearing-muted shrink-0">{expanded ? "▾" : "▸"}</span>
        <span className={`text-xs font-mono ${color}`}>
          {runs.length} {label}
        </span>
      </div>
      {expanded && runs.map((cr) => (
        <CheckRunRow key={cr.id} run={cr} />
      ))}
    </div>
  );
}

function SignalsCard({
  checkRuns,
  mergeable,
  showMerge,
  allowedMergeMethods,
  owner,
  repo,
  number,
  onMerged,
}: {
  checkRuns: CheckRun[];
  mergeable: boolean | null;
  mergeableState: string;
  showMerge: boolean;
  allowedMergeMethods: ("merge" | "squash" | "rebase")[];
  owner: string;
  repo: string;
  number: number;
  onMerged: () => void;
}) {
  const passed = checkRuns.filter((c) => c.status === "completed" && (c.conclusion === "success" || c.conclusion === "neutral"));
  const failed = checkRuns.filter((c) => c.status === "completed" && (c.conclusion === "failure" || c.conclusion === "timed_out" || c.conclusion === "action_required"));
  const skipped = checkRuns.filter((c) => c.status === "completed" && (c.conclusion === "skipped" || c.conclusion === "cancelled"));
  const pending = checkRuns.filter((c) => c.status !== "completed");

  const hasMergeConflicts = mergeable === false;
  const hasFailures = failed.length > 0;

  const [method, setMethod] = useState<"merge" | "squash" | "rebase" | "close">(() => {
    const saved = localStorage.getItem(`bearing:mergeMethod:${owner}/${repo}`);
    if (saved && allowedMergeMethods.includes(saved as any)) return saved as any;
    return allowedMergeMethods[0] ?? "merge";
  });
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [forceWithFailures, setForceWithFailures] = useState(false);

  const isClose = method === "close";
  const needsCommitMessage = method === "merge" || method === "squash";
  const canMerge = isClose || (mergeable === true && (!hasFailures || forceWithFailures));

  const handleMerge = useCallback(async () => {
    setMerging(true);
    setMergeError(null);
    try {
      if (isClose) {
        await closePR(owner, repo, number);
      } else {
        await mergePR(owner, repo, number, method as "merge" | "squash" | "rebase", commitMessage || undefined);
        localStorage.setItem(`bearing:mergeMethod:${owner}/${repo}`, method);
      }
      setConfirmOpen(false);
      setCommitMessage("");
      onMerged();
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : "Failed");
    } finally {
      setMerging(false);
    }
  }, [owner, repo, number, method, commitMessage, isClose, onMerged]);

  return (
    <div className="border border-bearing-border rounded-lg bg-bearing-surface">
      {checkRuns.length > 0 && (
        <>
          <div className="px-5 py-2 flex items-center gap-3">
            <span className="text-xs font-mono text-bearing-muted">signals</span>
            <span className="flex-1" />
            {pending.length > 0 && (
              <span className="text-[10px] font-mono text-bearing-yellow">{pending.length} pending</span>
            )}
          </div>
          <SignalsGroup label="failed" runs={failed} color="text-bearing-red" />
          <SignalsGroup label="passed" runs={passed} color="text-bearing-cyan" />
          <SignalsGroup label="skipped" runs={skipped} color="text-bearing-muted" />
        </>
      )}
      <div className="border-t border-bearing-border/50 px-5 py-2 flex items-center gap-2">
        <span className={`text-xs font-mono ${hasMergeConflicts ? "text-bearing-red" : mergeable === null ? "text-bearing-yellow" : "text-bearing-cyan"}`}>
          {hasMergeConflicts ? "✗ merge conflicts" : mergeable === null ? "● checking mergeability…" : "✓ no conflicts"}
        </span>
      </div>
      {showMerge && (
        <div className="border-t border-bearing-border/50 px-5 py-3">
          {!confirmOpen ? (
            <div className="flex items-center gap-2">
              {hasFailures && mergeable === true && (
                <button
                  onClick={() => setForceWithFailures((v) => !v)}
                  className={`text-[10px] font-mono px-2 py-0.5 rounded border transition-colors ${
                    forceWithFailures
                      ? "border-bearing-yellow/50 text-bearing-yellow"
                      : "border-bearing-border text-bearing-muted hover:text-bearing-yellow hover:border-bearing-yellow/30"
                  }`}
                >
                  merge with failing signals
                </button>
              )}
              <span className="flex-1" />
              <Picker
                value={method}
                options={[...allowedMergeMethods, "close"]}
                labels={MERGE_LABELS}
                colorMap={{ close: "text-bearing-red" }}
                onChange={setMethod}
                popDirection="up"
              />
              <button
                onClick={() => setConfirmOpen(true)}
                disabled={!canMerge}
                className={`text-xs font-mono px-3 py-1 rounded border disabled:opacity-40 disabled:cursor-not-allowed ${
                  isClose
                    ? "border-bearing-red/50 text-bearing-red hover:border-bearing-red"
                    : "border-bearing-cyan/50 text-bearing-cyan hover:border-bearing-cyan"
                }`}
              >
                {MERGE_LABELS[method] ?? method}
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className={`text-xs font-mono ${isClose ? "text-bearing-red" : "text-bearing-yellow"}`}>
                  {MERGE_LABELS[method] ?? method}?
                </span>
              </div>
              {needsCommitMessage && (
                <textarea
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  placeholder="Commit message (optional)"
                  className="w-full bg-bearing-overlay border border-bearing-border rounded px-2 py-1.5 text-xs font-mono text-bearing-text placeholder:text-bearing-muted/50 resize-none focus:outline-none focus:border-bearing-accent"
                  rows={2}
                  disabled={merging}
                />
              )}
              <div className="flex items-center gap-2">
                <span className="flex-1" />
                <button
                  onClick={() => { setConfirmOpen(false); setCommitMessage(""); setMergeError(null); }}
                  disabled={merging}
                  className="text-[10px] font-mono px-2 py-1 text-bearing-muted hover:text-bearing-text"
                >
                  cancel
                </button>
                <button
                  onClick={handleMerge}
                  disabled={merging}
                  className={`text-xs font-mono px-3 py-1 rounded border disabled:opacity-40 ${
                    isClose
                      ? "border-bearing-red/50 text-bearing-red hover:border-bearing-red"
                      : "border-bearing-cyan/50 text-bearing-cyan hover:border-bearing-cyan"
                  }`}
                >
                  {merging ? (isClose ? "closing…" : "merging…") : "confirm"}
                </button>
              </div>
              {mergeError && (
                <div className="text-[10px] font-mono text-bearing-red mt-1 truncate">
                  {mergeError}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const CHECK_CONCLUSION_COLOR: Record<string, string> = {
  success: "text-bearing-cyan",
  failure: "text-bearing-red",
  cancelled: "text-bearing-muted",
  skipped: "text-bearing-muted",
  neutral: "text-bearing-muted",
  timed_out: "text-bearing-red",
  action_required: "text-bearing-yellow",
};

const CHECK_CONCLUSION_LABEL: Record<string, string> = {
  success: "✓",
  failure: "✗",
  cancelled: "⊘",
  skipped: "−",
  neutral: "−",
  timed_out: "✗",
  action_required: "!",
};

function CheckRunRow({ run }: { run: CheckRun }) {
  const isComplete = run.status === "completed";
  const color = isComplete
    ? CHECK_CONCLUSION_COLOR[run.conclusion ?? ""] ?? "text-bearing-muted"
    : "text-bearing-yellow";
  const label = isComplete
    ? CHECK_CONCLUSION_LABEL[run.conclusion ?? ""] ?? "?"
    : "●";

  return (
    <a
      href={run.htmlUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 px-5 py-1.5 hover:bg-bearing-overlay/30 transition-colors"
    >
      <span className={`text-xs font-mono w-4 text-center ${color}`}>{label}</span>
      <span className="text-xs font-mono text-bearing-text truncate">{run.name}</span>
    </a>
  );
}

function Picker({
  value,
  options,
  labels,
  onChange,
  popDirection = "up",
  colorMap,
}: {
  value: string;
  options: string[];
  labels?: Record<string, string>;
  onChange: (v: any) => void;
  popDirection?: "up" | "down";
  colorMap?: Record<string, string>;
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

  const display = labels?.[value] ?? value;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-[10px] font-mono text-bearing-muted hover:text-bearing-text"
      >
        [{display}]
      </button>
      {open && (
        <div className={`absolute right-0 z-20 bg-bearing-surface border border-bearing-border rounded shadow-lg py-1 min-w-[180px] ${
          popDirection === "up" ? "bottom-full mb-1" : "top-full mt-1"
        }`}>
          {options.map((opt) => {
            const active = opt === value;
            const color = colorMap?.[opt];
            return (
              <button
                key={opt}
                onClick={() => { onChange(opt); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-bearing-overlay text-left ${
                  active ? (color ?? "text-bearing-accent") : "text-bearing-text"
                }`}
              >
                <span className={`text-[10px] ${active ? (color ?? "text-bearing-accent") : "text-bearing-muted"}`}>
                  {active ? "●" : "○"}
                </span>
                {labels?.[opt] ?? opt}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const MERGE_LABELS: Record<string, string> = {
  merge: "merge commit",
  squash: "squash and merge",
  rebase: "rebase and merge",
  close: "close",
};

// --- Activity Timeline (fallback when sidebar closed) ---

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
  pendingComments,
  activeCommentLine,
  onLineClick,
  onAddComment,
  onCancelComment,
  onRemovePendingComment,
  onToggleCollapse,
  onToggleReviewed,
  onHoverThread,
}: {
  file: PullRequestFile;
  collapsed: boolean;
  reviewed: boolean;
  threads: CommentThread[];
  highlighter: Highlighter | null;
  viewMode: "unified" | "split";
  pendingComments: PendingComment[];
  activeCommentLine: { path: string; line: number; startLine?: number; side: "LEFT" | "RIGHT" } | null;
  onLineClick: (line: number, side: "LEFT" | "RIGHT", shiftKey: boolean) => void;
  onAddComment: (line: number, side: "LEFT" | "RIGHT", body: string, startLine?: number) => void;
  onCancelComment: () => void;
  onRemovePendingComment: (id: number) => void;
  onToggleCollapse: () => void;
  onToggleReviewed: () => void;
  onHoverThread: (id: number | null) => void;
}) {
  const hunks = file.patch ? parsePatch(file.patch) : [];
  const lang = langFromFilename(file.filename) ?? undefined;
  const renamedPrefix =
    file.status === "renamed" && file.previousFilename
      ? `${file.previousFilename} → `
      : "";

  return (
    <div id={`file-${file.filename}`} style={{ scrollMarginTop: "3rem" }}>
      <div
        data-file={file.filename}
        className={`group/file flex items-center gap-2 px-4 py-2 cursor-pointer sticky top-9 z-10 bg-bearing-surface border border-bearing-border rounded-t-lg transition-colors ${collapsed ? "rounded-b-lg" : "border-b-0"} ${reviewed ? "opacity-60" : ""}`}
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
        <div data-file={file.filename} className="overflow-x-auto border border-t-0 border-bearing-border rounded-b-lg bg-bearing-surface transition-colors">
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
                  pendingComments={pendingComments}
                  activeCommentLine={activeCommentLine}
                  onLineClick={onLineClick}
                  onAddComment={onAddComment}
                  onCancelComment={onCancelComment}
                  onRemovePendingComment={onRemovePendingComment}
                  highlighter={highlighter}
                  onHoverThread={onHoverThread}
                />
              ) : (
                <HunkView
                  key={i}
                  hunk={hunk}
                  lang={lang}
                  path={file.filename}
                  threads={threads}
                  pendingComments={pendingComments}
                  activeCommentLine={activeCommentLine}
                  onLineClick={onLineClick}
                  onAddComment={onAddComment}
                  onCancelComment={onCancelComment}
                  onRemovePendingComment={onRemovePendingComment}
                  highlighter={highlighter}
                  onHoverThread={onHoverThread}
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
  pendingComments,
  activeCommentLine,
  onLineClick,
  onAddComment,
  onCancelComment,
  onRemovePendingComment,
  highlighter,
  onHoverThread,
}: {
  hunk: DiffHunk;
  lang: BundledLanguage | undefined;
  path: string;
  threads: CommentThread[];
  pendingComments: PendingComment[];
  activeCommentLine: { path: string; line: number; startLine?: number; side: "LEFT" | "RIGHT" } | null;
  onLineClick: (line: number, side: "LEFT" | "RIGHT", shiftKey: boolean) => void;
  onAddComment: (line: number, side: "LEFT" | "RIGHT", body: string, startLine?: number) => void;
  onCancelComment: () => void;
  onRemovePendingComment: (id: number) => void;
  highlighter: Highlighter | null;
  onHoverThread: (id: number | null) => void;
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

            const commentLine = line.type === "deletion" ? line.oldLine : line.newLine;
            const commentSide: "LEFT" | "RIGHT" = line.type === "deletion" ? "LEFT" : "RIGHT";

            const inThreadRange = commentLine != null && threads.some((t) => {
              if (t.root.line === null) return false;
              const tStart = t.root.startLine ?? t.root.line;
              const tEnd = t.root.line;
              if (t.root.side === "LEFT" && commentSide === "LEFT")
                return commentLine >= tStart && commentLine <= tEnd;
              if (t.root.side !== "LEFT" && commentSide === "RIGHT")
                return commentLine >= tStart && commentLine <= tEnd;
              return false;
            });
            const linePending = commentLine != null
              ? pendingComments.filter((c) => c.line === commentLine && c.side === commentSide)
              : [];
            const rangeStart = activeCommentLine?.startLine ?? activeCommentLine?.line;
            const rangeEnd = activeCommentLine?.line;
            const isInRange = activeCommentLine != null && commentLine != null
              && activeCommentLine.side === commentSide
              && rangeStart != null && rangeEnd != null
              && commentLine >= rangeStart && commentLine <= rangeEnd;
            const isRangeEnd = isInRange && commentLine === rangeEnd;
            const isRangeStart = isInRange && commentLine === rangeStart;

            return (
              <Fragment key={i}>
                <DiffLineRow
                  line={line}
                  lang={lang}
                  highlighter={highlighter}
                  highlighted={isInRange}
                  highlightedFirst={isRangeStart}
                  threadBorder={inThreadRange || lineThreads.length > 0}
                  commentLine={commentLine}
                  commentSide={commentSide}
                  onLineClick={onLineClick}
                />
                {lineThreads.map((thread) => (
                  <tr key={thread.root.id}>
                    <td colSpan={4} className="p-0 border-l-2 border-l-bearing-subtle">
                      <ThreadView thread={thread} onHover={onHoverThread} />
                    </td>
                  </tr>
                ))}
                {linePending.map((pc) => (
                  <tr key={`pending-${pc.id}`}>
                    <td colSpan={4} className="p-0">
                      <PendingCommentView comment={pc} onRemove={() => onRemovePendingComment(pc.id)} />
                    </td>
                  </tr>
                ))}
                {isRangeEnd && (
                  <tr>
                    <td colSpan={4} className="p-0 border-l-2 border-l-bearing-subtle">
                      <InlineCommentForm
                        line={commentLine!}
                        startLine={activeCommentLine!.startLine}
                        onSubmit={(body) => onAddComment(commentLine!, commentSide, body, activeCommentLine!.startLine)}
                        onCancel={onCancelComment}
                      />
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

const DiffLineRow = memo(function DiffLineRow({
  line,
  lang,
  highlighter,
  highlighted,
  highlightedFirst,
  threadBorder,
  commentLine,
  commentSide,
  onLineClick,
}: {
  line: DiffLine;
  lang: BundledLanguage | undefined;
  highlighter: Highlighter | null;
  highlighted?: boolean;
  highlightedFirst?: boolean;
  threadBorder?: boolean;
  commentLine: number | null;
  commentSide: "LEFT" | "RIGHT";
  onLineClick: (line: number, side: "LEFT" | "RIGHT", shiftKey: boolean) => void;
}) {
  const rowRef = useRef<HTMLTableRowElement>(null);
  const visible = useLazyVisible(rowRef);

  const tokens = visible && highlighter && line.content
    ? getCachedTokens(highlighter, line.content, lang)
    : null;

  const clickable = commentLine != null;

  return (
    <tr ref={rowRef} className={`${LINE_BG[line.type]} group/line ${""}`}>
      <td
        className={`w-[1px] whitespace-nowrap text-right pl-4 pr-3 py-0 text-xs text-bearing-muted/40 select-none ${GUTTER_BG[line.type]} ${clickable ? "cursor-pointer hover:text-bearing-accent" : ""} ${highlighted || threadBorder ? "border-l-2 border-l-bearing-subtle" : ""}`}
        onClick={clickable ? (e) => onLineClick(commentLine, commentSide, e.shiftKey) : undefined}
      >
        {line.oldLine ?? ""}
      </td>
      <td
        className={`w-[1px] whitespace-nowrap text-right px-2 py-0 text-xs text-bearing-muted/40 select-none border-r border-bearing-border/20 ${GUTTER_BG[line.type]} ${clickable ? "cursor-pointer hover:text-bearing-accent" : ""}`}
        onClick={clickable ? (e) => onLineClick(commentLine, commentSide, e.shiftKey) : undefined}
      >
        {line.newLine ?? ""}
      </td>
      <td
        className={`w-[1px] px-3 py-0 select-none ${PREFIX_COLOR[line.type]}`}
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
});

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
  pendingComments,
  activeCommentLine,
  onLineClick,
  onAddComment,
  onCancelComment,
  onRemovePendingComment,
  highlighter,
  onHoverThread,
}: {
  hunk: DiffHunk;
  lang: BundledLanguage | undefined;
  path: string;
  threads: CommentThread[];
  pendingComments: PendingComment[];
  activeCommentLine: { path: string; line: number; startLine?: number; side: "LEFT" | "RIGHT" } | null;
  onLineClick: (line: number, side: "LEFT" | "RIGHT", shiftKey: boolean) => void;
  onAddComment: (line: number, side: "LEFT" | "RIGHT", body: string, startLine?: number) => void;
  onCancelComment: () => void;
  onRemovePendingComment: (id: number) => void;
  highlighter: Highlighter | null;
  onHoverThread: (id: number | null) => void;
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

            const leftLine = row.left?.oldLine ?? null;
            const rightLine = row.right?.newLine ?? null;
            const leftPending = leftLine != null ? pendingComments.filter((c) => c.line === leftLine && c.side === "LEFT") : [];
            const rightPending = rightLine != null ? pendingComments.filter((c) => c.line === rightLine && c.side === "RIGHT") : [];

            const lRangeStart = activeCommentLine?.side === "LEFT" ? (activeCommentLine.startLine ?? activeCommentLine.line) : null;
            const lRangeEnd = activeCommentLine?.side === "LEFT" ? activeCommentLine.line : null;
            const rRangeStart = activeCommentLine?.side === "RIGHT" ? (activeCommentLine.startLine ?? activeCommentLine.line) : null;
            const rRangeEnd = activeCommentLine?.side === "RIGHT" ? activeCommentLine.line : null;

            const leftInRange = leftLine != null && lRangeStart != null && lRangeEnd != null && leftLine >= lRangeStart && leftLine <= lRangeEnd;
            const rightInRange = rightLine != null && rRangeStart != null && rRangeEnd != null && rightLine >= rRangeStart && rightLine <= rRangeEnd;
            const leftRangeEnd = leftInRange && leftLine === lRangeEnd;
            const rightRangeEnd = rightInRange && rightLine === rRangeEnd;
            const leftRangeStart = leftInRange && leftLine === lRangeStart;
            const rightRangeStart = rightInRange && rightLine === rRangeStart;

            const leftInThreadRange = leftLine != null && threads.some((t) => {
              if (t.root.line === null || t.root.side !== "LEFT") return false;
              const tStart = t.root.startLine ?? t.root.line;
              return leftLine >= tStart && leftLine <= t.root.line;
            });
            const rightInThreadRange = rightLine != null && threads.some((t) => {
              if (t.root.line === null || t.root.side === "LEFT") return false;
              const tStart = t.root.startLine ?? t.root.line;
              return rightLine >= tStart && rightLine <= t.root.line;
            });

            const hasExtra = leftThreads.length > 0 || rightThreads.length > 0
              || leftPending.length > 0 || rightPending.length > 0
              || leftRangeEnd || rightRangeEnd;

            return (
              <Fragment key={i}>
                <SplitDiffRow
                  left={row.left}
                  right={row.right}
                  lang={lang}
                  highlighter={highlighter}
                  leftHighlighted={leftInRange}
                  rightHighlighted={rightInRange}
                  leftHighlightedFirst={leftRangeStart}
                  rightHighlightedFirst={rightRangeStart}
                  leftThreadBorder={leftInThreadRange}
                  rightThreadBorder={rightInThreadRange}
                  leftLine={leftLine}
                  rightLine={rightLine}
                  onLineClick={onLineClick}
                />
                {hasExtra && (
                  <tr>
                    <td colSpan={3} className={`p-0 align-top border-r border-bearing-border/30 ${leftRangeEnd || leftThreads.length > 0 ? "border-l-2 border-l-bearing-subtle" : ""}`}>
                      {leftThreads.map((thread) => (
                        <ThreadView key={thread.root.id} thread={thread} onHover={onHoverThread} />
                      ))}
                      {leftPending.map((pc) => (
                        <PendingCommentView key={`pending-${pc.id}`} comment={pc} onRemove={() => onRemovePendingComment(pc.id)} />
                      ))}
                      {leftRangeEnd && (
                        <InlineCommentForm
                          line={leftLine!}
                          startLine={activeCommentLine!.startLine}
                          onSubmit={(body) => onAddComment(leftLine!, "LEFT", body, activeCommentLine!.startLine)}
                          onCancel={onCancelComment}
                        />
                      )}
                    </td>
                    <td colSpan={3} className={`p-0 align-top ${rightRangeEnd || rightThreads.length > 0 ? "border-l-2 border-l-bearing-subtle" : ""}`}>
                      {rightThreads.map((thread) => (
                        <ThreadView key={thread.root.id} thread={thread} onHover={onHoverThread} />
                      ))}
                      {rightPending.map((pc) => (
                        <PendingCommentView key={`pending-${pc.id}`} comment={pc} onRemove={() => onRemovePendingComment(pc.id)} />
                      ))}
                      {rightRangeEnd && (
                        <InlineCommentForm
                          line={rightLine!}
                          startLine={activeCommentLine!.startLine}
                          onSubmit={(body) => onAddComment(rightLine!, "RIGHT", body, activeCommentLine!.startLine)}
                          onCancel={onCancelComment}
                        />
                      )}
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

const SplitDiffRow = memo(function SplitDiffRow({
  left,
  right,
  lang,
  highlighter,
  leftHighlighted,
  rightHighlighted,
  leftHighlightedFirst,
  rightHighlightedFirst,
  leftThreadBorder,
  rightThreadBorder,
  leftLine,
  rightLine,
  onLineClick,
}: {
  left: DiffLine | null;
  right: DiffLine | null;
  lang: BundledLanguage | undefined;
  highlighter: Highlighter | null;
  leftHighlighted?: boolean;
  rightHighlighted?: boolean;
  leftHighlightedFirst?: boolean;
  rightHighlightedFirst?: boolean;
  leftThreadBorder?: boolean;
  rightThreadBorder?: boolean;
  leftLine: number | null;
  rightLine: number | null;
  onLineClick: (line: number, side: "LEFT" | "RIGHT", shiftKey: boolean) => void;
}) {
  return (
    <tr>
      <SplitHalf line={left} side="left" lang={lang} highlighter={highlighter} highlighted={leftHighlighted} highlightedFirst={leftHighlightedFirst} threadBorder={leftThreadBorder} commentLine={leftLine} onLineClick={onLineClick} />
      <SplitHalf
        line={right}
        side="right"
        lang={lang}
        highlighter={highlighter}
        highlighted={rightHighlighted}
        highlightedFirst={rightHighlightedFirst}
        threadBorder={rightThreadBorder}
        commentLine={rightLine}
        onLineClick={onLineClick}
      />
    </tr>
  );
});

const SplitHalf = memo(function SplitHalf({
  line,
  side,
  lang,
  highlighter,
  highlighted,
  highlightedFirst,
  threadBorder,
  commentLine,
  onLineClick,
}: {
  line: DiffLine | null;
  side: "left" | "right";
  lang: BundledLanguage | undefined;
  highlighter: Highlighter | null;
  highlighted?: boolean;
  highlightedFirst?: boolean;
  threadBorder?: boolean;
  commentLine: number | null;
  onLineClick: (line: number, side: "LEFT" | "RIGHT", shiftKey: boolean) => void;
}) {
  const clickSide: "LEFT" | "RIGHT" = side === "left" ? "LEFT" : "RIGHT";
  const clickable = commentLine != null;

  if (!line) {
    return (
      <>
        <td className="w-[1px] pl-4 pr-3 py-0 bg-bearing-overlay/30 select-none" />
        <td className="w-[1px] px-3 py-0 bg-bearing-overlay/30 select-none" />
        <td
          className={`w-1/2 py-0 bg-bearing-overlay/30 ${side === "left" ? "border-r border-bearing-border/30" : ""}`}
        />
      </>
    );
  }

  const type = line.type === "context" ? "context" : line.type;
  const lineNum = side === "left" ? line.oldLine : line.newLine;
  const bg = highlighted ? "" : LINE_BG[type];
  const gutterBg = highlighted ? "" : GUTTER_BG[type];

  const tokens = highlighter && line.content
    ? getCachedTokens(highlighter, line.content, lang)
    : null;

  const prefix =
    type === "deletion" ? "-" : type === "addition" ? "+" : " ";
  const prefixColor = PREFIX_COLOR[type];

  return (
    <>
      <td
        className={`w-[1px] whitespace-nowrap text-right pl-4 pr-3 py-0 text-xs text-bearing-muted/40 select-none ${gutterBg} ${clickable ? "cursor-pointer hover:text-bearing-accent" : ""} ${highlighted || threadBorder ? "border-l-2 border-l-bearing-subtle" : ""}`}
        onClick={clickable ? (e) => onLineClick(commentLine, clickSide, e.shiftKey) : undefined}
      >
        {lineNum ?? ""}
      </td>
      <td className={`w-[1px] px-3 py-0 select-none ${prefixColor} ${bg} ${""}`}>
        {prefix}
      </td>
      <td
        className={`w-1/2 py-0 pr-2 ${bg} ${side === "left" ? "border-r border-bearing-border/30" : ""} ${""}`}
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
});

function InlineCommentForm({
  line,
  startLine,
  onSubmit,
  onCancel,
}: {
  line: number;
  startLine?: number;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div className="mx-4 my-2 border border-bearing-accent/50 rounded-lg bg-bearing-surface p-3">
      <div className="text-[10px] font-mono text-bearing-muted mb-1.5">
        {startLine != null ? `L${startLine}–${line}` : `L${line}`}
      </div>
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim()) {
            e.preventDefault();
            onSubmit(body);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="Write a comment…"
        className="w-full bg-bearing-overlay border border-bearing-border rounded px-2 py-1.5 text-xs font-mono text-bearing-text placeholder:text-bearing-muted/50 resize-none focus:outline-none focus:border-bearing-accent"
        rows={2}
      />
      <div className="flex items-center gap-2 mt-2">
        <span className="flex-1" />
        <button
          onClick={onCancel}
          className="text-[10px] font-mono px-2 py-0.5 text-bearing-muted hover:text-bearing-text"
        >
          cancel
        </button>
        <button
          onClick={() => body.trim() && onSubmit(body)}
          disabled={!body.trim()}
          className="text-[10px] font-mono px-2.5 py-0.5 rounded border border-bearing-accent/50 text-bearing-accent hover:border-bearing-accent disabled:opacity-40 disabled:cursor-not-allowed"
        >
          add comment
        </button>
      </div>
    </div>
  );
}

function PendingCommentView({
  comment,
  onRemove,
}: {
  comment: PendingComment;
  onRemove: () => void;
}) {
  return (
    <div className="mx-4 my-2 border border-bearing-yellow/30 rounded-lg bg-bearing-surface p-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] font-mono text-bearing-yellow">pending</span>
        <span className="flex-1" />
        <button
          onClick={onRemove}
          className="text-[10px] font-mono text-bearing-muted hover:text-bearing-red"
        >
          remove
        </button>
      </div>
      <div className="prose-bearing text-xs">
        <Markdown>{comment.body}</Markdown>
      </div>
    </div>
  );
}

function ThreadView({ thread, onHover }: { thread: CommentThread; onHover: (id: number | null) => void }) {
  const all = [thread.root, ...thread.replies];

  return (
    <div
      id={`thread-${thread.root.id}`}
      data-thread-id={thread.root.id}
      className="mx-4 my-2 border border-bearing-border rounded-lg overflow-hidden bg-bearing-surface transition-colors"
      onMouseEnter={() => onHover(thread.root.id)}
      onMouseLeave={() => onHover(null)}
    >
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
