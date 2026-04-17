import { useState, useCallback, useEffect } from "react";
import { Route, Switch } from "wouter";
import { Dashboard } from "./routes/Dashboard";
import { Review } from "./routes/Review";
import { Shell } from "./components/Shell";
import { fetchTags, type TagDefinition } from "./lib/api";

export function App() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [tags, setTags] = useState<TagDefinition[]>([]);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const loadTags = useCallback(() => {
    fetchTags()
      .then((r) => setTags(r.tags))
      .catch(() => setTags([]));
  }, []);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  return (
    <Shell onRefresh={refresh} tags={tags} onTagsChange={loadTags}>
      <Switch>
        <Route path="/">
          <Dashboard refreshKey={refreshKey} tags={tags} />
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
