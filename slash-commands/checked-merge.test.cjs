const assert = require('node:assert/strict');
const { test } = require('node:test');
const checkedMerge = require('./checked-merge');
const main = require('./main');

function fixture(overrides = {}, options = {}) {
  const pr = {
    number: 42, node_id: 'PR_42', state: 'open', draft: false,
    title: 'fix(SEP-3398): correct cancellation', body: 'Description and disclosure.',
    head: { sha: 'head' }, base: { sha: 'base' }, user: { login: 'author' },
    labels: [{ name: 'accepted' }], commits: 1, mergeable_state: 'clean',
    ...overrides,
  };
  const calls = [];
  const logs = [];
  let reads = 0;
  const github = { rest: {
    pulls: {
      get: async () => ({ data: options.read?.(++reads, pr) || pr }),
      merge: async input => { calls.push(['merge', input]); return { data: { merged: true } }; },
      listCommits() {}, listReviews() {},
      list: async () => ({ data: [pr] }),
      createReview: async input => calls.push(['approve', input]),
    },
    checks: { listForRef() {} },
    teams: { getMembershipForUserInOrg: async () => ({ data: { state: 'active' } }) },
    issues: { addLabels: async () => {}, removeLabel: async () => {} },
    reactions: { createForIssueComment: async () => {} },
  } };
  const check = { id: 1, name: 'PR title', app: { slug: 'github-actions' },
    head_sha: 'head', status: 'completed', conclusion: 'success' };
  github.paginate = async (method, params) => {
    if (method === github.rest.checks.listForRef) {
      assert.equal(params.ref, pr.head.sha);
      if (options.checkError) throw new Error('Check API unavailable');
      return options.runs || [check];
    }
    if (method === github.rest.pulls.listReviews) return options.reviews || [{
      state: 'APPROVED', commit_id: 'head', user: { type: 'Bot' }, body: '<!-- slash-commands-lgtm -->',
    }];
    if (method === github.rest.pulls.listCommits) return options.commits || [];
    throw new Error('Unexpected pagination');
  };
  github.graphql = async (query, variables) => {
    if (query.includes('disablePullRequestAutoMerge')) {
      calls.push(['disable', variables]);
      return {};
    }
    calls.push(['enable', variables]);
    if (options.autoError) throw new Error(options.autoError);
    return { enablePullRequestAutoMerge: { pullRequest: { reviewDecision: options.decision || 'APPROVED' } } };
  };
  const core = { info: message => logs.push(message), warning: message => logs.push(message), setOutput() {} };
  return { pr, calls, logs, check, github, core,
    run: () => checkedMerge({ github, core, owner: 'org', repo: 'repo', prNumber: 42, checkName: 'PR title', holdLabel: 'hold' }),
  };
}

function env(t, overrides = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    APPROVED_LABEL: 'accepted', HOLD_LABEL: 'hold', ALWAYS_ALLOW_TEAMS: 'maintainers',
    FORCE_ALLOW_TEAMS: 'maintainers', CODEOWNERS_PATH: '.github/CODEOWNERS',
    INVALIDATE_ON_PUSH: 'true', SUBMIT_REVIEW: 'true', ENABLE_AUTO_MERGE: 'true',
    AUTO_MERGE_METHOD: 'squash', REMOVE_LABELS_ON_ACCEPT: '', PROJECT_NUMBER: '',
    DEPENDABOT_AUTO_APPROVE: '', DEPENDABOT_ALLOWED_FILES: '', REQUIRED_TITLE_CHECK: '',
    ...overrides,
  });
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
}
const comment = { eventName: 'issue_comment', repo: { owner: 'org', repo: 'repo' }, payload: {
  issue: { number: 42, pull_request: {} }, comment: { id: 1, body: '/lgtm', user: { login: 'maintainer' } },
} };

test('squash uses checked head, latest title, disclosure and co-authors', async () => {
  const f = fixture({ body: 'AI-assisted change.\n\nCo-authored-by: Alice <alice@example.com>' }, { commits: [
    { author: { login: 'alice' }, commit: { author: { name: 'Alice', email: 'alice@example.com' }, message: 'Work\n\nCo-authored-by: Bob <bob@example.com>' } },
  ] });
  await f.run();
  assert.deepEqual(f.calls, [['enable', {
    id: 'PR_42', sha: 'head', title: f.pr.title,
    body: 'AI-assisted change.\n\nCo-authored-by: Alice <alice@example.com>\n\nCo-authored-by: Bob <bob@example.com>',
  }]]);
});

for (const title of ['Update stuff', 'sep(3398): proposal', 'sep(SEP-0): proposal', 'sep(SEP-03398): proposal', 'fix: ']) {
  test(`invalid title stays pending: ${title}`, async () => {
    const f = fixture({ title }); await f.run(); assert.deepEqual(f.calls, []);
  });
}
for (const title of ['sep: new proposal', 'sep(SEP-932)!: revise governance', 'build(deps-dev): update TypeDoc']) {
  test(`allowed title: ${title}`, async () => {
    const f = fixture({ title }); await f.run(); assert.equal(f.calls[0][0], 'enable');
  });
}
for (const change of [{ conclusion: 'failure' }, { conclusion: 'skipped' }, { status: 'in_progress' }, { app: { slug: 'other-app' } }, { head_sha: 'old' }]) {
  test(`unsuitable check stays pending: ${JSON.stringify(change)}`, async () => {
    const f = fixture(); f.github.paginate = async () => [{ ...f.check, ...change }];
    await f.run(); assert.deepEqual(f.calls, []);
  });
}
test('missing check or newer failed run cannot use an older success', async () => {
  for (const runs of [[], [fixture().check, { ...fixture().check, id: 2, conclusion: 'failure' }]]) {
    const f = fixture({}, { runs }); await f.run(); assert.deepEqual(f.calls, []);
  }
});
test('existing auto-merge is disabled when title becomes invalid', async () => {
  const f = fixture({ auto_merge: {}, title: 'invalid' }); await f.run();
  assert.deepEqual(f.calls, [['disable', { id: 'PR_42' }]]);
});
test('pending reviews never use the bypass fallback', async () => {
  const f = fixture({}, { decision: 'REVIEW_REQUIRED' }); await f.run();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'enable');
});
test('clean-status fallback pins the SHA and preserves the squash message', async () => {
  const f = fixture({}, { autoError: 'Pull request is in clean status' }); await f.run();
  assert.deepEqual(f.calls[1], ['merge', { owner: 'org', repo: 'repo', pull_number: 42,
    sha: 'head', merge_method: 'squash', commit_title: f.pr.title, commit_message: f.pr.body }]);
});
for (const change of [{ title: 'fix: newer title' }, { head: { sha: 'new' } }, { body: 'changed' }, { base: { sha: 'newbase' } }, { labels: [{ name: 'hold' }] }]) {
  test(`changed PR is not merged: ${JSON.stringify(change)}`, async () => {
    const f = fixture({}, { read: (count, pr) => count > 1 ? { ...pr, ...change } : pr });
    await f.run(); assert.deepEqual(f.calls, []);
  });
}
test('direct fallback refuses blocked state or edits after enabling was attempted', async () => {
  for (const change of [{ mergeable_state: 'blocked' }, { title: 'fix: newer title' }]) {
    const f = fixture({}, { autoError: 'clean status', read: (count, pr) => count > 2 ? { ...pr, ...change } : pr });
    await f.run(); assert.equal(f.calls.length, 1);
  }
});
test('API errors fail closed', async () => {
  const f = fixture({}, { checkError: true });
  await assert.rejects(f.run, /Check API unavailable/); assert.deepEqual(f.calls, []);
  const g = fixture({}, { autoError: 'Forbidden' });
  await assert.rejects(g.run, /Forbidden/); assert.equal(g.calls.length, 1);
});
test('draft, hold, closed, and too many commits stay pending', async () => {
  for (const overrides of [{ draft: true }, { labels: [{ name: 'hold' }] }, { state: 'closed' }, { commits: 251 }]) {
    const f = fixture(overrides); await f.run(); assert.deepEqual(f.calls, []);
  }
});
test('default caller retains the existing bypass fallback', async t => {
  env(t); const f = fixture({ title: 'Legacy title' }, { decision: 'REVIEW_REQUIRED' });
  await main({ ...f, context: comment });
  assert.deepEqual(f.calls.filter(([name]) => name === 'merge'), [['merge', {
    owner: 'org', repo: 'repo', pull_number: 42, merge_method: 'squash',
  }]]);
});
test('opt-in caller uses checked squash path and rejects other merge methods', async t => {
  env(t, { REQUIRED_TITLE_CHECK: 'PR title' }); const f = fixture();
  await main({ ...f, context: comment });
  assert.equal(f.calls.find(([name]) => name === 'enable')[1].sha, 'head');
  process.env.AUTO_MERGE_METHOD = 'merge';
  await assert.rejects(() => main({ ...fixture(), context: comment }), /requires auto-merge-method: squash/);
});
for (const eventName of ['pull_request_target', 'workflow_run']) {
  test(`${eventName} refreshes an approved PR after a title change`, async t => {
    env(t, { REQUIRED_TITLE_CHECK: 'PR title' }); const f = fixture({ auto_merge: {} });
    const payload = eventName === 'workflow_run'
      ? { action: 'completed', workflow_run: { head_sha: 'head', pull_requests: [{ number: 42 }] } }
      : { action: 'edited', changes: { title: { from: 'Old title' } }, pull_request: { number: 42 } };
    await main({ ...f, context: { eventName, repo: comment.repo, payload } });
    assert.deepEqual(f.calls.map(([name]) => name), ['disable', 'enable']);
  });
}
test('refresh never authorizes an unapproved PR or an approval on an old head', async t => {
  env(t, { REQUIRED_TITLE_CHECK: 'PR title' });
  for (const reviews of [[], [{ state: 'APPROVED', commit_id: 'old', user: { type: 'Bot' }, body: '<!-- slash-commands-lgtm -->' }]]) {
    const f = fixture({}, { reviews });
    await main({ ...f, context: { eventName: 'workflow_run', repo: comment.repo,
      payload: { action: 'completed', workflow_run: { head_sha: 'head', pull_requests: [{ number: 42 }] } } } });
    assert.deepEqual(f.calls, []);
  }
});
