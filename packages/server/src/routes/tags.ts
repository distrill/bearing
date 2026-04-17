import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

export async function tagRoutes(
  app: FastifyInstance,
  db: Database.Database,
) {
  // List tag definitions
  app.get("/api/tags", async () => {
    const tags = db
      .prepare("SELECT name, color FROM tag_definitions ORDER BY name")
      .all() as Array<{ name: string; color: string }>;
    return { tags };
  });

  // Create a tag
  app.post("/api/tags", async (request, reply) => {
    const { name, color } = request.body as { name: string; color: string };
    if (!name || !color) return reply.status(400).send({ error: "name and color required" });
    try {
      db.prepare("INSERT INTO tag_definitions (name, color) VALUES (?, ?)").run(name, color);
    } catch {
      return reply.status(409).send({ error: "tag already exists" });
    }
    return { ok: true };
  });

  // Update a tag
  app.put<{ Params: { name: string } }>("/api/tags/:name", async (request, reply) => {
    const oldName = request.params.name;
    const { name, color } = request.body as { name: string; color: string };
    if (!name || !color) return reply.status(400).send({ error: "name and color required" });

    const update = db.transaction(() => {
      const existing = db
        .prepare("SELECT name FROM tag_definitions WHERE name = ?")
        .get(oldName) as { name: string } | undefined;
      if (!existing) return null;

      if (oldName !== name) {
        // Rename: insert new, migrate assignments, delete old
        db.prepare("INSERT OR REPLACE INTO tag_definitions (name, color) VALUES (?, ?)").run(name, color);
        db.prepare("UPDATE pr_tags SET tag = ? WHERE tag = ?").run(name, oldName);
        db.prepare("UPDATE issue_tags SET tag = ? WHERE tag = ?").run(name, oldName);
        db.prepare("DELETE FROM tag_definitions WHERE name = ?").run(oldName);
      } else {
        db.prepare("UPDATE tag_definitions SET color = ? WHERE name = ?").run(color, name);
      }
      return true;
    });

    const result = update();
    if (!result) return reply.status(404).send({ error: "tag not found" });
    return { ok: true };
  });

  // Delete a tag
  app.delete<{ Params: { name: string } }>("/api/tags/:name", async (request, reply) => {
    const { name } = request.params;

    const remove = db.transaction(() => {
      const existing = db
        .prepare("SELECT name FROM tag_definitions WHERE name = ?")
        .get(name) as { name: string } | undefined;
      if (!existing) return null;

      db.prepare("DELETE FROM pr_tags WHERE tag = ?").run(name);
      db.prepare("DELETE FROM issue_tags WHERE tag = ?").run(name);
      db.prepare("DELETE FROM tag_definitions WHERE name = ?").run(name);
      return true;
    });

    const result = remove();
    if (!result) return reply.status(404).send({ error: "tag not found" });
    return { ok: true };
  });

  // Get all tag assignments
  app.get("/api/tags/assignments", async () => {
    const prTags = db
      .prepare("SELECT tag, owner, repo, number FROM pr_tags")
      .all() as Array<{
      tag: string;
      owner: string;
      repo: string;
      number: number;
    }>;

    const issueTags = db
      .prepare("SELECT tag, issue_id FROM issue_tags")
      .all() as Array<{ tag: string; issue_id: string }>;

    return { prTags, issueTags };
  });

  // Tag a PR
  app.post("/api/tags/pr", async (request) => {
    const { tag, owner, repo, number } = request.body as {
      tag: string;
      owner: string;
      repo: string;
      number: number;
    };
    db.prepare(
      "INSERT OR IGNORE INTO pr_tags (tag, owner, repo, number) VALUES (?, ?, ?, ?)",
    ).run(tag, owner, repo, number);
    return { ok: true };
  });

  // Untag a PR
  app.delete("/api/tags/pr", async (request) => {
    const { tag, owner, repo, number } = request.body as {
      tag: string;
      owner: string;
      repo: string;
      number: number;
    };
    db.prepare(
      "DELETE FROM pr_tags WHERE tag = ? AND owner = ? AND repo = ? AND number = ?",
    ).run(tag, owner, repo, number);
    return { ok: true };
  });

  // Tag an issue
  app.post("/api/tags/issue", async (request) => {
    const { tag, issue_id } = request.body as {
      tag: string;
      issue_id: string;
    };
    db.prepare(
      "INSERT OR IGNORE INTO issue_tags (tag, issue_id) VALUES (?, ?)",
    ).run(tag, issue_id);
    return { ok: true };
  });

  // Untag an issue
  app.delete("/api/tags/issue", async (request) => {
    const { tag, issue_id } = request.body as {
      tag: string;
      issue_id: string;
    };
    db.prepare(
      "DELETE FROM issue_tags WHERE tag = ? AND issue_id = ?",
    ).run(tag, issue_id);
    return { ok: true };
  });
}
