# cloudflare-pages-preview

Reusable composite actions for deploying **PR previews** to Cloudflare Pages
and cleaning them up when the PR closes.

## What it does

- **`deploy`** — Takes a pre-built static HTML directory and:
  1. Injects `X-Robots-Tag: noindex` headers (via `_headers`) and a
     `<meta name="robots" content="noindex">` tag into every HTML page so
     previews aren't crawled by search engines (optional, on by default)
  2. Deploys to Cloudflare Pages under a per-PR branch alias
     (`pr-<number>` by default) giving a stable URL across force-pushes
  3. Posts or updates a sticky PR comment with the preview URLs

- **`cleanup`** — On PR close:
  1. Deletes all Cloudflare Pages deployments for the PR's branch alias
  2. Updates the sticky PR comment to indicate cleanup

## Prerequisites

- A **Cloudflare Pages project** must be created in the Cloudflare dashboard
  first. Pass its name as `project-name`.
- Two GitHub Actions secrets (see below).

## Required secrets

Configure these in the caller repo (**Settings → Secrets and variables →
Actions**) and pass them to the action via `with:`:

| Secret | Passed as | What it is |
|---|---|---|
| Cloudflare API token | `api-token` | Token with **`Pages:Edit`** permission scoped **only** to the target Pages project. Do not reuse a general-purpose or account-wide Cloudflare token — create a dedicated token per project. |
| Cloudflare account ID | `account-id` | Found in the Cloudflare dashboard sidebar. Not actually secret, but stored as one to co-locate with the token. |

Both actions require the same two secrets.

The default `github-token` (`${{ github.token }}`) is sufficient for PR
commenting with the standard `pull-requests: write` permission — no additional
secret is needed there unless you want to comment as a different identity.

## Caller workflow requirements

The calling workflow must configure:

| | |
|---|---|
| **Permissions** | `contents: read`, `pull-requests: write` |
| **Fork-PR guard** | `if: github.event.pull_request.head.repo.full_name == github.repository` — forks do not have access to secrets, so deploys would fail anyway |
| **Concurrency** | Per-PR group with `cancel-in-progress: true` to avoid racing deploys |
| **Build** | Caller is responsible for checkout + building the static site before calling `deploy` |

## Usage

```yaml
name: Preview

on:
  pull_request:
    types: [opened, synchronize, reopened, closed]
    paths:
      - "site/**"

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: preview-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  build-and-deploy:
    if: >-
      github.event.action != 'closed' &&
      github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      # ... your build steps — produce static HTML in site/public ...

      - uses: modelcontextprotocol/actions/cloudflare-pages-preview/deploy@main
        with:
          directory: site/public
          project-name: my-cf-pages-project
          api-token: ${{ secrets.CF_PREVIEW_API_TOKEN }}
          account-id: ${{ secrets.CF_PREVIEW_ACCOUNT_ID }}

  cleanup:
    if: >-
      github.event.action == 'closed' &&
      github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: modelcontextprotocol/actions/cloudflare-pages-preview/cleanup@main
        with:
          project-name: my-cf-pages-project
          api-token: ${{ secrets.CF_PREVIEW_API_TOKEN }}
          account-id: ${{ secrets.CF_PREVIEW_ACCOUNT_ID }}
```

Note: `cleanup` does **not** require `actions/checkout` — it only calls the
Cloudflare API and GitHub API.

## Inputs

### `deploy`

| Input | Required | Default | Description |
|---|---|---|---|
| `directory` | ✅ | — | Path to built static HTML |
| `project-name` | ✅ | — | Cloudflare Pages project name |
| `api-token` | ✅ | — | Cloudflare API token (`Pages:Edit`) |
| `account-id` | ✅ | — | Cloudflare account ID |
| `branch` | | `pr-<PR number>` | CF Pages branch alias |
| `inject-noindex` | | `'true'` | Inject `_headers` + `<meta>` noindex |
| `comment-marker` | | `<!-- cf-pages-preview -->` | Sticky-comment identifier |
| `comment-title` | | `Preview Deployed` | Heading in PR comment |
| `github-token` | | `${{ github.token }}` | Token for PR commenting |

### `cleanup`

| Input | Required | Default | Description |
|---|---|---|---|
| `project-name` | ✅ | — | Cloudflare Pages project name |
| `api-token` | ✅ | — | Cloudflare API token (`Pages:Edit`) |
| `account-id` | ✅ | — | Cloudflare account ID |
| `branch` | | `pr-<PR number>` | CF Pages branch alias to delete |
| `comment-marker` | | `<!-- cf-pages-preview -->` | Sticky-comment identifier |
| `github-token` | | `${{ github.token }}` | Token for PR commenting |

## Outputs

### `deploy`

| Output | Description |
|---|---|
| `deployment-url` | URL of this specific deployment (changes per push) |
| `alias-url` | Stable branch-alias URL (same across pushes) |
