// Posts or updates the PR preview-URL comment. Called by actions/github-script
// via `require(GITHUB_ACTION_PATH + '/comment.js')({ github, context, core })`.
// All inputs are passed via env vars (see action.yml).

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const prNumber = Number(process.env.PR_NUMBER);
  if (!prNumber) {
    core.info('No PR number available — skipping comment.');
    return;
  }
  const deployUrl = process.env.DEPLOY_URL;
  const aliasUrl = process.env.ALIAS_URL || deployUrl;
  const marker = process.env.COMMENT_MARKER;
  const title = process.env.COMMENT_TITLE;
  const mode = process.env.COMMENT_MODE;
  const noindex = process.env.INJECT_NOINDEX === 'true';
  const commitSha = process.env.COMMIT_SHA;

  const noindexNote = noindex
    ? ' All pages served with `noindex, nofollow` — search engines will not crawl this preview.'
    : '';

  const body = [
    marker,
    `## ${title}`,
    '',
    '| | |',
    '|---|---|',
    `| **Preview (stable)** | ${aliasUrl} |`,
    `| **This commit** | ${deployUrl} |`,
    `| **Commit** | \`${commitSha.slice(0, 7)}\` |`,
    '',
    `_Includes drafts and future-dated posts.${noindexNote}_`,
  ].join('\n');

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: prNumber, per_page: 100,
  });
  const prior = comments.filter(c =>
    c.user.type === 'Bot' && c.body && c.body.includes(marker)
  );

  if (mode === 'repost') {
    for (const c of prior) {
      try {
        await github.graphql(
          `mutation($id: ID!) {
             minimizeComment(input: {subjectId: $id, classifier: OUTDATED}) {
               minimizedComment { isMinimized }
             }
           }`,
          { id: c.node_id },
        );
        core.info(`Minimized prior comment ${c.id} as OUTDATED`);
      } catch (e) {
        core.warning(`Could not minimize comment ${c.id}: ${e.message}`);
      }
    }
    await github.rest.issues.createComment({
      owner, repo, issue_number: prNumber, body,
    });
  } else {
    // sticky: update the first prior comment in place, or create one
    const existing = prior[0];
    if (existing) {
      await github.rest.issues.updateComment({
        owner, repo, comment_id: existing.id, body,
      });
    } else {
      await github.rest.issues.createComment({
        owner, repo, issue_number: prNumber, body,
      });
    }
  }
};
