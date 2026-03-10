# Adding new actions to this repo

This repo holds **composite GitHub Actions** reused across MCP-family repos.
Before adding a new action, confirm the logic is (or will be) needed in more
than one caller repo — single-repo logic should stay in that repo's workflow.

## Directory layout

Each action lives in its own directory. If a feature has multiple related
entry points (e.g. deploy + cleanup), group them under a common parent:

```
<action-name>/
  README.md              # usage docs, inputs/outputs, caller requirements
  action.yml             # the composite action
```

or for multi-action groups:

```
<group-name>/
  README.md              # covers all actions in the group
  <sub-action>/
    action.yml
  <sub-action>/
    action.yml
```

Caller references:
- `modelcontextprotocol/actions/<action-name>@main`
- `modelcontextprotocol/actions/<group-name>/<sub-action>@main`

## Composite action conventions

**Required fields**

Every `action.yml` must include:
- `name` — human-readable name
- `description` — one or two sentences on what it does
- `inputs` — with `description` and `required` for each; use `default` for
  optional inputs
- `runs.using: composite`

**Every `run:` step needs an explicit `shell:`**

Composite actions do not inherit a default shell. Omitting `shell:` fails at
runtime, not validation time.

```yaml
- name: Do something
  shell: bash
  run: |
    echo "..."
```

**Pass inputs to scripts via `env:`, not interpolation**

Direct interpolation of `${{ inputs.* }}` into `run:` or `script:` bodies is
an injection vector. Pass values through `env:` and read them as environment
variables or `process.env.*`:

```yaml
- shell: bash
  env:
    MY_INPUT: ${{ inputs.my-input }}
  run: |
    echo "${MY_INPUT}"

- uses: actions/github-script@v8
  env:
    MY_INPUT: ${{ inputs.my-input }}
  with:
    script: |
      const val = process.env.MY_INPUT;
```

**Do not `actions/checkout` inside a composite action**

The caller has already checked out; the composite runs in that workspace.
Document in the README if a checkout is required on the caller side.

**Secrets are always caller-provided**

Composite actions cannot access `secrets.*` directly. Define inputs for any
credentials and document in the README which secrets the caller must configure
and pass through.

**`github-token` input**

If the action posts comments, creates issues, or otherwise calls the GitHub
API, accept a `github-token` input with default `${{ github.token }}`. This
lets callers override with a PAT if needed:

```yaml
github-token:
  description: GitHub token for API calls
  required: false
  default: ${{ github.token }}
```

**Outputs**

Expose anything a caller might want to reference downstream. Wire outputs from
steps to the action's `outputs:` block:

```yaml
outputs:
  url:
    description: Deployment URL
    value: ${{ steps.deploy.outputs.url }}
```

## README requirements

Each action (or group) must have a `README.md` covering:

1. **What it does** — one paragraph per action
2. **Prerequisites** — external resources that must exist (CF project, etc.)
3. **Required secrets** — a dedicated section starting with a table with
   **concrete** secret names and wiring. Prescribe exact names so callers can
   copy-paste without deciding:

   ```markdown
   | Repo secret name | Action input | Value |
   |---|---|---|
   | `FOO_API_TOKEN` | `api-token` | ... |
   ```

   Follow the table with a subsection per secret documenting:
   - **Where to get it** — exact navigation path in the external dashboard/UI
     (e.g. "Cloudflare → My Profile → API Tokens → Create Token")
   - **Minimum permission scope** — the least privilege that makes the
     action work

   The usage example must reference the same concrete secret names.

   If no secrets are needed, state that explicitly.
4. **Caller requirements** — `permissions:`, fork-PR guards, concurrency
5. **Usage** — a minimal but complete caller workflow example
6. **Inputs/outputs** — tables with name, required, default, description

## Registering the action

Add a row to the root [`README.md`](README.md) table with the action path and
a one-line description.

## Validation

- Parse check: `python3 -c "import yaml; yaml.safe_load(open('path/action.yml'))"`
- Structure: verify every `run:` step has `shell:`
- Full verification requires a live caller workflow — open a PR in a consuming
  repo that references `@<your-branch>` and confirm end-to-end behavior before
  merging
