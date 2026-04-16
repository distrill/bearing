import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface BearingConfig {
  github: { token: string };
  linear: { apiKey: string };
}

const CONFIG_DIR = join(homedir(), ".bearing");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const EMPTY_CONFIG: BearingConfig = {
  github: { token: "" },
  linear: { apiKey: "" },
};

export function loadConfig(): BearingConfig {
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(EMPTY_CONFIG, null, 2) + "\n");
    console.log(`Created config file at ${CONFIG_PATH}`);
    console.log("Add your GitHub token and Linear API key to get started.");
    return EMPTY_CONFIG;
  }

  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as BearingConfig;
}

export function hasGitHubToken(config: BearingConfig): boolean {
  return config.github.token.length > 0;
}

export function hasLinearKey(config: BearingConfig): boolean {
  return config.linear.apiKey.length > 0;
}
