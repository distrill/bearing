# bearing

Personal dev dashboard that pulls together GitHub PRs and Linear issues into a single view, with a built-in PR review UI and AI-generated weekly reports.

## Features

- **Dashboard** — GitHub PRs (review requested, authored, suggested) and Linear issues side by side, with attention indicators, status management, and tag-based organization
- **PR Review** — Full code review UI with diff view, syntax highlighting, inline comments, review submission, and merge/close actions
- **Weekly Reports** — AI-generated productivity reports using Claude, with week-over-week comparisons, side-by-side diff on regeneration, and markdown editing
- **Overview Stats** — Rolling 7-day metrics with 14-day sparklines for PRs opened/merged/reviewed, lines authored, and tasks closed
- **Filtering** — Exclusion-based filters (new items show by default), tag filters, status filters, attention-only mode, search

## Architecture

Monorepo with three packages:

- `packages/client` — React + Vite + Tailwind
- `packages/server` — Fastify + better-sqlite3
- `packages/shared` — Shared TypeScript types

## Setup

Requires Node >= 20 and pnpm.

```bash
pnpm install
```

Create `config.json` in the project root:

```json
{
  "github": {
    "token": "ghp_...",
    "suggestions": {
      "teams": ["org/team-slug"],
      "preferAuthors": ["username1", "username2"]
    }
  },
  "linear": {
    "apiKeys": ["lin_api_..."]
  },
  "anthropic": {
    "token": "sk-ant-..."
  }
}
```

- **github.token** — Personal access token with `repo` scope
- **github.suggestions** — (optional) Teams and preferred authors for suggested PR reviews
- **linear.apiKeys** — One or more Linear API keys (supports multiple workspaces)
- **anthropic.token** — Anthropic API key for weekly report generation

## Running

```bash
pnpm dev
```

This starts both the server (port 3001) and client (port 5173) in parallel with hot reload.

Open http://localhost:5173.

## Data

Tags, tag assignments, and weekly reports are stored in SQLite at `~/.bearing/bearing.db`. Config is read from `config.json` in the project root (falls back to `~/.bearing/config.json`).
