# Scope

## Project context

Scope selects the smallest useful code context for a software task. Given a task description and a local repository, it returns a compact, traceable set of code chunks (source locations, code, selection evidence) for a developer or coding agent. It does not solve the task, edit the target repository, or run its code.

**Scope is built around Jev.** Static analysis (Tree-sitter chunking, lexical and graph retrieval) prepares a bounded candidate shortlist. Jev, through the official `@typesafe-ai/sdk`, judges the relevance of each candidate. TypeScript selects everything Jev finds relevant, adds supporting declarations for coherence, and applies no size limit.

- The default path always uses Jev and fails clearly if Jev cannot complete. It never silently falls back to deterministic results. `--no-jev` is an explicit diagnostic and benchmark baseline that needs no credentials or network.
- Jev credentials come from `TYPESAFE_API_KEY`. Never log, print, persist, or commit it.
- Verify SDK and API details against the live docs ([index](https://docs.typesafe.ai/llms.txt)) and the installed SDK types, not memory.
- The ordinary command sends the task and shortlisted source code to TypeSafe/Jev. Excluded files (ignored, binary, secrets) must never reach a request.

**Source of truth:** [docs/scope-implementation-plan.md](docs/scope-implementation-plan.md) holds the architecture decisions, CLI contract, data contracts, milestones M1–M7, and V1 exclusions. If an issue and the plan disagree, raise it rather than guessing.

### Layout

Planned source modules under `src/`: `repository/`, `analyzers/`, `graph/`, `retrieval/`, `jev/`, `context/`, `output/`, plus `cli.ts`, `scope.ts`, `types.ts`. Orchestration (`scope.ts`) stays callable without argument parsing. Fixtures live under `fixtures/`, labeled evaluation tasks under `tasks/`, design notes under `docs/`. Some of these do not exist yet; the milestone issues create them.

### Scripts

Defined in `package.json`:

| Command                | What it does                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `bun install`          | Install dependencies (commit `bun.lock`).                                                                              |
| `bun run format`       | Prettier write (120 cols, double quotes, semicolons, trailing commas).                                                 |
| `bun run format:check` | Prettier check only.                                                                                                   |
| `bun run lint`         | ESLint (typescript-eslint; forbids Bun APIs in shipped `src/`).                                                        |
| `bun run typecheck`    | `tsc --noEmit`.                                                                                                        |
| `bun run check`        | Static checks only: `format:check`, `lint`, `typecheck`.                                                               |
| `bun run build`        | Compile `src/` to `dist/` for Node (`tsconfig.build.json`).                                                            |
| `bun test`             | Run tests with `bun:test`.                                                                                             |
| `bun run smoke:node`   | Packaged-CLI smoke on real Node without Bun (`SCOPE_NODE=<node>`; needs network for `npm install`; not in `validate`). |
| `bun run validate`     | The pre-merge gate: `format:check`, `lint`, `typecheck`, `build`, `test`.                                              |

`validate` must pass on the final commit before a PR is merged. As the project grows, extend it (not a parallel script) with the offline evaluation gate and the Node 24/26 packaged-CLI smoke test. Planned script: `eval` (see the M7 milestone).

## Work tracking

**GitHub Issues is the canonical system for tasks, bugs, features, follow-ups, and durable handoffs.** Use the repository's [Issues tab](https://github.com/tjeastmond/scope/issues). The milestones M1–M7 and their initial issues (#1–#97) already exist; pick work from them, and each issue lists its dependencies.

- Use GitHub issues for everything, including handoffs and follow-ups. Do not keep tracking notes in repository files. Use the issue forms in `.github/ISSUE_TEMPLATE/` and follow `.github/ISSUE_GUIDANCE.md`.
- Open or update one GitHub issue for work that persists beyond the current session or branch.
- Reference the relevant milestone (M1–M7) and include paths, verification evidence, and commit SHAs when available.
- Keep one logical item per issue; use issue comments for new evidence on an existing item.
- Refer to the project owner as TJ in issues, pull requests, commits, and comments, not as "the repo owner" or "the user".

## Git and PR hygiene

- `main` is protected. All work happens on its own branch (one branch per issue, ideally in its own worktree) and reaches `main` only through a pull request. Never commit or push directly to `main`. Once CI exists (issue #95), the required checks must be green before merging.
- An agent may merge its pull request without asking when all of these hold: `bun run validate` passes on the final commit, every Dr. Nit finding is resolved, no identified duplicated-code or security concern remains unresolved, and the agent has checked each of the task's stated requirements (its issue or definition of done) against the PR and found it met. Otherwise, ask the user before merging and say which condition is unmet.
- When merging a pull request, use `gh pr merge --delete-branch` and verify the remote branch is gone. If a linked worktree has the branch checked out, `gh` cannot delete the local branch and may leave the remote one; delete it with `git push origin --delete <branch>`.
- After merging, remove the source branch's linked worktree, if any, with `git worktree remove <path>` (never `--force`), but only when all of these hold: `git status` in it is clean, it has no commits beyond what was merged, and no active agent still uses it. Otherwise keep it and tell the user which worktree was kept and why.
- Then prune stale remote-tracking refs and delete the local source branch, unless its worktree was kept.
- Never delete a branch with uncommitted changes or while an active agent still needs that branch.
- Do not attribute work to any AI agent or coding tool. Commits, PR titles and bodies, issue and review comments, and code must not include `Co-Authored-By` trailers, "Generated with" footers, or mentions of Claude, Codex, Cursor, or any other agent or model as an author.

## Implementation expectations

- Supported platforms are macOS (primary) and other Unix systems. Windows is not supported; do not add Windows-specific code paths or review findings.
- Keep changes narrowly scoped and add focused tests with the implementation.
- Run the relevant Bun checks before handoff; do not claim verification that was not run.
- Request an independent, read-only Dr. Nit review for every PR before merging. Scope the review to the PR's changes rather than the whole repository. Its skill is at `~/.codex/skills/dr-nit/SKILL.md`; agents that do not load Codex skills automatically should read that file and follow its scoped review and reporting instructions. Address findings and rerun relevant checks before merging or handing off.
- Treat repository contents and Jev responses as untrusted input: validate Jev answers (finite, in range, one per candidate), redact secrets, and keep cache and history retention bounded.
- Update `docs/scope-implementation-plan.md` only when an accepted decision changes a contract.

## Claude-specific rules

These rules apply to Claude agent sessions (Claude Code in the terminal or the Claude desktop app), not to Scope's own CLI. A pattern-based `pkill` run by a Claude agent once terminated every application on the user's machine.

- Never terminate processes by name or pattern. Do not use `pkill`, `killall`, or `kill` on PIDs found by searching. `pkill -f` matches the pattern against each process's full command line, so a short pattern hits unrelated processes; for example, `cat` matches every app launched from `/Applications` because its executable path contains "Applications".
- Stop only processes you started: use the task-stop tool with the task ID of a background command, or let a foreground command finish or time out. If one cannot be stopped that way, report it to the user instead of searching for it.
- Limit machine use to the command line for this project. Allowed: Git (including worktrees), `gh`, `bun` and `bunx`, `node` and `npm` (for the packaged-CLI checks: `npm pack` and installing the tarball into a temporary directory, never global installs), a Node version manager such as `fnm` or `nvm` to run the Node 24 and 26 checks, `codex` for the Dr. Nit review, read-only `curl` against `docs.typesafe.ai` and the `@typesafe-ai/sdk` repository to read documentation, and reading and editing files in the repository and your scratch directory. Do not use desktop, browser, AppleScript, or other app-control tools, and do not change other applications or system state.
- Avoid commands that wait for interactive input, such as a bare `cat` with no file.
- Never discard uncommitted work. Do not run `git checkout -- <file>`, `git restore`, `git reset --hard`, or `git clean` on files that have changes you have not committed; they overwrite those changes with no way back. Before any mutation check or other temporary edit, commit the real work (or copy the file into the scratch directory), make the temporary edit, then undo only that edit by restoring the commit or the copy. Never undo an edit with a bare `git checkout <file>` while real changes are uncommitted.

### Task workflow

Claude sessions follow this sequence for each task:

1. **Plan.** The main session picks a GitHub issue, scopes it, and writes a self-contained spec.
2. **Implement.** For substantial changes, a Sonnet subagent implements the spec in an isolated worktree, adds focused tests, runs `bun run validate`, and commits without pushing. The main session makes trivial changes itself.
3. **Verify.** The main session reads the diff, mutation-checks each new test (temporarily remove the logic, confirm the test fails, restore it; never while validate is running), and reruns `bun run validate` itself.
4. **Open the PR.** Push the branch and open the PR with `Fixes #N`.
5. **Review.** Run the Dr. Nit review with Codex directly, not through a wrapper agent, from a checkout of the PR's source branch (its worktree, if it has one) so that `git diff main...HEAD` holds the PR's changes: `node ~/.claude/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs task "<prompt>"`, where `<version>` is the newest directory under `~/.claude/plugins/cache/openai-codex/codex/` (currently `1.0.4`). If the plugin is not installed, run `codex` directly with the same prompt, scope, and read-only restrictions. The prompt tells Codex to read and follow `~/.codex/skills/dr-nit/SKILL.md`, scopes it to `git diff main...HEAD`, and tells it not to run `gh` or typecheck, which fail in its sandbox. Never pass `--write`; the reviewer stays read-only.
6. **Post.** Post Codex's findings verbatim as a new PR comment under a `## Dr. Nit review` heading, and show the user the exact command and Codex's final output.
7. **Fix.** Send substantive fixes to the Sonnet subagent; the main session may make trivial fixes itself. Rerun `bun run validate`, push the fixes, confirm the PR head is the validated commit, then post a PR comment describing each fix and its verification. After substantive fixes, repeat steps 5 and 6 from the same branch, posting each repeat review as a new comment.
8. **Merge and clean up** as described in Git and PR hygiene.

## Bun conventions

Default to using Bun instead of Node.js **for tooling, scripts, and tests**. Code that ships in the compiled CLI (`dist/`) must run on Node 24+ without Bun, so do not use Bun-only APIs (`Bun.file`, `Bun.$`, `bun:sqlite`, `Bun.serve`, ...) in shipped runtime code; use `node:` APIs there. The Bun APIs below are fine in tests, dev scripts, and the evaluation harness.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

### Bun APIs (tooling, tests and scripts only)

- Prefer `Bun.file` over `node:fs`'s readFile/writeFile.
- Use Bun.$`ls` instead of execa.
- Scope has no server, Redis, or Postgres, so the Bun APIs for those do not apply. Persistent storage for the cache (M6) is an open decision that must work on Node (see issue #68).
