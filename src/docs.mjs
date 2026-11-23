// What the model reads: the tool description (sent with every request, so it stays short), the server instructions,
// and help(topic) for the details, read only when needed.

/** The tool description. It says how much text a reply holds, so code can be written to return what fits. */
export const toolDescription = (maxOutput = 8000) => `Run JavaScript (Node, async) that does many steps in one call. Use it in place of separate Bash, Read, Grep, Glob and Edit calls whenever a task takes more than one step. Only what the code returns or logs comes back, so search, read, edit and test in one run and return just the part you need.

Helpers (each is async: await it. Paths are relative to the project folder, and commands run there):
await $\`cmd \${x}\`  shell; values are quoted; throws on a non-zero exit; result {stdout, stderr, exitCode, ok}. Chain .nothrow() .cwd(dir) .env({}) .timeout(ms) .input(text), then .text() .lines() .json()
await read(path, {from, to})  ·  await write(path, text|object)  ·  await exists(path)  ·  await ls(dir)
await edit(path, old, new, {all})  ·  edit(path, [[old, new], ...])  ·  edit(path, text => newText)
await glob('src/**/*.ts')  → paths, sorted; .gitignore and node_modules are skipped
await grep(/re/i or 'text', {path, glob, context, max})  → [{file, line, text}]; {files: true} → paths; {count: true} → {path: n}
undo()  puts back what the last changing run wrote  ·  state  kept between runs (variables are not)  ·  sleep(ms)
jobs.wait(id) · jobs.list() · jobs.cancel(id)  for runs moved to the background
mcp.<server>.<tool>(args)  call other MCP servers; mcp.servers(), mcp.tools(name)
help('shell' | 'files' | 'search' | 'mcp' | 'jobs' | 'output')  more detail

The last expression (or a top-level return) is the result. Promise.all runs steps in parallel. Each step still passes the user's hooks and guards. A reply holds up to ${maxOutput.toLocaleString('en-US')} characters: longer values are cut in the middle and the whole text is saved to a file.`

export const INSTRUCTIONS = `When work on files or commands takes more than one step (search then read, read then edit, edit then test, the same change in several files), start with lever's run tool: write one piece of JavaScript that does all the steps with its helpers and returns only what you need. One run takes the place of several Bash, Read, Grep, Glob and Edit calls, so the task takes fewer turns and their output stays out of the conversation. Use the separate tools only when one small call answers the request.`

const TOPICS = {
  shell: `$\`git log -n 3 \${branch}\`   interpolated values are quoted as single arguments; arrays become several arguments.
$.raw(text) inserts text unquoted. $('whole command') runs a string as it is. Commands run in the project folder.
Throws ShellError on a non-zero exit (message has the exit code and the end of stderr); .nothrow() returns the result instead.
Result: {stdout, stderr, exitCode, signal, ok, ms}. String(result) is stdout.
Before the command starts: .nothrow() · .cwd('sub') · .env({ CI: '1' }) · .timeout(ms) stops it (and what it started) · .input(text) is its standard input.
Then: .text() trims the last newline · .lines() · .json().
The same as options: $({ cwd: 'sub', env: { CI: '1' }, timeout: 60000, nothrow: true, input: text })\`npm test\`
Run independent commands together: await Promise.all([$\`npm run lint\`, $\`npm test\`]).
To run a project file after changing it, start a process ($\`node file.mjs\`): import() keeps the first copy it loaded.`,
  files: `read(path) → text · read(path, {from: 10, to: 40}) → those lines · read(path, {encoding: 'buffer'})
write(path, text | Buffer | object) creates folders; objects are written as JSON. Returns {path, bytes}.
edit(path, old, new) replaces exactly one match; it throws if the text is missing (with a hint) or found more than once (with line numbers). {all: true} replaces every match.
Text given with every line indented more or less than in the file, or with other line endings, is still found; the new text moves the same way and a note says so.
edit(path, [[old1, new1], [old2, new2]]) applies several in order · edit(path, text => text.replace(...)) for anything else.
Edits of one file that start together (Promise.all) run one after another, so all of them land.
await exists(path) → true or false (without await it is a promise, which is always truthy) · ls(dir) → names, folders end with /.
A grep match or a write result can stand for its path: read(match), edit(match, old, new).
undo() puts back the files the most recent changing run wrote (a new file is removed). undo(runId) for an older run.
A file changed again since is skipped; undo(id, {force: true}) overwrites it anyway.`,
  search: `glob(pattern, {cwd, hidden, ignored, all, ignoreCase}): *.ts matches only the top folder; **/*.ts every folder; {a,b} and [abc] work.
Hidden folders, node_modules and .gitignore'd files are skipped unless {hidden: true} / {ignored: true} / {all: true}, or the pattern points inside node_modules.
grep(pattern, {path, glob, type, ignoreCase, fixed, word, multiline, context, before, after, max, files, count})
  pattern: a string (regex) or a RegExp (its i flag counts). path: a file, a folder, or a list.
  JavaScript patterns work, lookbehind and backreferences too. A string that is no regular expression is searched for as plain text.
  → [{file, line, text, before?, after?}]; {files: true} → paths; {count: true} → {path: matches}.
  Stops at max matches (default 2000) and says so. Long lines are cut around the match.
Returned matches print as file:line:text lines.`,
  mcp: `mcp.servers() lists the MCP servers lever can start (from Claude Code's settings, .mcp.json and lever's config).
mcp.tools('server') lists that server's tools with their parameters.
await mcp.server.tool({ ...args }) or mcp.call('server', 'tool', args). Use mcp['name-with-dash'] for names with dashes.
Results: structured content when the tool gives it, else the text (JSON text is parsed); images are saved to a file and come back as {image: path}.
Each server starts on first use and stays up for the session. It is a separate copy of the server, not the one your client already runs.`,
  jobs: `A run that is still going after the background limit (Codex: 50 s) returns early and keeps running as a job.
Call run with {"background": true} to start one on purpose.
jobs.list() → [{id, status, seconds, last}] · await jobs.wait(id, ms) → the job's reply, or a still-running note
  (by default it waits as long as the client allows one call, else 30 s)
jobs.cancel(id) stops it and what it started. A run stops after 10 minutes (background: 2 hours) unless {"timeout": seconds} says otherwise.`,
  output: `The reply is: console output, then the returned value, then a summary line (steps, bytes read and returned, time),
failed or refused steps, changed files, and notes from hooks.
Strings print as they are. An object prints its one-line values as key: value lines, then each value of several lines under a "==> key <==" line, exactly as it is, so file text can go back into edit() unchanged. Arrays of objects print one JSON per line.
Shell results print their stdout (or exit code and stderr when they failed). Promises inside the returned value are awaited.
When a reply would pass the limit, the longest strings are cut in the middle first, then long lists are shortened; the whole text is saved to a file whose path is in the reply.
Return less, not more: filter, count and summarise in the code. To read part of a big file, use grep with {context} or read(path, {from, to}).`,
}

export function help(topic) {
  if (topic && TOPICS[topic]) return TOPICS[topic]
  const names = Object.keys(TOPICS).join(', ')
  return topic ? `No help topic "${topic}". Topics: ${names}` : `${toolDescription()}\n\nTopics: ${names}`
}
