import { useState } from "react";

type PrFilter = "review_requested" | "authored";

export function Dashboard() {
  const [prFilter, setPrFilter] = useState<PrFilter>("review_requested");

  return (
    <div className="h-full grid grid-cols-2 divide-x divide-bearing-border">
      {/* Left panel: Pull Requests */}
      <div className="flex flex-col overflow-hidden">
        <div className="flex items-center gap-1 px-4 py-2 border-b border-bearing-border">
          <button
            onClick={() => setPrFilter("review_requested")}
            className={`px-2 py-1 text-xs font-mono rounded ${
              prFilter === "review_requested"
                ? "bg-bearing-accent/15 text-bearing-accent"
                : "text-bearing-muted hover:text-bearing-text"
            }`}
          >
            needs review
          </button>
          <button
            onClick={() => setPrFilter("authored")}
            className={`px-2 py-1 text-xs font-mono rounded ${
              prFilter === "authored"
                ? "bg-bearing-accent/15 text-bearing-accent"
                : "text-bearing-muted hover:text-bearing-text"
            }`}
          >
            authored
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <p className="text-sm text-bearing-muted font-mono">
            No PRs loaded. Configure GitHub token in ~/.bearing/config.json
          </p>
        </div>
      </div>

      {/* Right panel: Linear Issues */}
      <div className="flex flex-col overflow-hidden">
        <div className="flex items-center px-4 py-2 border-b border-bearing-border">
          <span className="text-xs font-mono text-bearing-muted">issues</span>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <p className="text-sm text-bearing-muted font-mono">
            No issues loaded. Configure Linear API key in ~/.bearing/config.json
          </p>
        </div>
      </div>
    </div>
  );
}
