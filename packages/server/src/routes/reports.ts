import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import type { BearingConfig } from "../config.js";
import type { WeeklyReport } from "@bearing/shared";
import { fetchGitHubStats, makeDays } from "../github.js";
import { fetchCompletedIssuesForStats, fetchIssuesForReport } from "../linear.js";

export async function reportRoutes(
  app: FastifyInstance,
  db: Database.Database,
  config: BearingConfig,
) {
  app.get("/api/reports", async () => {
    const rows = db
      .prepare("SELECT week_start, content, generated_at, stats_json FROM weekly_reports ORDER BY week_start DESC")
      .all() as Array<{ week_start: string; content: string; generated_at: string; stats_json: string | null }>;

    const reports: WeeklyReport[] = rows.map((r) => {
      let stats: WeeklyReport["stats"] = null;
      if (r.stats_json) {
        try { stats = JSON.parse(r.stats_json); } catch { /* ignore corrupt json */ }
      }
      return { weekStart: r.week_start, content: r.content, generatedAt: r.generated_at, stats };
    });

    return { reports };
  });

  app.get("/api/reports/:weekStart", async (request, reply) => {
    const { weekStart } = request.params as { weekStart: string };

    const row = db
      .prepare("SELECT week_start, content, generated_at, stats_json FROM weekly_reports WHERE week_start = ?")
      .get(weekStart) as { week_start: string; content: string; generated_at: string; stats_json: string | null } | undefined;

    if (!row) {
      return reply.code(404).send({ error: "Report not found" });
    }

    return {
      weekStart: row.week_start,
      content: row.content,
      generatedAt: row.generated_at,
      stats: (() => { try { return row.stats_json ? JSON.parse(row.stats_json) : null; } catch { return null; } })(),
    } satisfies WeeklyReport;
  });

  app.put("/api/reports/:weekStart", async (request) => {
    const { weekStart } = request.params as { weekStart: string };
    const { content, stats } = request.body as { content: string; stats?: WeeklyReport["stats"] };

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO weekly_reports (week_start, content, generated_at, stats_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(week_start) DO UPDATE SET content = excluded.content, generated_at = excluded.generated_at, stats_json = excluded.stats_json`,
    ).run(weekStart, content, now, stats ? JSON.stringify(stats) : null);

    return { ok: true };
  });

  app.post("/api/reports/:weekStart/generate", async (request, reply) => {
    if (!config.anthropic.token) {
      return reply.code(503).send({ error: "Anthropic API key not configured" });
    }

    const { weekStart } = request.params as { weekStart: string };

    const weekEnd = new Date(new Date(weekStart + "T00:00:00Z").getTime() + 6 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);

    const statsRepos = (request.query as { repos?: string }).repos?.split(",").filter(Boolean) ?? [];
    const statsTeams = (request.query as { teams?: string }).teams?.split(",").filter(Boolean) ?? [];

    let weekStats = {
      prsOpened: 0,
      prsMerged: 0,
      prsReviewed: 0,
      linesAuthored: 0,
      issuesClosed: 0,
    };

    let ghContext = "";
    let linearContext = "";
    let prevWeekContext = "";

    if (statsRepos.length > 0 && config.github.token) {
      try {
        const stats = await fetchGitHubStats(config.github.token, statsRepos, weekStart, weekEnd);
        const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
        weekStats.prsOpened = sum(stats.prsOpened);
        weekStats.prsMerged = sum(stats.prsMerged);
        weekStats.prsReviewed = sum(stats.prsReviewed);
        weekStats.linesAuthored = sum(stats.linesAuthored);

        ghContext = `GitHub activity (${weekStart} to ${weekEnd}):\n` +
          `- PRs authored/opened: ${weekStats.prsOpened}\n` +
          `- PRs merged (authored by me): ${weekStats.prsMerged}\n` +
          `- PRs reviewed (others' PRs): ${weekStats.prsReviewed}\n` +
          `- Lines authored: ${weekStats.linesAuthored}\n` +
          `- Repos tracked: ${statsRepos.join(", ")}\n`;

        if (stats.authoredPRs && stats.authoredPRs.length > 0) {
          ghContext += `\nMy PRs (authored):\n`;
          for (const pr of stats.authoredPRs) {
            ghContext += `- ${pr.title} (${pr.repo}#${pr.number}) [${pr.state}] +${pr.additions}/-${pr.deletions}\n`;
          }
        }

        if (stats.reviewedPRs && stats.reviewedPRs.length > 0) {
          ghContext += `\nPRs I reviewed (others' work):\n`;
          for (const pr of stats.reviewedPRs) {
            ghContext += `- ${pr.title} (${pr.repo}#${pr.number}) by someone else, +${pr.additions}/-${pr.deletions}\n`;
          }
        }

        // Fetch previous week for comparison
        const prevStart = new Date(new Date(weekStart + "T00:00:00Z").getTime() - 7 * 24 * 60 * 60 * 1000)
          .toISOString().slice(0, 10);
        const prevEnd = new Date(new Date(weekStart + "T00:00:00Z").getTime() - 1 * 24 * 60 * 60 * 1000)
          .toISOString().slice(0, 10);

        try {
          const prevStats = await fetchGitHubStats(config.github.token, statsRepos, prevStart, prevEnd);
          const prevSum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
          const prevOpened = prevSum(prevStats.prsOpened);
          const prevMerged = prevSum(prevStats.prsMerged);
          const prevReviewed = prevSum(prevStats.prsReviewed);
          const prevLines = prevSum(prevStats.linesAuthored);

          if (prevOpened > 0 || prevMerged > 0 || prevReviewed > 0 || prevLines > 0) {
            prevWeekContext = `\nPrevious week (${prevStart} to ${prevEnd}) for comparison:\n` +
              `- PRs opened: ${prevOpened}\n` +
              `- PRs merged: ${prevMerged}\n` +
              `- PRs reviewed: ${prevReviewed}\n` +
              `- Lines authored: ${prevLines}\n`;
          } else {
            prevWeekContext = `\nNo previous week data available (this may be the first tracked week).\n`;
          }
        } catch {
          prevWeekContext = `\nNo previous week data available.\n`;
        }
      } catch {
        // continue without GitHub stats
      }
    }

    if (statsTeams.length > 0 && config.linear.apiKeys.length > 0) {
      try {
        const { completed, created } = await fetchIssuesForReport(
          config.linear.apiKeys, statsTeams, weekStart, weekEnd,
        );
        weekStats.issuesClosed = completed.length;

        if (completed.length > 0) {
          linearContext += `\nLinear issues completed (${completed.length}):\n`;
          for (const i of completed) {
            const labels = i.labels.length > 0 ? ` [${i.labels.join(", ")}]` : "";
            linearContext += `- ${i.identifier}: ${i.title} (${i.teamName})${labels}\n`;
          }
        }

        if (created.length > 0) {
          linearContext += `\nLinear issues created this week (${created.length}):\n`;
          for (const i of created) {
            const labels = i.labels.length > 0 ? ` [${i.labels.join(", ")}]` : "";
            linearContext += `- ${i.identifier}: ${i.title} (${i.teamName}) — ${i.stateName}${labels}\n`;
          }
        }
      } catch {
        // continue without Linear stats
      }
    }

    const prompt = `You are writing a weekly productivity report for a software engineer. Write a concise, well-structured markdown report summarizing their work for the week of ${weekStart} to ${weekEnd}.

${ghContext}
${linearContext}
${prevWeekContext}

Write the report in markdown with these sections:
## Highlights
A few bullet points of the most impactful work shipped or accomplished this week.

## Shipped
PRs that I authored — what I built and shipped this week. Only include PRs from the "My PRs (authored)" list.

## Reviews
PRs from teammates that I reviewed — how I supported the team. Only include PRs from the "PRs I reviewed" list. Do NOT include these in the Shipped section.

## Issues
Summarize completed issues — group by theme or area if patterns emerge (e.g. "3 issues around auth improvements"). List individual issues with their identifiers. If issues were also created this week, note the planning work separately (e.g. "Created 4 new issues for the X initiative"). Distinguish execution from planning.

## Week over Week
Brief comparison to the previous week's numbers. Note trends. If no previous data exists, skip this section entirely.

## Notes
Any observations about focus areas or things to follow up on.

Keep it concise and factual. Use the data provided — don't invent details. If data is sparse, keep the report short rather than padding it. Do NOT attribute reviewed PRs as my own work.`;

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": config.anthropic.token,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return reply.code(502).send({ error: `Anthropic API error: ${anthropicRes.status}`, detail: errText });
    }

    const result = await anthropicRes.json() as {
      content?: Array<{ type: string; text?: string }>;
    };

    if (!result.content || !Array.isArray(result.content)) {
      return reply.code(502).send({ error: "Unexpected response from Anthropic API" });
    }

    const content = result.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n");

    if (!content.trim()) {
      return reply.code(502).send({ error: "Anthropic API returned empty content" });
    }

    const preview = (request.query as { preview?: string }).preview !== undefined;
    const now = new Date().toISOString();

    if (!preview) {
      db.prepare(
        `INSERT INTO weekly_reports (week_start, content, generated_at, stats_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(week_start) DO UPDATE SET content = excluded.content, generated_at = excluded.generated_at, stats_json = excluded.stats_json`,
      ).run(weekStart, content, now, JSON.stringify(weekStats));
    }

    return {
      weekStart,
      content,
      generatedAt: now,
      stats: weekStats,
    } satisfies WeeklyReport;
  });
}
