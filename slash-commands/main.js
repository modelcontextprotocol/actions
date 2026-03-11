// Handler for /lgtm, /hold, and /stageblog slash commands. Called by actions/github-script
// via `require(github.action_path + '/main.js')({ github, context, core })`.
// See action.yml for input wiring via env vars.

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const approvedLabel = process.env.APPROVED_LABEL;
  const holdLabel = process.env.HOLD_LABEL;
  const alwaysAllowTeams = process.env.ALWAYS_ALLOW_TEAMS
    .split(',').map(s => s.trim()).filter(Boolean);
  const codeownersPath = process.env.CODEOWNERS_PATH;
  const invalidateOnPush = process.env.INVALIDATE_ON_PUSH === 'true';
  const submitReview = process.env.SUBMIT_REVIEW === 'true';
  const reviewMarker = '<!-- slash-commands-lgtm -->';

  // Separate client for user-visible side effects (comments, reactions,
  // labels, reviews). Uses github.token so everything shows as authored by
  // github-actions[bot] instead of the PAT's identity. The PAT (`github`)
  // is still used for team-membership checks (needs read:org), CODEOWNERS
  // fetch, listFiles, pulls.get, and workflow dispatch.
  const bot = require('@actions/github').getOctokit(process.env.BOT_TOKEN);

  function setResult(result, actor) {
    core.setOutput('result', result);
    core.setOutput('actor', actor || '');
    core.info(`Result: ${result}${actor ? ` (actor: ${actor})` : ''}`);
  }

  // --- CODEOWNERS pattern → regex ---------------------------------
  // Supports: leading-/ anchoring, trailing-/ directory match,
  // `**` (any depth), `*` (single segment), `?`. No `!` negation.
  function patternToRegex(pattern) {
    let p = pattern;
    const anchored = p.startsWith('/');
    if (anchored) p = p.slice(1);
    const dirMatch = p.endsWith('/');
    if (dirMatch) p = p.slice(0, -1);
    // Escape regex meta chars except our glob tokens * and ?
    let re = p.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    // Handle globs. Use placeholders so single-* replacement doesn't
    // catch ** sequences. `**/` = zero or more directories.
    re = re.replace(/\*\*\//g, '\u0001');
    re = re.replace(/\*\*/g, '\u0000');
    re = re.replace(/\*/g, '[^/]*');
    re = re.replace(/\?/g, '[^/]');
    re = re.replace(/\u0001/g, '(?:.*/)?');
    re = re.replace(/\u0000/g, '.*');
    // Anchoring: leading `/` → match from repo root; otherwise
    // match at any path depth (start or after a `/`).
    const prefix = anchored ? '^' : '(^|/)';
    // Trailing `/` → directory prefix (match anything under it).
    // Otherwise must match to end of string.
    const suffix = dirMatch ? '/.*$' : '$';
    return new RegExp(prefix + re + suffix);
  }

  function parseCodeowners(content) {
    const rules = [];
    for (const raw of content.split('\n')) {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) continue;
      const parts = line.split(/\s+/);
      const pattern = parts[0];
      const owners = parts.slice(1);
      if (!owners.length) continue;
      rules.push({ regex: patternToRegex(pattern), owners });
    }
    return rules;
  }

  function ownersForFile(rules, file) {
    // Last match wins.
    let owners = null;
    for (const r of rules) {
      if (r.regex.test(file)) owners = r.owners;
    }
    return owners || [];
  }

  // --- Auth helpers -----------------------------------------------
  const teamMembershipCache = new Map();
  async function isTeamMember(user, teamSlug) {
    const key = `${teamSlug}:${user}`;
    if (teamMembershipCache.has(key)) return teamMembershipCache.get(key);
    try {
      const { data } = await github.rest.teams.getMembershipForUserInOrg({
        org: owner, team_slug: teamSlug, username: user,
      });
      const ok = data.state === 'active';
      teamMembershipCache.set(key, ok);
      return ok;
    } catch (e) {
      if (e.status === 404) {
        teamMembershipCache.set(key, false);
        return false;
      }
      // 403 here almost always means the token lacks read:org.
      if (e.status === 403) {
        core.warning(`Team membership check for @${owner}/${teamSlug} returned 403 — the provided github-token likely lacks read:org (Organization Members:read) scope. Treating as not-a-member.`);
        teamMembershipCache.set(key, false);
        return false;
      }
      throw e;
    }
  }

  async function isAuthorized(user, pr) {
    // 1. always-allow teams
    for (const team of alwaysAllowTeams) {
      if (await isTeamMember(user, team)) {
        core.info(`@${user} authorized via always-allow team @${owner}/${team}`);
        return true;
      }
    }
    // 2. CODEOWNERS of the PR's changed files (from BASE ref)
    let content;
    try {
      const { data } = await github.rest.repos.getContent({
        owner, repo, path: codeownersPath, ref: pr.base.ref,
      });
      content = Buffer.from(data.content, data.encoding).toString('utf8');
    } catch (e) {
      if (e.status === 404) {
        core.info(`No CODEOWNERS found at ${codeownersPath} on ${pr.base.ref}`);
        return false;
      }
      throw e;
    }
    const rules = parseCodeowners(content);
    const files = await github.paginate(github.rest.pulls.listFiles, {
      owner, repo, pull_number: pr.number, per_page: 100,
    });
    const ownerSet = new Set();
    for (const f of files) {
      for (const o of ownersForFile(rules, f.filename)) ownerSet.add(o);
    }
    core.info(`CODEOWNERS for this PR's files: ${[...ownerSet].join(', ') || '(none)'}`);
    for (const o of ownerSet) {
      if (o.includes('/')) {
        // @org/team — we require the org to match our repo's org
        const [oOrg, oTeam] = o.replace(/^@/, '').split('/');
        if (oOrg.toLowerCase() !== owner.toLowerCase()) continue;
        if (await isTeamMember(user, oTeam)) {
          core.info(`@${user} authorized via CODEOWNER team ${o}`);
          return true;
        }
      } else {
        // @user
        if (o.replace(/^@/, '').toLowerCase() === user.toLowerCase()) {
          core.info(`@${user} authorized via CODEOWNER user entry`);
          return true;
        }
      }
    }
    return false;
  }

  // --- Label & review helpers -------------------------------------
  async function addLabel(prNumber, label) {
    await bot.rest.issues.addLabels({
      owner, repo, issue_number: prNumber, labels: [label],
    });
  }
  async function removeLabel(prNumber, label) {
    try {
      await bot.rest.issues.removeLabel({
        owner, repo, issue_number: prNumber, name: label,
      });
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  async function react(commentId, content) {
    await bot.rest.reactions.createForIssueComment({
      owner, repo, comment_id: commentId, content,
    });
  }
  async function submitApproval(prNumber, onBehalfOf) {
    await bot.rest.pulls.createReview({
      owner, repo, pull_number: prNumber, event: 'APPROVE',
      body: `${reviewMarker}\nApproved on behalf of @${onBehalfOf} via \`/lgtm\`.`,
    });
  }
  async function dismissBotApprovals(prNumber, reason) {
    const reviews = await bot.paginate(bot.rest.pulls.listReviews, {
      owner, repo, pull_number: prNumber, per_page: 100,
    });
    for (const r of reviews) {
      if (r.state !== 'APPROVED') continue;
      if (!r.body || !r.body.includes(reviewMarker)) continue;
      try {
        await bot.rest.pulls.dismissReview({
          owner, repo, pull_number: prNumber, review_id: r.id,
          message: reason,
        });
      } catch (e) {
        core.warning(`Failed to dismiss review ${r.id}: ${e.message}`);
      }
    }
  }

  // --- Dispatch ---------------------------------------------------
  const ev = context.eventName;

  // Invalidation on push
  if (ev === 'pull_request_target' && context.payload.action === 'synchronize') {
    if (!invalidateOnPush) return setResult('noop');
    const pr = context.payload.pull_request;
    const hasApproved = pr.labels.some(l => l.name === approvedLabel);
    if (!hasApproved) return setResult('noop');
    await removeLabel(pr.number, approvedLabel);
    await dismissBotApprovals(pr.number, 'New commits pushed — approval invalidated.');
    await bot.rest.issues.createComment({
      owner, repo, issue_number: pr.number,
      body: `New commits were pushed — removed the \`${approvedLabel}\` label. Re-approve with \`/lgtm\`.`,
    });
    return setResult('invalidated');
  }

  // Comment commands
  if (ev !== 'issue_comment') return setResult('noop');
  if (!context.payload.issue.pull_request) return setResult('noop');

  const commentBody = context.payload.comment.body || '';
  const commentId = context.payload.comment.id;
  const actor = context.payload.comment.user.login;
  const firstLine = commentBody.split('\n')[0].trim();
  const m = firstLine.match(/^\/(lgtm|hold|unhold|stageblog)\b\s*(cancel)?\s*$/i);
  if (!m) return setResult('noop', actor);

  const cmd = m[1].toLowerCase();
  const cancel = !!m[2] || cmd === 'unhold';

  const prNumber = context.payload.issue.number;
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (pr.state !== 'open') return setResult('noop', actor);

  // Self-approval guard (only for /lgtm, not /hold)
  if (cmd === 'lgtm' && !cancel && actor.toLowerCase() === pr.user.login.toLowerCase()) {
    await react(commentId, '-1');
    return setResult('self-lgtm-blocked', actor);
  }

  // Auth check (same rule for all commands)
  if (!(await isAuthorized(actor, pr))) {
    await react(commentId, '-1');
    return setResult('unauthorized', actor);
  }

  // /stageblog — dispatch a caller-defined workflow with pinned head SHA
  if (cmd === 'stageblog') {
    const stageblogWorkflow = process.env.STAGEBLOG_WORKFLOW;
    if (!stageblogWorkflow) {
      await react(commentId, 'confused');
      return setResult('stageblog-disabled', actor);
    }
    // cancel is meaningless here — just ignore silently
    if (cancel) return setResult('noop', actor);

    // Ack early — listFiles pagination + workflow dispatch can take a few
    // seconds and the commenter otherwise gets no feedback until then.
    await react(commentId, 'eyes');

    // Gate: PR must touch blog paths
    const blogRegexes = process.env.STAGEBLOG_PATHS
      .split(',').map(s => s.trim()).filter(Boolean).map(patternToRegex);
    const files = await github.paginate(github.rest.pulls.listFiles, {
      owner, repo, pull_number: prNumber, per_page: 100,
    });
    const touchesBlog = files.some(f => blogRegexes.some(r => r.test(f.filename)));
    if (!touchesBlog) {
      await react(commentId, '-1');
      await bot.rest.issues.createComment({
        owner, repo, issue_number: prNumber,
        body: `\`/stageblog\` refused — this PR does not touch any blog paths (\`${process.env.STAGEBLOG_PATHS}\`).`,
      });
      return setResult('stageblog-not-blog', actor);
    }

    // Dispatch — pin head SHA at time of comment
    const headSha = pr.head.sha;
    await github.rest.actions.createWorkflowDispatch({
      owner, repo, workflow_id: stageblogWorkflow, ref: pr.base.ref,
      inputs: { pr_number: String(prNumber), head_sha: headSha },
    });
    await react(commentId, 'rocket');
    await bot.rest.issues.createComment({
      owner, repo, issue_number: prNumber,
      body: `Blog staging triggered by @${actor} for \`${headSha.slice(0, 7)}\`. Watch the [**${stageblogWorkflow}** workflow](../actions/workflows/${stageblogWorkflow}) for the preview link.`,
    });
    return setResult('stageblog-dispatched', actor);
  }

  // Execute
  if (cmd === 'lgtm' && !cancel) {
    await addLabel(prNumber, approvedLabel);
    if (submitReview) await submitApproval(prNumber, actor);
    await react(commentId, '+1');
    return setResult('lgtm-added', actor);
  }
  if (cmd === 'lgtm' && cancel) {
    await removeLabel(prNumber, approvedLabel);
    await dismissBotApprovals(prNumber, `@${actor} cancelled approval via /lgtm cancel.`);
    await react(commentId, '+1');
    return setResult('lgtm-removed', actor);
  }
  if ((cmd === 'hold' && !cancel)) {
    await addLabel(prNumber, holdLabel);
    await react(commentId, '+1');
    return setResult('hold-added', actor);
  }
  // /hold cancel or /unhold
  await removeLabel(prNumber, holdLabel);
  await react(commentId, '+1');
  return setResult('hold-removed', actor);
};
