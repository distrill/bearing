import { Route, Switch } from "wouter";
import { Dashboard } from "./routes/Dashboard";
import { Review } from "./routes/Review";
import { Shell } from "./components/Shell";

export function App() {
  return (
    <Shell>
      <Switch>
        <Route path="/" component={Dashboard} />
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
