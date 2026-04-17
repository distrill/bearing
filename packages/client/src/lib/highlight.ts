import { createHighlighter, type ThemedToken, type BundledLanguage } from "shiki";

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;

let promise: Promise<Highlighter> | null = null;

export function getHighlighter(): Promise<Highlighter> {
  if (!promise) {
    promise = createHighlighter({
      themes: ["rose-pine"],
      langs: [
        "typescript",
        "javascript",
        "tsx",
        "jsx",
        "json",
        "css",
        "html",
        "markdown",
        "yaml",
        "python",
        "go",
        "rust",
        "bash",
        "sql",
        "ruby",
        "java",
        "c",
        "cpp",
        "swift",
      ],
    });
  }
  return promise;
}

const EXT_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  json: "json",
  css: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  mdx: "markdown",
  yml: "yaml",
  yaml: "yaml",
  py: "python",
  go: "go",
  rs: "rust",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  rb: "ruby",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  swift: "swift",
};

export function langFromFilename(filename: string): BundledLanguage | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return (EXT_MAP[ext] as BundledLanguage) ?? null;
}

export type { Highlighter, ThemedToken, BundledLanguage };
