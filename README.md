# limit: a Claude Code plugin for usage limits

`/limit` stops Claude Code's work **now** or **at a 5-hour usage percentage** that you choose. If you ask for it, `/limit`
also restarts **this session** by itself after the 5-hour limit resets.

## Install

In a Claude Code terminal session, type:

```
/plugin install limit --marketplace yokeeswaran-dev/claude-limit
```

Answer `y` to add the marketplace, then press Enter to install for your user. Nothing else needs to be set up.

## Commands

| Command | What it does |
| --- | --- |
| `/limit stop-now` | Stops all work at once: tool calls of the main conversation, subagents and workflows are refused. Type `continue` to resume where it stopped. |
| `/limit stop-limit <percent>` | Stops all work when the **5-hour** usage reaches `<percent>`, for example `/limit stop-limit 85`. |
| `/limit continue-limit` | Turns on the automatic restart **for this session only**. If `stop-limit` or the real usage limit stops this session, the plugin sends `continue` 2 minutes after the 5-hour window resets. |
| `/limit status` | Shows the 5-hour usage, the settings and whether work is stopped. |
| `/limit off` | Turns `stop-limit` and `continue-limit` off. A stop already in place stays until you type `continue`. |

The status line shows the state, for example `limit: 5h 42% · stop at 85% · auto-restart on`.

## How it behaves

- **Only the session where you typed `/limit continue-limit` restarts.** Other sessions are never started.
- If another session uses up the real limit, every running session stops, because the limit is per account. Only the
  sessions with `continue-limit` turned on restart after the reset.
- A stop by `/limit stop-now` is never restarted by itself; you type `continue`.
- **Keep the session open.** The restart is a timer inside the session: closing Claude Code cancels it.
- The settings belong to one session. Turn them on again in a new session.

## Requirements

- Claude Code 2.1.296 or newer. The plugin uses Claude Code's plugin hooks API, which is early access.
- A Claude Pro or Max plan. The 5-hour usage figure is only available on a subscription.

## Develop

- Run the tests with `claude plugin test .`
- Check the plugin with `claude plugin validate .`
