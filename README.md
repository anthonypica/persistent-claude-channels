# Persistent Claude Code Channels

Run [Claude Code](https://claude.com/claude-code) channel plugins (Telegram, Discord) as persistent background services using tmux.

Each channel gets its own Claude Code session with a real TTY — attachable for live debugging, detachable to run in the background.

## Why

Claude Code channels require an interactive session. When you close your terminal, the channel dies. This tool keeps them alive in tmux sessions you can attach to anytime.

## Requirements

- [Claude Code](https://claude.com/claude-code) v2.1.80+ with channels support
- [Bun](https://bun.sh) or [Node.js](https://nodejs.org) v23.6+ (v22.6+ with `--experimental-strip-types`)
- [tmux](https://github.com/tmux/tmux) (`brew install tmux` on macOS, `apt install tmux` on Linux)
- Channel plugins installed in Claude Code:
  ```
  /plugin install telegram@claude-plugins-official
  /plugin install discord@claude-plugins-official
  ```

## Install

This is a standalone tool — it does **not** need to be inside `~/.claude/` or any Claude-managed directory. Clone it wherever you keep tools (the setup wizard creates an alias pointing here, so don't move it after):

```bash
cd ~/tools  # or wherever you keep tools
git clone https://github.com/anthonypica/persistent-claude-channels.git
cd persistent-claude-channels
```

Run the setup wizard:

```bash
# With Bun
bun pcc.ts init

# With Node.js v23.6+
node pcc.ts init

# With Node.js v22.6–23.5
node --experimental-strip-types pcc.ts init
```

This will:
1. Ask which channels you want (Telegram, Discord)
2. Let you pick a custom command alias (default: `pcc`)
3. Configure auto-accept permissions for unattended use
4. Optionally enable [PAI](https://github.com/danielmiessler/PAI) integration
5. Write config to `~/.config/persistent-channels/config.json`
6. Add your alias to `~/.zshrc` or `~/.bashrc`

## Usage

```bash
# Start all configured channels
pcc up

# Check status
pcc status

# Attach to a channel's live terminal (detach: Ctrl-B D)
pcc attach telegram

# View logs
pcc logs telegram

# Stop all channels
pcc down
```

## Configuration

Config lives at `~/.config/persistent-channels/config.json`:

```json
{
  "channels": ["telegram", "discord"],
  "alias": "claire",
  "autoAcceptPermissions": true,
  "workingDirectory": "/Users/you/.claude",
  "paiEnabled": false
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `channels` | Which channel plugins to run | `["telegram", "discord"]` |
| `alias` | Custom command name | `"pcc"` |
| `autoAcceptPermissions` | Auto-accept the `--dangerously-skip-permissions` prompt | `true` |
| `workingDirectory` | Directory for channel sessions (use one you've already run claude in to avoid the workspace trust prompt) | `$HOME` |
| `paiEnabled` | Run through PAI for enhanced context | `false` |
| `paiScript` | Path to `pai.ts` (when `paiEnabled: true`) | `~/.claude/PAI/Tools/pai.ts` |

## How it works

1. **`pcc up`** creates a detached tmux session per channel
2. Each session runs `claude --channels plugin:<name>@claude-plugins-official`
3. If `autoAcceptPermissions` is on, it sends keystrokes to accept the permissions prompt
4. The channel plugin connects to its platform (Telegram bot API, Discord gateway) and forwards messages into the Claude session
5. **`pcc attach <channel>`** lets you see the live session — Claude receiving messages, thinking, replying
6. **Ctrl-B D** detaches without killing the session

## PAI Integration

If you use [PAI](https://github.com/danielmiessler/PAI), enable it during `pcc init` or set `paiEnabled: true` in config. This runs channels through `pai.ts` instead of bare `claude`, giving each channel session the full PAI context (Algorithm, skills, hooks, etc.).

## Troubleshooting

**Channel starts but doesn't receive messages:**
- Make sure the channel plugin is installed: `/plugin install telegram@claude-plugins-official`
- Make sure you've configured the bot token: `/telegram:configure <token>`
- Make sure your sender ID is on the allowlist: `/telegram:access pair <code>`

**"MCP server failed" in the session:**
- Check if another instance is already running (only one can poll a bot token at a time)
- Run `pcc down` then `pcc up` to restart cleanly

**Can't detach with Ctrl-B D:**
- Claude Code's TUI may capture keystrokes. Try from another terminal: `tmux detach-client -t pcc-telegram`

**tmux not found:**
- Install with `brew install tmux` (macOS) or `apt install tmux` (Linux)

## License

MIT
