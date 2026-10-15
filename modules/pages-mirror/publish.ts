// Publishes the mirror's files as the tip of a git branch with the git CLI: start from the remote branch,
// replace the whole tree, commit only when something changed, and push without force. A push the remote
// rejects because the branch moved is tried once more on top of the remote's new tip.
//
// The token reaches git only through the environment of each git process (GIT_CONFIG_COUNT/KEY/VALUE,
// git 2.31+), as an Authorization header for the repository's host: it is never written into .git/config,
// a remote URL or a command line, and it is removed from any error message.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface PublishOptions {
  /** The working checkout (created on first use). */
  dir: string;
  repo: string;
  branch: string;
  token: string | null;
  /** "Name <email>". */
  author: string;
  files: ReadonlyMap<string, Buffer>;
  now: Date;
}

export interface PublishResult {
  /** The branch's tip after the run. */
  commit: string;
  changed: boolean;
  /** When the push was accepted; null when there was nothing to push. */
  pushedAt: Date | null;
}

export function parseAuthor(author: string): { name: string; email: string } {
  const m = /^\s*(.+?)\s*<([^<>\s]+)>\s*$/.exec(author);
  if (!m) throw new Error(`PAGES_MIRROR_GIT_AUTHOR must look like "Name <email>" (got "${author}")`);
  return { name: m[1]!, email: m[2]! };
}

export async function publish(options: PublishOptions): Promise<PublishResult> {
  const { dir, branch } = options;
  const author = parseAuthor(options.author);
  const secrets: string[] = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
  };
  const remote = /^https?:\/\//i.test(options.repo) ? new URL(options.repo) : null;
  if (options.token && remote) {
    const basic = Buffer.from(`x-access-token:${options.token}`).toString("base64");
    secrets.push(options.token, basic);
    Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${remote.origin}/.extraheader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` });
  }
  const redact = (text: string) => secrets.reduce((t, s) => t.split(s).join("***"), text);
  const git = async (...args: string[]): Promise<string> => {
    try {
      const { stdout } = await run("git", ["-c", "commit.gpgsign=false", ...args], { cwd: dir, env, maxBuffer: 64 * 1024 * 1024 });
      return stdout.trim();
    } catch (error) {
      const e = error as Error & { stderr?: string };
      throw new Error(redact(`git ${args[0]} failed: ${(e.stderr || e.message).trim()}`));
    }
  };

  await mkdir(dir, { recursive: true });
  if (!existsSync(path.join(dir, ".git"))) {
    await git("init", "-q");
    await git("remote", "add", "origin", options.repo);
  } else {
    await git("remote", "set-url", "origin", options.repo);
  }

  /** Puts the checkout on the remote branch's tip (or an empty new branch) with exactly the mirror's files staged. */
  const prepare = async () => {
    const onRemote = (await git("ls-remote", "--heads", "origin", `refs/heads/${branch}`)) !== "";
    if (onRemote) {
      await git("fetch", "-q", "--depth=1", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
      await git("checkout", "-q", "-f", "-B", branch, `refs/remotes/origin/${branch}`);
    } else {
      await git("symbolic-ref", "HEAD", `refs/heads/${branch}`);
      await git("update-ref", "-d", `refs/heads/${branch}`);
      await git("read-tree", "--empty");
    }
    for (const entry of await readdir(dir)) if (entry !== ".git") await rm(path.join(dir, entry), { recursive: true, force: true });
    for (const [file, body] of options.files) {
      const target = path.join(dir, ...file.split("/"));
      if (!target.startsWith(dir + path.sep)) throw new Error(`refusing to write outside the checkout: ${file}`);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body);
    }
    await git("add", "-A");
    return (await git("status", "--porcelain")) !== "";
  };

  /** Commits what changed; false when the branch already holds this tree. */
  const commit = async () => {
    if (!(await prepare())) return false;
    await git("commit", "-q", "-m", `Mirror ${options.now.toISOString()}`);
    return true;
  };

  let changed = await commit();
  if (!changed) return { commit: await git("rev-parse", "HEAD"), changed, pushedAt: null };
  try {
    await git("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  } catch {
    // The branch moved since it was read: start again from its new tip.
    changed = await commit();
    if (!changed) return { commit: await git("rev-parse", "HEAD"), changed, pushedAt: null };
    await git("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  }
  return { commit: await git("rev-parse", "HEAD"), changed, pushedAt: new Date() };
}
