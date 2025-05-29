import { Context, Probot } from 'probot';
import { minimatch } from 'minimatch';

import { Chat } from './chat.js';
import log from 'loglevel';

const OPENAI_API_KEY = 'OPENAI_API_KEY';
const MAX_PATCH_COUNT = process.env.MAX_PATCH_LENGTH
  ? +process.env.MAX_PATCH_LENGTH
  : Infinity;

export const robot = (app: Probot) => {
  const loadChat = async (context: Context) => {
    if (process.env.OPENAI_API_KEY) {
      return new Chat(process.env.OPENAI_API_KEY);
    }

    const repo = context.repo();

    try {
      const { data } = (await context.octokit.request(
        'GET /repos/{owner}/{repo}/actions/variables/{name}',
        {
          owner: repo.owner,
          repo: repo.repo,
          name: OPENAI_API_KEY,
        }
      )) as any;

      if (!data?.value) {
        return null;
      }

      return new Chat(data.value);
    } catch {
      await context.octokit.issues.createComment({
        repo: repo.repo,
        owner: repo.owner,
        issue_number: context.pullRequest().pull_number,
        body: `Seems you are using me but didn't get OPENAI_API_KEY set in Variables/Secrets for this repo. You could follow [readme](https://github.com/anc95/ChatGPT-CodeReview) for more information.`,
      });
      return null;
    }
  };

  app.on(['pull_request.opened', 'pull_request.synchronize'], async (context) => {
    const repo = context.repo();
    const chat = await loadChat(context);

    if (!chat) {
      log.info('Chat initialized failed');
      return 'no chat';
    }

    const pull_request = context.payload.pull_request;

    if (pull_request.state === 'closed' || pull_request.locked) {
      log.info('invalid event payload');
      return 'invalid event payload';
    }

    const target_label = process.env.TARGET_LABEL;
    if (
      target_label &&
      (!pull_request.labels?.length ||
        pull_request.labels.every((label) => label.name !== target_label))
    ) {
      log.info('no target label attached');
      return 'no target label attached';
    }

    const data = await context.octokit.repos.compareCommits({
      owner: repo.owner,
      repo: repo.repo,
      base: context.payload.pull_request.base.sha,
      head: context.payload.pull_request.head.sha,
    });

    let { files: changedFiles, commits } = data.data;

    if (context.payload.action === 'synchronize' && commits.length >= 2) {
      const {
        data: { files },
      } = await context.octokit.repos.compareCommits({
        owner: repo.owner,
        repo: repo.repo,
        base: commits[commits.length - 2].sha,
        head: commits[commits.length - 1].sha,
      });

      changedFiles = files;
    }

    const ignoreList = (process.env.IGNORE || '').split('\n').filter((v) => v !== '');
    const ignorePatterns = (process.env.IGNORE_PATTERNS || '').split(',').filter((v) => v.trim());
    const includePatterns = (process.env.INCLUDE_PATTERNS || '').split(',').filter((v) => v.trim());

    changedFiles = changedFiles?.filter((file) => {
      const url = new URL(file.contents_url);
      const pathname = decodeURIComponent(url.pathname);

      if (includePatterns.length) {
        return matchPatterns(includePatterns, pathname);
      }

      if (ignoreList.includes(file.filename)) {
        return false;
      }

      if (ignorePatterns.length) {
        return !matchPatterns(ignorePatterns, pathname);
      }

      return true;
    });

    if (!changedFiles?.length) {
      log.info('no change found');
      return 'no change';
    }

    console.time('gpt cost');

    // ✅ 핵심: 전체 diff 문자열 생성
    let combinedPatch = '';

    for (const file of changedFiles) {
      const patch = file.patch || '';
      if (file.status !== 'modified' && file.status !== 'added') continue;
      if (!patch || patch.length > MAX_PATCH_COUNT) continue;

      combinedPatch += `\n\n// File: ${file.filename}\n${patch}`;
    }

    let commentBody = 'LGTM 👍';

    try {
      const res = await chat.codeReview(combinedPatch);
      if (res?.review_comment && !res.lgtm) {
        commentBody = res.review_comment;
      }
    } catch (e) {
      log.info(`GPT review failed`, e);
    }

    try {
      await context.octokit.issues.createComment({
        ...context.issue(),
        body: commentBody,
      });
    } catch (e) {
      log.info(`Failed to create PR comment`, e);
    }

    console.timeEnd('gpt cost');
    log.info('successfully reviewed', pull_request.html_url);
    return 'success';
  });
};

const matchPatterns = (patterns: string[], path: string) => {
  return patterns.some((pattern) => {
    try {
      return minimatch(
        path,
        pattern.startsWith('/') ? '**' + pattern : pattern.startsWith('**') ? pattern : '**/' + pattern
      );
    } catch {
      try {
        return new RegExp(pattern).test(path);
      } catch {
        return false;
      }
    }
  });
};
