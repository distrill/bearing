import { useState, useCallback, useEffect } from "react";
import { Route, Switch } from "wouter";
import { Dashboard } from "./routes/Dashboard";
import { Review } from "./routes/Review";
import { Shell } from "./components/Shell";
import { fetchTags, type TagDefinition } from "./lib/api";

export function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [tags, setTags] = useState<TagDefinition[]>([]);
  const [issueSearch, setIssueSearch] = useState("");
  const [prSearch, setPrSearch] = useState("");
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const loadTags = useCallback(() => {
    fetchTags()
      .then((r) => setTags(r.tags))
      .catch(() => setTags([]));
  }, []);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  const handleSearch = useCallback((scope: "issues" | "prs" | "both", term: string) => {
    if (scope === "issues" || scope === "both") setIssueSearch(term);
    if (scope === "prs" || scope === "both") setPrSearch(term);
  }, []);

  const handleClearSearch = useCallback(() => {
    setIssueSearch("");
    setPrSearch("");
  }, []);

  return (
    <Shell onRefresh={refresh} tags={tags} onTagsChange={loadTags} onIssueCreated={refresh} onSearch={handleSearch} onClearSearch={handleClearSearch}>
      <Switch>
        <Route path="/">
          <Dashboard
            refreshKey={refreshKey}
            tags={tags}
            issueSearch={issueSearch}
            prSearch={prSearch}
            onClearIssueSearch={() => setIssueSearch("")}
            onClearPrSearch={() => setPrSearch("")}
          />
        </Route>
        <Route path="/review/:owner/:repo/:number" component={Review} />
        <Route>
          <div className="flex items-center justify-center h-full text-bearing-muted">
            404
          </div>
        </Route>
      </Switch>
    </Shell>
  );
}
