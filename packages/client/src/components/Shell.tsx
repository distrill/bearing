import type { ReactNode } from "react";
import { useLocation } from "wouter";

export function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const isReview = location.startsWith("/review");

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <header className="flex items-center justify-between px-4 h-10 border-b border-bearing-border bg-bearing-surface shrink-0">
        <a href="/" className="font-mono text-sm font-medium tracking-wide text-bearing-text hover:text-white">
          bearing
        </a>
        {isReview && (
          <a
            href="/"
            className="text-xs text-bearing-muted hover:text-bearing-text font-mono"
          >
            ← dashboard
          </a>
        )}
      </header>
      <main className="flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
