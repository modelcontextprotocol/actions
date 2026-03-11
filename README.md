# actions

GitHub Actions relevant to the management of MCP repositories.

## Actions

| Action | Description |
|---|---|
| [`cloudflare-pages-preview/deploy`](cloudflare-pages-preview/README.md) | Deploy a static HTML directory to Cloudflare Pages under a per-PR branch alias, inject noindex headers, and post a sticky PR comment with preview URLs |
| [`cloudflare-pages-preview/cleanup`](cloudflare-pages-preview/README.md) | Delete Cloudflare Pages deployments for a closed PR's branch alias and update the sticky comment |
| [`slash-commands`](slash-commands/README.md) | Handle `/lgtm` and `/hold` PR slash commands gated by team membership + CODEOWNERS; invalidate approval on push |
