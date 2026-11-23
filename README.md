# lever

Code Mode for any MCP client. The model writes one piece of JavaScript. lever runs it with shell, file, search and MCP helpers, and only what the code returns goes back to the model.

lever is tested with Claude Code 2.1.330 (`claude -p` and a background session) and with Codex (`codex exec`). Other clients that start MCP servers over stdio use the same protocol, but they are not tested yet. lever has no dependencies and needs Node 20.11 or newer.

[한국어 README](README.ko.md)

## Why

Most of an agent's tokens go to tool output that it reads once and then ignores: a whole file to find one line, a full test log to find one failure, one search result per name. Every step is also one more model turn. With lever the model writes the steps as code. Loops, filters and counts run in Node, and the model reads only the answer.

This is a real call from the benchmark below. Claude Haiku was asked for the three longest source files and sent one `run` call:

```js
const files = await glob('src/**/*.mjs');
const counts = [];
for (const f of files) {
  const text = await read(f);
  counts.push({ f, n: text.split('\n').length });
}
counts.sort((a, b) => b.n - a.n);
return counts.slice(0, 3).map(c => `${c.f}: ${c.n}`).join('\n');
```

lever read 15 files (126.6 KB) and sent back 73 bytes:

```
src/helpers/mcp.mjs: 390
src/helpers/search.mjs: 361
src/session.mjs: 318
---
1 glob, 15 read · read 126.6 KB, returned 73 B · 180 ms
```

## Measurements

### In real Claude Code

`node bench/live.mjs haiku 3` gives Claude Code the same four requests three ways: with only the built-in tools (Glob, Grep, Read, Edit, Write, Bash), with the built-in tools and lever (a normal install), and with only lever's `run`. Each request works on a fresh copy of this repository, and each answer is checked. Each row is the median of three runs. Turns, tokens, cost and time come from Claude Code's own result, and input tokens include cached ones. This run used Claude Code 2.1.330 with Claude Haiku on 2026-11-23. All 36 answers were correct.

| Sum of the four tasks | Turns | Tool calls | Input tokens | Output tokens | Cost (USD) | Time (s) |
| :- | -: | -: | -: | -: | -: | -: |
| Built-in tools | 15 | 11 | 592,397 | 4,523 | 0.0310 | 44.1 |
| Built-in tools + lever | 11 (−27%) | 7 (−36%) | 462,520 (−22%) | 3,239 (−28%) | 0.0282 (−9%) | 38.2 (−13%) |
| lever only | 12 (−20%) | 8 (−27%) | 458,358 (−23%) | 3,098 (−32%) | 0.0283 (−9%) | 36.0 (−18%) |

| Task | Way | Turns | Tool calls | Used lever | Input tokens | Output tokens | Cost (USD) | Time (s) |
| :- | :- | -: | -: | :-: | -: | -: | -: | -: |
| Three longest source files | Built-in tools | 2 | 1 | - | 80,705 | 378 | 0.0062 | 4.0 |
| Three longest source files | Built-in tools + lever | 2 | 1 | 0/3 | 82,716 | 425 | 0.0063 | 4.3 |
| Three longest source files | lever only | 2 | 1 | 3/3 | 74,072 | 333 | 0.0061 | 4.4 |
| Where each export of format.mjs is used | Built-in tools | 4 | 3 | - | 178,318 | 1,893 | 0.0091 | 12.8 |
| Where each export of format.mjs is used | Built-in tools + lever | 3 | 2 | 3/3 | 126,329 | 1,312 | 0.0075 | 12.8 |
| Where each export of format.mjs is used | lever only | 4 | 3 | 3/3 | 156,481 | 1,443 | 0.0081 | 11.1 |
| Rename a function everywhere | Built-in tools | 7 | 6 | - | 250,474 | 1,873 | 0.0092 | 15.1 |
| Rename a function everywhere | Built-in tools + lever | 4 | 3 | 3/3 | 168,586 | 1,097 | 0.0077 | 9.0 |
| Rename a function everywhere | lever only | 4 | 3 | 3/3 | 151,309 | 813 | 0.0074 | 8.6 |
| Run the tests, report only failures | Built-in tools | 2 | 1 | - | 82,900 | 379 | 0.0066 | 12.1 |
| Run the tests, report only failures | Built-in tools + lever | 2 | 1 | 0/3 | 84,889 | 405 | 0.0067 | 12.1 |
| Run the tests, report only failures | lever only | 2 | 1 | 3/3 | 76,496 | 509 | 0.0067 | 11.9 |

What the numbers show:

- With a normal install, Haiku used lever for the two tasks that take several steps (6 of 6 runs) and one built-in call for the two tasks that take one step. That is what lever's instructions ask for.
- Most input tokens are the context that Claude Code sends again on every turn, so the saving comes from fewer turns: 7 → 4 for the rename and 4 → 3 for the export count.
- When one shell command can do the task, lever saves nothing. lever's own description adds about 1,000 tokens to each turn.
- "lever only" also removes the six built-in tool definitions, which is about 3,300 tokens less on each turn. To run Claude Code this way, start it with `claude --disallowedTools Bash Read Edit Write Glob Grep`.
- The wording of the instructions matters. With an earlier, vaguer version ("prefer it when a task needs three or more tool calls"), Haiku did not pick lever once in 12 runs of the normal install.
- Three runs for each row is a small sample, and a row can change by one turn from run to run. Run the script with your own model and project before you rely on these numbers.

### Without a model

`npm run bench` does four tasks both ways on copies of this repository, without a model. The built-in side makes one call for each step and counts the output that Claude Code's tools return (Read with line numbers, absolute paths). The lever side makes one `run` call and counts its reply. Tokens are estimated as characters ÷ 4.

| Task | Tool calls | Characters the model reads | ≈ Tokens | Fewer |
| :- | :-: | -: | -: | -: |
| Three longest source files | 16 → 1 | 152,401 → 130 | 38,100 → 33 | 99.9% |
| Where each export of format.mjs is used | 14 → 1 | 14,024 → 215 | 3,506 → 54 | 98.5% |
| Rename a function everywhere | 5 → 1 | 27,034 → 158 | 6,759 → 40 | 99.4% |
| Run the tests, report only failures | 1 → 1 | 5,500 → 415 | 1,375 → 104 | 92.5% |
| **All four** | **36 → 4** | **198,959 → 918** | **49,740 → 230** | **99.5%** |

The rename leaves the same files both ways. This is the most that lever can save, because the built-in side here takes one call for every step. A real model often finds a shorter way with the built-in tools too (for the first task, Haiku used one `find … | xargs wc -l` command), so the measurement in real Claude Code above shows smaller savings.

## Install

```sh
npm install -g lever-code
lever install    # adds lever to Claude Code and Codex, whichever is on your PATH
lever doctor     # checks the setup and runs one test
```

- `lever install --claude` or `lever install --codex` picks one client. `--scope project` adds lever to the current project only (Claude Code).
- For any other MCP client, add a stdio server whose command is `lever`, with no arguments.
- From source: `git clone https://github.com/Junhan2/lever && cd lever && node bin/lever.mjs install`.
- To remove it: `lever uninstall`.

Start a new session after installing. In Claude Code, `/mcp` lists `lever`.

## What the model gets

One tool, `run`:

| Input | Meaning |
| :- | :- |
| `code` | JavaScript. `await` works at the top level. The last expression, or a top-level `return`, is the result. |
| `background` | `true` starts the code as a job and replies at once. |
| `timeout` | Seconds before the run stops (default 600; for a background job 7200). |

The tool description is about 1.4 KB. Claude Code loads it up front (`anthropic/alwaysLoad`), so the first call needs no tool search. Details that the model rarely needs are behind `help(topic)`.

### Helpers inside the code

Paths are relative to the project folder.

| Helper | What it does |
| :- | :- |
| `` await $`cmd ${x}` `` | Runs a shell command. Interpolated values are quoted. It throws on a non-zero exit. The result is `{stdout, stderr, exitCode, ok}`. Chain `.nothrow()`, `.text()`, `.lines()`, `.json()` or `.timeout(ms)`; set options with `` $({cwd, env, timeout})`...` ``. |
| `await read(path, {from, to})` | Reads a file, or a range of its lines. |
| `await write(path, text or object)` | Writes a file and creates its folders. An object is written as JSON. |
| `await edit(path, old, new, {all})` | Replaces text. Without `all`, the text must occur exactly once; otherwise it throws with the line numbers or a hint. Also `edit(path, [[old, new], ...])` and `edit(path, text => newText)`. |
| `await exists(path)`, `await ls(dir)` | Checks a path. Lists a folder. |
| `await glob('src/**/*.ts')` | Lists files, sorted. `.gitignore` is honoured. |
| `await grep(/re/i or 'text', {path, glob, context, files, count, max})` | Searches with ripgrep, or with Node when ripgrep is missing. Returns `[{file, line, text}]`, printed as `file:line:text`. |
| `undo()` | Puts back the files that the most recent changing run wrote. |
| `state` | An object that is kept between runs. |
| `jobs.list()`, `jobs.wait(id)`, `jobs.cancel(id)` | Background jobs. |
| `mcp.<server>.<tool>(args)` | Calls another MCP server from the code: the stdio servers in Claude Code's settings, in `.mcp.json` and in lever's config. `mcp.servers()` and `mcp.tools(name)` list them. |
| `help(topic)` | More detail on `shell`, `files`, `search`, `mcp`, `jobs` or `output`. |

Node's own modules also work (`import`, `require`), but they skip lever's checks. See [Safety](#safety).

### The reply

1. What the code logged, then the result. Strings print as they are. Objects print as `key: value` lines. Arrays of objects print one JSON object per line.
2. After `---`, a summary: the steps by kind, the bytes read and returned, and the time; failed and refused steps; changed files, with a reminder that `undo()` puts them back; messages from hooks.
3. When a reply would be longer than 8,000 characters, long strings are cut in the middle and long lists are shortened, only as much as needed. The whole text is saved to a private file, and the reply gives its path.
4. An error names the line of the code that threw. For the common missing-semicolon mistake it also says how to fix it.

### Long runs

A run stops after 10 minutes, and a background job after 2 hours. Codex stops waiting for an MCP tool after 60 seconds, so for clients other than Claude Code, lever replies after 50 seconds and lets the run go on as a job. The model then gets the result with `jobs.wait(id)`. If a run never gives control back, as in an endless loop, lever replaces its worker thread, ends the processes that the run started, and starts with a new `state`.

## Safety

lever checks every step inside the code under the name of the Claude Code tool that the step stands for (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `mcp__server__tool`):

1. **Guard modules** that you list. See [Guard modules](#guard-modules).
2. **Claude Code's permission rules** from your settings files. A `deny` rule refuses the step. An `ask` rule also refuses it, and the message tells the model to make that call with the normal tool, where you get the usual prompt. lever cannot show a prompt itself.
3. **Claude Code's `PreToolUse` and `PostToolUse` command hooks**, with the documented input, exit codes and JSON fields.

Checks 2 and 3 are on when lever runs under Claude Code. Set `LEVER_HOOKS=on` to use them with other clients too (for example Codex), or `LEVER_HOOKS=off` to turn them off. `glob`, `grep` and `ls` leave out the files that your `Read` deny rules cover.

**lever is not a sandbox.** The code runs in a Node worker thread with your user's rights. It can `import('node:fs')` or `require('node:child_process')` and skip every check above. The checks catch ordinary helper calls. They do not stop code that is written to get around them, and Bash rules match command text, as in Claude Code. Give lever the trust that you give an agent's Bash tool, and run the client in a container or virtual machine when you need isolation. Claude Code's built-in Code Mode has the same limit: its documentation says that the JavaScript and its file and MCP calls run outside the sandbox.

### Guard modules

A guard module exports one function. lever calls it before each step:

```js
export default function ({ tool, input, cwd }) {
  // Return a reason (a string) to refuse the step, { note } to pass a message to the model, or null to let it run.
}
```

[examples/guards/deny-paths.mjs](examples/guards/deny-paths.mjs) refuses steps that touch `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh` or `.env` files. Load guard modules with `LEVER_GUARDS=/path/a.mjs:/path/b.mjs` or with the `guards` list in the config file.

## Compared with Claude Code's built-in Code Mode

Claude Code added an experimental Code Mode in v2.1.323 (November 2026). The facts in the left column come from its [documentation](https://code.claude.com/docs/en/code-mode), read on 2026-11-21.

| | Built-in Code Mode | lever |
| :- | :- | :- |
| Where it works | Interactive terminal sessions only. Not in `-p`, the Agent SDK, VS Code, the Desktop app, cloud sessions or background sessions | Any session type in Claude Code, Codex, and other MCP clients |
| Models and accounts | Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.2, through the Anthropic API only (no Bedrock, Vertex, gateways or API key helpers) | Whatever the client uses |
| What it turns off | Remote Control, Claude in Chrome, computer use, some plugins and mods, OpenTelemetry export | Nothing. It is one more tool next to the normal ones |
| Resuming a session | A Code Mode session resumes only with Code Mode on | No effect on sessions |
| Checks for each call | `deny` and `ask` rules, `PreToolUse` hooks, permission prompts | `deny` rules, `ask` rules (the step is refused with a message), `PreToolUse` and `PostToolUse` hooks, guard modules. No prompts |
| Shell sandbox | Shell commands follow Claude Code's sandbox settings | Not applied |
| What you see | Each tool call, such as an edit's diff. The code is in the transcript viewer | One call with the code and the reply |
| Long runs | 10 minutes. In auto and bypass modes, background code for up to 2 hours | 10 minutes. Background jobs for up to 2 hours. An early reply for clients with short tool limits |
| Large output | A `PostToolUse` hook on `REPL` can change it | Kept under 8,000 characters, with the whole text in a file and a summary line |
| MCP servers from code | Claude Code's own connections | lever starts its own copy of each stdio server. HTTP servers are not reachable |

## Limits

- lever is not a sandbox. See [Safety](#safety).
- There are no permission prompts. An `ask` rule refuses the step.
- `mcp.<server>` starts a separate copy of a stdio server. The copy does not share the client's connection, sign-in or state, and lever cannot reach HTTP servers.
- In Claude Code you see one tool call for each run, not one for each step.

## Settings

Environment variables come first, then `~/.config/lever/config.json` (or the file that `LEVER_CONFIG` names), then the defaults.

| Variable | Config key | Default | Meaning |
| :- | :- | :- | :- |
| `LEVER_MAX_OUTPUT` | `maxOutput` | `8000` | Characters that one reply can hold before the rest goes to a file |
| `LEVER_TIMEOUT_MS` | `timeoutMs` | `600000` | Time limit of a run |
| `LEVER_BACKGROUND_TIMEOUT_MS` | `backgroundTimeoutMs` | `7200000` | Time limit of a background job |
| `LEVER_AUTO_BACKGROUND_MS` | `autoBackgroundMs` | `0` (off) for Claude Code, `50000` for other clients | When a run that is still going becomes a job |
| `LEVER_HOOKS` | `hooks` | `auto` | Permission rules and hooks: `on`, `off`, or `auto` (on under Claude Code) |
| `LEVER_GUARDS` | `guards` | none | Guard modules, separated by `:` |
| `LEVER_SHELL` | `shell` | `bash`, else `sh` | The shell for `$` |
| `LEVER_SPILL_DIR` | `spillDir` | `<tmp>/lever-<uid>` | Where long replies are saved |
| `LEVER_MCP_IMPORT` | `mcpImport` | `claude:project` | Which server lists `mcp` offers: `claude` (Claude Code's settings), `project` (`.mcp.json`) |
| | `mcpServers` | none | More MCP servers, in the `.mcp.json` format |
| `LEVER_RG` | | ripgrep on `PATH` | The ripgrep to use, or `off` |

The project folder is `CLAUDE_PROJECT_DIR` when the client sets it. Otherwise it is the folder that the client starts lever in.

## Commands

| Command | What it does |
| :- | :- |
| `lever` | Starts the MCP server on stdin and stdout. Clients run this |
| `lever run -e 'code'`, `lever run file.js`, `lever run -` | Runs code once in the current folder and prints the reply |
| `lever install`, `lever uninstall` | Adds lever to Claude Code and Codex, or removes it (`--claude`, `--codex`, `--scope`, `--force`, `--dry-run`) |
| `lever doctor` | Checks Node, ripgrep, hooks, guard modules, MCP servers and registration, and runs one test |

## Development

```sh
npm test                       # unit tests and stdio tests
npm run bench                  # the measurement without a model
node bench/live.mjs haiku 3    # the measurement in real Claude Code; it uses your Claude Code account
```

## Earlier work

- [CodeAct](https://arxiv.org/abs/2402.01030) (ICML 2024) showed that agents that act through code instead of JSON tool calls succeed more often, in fewer turns.
- Armin Ronacher, [Your MCP Doesn't Need 30 Tools: It Needs Code](https://lucumr.pocoo.org/2025/8/18/code-mcps/) (August 2025).
- Cloudflare, [Code Mode: the better way to use MCP](https://blog.cloudflare.com/code-mode/) (September 2025) and [`@cloudflare/codemode`](https://developers.cloudflare.com/agents/tools/codemode/).
- Anthropic, [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) (November 2025) and [programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling).
- Claude Code's [Code Mode](https://code.claude.com/docs/en/code-mode) (v2.1.323) and Codex's code mode (`features.code_mode`, still under development).

lever is for local coding agents: shell, files, search and MCP in one tool that works in every client and session type, with Claude Code's own permission rules and hooks applied to each step.

## License

MIT
