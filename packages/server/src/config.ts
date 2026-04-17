import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

export interface SuggestionsConfig {
  teams?: string[];
  preferAuthors?: string[];
  limit?: number;
}

export interface BearingConfig {
  github: { token: string; suggestions?: SuggestionsConfig };
  linear: { apiKeys: string[] };
}

const EMPTY_CONFIG: BearingConfig = {
  github: { token: "" },
  linear: { apiKeys: [] },
};

function findProjectRoot(): string | null {
  let dir = process.cwd();
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findConfigPath(): string | null {
  // Check project root first
  const root = findProjectRoot();
  if (root) {
    const projectConfig = join(root, "config.json");
    if (existsSync(projectConfig)) return projectConfig;
  }

  // Fall back to ~/.bearing/config.json
  const homeConfig = join(homedir(), ".bearing", "config.json");
  if (existsSync(homeConfig)) return homeConfig;

  return null;
}

export function loadConfig(): BearingConfig {
  const configPath = findConfigPath();

  if (!configPath) {
    console.log(
      "No config.json found. Create one in the project root or ~/.bearing/config.json",
    );
    return EMPTY_CONFIG;
  }

  console.log(`Loading config from ${configPath}`);
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as BearingConfig;
}

export function hasGitHubToken(config: BearingConfig): boolean {
  return config.github.token.length > 0;
}

export function hasLinearKeys(config: BearingConfig): boolean {
  return config.linear.apiKeys.length > 0;
}
