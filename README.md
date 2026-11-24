# lever

Code Mode for any MCP client. The model writes one piece of JavaScript. lever runs it with shell, file, search and MCP helpers, and only what the code returns goes back to the model.

lever is tested with Claude Code 2.1.330 (`claude -p` and a background session), with Codex (`codex exec`) and with Grok Build 1.0.92 (`grok -p`). Other clients that start MCP servers over stdio use the same protocol, but they are not tested yet. lever has no dependencies and needs Node 20.11 or newer.

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

`npm run stress` gives Claude Code eleven tasks that each take several steps, on a generated project of 82 files: fix bugs until the tests pass, move a function and update every import, change a function's signature and every caller, find the commit that broke a test, follow a chain of fifteen files, and others. Each task runs three ways: with only the built-in tools (Glob, Grep, Read, Edit, Write, Bash), with the built-in tools and lever (a normal install), and with only lever's `run`. Each run works on a fresh copy of the project, and a checker decides whether the result is right. Each row is the median of three runs.

A model call is one round trip to the model. Claude Code's own turn count is the number of tool calls plus one, which hides that the built-in tools can send several calls in one round trip, so it is not used here. These runs used Claude Code 2.1.330 on 2026-11-24, without the user's own settings and hooks.

Claude Haiku, 99 runs, all results right:

| Sum of the eleven tasks | Right | Model calls | Tool calls | Input tokens | Output tokens | Cost (USD) | Time (s) |
| :- | :-: | -: | -: | -: | -: | -: | -: |
| Built-in tools | 33/33 | 56 | 74 | 1,328,725 | 20,811 | 0.0508 | 113.0 |
| Built-in tools + lever | 33/33 | 37 (−34%) | 28 (−62%) | 904,163 (−32%) | 12,802 (−38%) | 0.0391 (−23%) | 73.7 (−35%) |
| lever only | 33/33 | 33 (−41%) | 22 (−70%) | 657,964 (−50%) | 11,523 (−45%) | 0.0354 (−30%) | 67.4 (−40%) |

Claude Opus, 99 runs, all results right:

| Sum of the eleven tasks | Right | Model calls | Tool calls | Input tokens | Output tokens | Cost (USD) | Time (s) |
| :- | :-: | -: | -: | -: | -: | -: | -: |
| Built-in tools | 33/33 | 41 | 30 | 896,447 | 8,624 | 1.2452 | 105.8 |
| Built-in tools + lever | 33/33 | 35 (−15%) | 24 (−20%) | 801,265 (−11%) | 6,983 (−19%) | 1.1271 (−9%) | 86.8 (−18%) |
| lever only | 33/33 | 35 (−15%) | 24 (−20%) | 648,274 (−28%) | 7,412 (−14%) | 1.0981 (−12%) | 87.3 (−17%) |

By task with Haiku, as built-in tools → built-in tools + lever → lever only:

| Task | Model calls | Input tokens | Time (s) | lever chosen |
| :- | :-: | :-: | :-: | :-: |
| Fix three bugs until the tests pass | 4 → 4 → 4 | 100k → 106k → 88k | 9 → 8 → 7 | 3/3 |
| Move a function to a new module and update every import | 5 → 4 → 3 | 123k → 99k → 60k | 15 → 9 → 9 | 3/3 |
| Find the exports nothing else uses | 4 → 2 → 2 | 106k → 45k → 36k | 14 → 5 → 5 | 3/3 |
| Triage a 4 MB log | 4 → 3 → 2 | 87k → 69k → 36k | 7 → 5 → 4 | 3/3 |
| Add a function with tests | 4 → 3 → 3 | 91k → 71k → 57k | 7 → 6 → 6 | 3/3 |
| Apply a config file to fifteen modules | 4 → 4 → 4 | 95k → 103k → 86k | 7 → 6 → 6 | 3/3 |
| Find every file that depends on a module | 3 → 2 → 2 | 70k → 45k → 36k | 12 → 7 → 6 | 3/3 |
| Fix two bugs in a 660-line module | 4 → 5 → 5 | 116k → 129k → 107k | 8 → 9 → 8 | 2/3 |
| Change a function signature and every caller | 4 → 4 → 3 | 96k → 95k → 59k | 11 → 7 → 6 | 3/3 |
| Find the commit that broke a test | 4 → 4 → 3 | 90k → 96k → 57k | 8 → 10 → 9 | 0/3 |
| Follow a chain of fifteen config files | 16 → 2 → 2 | 355k → 45k → 36k | 14 → 3 → 3 | 3/3 |

What the numbers show:

- The gain depends on the shape of the task. Where each step depends on the one before (a chain of files, an analysis over many files, a log), one run takes the place of many model calls: 16 → 2 for the chain. Where the work is "read, edit, test", the built-in tools already send several calls in one round trip. There lever takes the same number of model calls, and it saves tool calls, output tokens and some time.
- The gain depends on the model. Opus plans the built-in calls well and writes shell loops by itself, so a normal install saves it 15% of the model calls and 18% of the time, where Haiku saves 34% and 35%.
- One task carries much of the Haiku total. Without the chain task, a normal install saves 12% of the model calls and 12% of the input tokens with Haiku.
- lever is not better everywhere. For the 660-line module, both models needed one more model call with lever than without. A reply holds 8,000 characters, so a whole large file does not come back at once.
- "lever only" also removes the six built-in tool definitions, which is about 3,300 tokens less on each model call. To run Claude Code this way, start it with `claude --disallowedTools Bash Read Edit Write Glob Grep`. `claude --tools ""` removes every built-in tool and leaves lever alone; the next measurement shows what that changes.
- In a normal install the model picks the tool. Haiku picked lever in 29 of 33 runs and Opus in 33 of 33. The wording of lever's instructions decides this: before they named loops and steps that follow from each other, Haiku read the fifteen chain files one by one in 5 of 9 runs.
- Three runs for each row is a small sample, and a row often moves by one model call from run to run. Drawn again at random from the same runs, the saving of a normal install with Haiku lies between 29% and 38% of the model calls. Run the script with your own model and project before you rely on these numbers.

[bench/results/2026-11-24.md](bench/results/2026-11-24.md) has the full tables, the results before this round of fixes, what the model's own code showed, and the test of three reply limits.

### Against Claude Code's own Code Mode

Claude Code has an experimental Code Mode of its own. It starts only in an interactive session in a terminal, so `bench/stress/terminal.mjs` runs the same eleven tasks in such sessions through tmux and reads the numbers from each session's transcript. Every way ran in that kind of session, so all rows come from the same setup. Claude Haiku, Claude Code 2.1.331 on 2026-11-24, three runs for each row, 198 sessions:

| Sum of the eleven tasks | Right | Model calls | Input tokens | Output tokens | Cost (USD) | Time (s) |
| :- | :-: | -: | -: | -: | -: | -: |
| Built-in tools | 33/33 | 59 | 2,236,725 | 18,925 | 0.0570 | 134.3 |
| Code Mode | 31/33 | 39 (−34%) | 995,811 (−55%) | 15,713 (−17%) | 0.0437 (−23%) | 106.5 (−21%) |
| Built-in tools + lever | 33/33 | 38 (−36%) | 1,480,664 (−34%) | 12,825 (−32%) | 0.0447 (−22%) | 92.8 (−31%) |
| lever only | 33/33 | 37 (−37%) | 1,321,263 (−41%) | 13,030 (−31%) | 0.0433 (−24%) | 91.4 (−32%) |
| lever, no built-in tools | 32/33 | 39 (−34%) | 316,549 (−86%) | 12,778 (−32%) | 0.0209 (−63%) | 84.3 (−37%) |
| Code Mode + lever | 31/33 | 35 (−41%) | 924,652 (−59%) | 16,019 (−15%) | 0.0445 (−22%) | 105.5 (−21%) |

What the numbers show:

- **Model calls and cost are the same.** Code Mode took 39 model calls, a normal install of lever 38, and lever only 37. Three runs for each row cannot tell these apart, and the cost is within 3%.
- **Code Mode reads fewer input tokens than a normal install of lever, because of the tool definitions.** A model call starts at 35,472 tokens in a session with the built-in tools, at 36,553 with lever added, and at 22,369 in Code Mode, which replaces the tool definitions with one description. So a normal install of lever read 49% more input tokens than Code Mode. Most of them come from the prompt cache, which is cheap, so the cost is the same.
- **lever with no built-in tools reads the fewest.** `claude --tools ""` leaves lever as the only tool, and a model call starts at 5,779 tokens. The eleven tasks took 68% fewer input tokens than in Code Mode and about half the cost. The session then has no subagents, skills or web tools, and Haiku wrote worse code there: 12 of 87 runs of lever failed, against 2 of 80 with the other tool definitions present.
- **lever was faster, and its answers were right.** A normal install took 92.8 s against 106.5 s. Code Mode had 2 of 33 answers wrong, both on the 4 MB log: a shell result held 13,015 of the log's 42,000 lines with no notice, and the counts of that part went into the answer.
- **Code Mode's own code did not fail once** in 83 pieces. lever's failed 4 times in 58 runs in a normal install.
- **Running both gains nothing.** With Code Mode on and lever connected, the model used lever in none of 33 sessions.
- This is Haiku only, and Code Mode is experimental: it can change in any release.

So where both can run, in a terminal session, they do about the same work for each model call. Where Code Mode cannot start (`claude -p`, background sessions, other clients such as Codex), lever does. [bench/results/2026-11-24-code-mode.md](bench/results/2026-11-24-code-mode.md) has the method, the tables by task and what the code of each side showed.

### In Grok Build

lever is an MCP server, so other clients can use it. `bench/stress/grok.mjs` runs the same eleven tasks in Grok Build 1.0.92 (`grok -p`, grok-4.7, reasoning effort xhigh), with Grok's own tools only and with lever among its MCP servers. No rule and no prompt named lever. Three runs for each row, 66 runs, 2026-11-24:

| Sum of the eleven tasks | Right | Model calls | Input tokens | Output tokens | Cost (USD) | Time (s) |
| :- | :-: | -: | -: | -: | -: | -: |
| Grok's own tools | 33/33 | 82 | 3,654,872 | 30,687 | 1.1013 | 516.3 |
| Grok's own tools + lever | 33/33 | 57 (−30%) | 2,497,992 (−32%) | 31,859 (+4%) | 0.8732 (−21%) | 544.5 (+5%) |

- **Grok picked lever by itself** in 29 of 33 runs. It finds MCP tools through its tool search, and the instructions of the server were enough.
- **Two tasks carry almost all of the gain.** The chain of fifteen files went from 16 model calls to 4, and the bisect task from 16 to 5. The other nine tasks took 50 model calls without lever and 48 with it.
- **The bisect gain has a special cause.** In two of three runs without lever, Grok did not run the model's shell loop in this unattended mode, because its permission check could not read the command. Inside lever the loop is code, and Grok's check of commands does not apply there. That helps unattended runs, and it means that steps inside lever do not pass through Grok's own permission rules.
- **No gain in time** (516 s against 544 s). A session spends one model call on the search for lever.
- **lever does not make Grok's context larger**: Grok does not load the tool definitions of MCP servers.
- lever's code failed in 7 of 62 runs; five times the model wrote `$"npm test"`, a string where JavaScript needs a template.

[bench/results/2026-11-24-grok.md](bench/results/2026-11-24-grok.md) has the method and the numbers by task.

### Without a model

`npm run bench` does four short tasks both ways on copies of this repository, without a model. The built-in side makes one call for each step and counts the output that Claude Code's tools return (Read with line numbers, absolute paths). The lever side makes one `run` call and counts its reply. Tokens are estimated as characters ÷ 4.

| Task | Tool calls | Characters the model reads | ≈ Tokens | Fewer |
| :- | :-: | -: | -: | -: |
| Three longest source files | 16 → 1 | 184,831 → 129 | 46,208 → 32 | 99.9% |
| Where each export of format.mjs is used | 15 → 1 | 16,555 → 229 | 4,139 → 57 | 98.6% |
| Rename a function everywhere | 5 → 1 | 34,525 → 158 | 8,631 → 40 | 99.5% |
| Run the tests, report only failures | 1 → 1 | 6,798 → 416 | 1,700 → 104 | 93.9% |
| **All four** | **37 → 4** | **242,709 → 932** | **60,677 → 233** | **99.6%** |

The rename leaves the same files both ways. This is the most that lever can save, because the built-in side here takes one call for every step. A real model often finds a shorter way with the built-in tools too (several calls in one round trip, or one shell command that does the whole task), so the measurement in real Claude Code above shows smaller savings.

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

The tool description is about 1.6 KB. Claude Code loads it up front (`anthropic/alwaysLoad`), so the first call needs no tool search. Details that the model rarely needs are behind `help(topic)`.

### Helpers inside the code

Paths are relative to the project folder, and commands run there. Every helper is async.

| Helper | What it does |
| :- | :- |
| `` await $`cmd ${x}` `` | Runs a shell command. Interpolated values are quoted. It throws on a non-zero exit. The result is `{stdout, stderr, exitCode, ok}`. Before the command starts, chain `.nothrow()`, `.cwd(dir)`, `.env({...})`, `.timeout(ms)` or `.input(text)`; then `.text()`, `.lines()` or `.json()`. The same settings work as options: `` $({cwd, env, timeout, input})`...` ``. |
| `await read(path, {from, to})` | Reads a file, or a range of its lines. |
| `await write(path, text or object)` | Writes a file and creates its folders. An object is written as JSON. |
| `await edit(path, old, new, {all})` | Replaces text. Without `all`, the text must occur exactly once; otherwise it throws with the line numbers or a hint. Text that is given with every line indented more or less than in the file is still found, and the reply says so. Edits of one file that start together run one after another, so all of them land. Also `edit(path, [[old, new], ...])` and `edit(path, text => newText)`. |
| `await exists(path)`, `await ls(dir)` | Checks a path. Lists a folder. `exists` without `await` is a promise, which is always truthy; the reply points that out. |
| `await glob('src/**/*.ts')` | Lists files, sorted. Hidden names, `node_modules` and what `.gitignore` files name are skipped, with ripgrep and without it. |
| `await grep(/re/i or 'text', {path, glob, context, files, count, max})` | Searches with ripgrep, or with Node when ripgrep is missing. Returns `[{file, line, text}]`, printed as `file:line:text`; `{files: true}` returns paths and `{count: true}` returns counts. Patterns that only JavaScript understands (lookbehind, backreferences) are matched by Node over the same files. A string that is no regular expression is searched for as plain text. |
| `undo()` | Puts back the files that the most recent changing run wrote. |
| `state` | An object that is kept between runs. Variables are not kept: each run has its own scope. |
| `jobs.list()`, `jobs.wait(id)`, `jobs.cancel(id)` | Background jobs. |
| `mcp.<server>.<tool>(args)` | Calls another MCP server from the code: the stdio servers in Claude Code's settings, in `.mcp.json` and in lever's config. `mcp.servers()` and `mcp.tools(name)` list them. |
| `help(topic)` | More detail on `shell`, `files`, `search`, `mcp`, `jobs` or `output`. |

Node's own modules also work (`import`, `require`), but they skip lever's checks. See [Safety](#safety).

### The reply

1. What the code logged, then the result. Strings print as they are. An object prints its one-line values as `key: value` lines, then each value of several lines under a `==> key <==` line, exactly as it is. File text that comes back this way can go into `edit` unchanged. Arrays of objects print one JSON object per line.
2. After `---`, a summary: the steps by kind, the bytes read and returned, and the time; failed and refused steps; changed files, with a reminder that `undo()` puts them back; messages from hooks; and notes about likely mistakes, such as a helper that was called without `await`.
3. When a reply would be longer than 8,000 characters, the longest strings are cut in the middle first and long lists are shortened after that, only as much as needed. The whole text is saved to a private file, and the reply gives its path. A saved text holds at most 16 MB, and saved texts older than a week are removed when the server starts.
4. An error names the line of the code that threw. Common mistakes get a hint: a missing semicolon before a line that starts with `(`, a variable with the name of a helper, a name from an earlier run, a method that `$` does not have. A missing file comes with the close names in its folder.

### Long runs

A run stops after 10 minutes, and a background job after 2 hours. Codex stops waiting for an MCP tool after 60 seconds, so for clients other than Claude Code, lever replies after 50 seconds and lets the run go on as a job. The model then gets the result with `jobs.wait(id)`. If a run never gives control back, as in an endless loop, lever replaces its worker thread, ends the processes that the run started, and starts with a new `state`. An error that code leaves behind (a timer that throws later, a rejected promise that nobody awaits) does not end the thread: the next reply shows it as a note.

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

Claude Code added an experimental Code Mode in v2.1.323 (November 2026). The facts in the left column come from its [documentation](https://code.claude.com/docs/en/code-mode), read on 2026-11-21. A measurement of the two in the same terminal sessions is under [Measurements](#against-claude-codes-own-code-mode).

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
- `import()` of a project file keeps the copy that it loaded first. When the file changed since then, a note says so. To run the new code, start a process (`` $`node file.mjs` ``).
- Without ripgrep, `.gitignore` support is the usual subset (comments, `!`, anchored and folder-only patterns). `.git/info/exclude` and the global ignore file are not read.

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
npm run edge                   # 67 edge cases against the real server, without a model
npm run bench                  # the measurement without a model
npm run stress -- --model haiku --repeats 3    # eleven multi-step tasks in real Claude Code; it uses your Claude Code account
node bench/stress/terminal.mjs --model haiku    # the same tasks in terminal sessions, with Claude Code's Code Mode; needs tmux
node bench/stress/grok.mjs --repeats 3         # the same tasks in Grok Build; it uses your Grok account
node bench/stress/selftest.mjs # checks the stress tasks' own checkers
node bench/live.mjs haiku 3    # four short tasks in real Claude Code
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
