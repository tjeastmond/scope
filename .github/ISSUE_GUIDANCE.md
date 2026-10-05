# Issue guidance

GitHub Issues is the canonical place for tasks, bugs, features, follow-ups, and handoffs. Do not track work in repository files.

## Before opening an issue

- Search existing issues first. The milestones M1–M7 and their initial issues already cover the [implementation plan](../docs/scope-implementation-plan.md); add evidence to an existing issue instead of opening a duplicate.
- One logical item per issue. Use comments for new evidence, status, and handoff notes.

## What a good issue contains

- **Goal:** the outcome, not the implementation.
- **Context:** the relevant plan section, milestone (M1–M7), and file paths.
- **Acceptance criteria:** a checklist someone else can verify.
- **Dependencies:** other issues that must land first (`Depends on: #N`).
- **Verification evidence:** commands run and their results, plus commit SHAs, when closing or handing off.

## Scope-specific rules

- Scope is built around Jev. Do not propose replacing the Jev relevance decision on the default path with heuristics. `--no-jev` is an explicit baseline only.
- If something cannot be verified (for example live Jev calls without `TYPESAFE_API_KEY`), say it is **blocked** in the issue rather than closing it as complete.
- Never paste API keys, tokens, or private source code into an issue. This repository is public.
- Refer to the project owner as TJ.

## Labels and milestones

Every issue gets one milestone (M1–M7) when it belongs to the plan, and area labels: `jev`, `parsing`, `graph`, `retrieval`, `output`, `cache`, `eval`, `cli`, `infra`, `testing`, `docs`. Use `bug` for defects.
