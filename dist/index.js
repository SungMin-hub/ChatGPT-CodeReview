import { run } from 'probot';
import log from 'loglevel';
import { minimatch } from 'minimatch';
import { AzureOpenAI, OpenAI } from 'openai';

log.setLevel(process.env.LOG_LEVEL || "info");

class Chat {
  openai;
  isAzure;
  constructor(apikey) {
    this.isAzure = Boolean(
      process.env.AZURE_API_VERSION && process.env.AZURE_DEPLOYMENT
    );
    if (this.isAzure) {
      this.openai = new AzureOpenAI({
        apiKey: apikey,
        endpoint: process.env.OPENAI_API_ENDPOINT || "",
        apiVersion: process.env.AZURE_API_VERSION || "",
        deployment: process.env.AZURE_DEPLOYMENT || ""
      });
    } else {
      this.openai = new OpenAI({
        apiKey: apikey,
        baseURL: process.env.OPENAI_API_ENDPOINT || "https://api.openai.com/v1"
      });
    }
  }
  generatePrompt = (patch) => {
    const answerLanguage = process.env.LANGUAGE ? `Answer me in ${process.env.LANGUAGE},` : "";
    const userPrompt = process.env.PROMPT || "Please review the following code patch. Focus on potential bugs, risks, and improvement suggestions.";
    const jsonFormatRequirement = '\nProvide your feedback in a strict JSON format with the following structure:\n{\n  "lgtm": boolean, // true if the code looks good to merge, false if there are concerns\n  "review_comment": string // Your detailed review comments. You can use markdown syntax in this string, but the overall response must be a valid JSON\n}\nEnsure your response is a valid JSON object.\n';
    return `${userPrompt}${jsonFormatRequirement} ${answerLanguage}:
    ${patch}
    `;
  };
  codeReview = async (patch) => {
    if (!patch) {
      return {
        lgtm: true,
        review_comment: ""
      };
    }
    console.time("code-review cost");
    const prompt = this.generatePrompt(patch);
    const res = await this.openai.chat.completions.create({
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      model: process.env.MODEL || "gpt-4o-mini",
      temperature: +(process.env.temperature || 0) || 1,
      top_p: +(process.env.top_p || 0) || 1,
      max_tokens: process.env.max_tokens ? +process.env.max_tokens : void 0,
      response_format: {
        type: "json_object"
      }
    });
    console.timeEnd("code-review cost");
    if (res.choices.length) {
      try {
        const json = JSON.parse(res.choices[0].message.content || "");
        return json;
      } catch (e) {
        return {
          lgtm: false,
          review_comment: res.choices[0].message.content || ""
        };
      }
    }
    return {
      lgtm: true,
      review_comment: ""
    };
  };
}

const OPENAI_API_KEY = "OPENAI_API_KEY";
const MAX_PATCH_COUNT = process.env.MAX_PATCH_LENGTH ? +process.env.MAX_PATCH_LENGTH : Infinity;
const robot = (app) => {
  const loadChat = async (context) => {
    if (process.env.OPENAI_API_KEY) {
      return new Chat(process.env.OPENAI_API_KEY);
    }
    const repo = context.repo();
    try {
      const { data } = await context.octokit.request(
        "GET /repos/{owner}/{repo}/actions/variables/{name}",
        {
          owner: repo.owner,
          repo: repo.repo,
          name: OPENAI_API_KEY
        }
      );
      if (!data?.value) {
        return null;
      }
      return new Chat(data.value);
    } catch {
      await context.octokit.issues.createComment({
        repo: repo.repo,
        owner: repo.owner,
        issue_number: context.pullRequest().pull_number,
        body: `Seems you are using me but didn't get OPENAI_API_KEY set in Variables/Secrets for this repo. You could follow [readme](https://github.com/anc95/ChatGPT-CodeReview) for more information.`
      });
      return null;
    }
  };
  app.on(["pull_request.opened", "pull_request.synchronize"], async (context) => {
    const repo = context.repo();
    const chat = await loadChat(context);
    if (!chat) {
      log.info("Chat initialized failed");
      return "no chat";
    }
    const pull_request = context.payload.pull_request;
    if (pull_request.state === "closed" || pull_request.locked) {
      log.info("invalid event payload");
      return "invalid event payload";
    }
    const target_label = process.env.TARGET_LABEL;
    if (target_label && (!pull_request.labels?.length || pull_request.labels.every((label) => label.name !== target_label))) {
      log.info("no target label attached");
      return "no target label attached";
    }
    const data = await context.octokit.repos.compareCommits({
      owner: repo.owner,
      repo: repo.repo,
      base: context.payload.pull_request.base.sha,
      head: context.payload.pull_request.head.sha
    });
    let { files: changedFiles, commits } = data.data;
    if (context.payload.action === "synchronize" && commits.length >= 2) {
      const {
        data: { files }
      } = await context.octokit.repos.compareCommits({
        owner: repo.owner,
        repo: repo.repo,
        base: commits[commits.length - 2].sha,
        head: commits[commits.length - 1].sha
      });
      changedFiles = files;
    }
    const ignoreList = (process.env.IGNORE || "").split("\n").filter((v) => v !== "");
    const ignorePatterns = (process.env.IGNORE_PATTERNS || "").split(",").filter((v) => v.trim());
    const includePatterns = (process.env.INCLUDE_PATTERNS || "").split(",").filter((v) => v.trim());
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
      log.info("no change found");
      return "no change";
    }
    console.time("gpt cost");
    let combinedPatch = "";
    for (const file of changedFiles) {
      const patch = file.patch || "";
      if (file.status !== "modified" && file.status !== "added")
        continue;
      if (!patch || patch.length > MAX_PATCH_COUNT)
        continue;
      combinedPatch += `

// File: ${file.filename}
${patch}`;
    }
    let commentBody = "LGTM \u{1F44D}";
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
        body: commentBody
      });
    } catch (e) {
      log.info(`Failed to create PR comment`, e);
    }
    console.timeEnd("gpt cost");
    log.info("successfully reviewed", pull_request.html_url);
    return "success";
  });
};
const matchPatterns = (patterns, path) => {
  return patterns.some((pattern) => {
    try {
      return minimatch(
        path,
        pattern.startsWith("/") ? "**" + pattern : pattern.startsWith("**") ? pattern : "**/" + pattern
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

log.info("Starting probot");
run(robot);
