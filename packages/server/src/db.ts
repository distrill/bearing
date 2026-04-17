import Database from "better-sqlite3";
import { join } from "path";
import { homedir } from "os";
import { mkdirSync } from "fs";

const DB_DIR = join(homedir(), ".bearing");
const DB_PATH = join(DB_DIR, "bearing.db");

export function initDb(): Database.Database {
  mkdirSync(DB_DIR, { recursive: true });
  const db = new Database(DB_PATH);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS pr_seen (
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_updated_at TEXT NOT NULL,
      PRIMARY KEY (owner, repo, number)
    );

    CREATE TABLE IF NOT EXISTS issue_seen (
      id TEXT PRIMARY KEY,
      last_seen_at TEXT NOT NULL,
      last_updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tag_definitions (
      name TEXT PRIMARY KEY,
      color TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pr_tags (
      tag TEXT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      PRIMARY KEY (tag, owner, repo, number)
    );

    CREATE TABLE IF NOT EXISTS issue_tags (
      tag TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      PRIMARY KEY (tag, issue_id)
    );
  `);

  return db;
}
