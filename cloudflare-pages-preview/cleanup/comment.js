// Updates the PR preview comment after deployments are deleted. Called by
// actions/github-script via `require(GITHUB_ACTION_PATH + '/comment.js')`.

module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  const prNumber = Number(process.env.PR_NUMBER);
  if (!prNumber) {
    core.info('No PR number available — skipping comment update.');
    return;
  }
  const marker = process.env.COMMENT_MARKER;
  const mode = process.env.COMMENT_MODE;

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: prNumber, per_page: 100,
  });
  const prior = comments.filter(c =>
    c.user.type === 'Bot' && c.body && c.body.includes(marker)
  );

  const cleanupBody = `${marker}\n## Preview\n\n_Preview deployments for this PR have been cleaned up._`;

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
      } catch (e) {
        core.warning(`Could not minimize comment ${c.id}: ${e.message}`);
      }
    }
    if (prior.length) {
      await github.rest.issues.createComment({
        owner, repo, issue_number: prNumber, body: cleanupBody,
      });
    }
  } else {
    const existing = prior[0];
    if (existing) {
      await github.rest.issues.updateComment({
        owner, repo, comment_id: existing.id, body: cleanupBody,
      });
    }
  }
};
