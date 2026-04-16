import { useParams } from "wouter";

export function Review() {
  const { owner, repo, number } = useParams<{
    owner: string;
    repo: string;
    number: string;
  }>();

  return (
    <div className="h-full flex flex-col overflow-hidden p-4">
      <div className="font-mono text-sm text-bearing-muted">
        {owner}/{repo}#{number}
      </div>
      <div className="flex-1 flex items-center justify-center text-bearing-muted text-sm">
        PR review UI — coming soon
      </div>
    </div>
  );
}
