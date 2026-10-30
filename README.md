# token-dash

A Claude Code mod that keeps a dashboard pane beside the chat. It shows:

- **Token usage**: how full the context window is, the session's cost, and the main conversation's input, output and cache tokens, plus a total for all subagents.
- **Rate-limit countdowns**: each usage window your account reports (5-hour, 7-day, and any model-specific ones) as a bar with its percentage used and a live countdown to its reset. The same figures appear in the status line, e.g. `5h 42% ↻2h13m · 7d 18% ↻3d4h`.
- **Subagents**: each one's description and type, its status, what it is doing right now (its latest tool call), its burn rate and its total tokens, with a **Kill** button while it runs.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install token-dash --marketplace gfetters/token-dash
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). From a shell instead:

```
claude plugin install token-dash --marketplace gfetters/token-dash
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `gfetters/token-dash`, then Add plugin.

### From a local clone

To run it from a folder you are editing, add the folder's absolute path to the `env` block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/token-dash"
  }
}
```

To try it in one session only, start Claude Code with `claude --plugin-dir /path/to/token-dash`.

Interactive sessions watch the folder, so saving a file reloads the mod.

## Use

Run `/dash` to open the pane. In a terminal at least 144 columns wide, the pane also opens by itself when a session starts.

| Control | What it does |
| --- | --- |
| **Kill** | Stops that subagent through the `TaskStop` tool. A toast says whether it worked and, if not, why. |
| **-** / **+** | Lowers or raises the burn limit in steps of 5k tokens/min. The limit starts at 20k/min. |
| **Auto-kill** | When on, stops any running subagent whose burn rate goes past the limit. Off by default. |

The burn limit and the auto-kill switch are remembered across sessions.

### How the numbers are worked out

- **Burn rate** is tokens per minute, averaged over the last 2 minutes, or over the subagent's age if it is younger (counted as at least 15 seconds). It counts input, output and cache-write tokens, and leaves out cache reads, which are much cheaper against usage limits and would swamp every other figure. The burn rate turns yellow at half the limit and red past it.
- **Auto-kill** never stops a subagent in its first 30 seconds, since its first request is usually a spike.
- **Rate-limit windows** appear after the first reply, and only on a Claude subscription (Pro or Max). Other accounts show none.
- The pane lists the 30 most recent subagents, running ones first.

## Limitations

- `TaskStop` is meant for background tasks. It may not be able to stop a foreground subagent; if it refuses, the toast gives its reason and the Kill button stays.
- The mod's own token counts (main conversation, subagents, burn rates) start when it first loads in a session; earlier requests are not counted. They survive a reload of the mod. Context fill, cost and rate limits come from Claude Code and cover the whole session.

## Development

```
claude plugin validate token-dash   # check the manifest and hooks module
claude plugin test token-dash       # run tests/*.test.tsx
```

- `hooks/register.tsx` is the mod's code.
- `types/index.d.ts` declares the values it keeps in session state.
- `tests/kill.test.tsx` covers the Kill button on the terminal and desktop surfaces.
