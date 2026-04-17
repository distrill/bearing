export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "context" | "addition" | "deletion";
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

export function parsePatch(patch: string): DiffHunk[] {
  if (!patch) return [];
  const lines = patch.split("\n");
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const m = line.match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/,
    );
    if (m) {
      current = {
        oldStart: parseInt(m[1]),
        oldCount: parseInt(m[2] ?? "1"),
        newStart: parseInt(m[3]),
        newCount: parseInt(m[4] ?? "1"),
        header: m[5]?.trim() ?? "",
        lines: [],
      };
      hunks.push(current);
      oldLine = current.oldStart;
      newLine = current.newStart;
      continue;
    }

    if (!current) continue;

    if (line.startsWith("+")) {
      current.lines.push({
        type: "addition",
        content: line.slice(1),
        oldLine: null,
        newLine: newLine++,
      });
    } else if (line.startsWith("-")) {
      current.lines.push({
        type: "deletion",
        content: line.slice(1),
        oldLine: oldLine++,
        newLine: null,
      });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file"
    } else {
      current.lines.push({
        type: "context",
        content: line.length > 0 ? line.slice(1) : "",
        oldLine: oldLine++,
        newLine: newLine++,
      });
    }
  }

  return hunks;
}
