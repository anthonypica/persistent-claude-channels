#!/usr/bin/env bun
/**
 * pcc - Persistent Claude Code Channels
 *
 * Runs Claude Code channel plugins (Telegram, Discord) as persistent
 * background services using tmux. Each channel gets its own Claude Code
 * session with a real TTY, attachable for debugging.
 *
 * Usage:
 *   pcc init              Interactive setup wizard
 *   pcc up                Start all configured channel services
 *   pcc down              Stop all channel services
 *   pcc status            Show channel service status
 *   pcc attach <channel>  Attach to a channel's tmux session
 *   pcc logs <channel>    Tail a channel's log file
 */

import { spawnSync } from "bun";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import { createInterface } from "readline";

// ============================================================================
// Configuration
// ============================================================================

const CONFIG_DIR = join(homedir(), ".config", "persistent-channels");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const LOG_DIR = platform() === "darwin"
  ? join(homedir(), "Library", "Logs")
  : join(homedir(), ".local", "share", "persistent-channels", "logs");

const KNOWN_CHANNELS: Record<string, string> = {
  telegram: "plugin:telegram@claude-plugins-official",
  discord: "plugin:discord@claude-plugins-official",
};

interface Config {
  channels: string[];
  alias?: string;
  autoAcceptPermissions: boolean;
  paiEnabled: boolean;
  paiScript?: string;
  workingDirectory?: string;
}

const DEFAULT_CONFIG: Config = {
  channels: ["telegram", "discord"],
  autoAcceptPermissions: true,
  paiEnabled: false,
};

// ============================================================================
// Config helpers
// ============================================================================

function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    return DEFAULT_CONFIG;
  }
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) };
  } catch {
    console.error("Warning: could not parse config, using defaults");
    return DEFAULT_CONFIG;
  }
}

function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

// ============================================================================
// tmux helpers
// ============================================================================

function findTmux(): string | null {
  const paths = [
    "/opt/homebrew/bin/tmux",
    "/usr/local/bin/tmux",
    "/usr/bin/tmux",
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  const which = spawnSync(["which", "tmux"]);
  if (which.exitCode === 0) return which.stdout.toString().trim();
  return null;
}

function requireTmux(): string {
  const tmux = findTmux();
  if (!tmux) {
    console.error("Error: tmux not found. Install it with: brew install tmux");
    process.exit(1);
  }
  return tmux;
}

function requireClaude(): void {
  const result = spawnSync(["which", "claude"]);
  if (result.exitCode !== 0) {
    console.error("Error: claude not found. Install Claude Code: https://claude.com/claude-code");
    process.exit(1);
  }
}

const SESSION_PREFIX = "pcc-";

function sessionName(channel: string): string {
  return `${SESSION_PREFIX}${channel}`;
}

function hasSession(tmux: string, session: string): boolean {
  return spawnSync([tmux, "has-session", "-t", session]).exitCode === 0;
}

function log(message: string, emoji = "") {
  console.log(emoji ? `${emoji} ${message}` : message);
}

// ============================================================================
// Readline helper for init
// ============================================================================

function ask(prompt: string, defaultValue = ""): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`${prompt}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

// ============================================================================
// Commands
// ============================================================================

async function cmdInit() {
  console.log("\nWelcome to Persistent Claude Code Channels!\n");

  // Preflight checks
  if (!findTmux()) {
    console.error("Warning: tmux not found. Install it before running 'up'.");
    console.error("  macOS: brew install tmux");
    console.error("  Linux: apt install tmux / dnf install tmux\n");
  }

  // Channel selection
  console.log("Which channels do you want to run?");
  const channels: string[] = [];
  for (const name of Object.keys(KNOWN_CHANNELS)) {
    const answer = await ask(`  Enable ${name}? (y/n)`, "y");
    if (answer.toLowerCase().startsWith("y")) {
      channels.push(name);
    }
  }
  if (channels.length === 0) {
    console.error("\nNo channels selected. At least one is required.");
    process.exit(1);
  }

  // Permissions
  const permsAnswer = await ask("\nAuto-accept Claude permissions for unattended use? (y/n)", "y");
  const autoAcceptPermissions = permsAnswer.toLowerCase().startsWith("y");

  // PAI integration
  const paiAnswer = await ask("\nEnable PAI integration? (y/n)", "n");
  const paiEnabled = paiAnswer.toLowerCase().startsWith("y");
  let paiScript: string | undefined;
  if (paiEnabled) {
    paiScript = await ask("  Path to pai.ts", join(homedir(), ".claude", "PAI", "Tools", "pai.ts"));
    if (!existsSync(paiScript)) {
      console.error(`  Warning: ${paiScript} not found`);
    }
  }

  // Working directory — where claude sessions will run from.
  // Should be a directory you've already run claude in (to avoid the workspace trust prompt).
  const defaultDir = paiEnabled ? join(homedir(), ".claude") : homedir();
  const workingDirectory = await ask("\nWorking directory for channel sessions", defaultDir);

  // Alias — comes after PAI so the user's PAI name is fresh in mind
  if (paiEnabled) {
    console.log("\n  Tip: Use your PAI assistant's name as the command (e.g. \"claire\")");
  }
  const alias = await ask("\nCommand alias", "pcc");

  const config: Config = {
    channels,
    alias: alias !== "pcc" ? alias : undefined,
    autoAcceptPermissions,
    paiEnabled,
    paiScript,
    workingDirectory: workingDirectory !== homedir() ? workingDirectory : undefined,
  };

  saveConfig(config);
  console.log(`\nConfig written to ${CONFIG_FILE}`);

  // Add alias to shell rc
  const shell = process.env.SHELL || "/bin/zsh";
  const rcFile = shell.includes("zsh")
    ? join(homedir(), ".zshrc")
    : join(homedir(), ".bashrc");

  const scriptPath = join(import.meta.dir, "pcc.ts");
  const aliasLine = `alias ${alias}='bun ${scriptPath}'`;
  const marker = "# persistent-claude-code-channels";

  if (existsSync(rcFile)) {
    const rcContent = readFileSync(rcFile, "utf-8");
    // Remove previous pcc block (marker + next line) to avoid duplicates
    const lines = rcContent.split("\n");
    const cleaned: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === marker) {
        i++; // skip the alias line that follows
        continue;
      }
      cleaned.push(lines[i]);
    }
    cleaned.push(marker);
    cleaned.push(aliasLine);
    writeFileSync(rcFile, cleaned.join("\n") + "\n");
  } else {
    writeFileSync(rcFile, `${marker}\n${aliasLine}\n`);
  }
  console.log(`Alias '${alias}' added to ${rcFile}`);

  console.log(`\nRun: source ${rcFile} && ${alias} up\n`);
}

function cmdUp() {
  const tmux = requireTmux();
  requireClaude();
  const config = loadConfig();
  const bunPath = join(homedir(), ".bun", "bin", "bun");

  mkdirSync(LOG_DIR, { recursive: true });

  for (const channel of config.channels) {
    const session = sessionName(channel);

    if (hasSession(tmux, session)) {
      log(`${channel} already running (tmux: ${session})`, "⚠️");
      continue;
    }

    const plugin = KNOWN_CHANNELS[channel];
    if (!plugin) {
      log(`Unknown channel: ${channel}`, "❌");
      continue;
    }

    // Build the command to run inside tmux
    let cmd: string;
    if (config.paiEnabled && config.paiScript && existsSync(config.paiScript)) {
      const flag = config.autoAcceptPermissions ? " --dangerous" : "";
      cmd = `${bunPath} run ${config.paiScript} --ch ${channel}${flag}`;
    } else {
      const flag = config.autoAcceptPermissions ? " --dangerously-skip-permissions" : "";
      cmd = `claude --channels ${plugin}${flag}`;
    }

    const logPath = join(LOG_DIR, `pcc-${channel}.log`);
    const cwd = config.workingDirectory || homedir();

    const result = spawnSync([
      tmux, "new-session", "-d", "-s", session,
      "-x", "200", "-y", "50",
      "-c", cwd,
      cmd,
    ], {
      env: {
        ...process.env,
        HOME: homedir(),
        PATH: `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${join(homedir(), ".bun", "bin")}:${join(homedir(), ".local", "bin")}`,
      },
    });

    if (result.exitCode !== 0) {
      const err = result.stderr.toString().trim();
      log(`Failed to start ${channel}: ${err}`, "❌");
      continue;
    }

    // Auto-accept the permissions TUI prompt if enabled.
    // The prompt defaults to "1. No, exit" — send Down arrow to select
    // "2. Yes, I accept", then Enter to confirm.
    if (config.autoAcceptPermissions) {
      spawnSync(["bash", "-c",
        `(sleep 3 && ${tmux} send-keys -t ${session} Down Enter) &`]);
    }

    // Pipe tmux output to log file
    spawnSync(["bash", "-c",
      `(${tmux} pipe-pane -t ${session} -o "cat >> ${logPath}") 2>/dev/null`]);

    log(`${channel} started (tmux: ${session})`, "✅");
  }
}

function cmdDown() {
  const tmux = requireTmux();
  const config = loadConfig();

  for (const channel of config.channels) {
    const session = sessionName(channel);

    if (!hasSession(tmux, session)) {
      log(`${channel} not running`, "⚠️");
      continue;
    }

    spawnSync([tmux, "kill-session", "-t", session]);
    log(`${channel} stopped`, "✅");
  }
}

function cmdStatus() {
  const tmux = requireTmux();
  const config = loadConfig();
  const name = config.alias || "pcc";

  log("Channel Services:", "📡");
  console.log();
  for (const channel of config.channels) {
    const session = sessionName(channel);
    if (hasSession(tmux, session)) {
      log(`${channel}: running (tmux: ${session})`, "🟢");
      console.log(`    attach: ${name} attach ${channel}`);
    } else {
      log(`${channel}: stopped`, "🔴");
    }
  }
}

function cmdAttach(channel?: string) {
  const tmux = requireTmux();
  const config = loadConfig();
  const name = config.alias || "pcc";

  if (!channel) {
    console.error(`Usage: ${name} attach <${config.channels.join("|")}>`);
    process.exit(1);
  }
  if (!config.channels.includes(channel)) {
    console.error(`Unknown channel: ${channel}. Configured: ${config.channels.join(", ")}`);
    process.exit(1);
  }

  const session = sessionName(channel);
  if (!hasSession(tmux, session)) {
    log(`${channel} not running`, "🔴");
    process.exit(1);
  }

  const result = spawnSync([tmux, "attach-session", "-t", session], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(result.exitCode ?? 0);
}

function cmdLogs(channel?: string) {
  const config = loadConfig();
  const name = config.alias || "pcc";

  if (!channel) {
    console.error(`Usage: ${name} logs <${config.channels.join("|")}>`);
    process.exit(1);
  }
  if (!config.channels.includes(channel)) {
    console.error(`Unknown channel: ${channel}. Configured: ${config.channels.join(", ")}`);
    process.exit(1);
  }

  const logPath = join(LOG_DIR, `pcc-${channel}.log`);
  if (!existsSync(logPath)) {
    log(`No log file found at ${logPath}`, "⚠️");
    process.exit(1);
  }

  const result = spawnSync(["tail", "-f", logPath], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  process.exit(result.exitCode ?? 0);
}

// ============================================================================
// Main
// ============================================================================

const command = process.argv[2];
const arg = process.argv[3];

switch (command) {
  case "init":
    await cmdInit();
    break;
  case "up":
    cmdUp();
    break;
  case "down":
    cmdDown();
    break;
  case "status":
    cmdStatus();
    break;
  case "attach":
    cmdAttach(arg);
    break;
  case "logs":
    cmdLogs(arg);
    break;
  default: {
    const config = loadConfig();
    const name = config.alias || "pcc";
    console.log(`pcc - Persistent Claude Code Channels

Run Claude Code channel plugins as persistent background services.

USAGE:
  ${name} init              Interactive setup wizard
  ${name} up                Start all configured channels
  ${name} down              Stop all configured channels
  ${name} status            Show channel service status
  ${name} attach <channel>  Attach to a channel session (detach: Ctrl-B D)
  ${name} logs <channel>    Tail a channel's log file

CHANNELS:
  ${Object.keys(KNOWN_CHANNELS).join(", ")}

REQUIREMENTS:
  - Claude Code (v2.1.80+)
  - Bun (bun.sh)
  - tmux (brew install tmux)
  - Channel plugins installed in Claude Code`);
    if (command) {
      console.error(`\nUnknown command: ${command}`);
      process.exit(1);
    }
  }
}
