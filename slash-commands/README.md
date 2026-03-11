# slash-commands

Reusable composite action that implements Prow-style `/lgtm`, `/hold`, and
`/stageblog` slash commands on pull requests, gated by team membership and
CODEOWNERS.

## What it does

Listens for PR comments and push events, then:

- **`/lgtm`** — if the commenter is a core maintainer _or_ a CODEOWNER of the
  PR's changed files, adds an `approved` label and submits a bot **APPROVE**
  review with body "Approved on behalf of @user via `/lgtm`."
- **`/lgtm cancel`** — removes the `approved` label and dismisses the bot
  review.
- **`/hold`** — adds a `do-not-merge/hold` label (same authorization rule).
- **`/hold cancel`** or **`/unhold`** — removes the hold label.
- **`/stageblog`** — if the PR touches any blog paths (default `blog/**`),
  dispatches a caller-defined `workflow_dispatch` workflow passing the PR
  number and the PR's head SHA **at the time of the comment**. Intended for
  letting maintainers manually stage blog previews for fork PRs (where the
  normal `pull_request`-triggered preview workflow can't access secrets).
  Disabled unless `stageblog-workflow` is set.
- **New commits pushed** — removes the `approved` label, dismisses the bot
  review, and posts a brief comment asking for re-approval.

Commands are parsed from the **first line** of the comment (case-insensitive,
must match `^/cmd\b`). Unauthorized attempts, or a PR author trying to `/lgtm`
their own PR, receive a 👎 reaction with no further noise. Successful commands
receive a 👍 reaction.

The caller workflow pairs this with the `slash-commands/status` sub-action,
which sets a commit status that stays **pending** until `approved` is present
and goes **failure** when `do-not-merge/hold` is present — making the labels
an actual merge gate via branch protection without a red ❌ on every fresh PR.

## Prerequisites

- The `approved` and `do-not-merge/hold` labels **must already exist** in the
  caller repo (the action does not auto-create them). Suggested colors:
  `approved` → `#0e8a16`, `do-not-merge/hold` → `#d93f0b`.
- A CODEOWNERS file at `.github/CODEOWNERS` (or pass a different path via
  `codeowners-path`). Without one, only `always-allow-teams` members can act.

## Required secrets

Create this secret in the caller repo: GitHub → repo → **Settings → Secrets
and variables → Actions → New repository secret**.

| Repo secret name | Action input | Value |
|---|---|---|
| `SLASH_COMMANDS_TOKEN` | `github-token` | Fine-grained PAT (or GitHub App installation token) with **Organization → Members: read** plus **Repository → Contents: read**. If `/stageblog` is enabled, additionally **Repository → Actions: write**. |

> **The default `${{ github.token }}` will NOT work** for `github-token` —
> team-membership checks (`GET /orgs/{org}/teams/{team}/memberships/{user}`)
> require `read:org` scope, which the automatic `GITHUB_TOKEN` never has. You
> _must_ provide a PAT or App token. Comments, reactions, labels, and reviews
> use a separate `bot-token` (defaults to `GITHUB_TOKEN`) so they show as
> authored by `github-actions[bot]`.

### `SLASH_COMMANDS_TOKEN`

**Option A — fine-grained PAT (recommended for single-repo setups):**

GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained
tokens → Generate new token**. Configure:

| Section | Setting |
|---|---|
| Resource owner | `modelcontextprotocol` (or your org) |
| Repository access | **Only select repositories** → pick the caller repo |
| Repository permissions → Contents | Read-only |
| Organization permissions → Members | Read-only |
| Repository permissions → Actions | Read and write _(only if `stageblog-workflow` is set)_ |

The PAT does not need write permissions — all writes (comments, reactions,
labels, reviews) use the workflow's `GITHUB_TOKEN`. **Contents** must remain
read-only — the action never writes code.

**Option B — GitHub App installation token:**

If your org already uses a bot App, generate an installation token with the
same scopes and store it as `SLASH_COMMANDS_TOKEN`. The App must be installed
on the caller repo _and_ have org-level **Members: read**.

## Caller workflow requirements

| | |
|---|---|
| **Triggers** | `issue_comment` (types: `created`) + `pull_request_target` (types: `synchronize`, `opened`, `reopened`, `labeled`, `unlabeled`) |
| **Permissions** | `pull-requests: write`, `issues: write`, `contents: read`, `statuses: write`. If `/stageblog` is enabled, also `actions: write`. |
| **Fork-PR safety** | No special guard needed — `issue_comment` and `pull_request_target` both run in the **base** repo's context with the base workflow definition, so fork authors cannot modify the logic. CODEOWNERS is also fetched from the PR's **base** ref, never the head. |
| **No checkout** | The action calls GitHub API only. Do not `actions/checkout` PR code. |

## Usage

```yaml
name: Slash Commands

on:
  issue_comment:
    types: [created]
  pull_request_target:
    types: [synchronize, opened, reopened, labeled, unlabeled]

permissions:
  pull-requests: write
  issues: write
  contents: read
  statuses: write

jobs:
  handle:
    if: >-
      (github.event_name == 'issue_comment' && github.event.issue.pull_request) ||
      (github.event_name == 'pull_request_target' && github.event.action == 'synchronize')
    runs-on: ubuntu-latest
    steps:
      - uses: modelcontextprotocol/actions/slash-commands@main
        with:
          github-token: ${{ secrets.SLASH_COMMANDS_TOKEN }}
          always-allow-teams: core-maintainers,lead-maintainers
          # stageblog-workflow: stage-blog.yml  # uncomment to enable /stageblog

  # Merge-gate commit status. Mark `slash-commands/approval` as a required
  # status check in branch protection. This stays pending (yellow) until
  # /lgtm adds the approved label — no red ❌ on fresh PRs.
  status:
    if: github.event_name == 'pull_request_target'
    runs-on: ubuntu-latest
    steps:
      - uses: modelcontextprotocol/actions/slash-commands/status@main
```

### Enabling `/stageblog` — companion workflow

When `stageblog-workflow` is set, you also need a separate workflow in the
caller repo that receives the dispatch. Example `stage-blog.yml`:

```yaml
name: Stage Blog (fork PRs)

on:
  workflow_dispatch:
    inputs:
      pr_number:
        required: true
        type: string
      head_sha:
        required: true
        type: string

permissions:
  contents: read
  pull-requests: write

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          ref: ${{ inputs.head_sha }}   # pinned — do NOT re-fetch the PR head

      # ... your blog build steps → output to blog/public ...

      - uses: modelcontextprotocol/actions/cloudflare-pages-preview/deploy@main
        with:
          directory: blog/public
          project-name: mcp-blog-preview
          api-token: ${{ secrets.CF_PAGES_PREVIEW_API_TOKEN }}
          account-id: ${{ secrets.CF_PAGES_PREVIEW_ACCOUNT_ID }}
          branch: pr-${{ inputs.pr_number }}
          pr-number: ${{ inputs.pr_number }}
          commit-sha: ${{ inputs.head_sha }}
          comment-title: "Blog Preview (staged via /stageblog)"
          comment-marker: "<!-- stage-blog-comment -->"
```

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | ✅ | — | PAT or App token with `read:org` + repo `contents: read` (+ `actions: write` for `/stageblog`). Used for team membership checks, CODEOWNERS fetch, and workflow dispatch. **Default `GITHUB_TOKEN` will not work** for team checks. |
| `bot-token` | | `${{ github.token }}` | Token for user-visible side effects (comments, reactions, labels, reviews) — defaults to `GITHUB_TOKEN` so these show as `github-actions[bot]`. Rarely needs overriding. |
| `approved-label` | | `approved` | Label added by `/lgtm` |
| `hold-label` | | `do-not-merge/hold` | Label added by `/hold` |
| `always-allow-teams` | | `core-maintainers` | Comma-separated team slugs (in the repo's org) whose members can `/lgtm` or `/hold` any PR regardless of CODEOWNERS |
| `codeowners-path` | | `.github/CODEOWNERS` | Path to CODEOWNERS, fetched from the PR's **base** ref (never head — tamper-proof) |
| `invalidate-on-push` | | `'true'` | Remove `approved` label + dismiss bot review + comment when new commits are pushed. Set `'false'` to keep approval across pushes. |
| `submit-review` | | `'true'` | Submit a bot APPROVE review alongside the label on `/lgtm`. Set `'false'` to use label only. |
| `stageblog-workflow` | | _(empty)_ | Workflow file name (e.g. `stage-blog.yml`) to dispatch when `/stageblog` is invoked. Empty = command disabled. The workflow must accept `pr_number` and `head_sha` string inputs. |
| `stageblog-paths` | | `blog/**` | Comma-separated CODEOWNERS-style glob patterns. `/stageblog` is refused if no changed file matches. |

## Outputs

| Output | Description |
|---|---|
| `result` | One of: `lgtm-added`, `lgtm-removed`, `hold-added`, `hold-removed`, `invalidated`, `unauthorized`, `self-lgtm-blocked`, `stageblog-dispatched`, `stageblog-not-blog`, `stageblog-disabled`, `noop` |
| `actor` | Login of the commenter (empty for non-comment triggers) |

## `slash-commands/status` sub-action

Sets a commit status on the PR head SHA derived from the approval/hold labels.
Use in a `status` job that runs on every `pull_request_target` event. The job
itself always succeeds — the commit status it creates is what branch protection
enforces. Make the `status-context` value a required status check.

**States:**

| Condition | Commit status | Description |
|---|---|---|
| `synchronize` event + `invalidate-on-push: true` | `pending` (🟡) | New commits — re-approve |
| `do-not-merge/hold` present | `failure` (❌) | Blocked by hold |
| `approved` present, no hold | `success` (✅) | Approved via /lgtm |
| otherwise | `pending` (🟡) | Awaiting /lgtm |

The `synchronize` special-case is a race guard: the event payload's labels
reflect the *pre-push* state, so without it this action would read a stale
`approved` and set `success` on the new SHA while the `handle` job is still
removing the label in parallel — letting auto-merge slip through.

**Inputs:**

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | | `${{ github.token }}` | Token for the commit-status API. Workflow needs `statuses: write`. |
| `approved-label` | | `approved` | Must match the main action's `approved-label` |
| `hold-label` | | `do-not-merge/hold` | Must match the main action's `hold-label` |
| `status-context` | | `slash-commands/approval` | Name shown in the merge box. Mark this as a required status check. |
| `invalidate-on-push` | | `'true'` | On `synchronize`, force pending regardless of labels. **Must match** the main action's `invalidate-on-push`. Disabling this opens an auto-merge race. |

**Outputs:**

| Output | Description |
|---|---|
| `state` | The commit status state set: `pending`, `success`, or `failure` |

## CODEOWNERS pattern support

The inline CODEOWNERS parser handles the patterns currently used in MCP repos:

| Pattern | Supported | Meaning |
|---|---|---|
| `/path/` | ✅ | Anchored directory prefix (matches anything under `path/`) |
| `/path/to/file.ext` | ✅ | Exact anchored path |
| `*.ext` | ✅ | Any file with extension `.ext` at any depth |
| `/path/**/*.ext` | ✅ | Glob at any depth under `/path/` |
| `**/file` | ✅ | File named `file` at any depth |
| `@user` / `@org/team` | ✅ | Owner: individual user or team (team org must match repo org) |
| `!negation` | ❌ | Not supported (not in use in MCP repos) |
| Escaped spaces (`\ `) | ❌ | Not supported |

Last-match-wins per file, consistent with GitHub's native CODEOWNERS semantics.

## Security notes

- **Comment body injection** — command parsing is a fixed regex on the
  first line in JS; comment text is never interpolated into a shell.
- **CODEOWNERS tampering** — fetched from `pr.base.ref`, never the PR head.
  An attacker cannot add themselves as CODEOWNER in the PR under review.
- **Workflow modification** — `issue_comment` and `pull_request_target` run
  from the default-branch workflow definition. The action does not check out
  PR code.
- **Self-approval** — explicitly blocked before the auth check.
- **`/stageblog` SHA pinning** — the dispatch passes `pr.head.sha` captured at
  the moment the maintainer comments. The companion workflow **must** check
  out `inputs.head_sha` (not `refs/pull/N/head` or `pr.head.ref`) so a fork
  author cannot push new commits between the maintainer's review and the build.
- **Review provenance** — the bot review body always names the real approver
  ("on behalf of @login"), even though GitHub shows the review as bot-authored.
