# slash-commands

Reusable composite action that implements Prow-style `/lgtm`, `/hold`, and
`/stageblog` slash commands on pull requests, gated by team membership and
CODEOWNERS.

## What it does

Listens for PR comments and push events, then:

- **`/lgtm`** — **core maintainers only** (`always-allow-teams`). Adds an
  `accepted` label, submits an **APPROVE** review on behalf of the commenter,
  and **enables auto-merge**. The PR merges automatically once all required
  checks pass. CODEOWNERS does _not_ grant `/lgtm` authorization. Optionally
  removes staging labels (`remove-labels-on-accept`) and moves the PR to an
  _Accepted_ status in a configured org Project (`project-number`).
- **`/lgtm cancel`** — removes the `accepted` label, dismisses the approval,
  and disables auto-merge.
- **`/lgtm force`** — same as `/lgtm`, but **only** members of
  `force-allow-teams` (default: core + lead maintainers) may use it, and it
  **bypasses the self-approval guard**. Intended as an escape hatch for
  maintainers who need to approve their own PRs. The review body notes the
  approval came via `/lgtm force`.
- **`/hold`** — adds a `do-not-merge/hold` label. Core maintainers _or_
  CODEOWNERS of the PR's changed files may use this.
- **`/hold cancel`** or **`/unhold`** — removes the hold label.
- **`/stageblog`** — if the PR touches any blog paths (default `blog/**`),
  dispatches a caller-defined `workflow_dispatch` workflow passing the PR
  number and the PR's head SHA **at the time of the comment**. Intended for
  letting maintainers manually stage blog previews for fork PRs (where the
  normal `pull_request`-triggered preview workflow can't access secrets).
  Disabled unless `stageblog-workflow` is set.
- **New commits pushed** — removes the `accepted` label, dismisses the
  approval, disables auto-merge, and posts a brief comment asking for
  re-approval.

Commands are parsed from the **first line** of the comment (case-insensitive,
must match `^/cmd\b`). Unauthorized attempts, or a PR author trying to `/lgtm`
their own PR, receive a 👎 reaction with no further noise. Successful commands
receive a 👍 reaction.

### Merge gate

The merge gate is **GitHub's native required-reviews rule** plus
**auto-merge**. Configure branch protection to require at least one approving
review; `/lgtm` satisfies that via the App's approval and turns on auto-merge.
The PR merges as soon as CI passes. Manually adding the `accepted` label in
the GitHub UI has no effect — the gate is the review, not the label.

> [!IMPORTANT]
> If your branch protection enables **Require review from Code Owners**, the
> App's approval will _not_ satisfy it — GitHub Apps cannot be members of org
> teams, so they cannot be code owners via a team entry. Auto-merge also does
> not inherit the bypass privileges of the App that enabled it. To make
> `/lgtm` work under this rule, **add the GitHub App to the ruleset's bypass
> list** (Settings → Rules → Rulesets → _your ruleset_ → Bypass list → add
> the App with mode _Always_). The action detects this case and falls back to
> a direct merge, which _does_ use the App's bypass.

## Prerequisites

- **A GitHub App** installed on the caller repo with the permissions listed
  below. The App's identity is what approves PRs and enables auto-merge.
- **Allow auto-merge** enabled in the caller repo
  (Settings → General → Pull Requests → Allow auto-merge).
- The `accepted` and `do-not-merge/hold` labels **must already exist** in the
  caller repo (the action does not auto-create them). Suggested colors:
  `accepted` → `#0e8a16`, `do-not-merge/hold` → `#d93f0b`.
- A CODEOWNERS file at `.github/CODEOWNERS` (or pass a different path via
  `codeowners-path`) if you want CODEOWNERS to grant `/hold`/`/stageblog`.
  Not required for `/lgtm`.

## Required secrets

The action runs as a **GitHub App** so its approvals satisfy branch
protection's required-reviews rule without depending on the
"Allow GitHub Actions to create and approve pull requests" repo setting.

| Repo secret name | Value |
|---|---|
| `MCP_COMMANDER_APP_ID` | The App's numeric ID (shown on the App's General settings page) |
| `MCP_COMMANDER_APP_KEY` | The App's private key — full contents of the downloaded `.pem` file, including the `-----BEGIN/END-----` lines |

### Creating the GitHub App

Org **Settings → Developer settings → GitHub Apps → New GitHub App**.
Configure:

| Section | Setting |
|---|---|
| Webhook | **Disable** (uncheck "Active") — the App is just an identity |
| Repository permissions → Pull requests | **Read & write** |
| Repository permissions → Contents | **Read-only** |
| Repository permissions → Actions | **Read & write** _(only if `/stageblog` is enabled)_ |
| Organization permissions → Members | **Read-only** |
| Where can this GitHub App be installed? | **Only on this account** |

After creating:

1. **Install** — left sidebar → Install App → pick the caller repo(s)
2. **App ID** — copy from the top of General settings → save as
   `MCP_COMMANDER_APP_ID` secret
3. **Private key** — scroll to bottom → Generate a private key →
   copy `.pem` contents → save as `MCP_COMMANDER_APP_KEY` secret

> **Why an App and not a PAT?** App installation tokens are short-lived
> (auto-minted per workflow run via `actions/create-github-app-token`), are
> not tied to any individual's account, and their approvals always count
> toward required reviews. The automatic `GITHUB_TOKEN` lacks `read:org` and
> its approvals are gated by a separate repo setting that may be disabled
> org-wide.

## Caller workflow requirements

| | |
|---|---|
| **Triggers** | `issue_comment` (types: `created`) + `pull_request_target` (types: `synchronize`) |
| **Permissions** | `contents: read` is sufficient — the App token handles all writes. |
| **Fork-PR safety** | No special guard needed — `issue_comment` and `pull_request_target` both run in the **base** repo's context with the base workflow definition, so fork authors cannot modify the logic. CODEOWNERS is also fetched from the PR's **base** ref, never the head. |
| **No checkout** | The action calls GitHub API only. Do not `actions/checkout` PR code. |

## Usage

```yaml
name: Slash Commands

on:
  issue_comment:
    types: [created]
  pull_request_target:
    types: [synchronize]

permissions:
  contents: read

jobs:
  handle:
    if: >-
      (github.event_name == 'issue_comment' && github.event.issue.pull_request) ||
      github.event_name == 'pull_request_target'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v2
        id: app-token
        with:
          app-id: ${{ secrets.MCP_COMMANDER_APP_ID }}
          private-key: ${{ secrets.MCP_COMMANDER_APP_KEY }}

      - uses: modelcontextprotocol/actions/slash-commands@main
        with:
          github-token: ${{ steps.app-token.outputs.token }}
          # auto-merge-method: squash  # default; also: merge, rebase
          # stageblog-workflow: stage-blog.yml  # uncomment to enable /stageblog
```

**Branch protection settings** for this flow: enable _Require a pull request
before merging_ → _Require approvals_ (1), and _Allow auto-merge_ in repo
Settings. The App's APPROVE review satisfies the requirement and auto-merge
handles the rest.

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
| `github-token` | ✅ | — | GitHub App installation token used for everything: team-membership checks, labels, comments, reactions, APPROVE review, auto-merge, CODEOWNERS fetch, workflow dispatch. Must have Organization Members:read + Repository Pull requests:write + Contents:read (+ Actions:write for `/stageblog`). **Default `GITHUB_TOKEN` will not work.** |
| `approved-label` | | `accepted` | Label added by `/lgtm` to mark the PR as accepted |
| `hold-label` | | `do-not-merge/hold` | Label added by `/hold` |
| `always-allow-teams` | | `core-maintainers` | Comma-separated team slugs (in the repo's org) whose members can `/lgtm` any PR. **Only these teams can `/lgtm`** — CODEOWNERS does not grant it. Members may also `/hold`/`/stageblog` any PR. |
| `force-allow-teams` | | `core-maintainers,lead-maintainers` | Comma-separated team slugs whose members may use `/lgtm force` (bypasses self-approval guard). CODEOWNERS does **not** grant this — only team membership. |
| `codeowners-path` | | `.github/CODEOWNERS` | Path to CODEOWNERS, fetched from the PR's **base** ref (never head — tamper-proof). Grants `/hold` and `/stageblog` only, not `/lgtm`. |
| `invalidate-on-push` | | `'true'` | Remove `accepted` label + dismiss approval + disable auto-merge + comment when new commits are pushed. Set `'false'` to keep approval across pushes. |
| `submit-review` | | `'true'` | Submit an APPROVE review alongside the label on `/lgtm`. Set `'false'` to use label only. |
| `enable-auto-merge` | | `'true'` | Enable auto-merge after `/lgtm` (disabled on `/lgtm cancel` and push invalidation). Requires repo setting "Allow auto-merge". |
| `auto-merge-method` | | `squash` | Merge method for auto-merge: `squash`, `merge`, or `rebase` |
| `remove-labels-on-accept` | | _(empty)_ | Comma-separated label names to remove when `/lgtm` accepts (e.g. `in-review,draft,proposal`). Missing labels are ignored. |
| `project-number` | | _(empty)_ | Org-level Project (V2) number to update on accept. Empty = disabled. Adds the PR to the project if not already present. Requires the App to have **Organization Projects: write**. |
| `project-status-field` | | `Status` | Name of the single-select field to set on accept. |
| `project-accepted-option` | | `Accepted` | Name of the option to set in the status field on accept. |
| `project-gate-label` | | _(empty)_ | If set, only update the project status when the PR has this label (e.g. `SEP`). Empty = update for every accepted PR. Label removal via `remove-labels-on-accept` is not gated — it always runs. |
| `stageblog-workflow` | | _(empty)_ | Workflow file name (e.g. `stage-blog.yml`) to dispatch when `/stageblog` is invoked. Empty = command disabled. The workflow must accept `pr_number` and `head_sha` string inputs. |
| `stageblog-paths` | | `blog/**` | Comma-separated CODEOWNERS-style glob patterns. `/stageblog` is refused if no changed file matches. |

## Outputs

| Output | Description |
|---|---|
| `result` | One of: `lgtm-added`, `lgtm-forced`, `lgtm-removed`, `hold-added`, `hold-removed`, `invalidated`, `unauthorized`, `force-unauthorized`, `self-lgtm-blocked`, `stageblog-dispatched`, `stageblog-not-blog`, `stageblog-disabled`, `noop` |
| `actor` | Login of the commenter (empty for non-comment triggers) |

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
- **Self-approval** — explicitly blocked before the auth check. The
  `/lgtm force` escape hatch bypasses this, but is gated strictly to
  `force-allow-teams` membership (CODEOWNERS does not grant it) and the
  review body records that `force` was used.
- **Manual label bypass** — the merge gate is the App's APPROVE review, which
  is only submitted by the `/lgtm` handler after the team-membership check
  passes. Adding the `accepted` label via the GitHub UI is cosmetic.
- **`/stageblog` SHA pinning** — the dispatch passes `pr.head.sha` captured at
  the moment the maintainer comments. The companion workflow **must** check
  out `inputs.head_sha` (not `refs/pull/N/head` or `pr.head.ref`) so a fork
  author cannot push new commits between the maintainer's review and the build.
- **Review provenance** — the review body always names the real approver
  ("on behalf of @login"), even though GitHub shows the review as App-authored.
