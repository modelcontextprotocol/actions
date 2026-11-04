// Opt-in squash path. The caller's required checks remain the final merge gate.
module.exports = async ({ github, core, owner, repo, prNumber, checkName, holdLabel }) => {
  const getPr = async () => (await github.rest.pulls.get({ owner, repo, pull_number: prNumber })).data;
  const pending = reason => core.info(`PR #${prNumber} left pending: ${reason}`);
  const pr = await getPr();
  if (pr.state !== 'open') return;

  // Clear a queued message before checking updated metadata. API failures stop here.
  if (pr.auto_merge) {
    await github.graphql(`mutation($id: ID!) {
      disablePullRequestAutoMerge(input: {pullRequestId: $id}) { pullRequest { id } }
    }`, { id: pr.node_id });
  }
  if (pr.draft || pr.labels.some(label => label.name === holdLabel)) {
    return pending('draft or on hold');
  }
  const title = pr.title.match(
    /^(sep|feat|fix|docs|ci|build|chore|refactor|test|perf|style|revert)(?:\(([^()\s]+)\))?!?: (\S.*)$/,
  );
  if (!title || (title[1] === 'sep' && title[2] && !/^SEP-[1-9]\d*$/.test(title[2]))) {
    return pending('use a conventional PR title; numbered SEP scopes must use SEP-N');
  }

  // A missing, skipped, pending, or failed check never permits a merge.
  const runs = await github.paginate(github.rest.checks.listForRef, {
    owner, repo, ref: pr.head.sha, check_name: checkName, filter: 'latest', per_page: 100,
  });
  const check = runs.filter(run => run.name === checkName && run.app?.slug === 'github-actions'
    && run.head_sha === pr.head.sha).sort((a, b) => b.id - a.id)[0];
  if (!check || check.status !== 'completed' || check.conclusion !== 'success') {
    return pending(`waiting for a successful '${checkName}' check on the current head`);
  }

  // Keep the description (including disclosures) and explicit co-author trailers.
  // GitHub's PR commits endpoint returns at most 250 commits; do not truncate authorship.
  if (pr.commits > 250) return pending('more than 250 commits; squash manually');
  const commits = await github.paginate(github.rest.pulls.listCommits, {
    owner, repo, pull_number: prNumber, per_page: 100,
  });
  const body = pr.body || '';
  const trailers = new Map();
  const add = line => trailers.set(line.toLowerCase(), line);
  for (const commit of commits) {
    for (const line of commit.commit.message.match(/^Co-authored-by: .+$/gim) || []) add(line.trim());
    const author = commit.commit.author;
    if (commit.author?.login !== pr.user.login && author?.name && author?.email) {
      add(`Co-authored-by: ${author.name} <${author.email}>`);
    }
  }
  for (const line of body.match(/^Co-authored-by: .+$/gim) || []) trailers.delete(line.trim().toLowerCase());
  const message = [body, [...trailers.values()].join('\n')].filter(Boolean).join('\n\n');

  // Refuse stale snapshots. GitHub also checks the head SHA atomically at merge time.
  const unchanged = fresh => fresh.state === 'open' && !fresh.draft
    && fresh.head.sha === pr.head.sha && fresh.base.sha === pr.base.sha
    && fresh.title === pr.title && fresh.body === pr.body
    && !fresh.labels.some(label => label.name === holdLabel);
  if (!unchanged(await getPr())) return pending('PR changed during validation; retry');
  try {
    const result = await github.graphql(`mutation($id: ID!, $sha: GitObjectID!, $title: String!, $body: String!) {
      enablePullRequestAutoMerge(input: {
        pullRequestId: $id, expectedHeadOid: $sha, mergeMethod: SQUASH,
        commitHeadline: $title, commitBody: $body
      }) { pullRequest { reviewDecision } }
    }`, { id: pr.node_id, sha: pr.head.sha, title: pr.title, body: message });
    if (result.enablePullRequestAutoMerge.pullRequest.reviewDecision === 'REVIEW_REQUIRED') {
      pending('auto-merge is waiting for required review; bypass fallback is disabled');
    } else {
      core.info(`Auto-merge enabled for PR #${prNumber} using its checked title`);
    }
  } catch (error) {
    if (!/clean status/i.test(error.message || '')) throw error;
    // GitHub rejects enabling auto-merge when a PR can already merge. Do not
    // use the App's bypass to turn a blocked/unknown state into a direct merge.
    const fresh = await getPr();
    if (!unchanged(fresh) || fresh.mergeable_state !== 'clean') {
      return pending('PR changed or still has merge requirements');
    }
    const { data } = await github.rest.pulls.merge({
      owner, repo, pull_number: prNumber, sha: pr.head.sha, merge_method: 'squash',
      commit_title: pr.title, commit_message: message,
    });
    if (!data.merged) throw new Error(`Merge refused: ${data.message}`);
    core.info(`Squash merged PR #${prNumber}`);
  }
};
