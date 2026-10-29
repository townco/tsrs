#!/usr/bin/env node
// Rebuild town/patched as oxc-project/tsrs main plus fork/patches.txt.
// Cherry-pick only. Never pushes the default branch. See docs/FORK.md.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstreamUrl = process.env.UPSTREAM_URL ?? "https://github.com/oxc-project/tsrs.git";
const originRemote = process.env.ORIGIN_REMOTE ?? "origin";
const repository = process.env.GITHUB_REPOSITORY ?? "townco/tsrs";
const patchListPath = path.join(repoRoot, "fork", "patches.txt");
const patchedBranch = "town/patched";
const failureBranch = "town/fork-sync-failure";
const failureTitle = "Fork sync failed";
const committerName = "github-actions[bot]";
const committerEmail = "41898282+github-actions[bot]@users.noreply.github.com";
const dryRun = process.argv.includes("--dry-run");
const forceTest = process.argv.includes("--test");

class SyncFailure extends Error {
    constructor(message) {
        super(message);
        this.name = "SyncFailure";
    }
}

const redact = (text) =>
    String(text ?? "")
        .replace(/x-access-token:[^@\s]+/g, "x-access-token:[REDACTED]")
        .replace(/password=.*/g, "password=[REDACTED]")
        .replace(/\b(ghp_|github_pat_|gho_)[A-Za-z0-9_]+/g, "[REDACTED]");

const clip = (text, limit = 12000) => {
    const clean = redact(text).trim();
    return clean.length <= limit ? clean : `…${clean.slice(clean.length - limit)}`;
};

function run(argv, { cwd = repoRoot, ok = false, env, inherit = false } = {}) {
    const options = {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    };
    if (inherit) {
        const result = spawnSync(argv[0], argv.slice(1), options);
        if (result.error) {
            const error = new SyncFailure(`${argv.join(" ")} failed to start: ${result.error.message}`);
            if (ok) return { code: 1, stdout: "", stderr: error.message };
            throw error;
        }
        const code = result.status ?? 1;
        if (code !== 0 && !ok) {
            throw new SyncFailure(`${argv.join(" ")} exited ${code}. The command output is in the job log.`);
        }
        return { code, stdout: "", stderr: "" };
    }
    try {
        const stdout = execFileSync(argv[0], argv.slice(1), options);
        return { code: 0, stdout: stdout ?? "", stderr: "" };
    } catch (error) {
        const result = {
            code: error.status ?? 1,
            stdout: error.stdout?.toString() ?? "",
            stderr: error.stderr?.toString() || error.message || "",
        };
        if (ok) return result;
        throw new SyncFailure(`${argv.join(" ")} exited ${result.code}\n${clip(result.stdout)}\n${clip(result.stderr)}`);
    }
}

const git = (args, options) => run(["git", ...args], options);

function assertRepository() {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
        throw new SyncFailure(`GITHUB_REPOSITORY ${repository} is not an owner/name`);
    }
}

function readPatchList() {
    const text = readFileSync(patchListPath, "utf8");
    const shas = [];
    for (const [index, raw] of text.split("\n").entries()) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        if (!/^[0-9a-f]{40}$/.test(line)) {
            throw new SyncFailure(`${patchListPath}:${index + 1} must be a full 40-character commit SHA`);
        }
        shas.push(line);
    }
    if (shas.length === 0) throw new SyncFailure(`${patchListPath} lists no commits; refusing to point ${patchedBranch} at bare upstream`);
    const seen = new Set();
    for (const sha of shas) {
        if (seen.has(sha)) throw new SyncFailure(`${patchListPath} lists ${sha} more than once`);
        seen.add(sha);
    }
    return shas;
}

function requireToken() {
    if (dryRun) return;
    if (process.env.FORK_PUSH_TOKEN) return;
    throw new SyncFailure(
        [
            "FORK_PUSH_TOKEN is missing.",
            `Fork sync will not push ${patchedBranch} or its backup tags, and it will not use GITHUB_TOKEN for that push.`,
            "Add a repository Actions secret named FORK_PUSH_TOKEN.",
            "The value is a fine-grained personal access token, or a GitHub App installation token, whose repository access is only townco/tsrs, with Contents read and write.",
            "Metadata read is required by GitHub. Workflows permission is not required for the current stack.",
            "Do not commit the token, and do not grant it a bypass of the ruleset \"Human-only default branch updates\". This job never pushes main.",
        ].join("\n"),
    );
}

function fetchUpstream() {
    git(["fetch", "--no-tags", upstreamUrl, `+main:refs/remotes/upstream/main`]);
    return git(["rev-parse", "refs/remotes/upstream/main"]).stdout.trim();
}

function fetchPatchCommit(sha) {
    const ref = `refs/fork-sync/patches/${sha}`;
    const fetched = git(["fetch", "--no-tags", originRemote, `${sha}:${ref}`], { ok: true });
    if (fetched.code !== 0) {
        throw new SyncFailure(
            `${sha} is not reachable from ${originRemote}. Keep the patch commit on a branch or a fork-backup-* tag.\n${clip(`${fetched.stdout}\n${fetched.stderr}`)}`,
        );
    }
    const type = git(["cat-file", "-t", sha], { ok: true });
    if (type.code !== 0 || type.stdout.trim() !== "commit") {
        throw new SyncFailure(`${sha} did not fetch as a commit`);
    }
    const parents = git(["rev-list", "--parents", "-n", "1", sha]).stdout.trim().split(/\s+/).slice(1);
    if (parents.length !== 1) {
        throw new SyncFailure(`${sha} has ${parents.length} parents. The patch list only cherry-picks non-merge commits.`);
    }
}

function readRemoteTip() {
    const listed = git(["ls-remote", originRemote, `refs/heads/${patchedBranch}`]);
    const line = listed.stdout.trim().split("\n").find((entry) => entry.endsWith(`refs/heads/${patchedBranch}`));
    if (!line) return null;
    const sha = line.split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new SyncFailure(`unexpected ls-remote line for ${patchedBranch}: ${clip(line, 200)}`);
    git(["fetch", "--no-tags", originRemote, `refs/heads/${patchedBranch}:refs/remotes/${originRemote}/${patchedBranch}`]);
    const tree = git(["rev-parse", `${sha}^{tree}`]).stdout.trim();
    return { sha, tree };
}

function cherryPickHead(worktree) {
    const gitPath = git(["rev-parse", "--git-path", "CHERRY_PICK_HEAD"], { cwd: worktree }).stdout.trim();
    const absolute = path.isAbsolute(gitPath) ? gitPath : path.join(worktree, gitPath);
    return existsSync(absolute);
}

function abortCherryPick(worktree) {
    git(["cherry-pick", "--abort"], { cwd: worktree, ok: true });
    git(["cherry-pick", "--quit"], { cwd: worktree, ok: true });
}

function cherryPickOne(worktree, sha) {
    const before = git(["rev-parse", "HEAD"], { cwd: worktree }).stdout.trim();
    const picked = git(
        ["-c", `user.name=${committerName}`, "-c", `user.email=${committerEmail}`, "cherry-pick", "-x", sha],
        { cwd: worktree, ok: true },
    );
    const output = `${picked.stdout}\n${picked.stderr}`;
    const unmerged = git(["diff", "--name-only", "--diff-filter=U"], { cwd: worktree, ok: true }).stdout.trim();
    const cached = git(["diff", "--cached", "--quiet"], { cwd: worktree, ok: true });
    const work = git(["diff", "--quiet"], { cwd: worktree, ok: true });
    const empty = /previous cherry-pick is now empty/i.test(output);
    const clean = !unmerged && cached.code === 0 && work.code === 0;
    if (picked.code !== 0 && empty && clean && cherryPickHead(worktree)) {
        const skipped = git(["cherry-pick", "--skip"], { cwd: worktree, ok: true });
        if (skipped.code !== 0 || git(["rev-parse", "HEAD"], { cwd: worktree }).stdout.trim() !== before || cherryPickHead(worktree)) {
            abortCherryPick(worktree);
            throw new SyncFailure(`could not drop empty cherry-pick of ${sha}\n${clip(`${output}\n${skipped.stdout}\n${skipped.stderr}`)}`);
        }
        return "drop";
    }
    if (picked.code !== 0 || cherryPickHead(worktree)) {
        const files = unmerged || "(no unmerged paths reported)";
        abortCherryPick(worktree);
        throw new SyncFailure(`cherry-pick of ${sha} conflicted. ${patchedBranch} was not moved.\nUnmerged paths:\n${files}\n${clip(output)}`);
    }
    const after = git(["rev-parse", "HEAD"], { cwd: worktree }).stdout.trim();
    if (after === before) throw new SyncFailure(`cherry-pick of ${sha} did not create a commit and was not empty`);
    return "keep";
}

function replay(upstreamSha, shas) {
    const worktree = mkdtempSync(path.join(tmpdir(), "tsrs-fork-sync-"));
    const kept = [];
    const dropped = [];
    try {
        git(["worktree", "add", "--detach", worktree, upstreamSha]);
        for (const sha of shas) {
            const ancestor = git(["merge-base", "--is-ancestor", sha, upstreamSha], { ok: true });
            if (ancestor.code === 0) {
                dropped.push(sha);
                continue;
            }
            const outcome = cherryPickOne(worktree, sha);
            if (outcome === "drop") dropped.push(sha);
            else kept.push(sha);
        }
        const head = git(["rev-parse", "HEAD"], { cwd: worktree }).stdout.trim();
        const tree = git(["rev-parse", "HEAD^{tree}"], { cwd: worktree }).stdout.trim();
        if (kept.length === 0) {
            if (head !== upstreamSha) throw new SyncFailure(`every patch was dropped but HEAD ${head} is not upstream ${upstreamSha}`);
        } else {
            const base = git(["rev-parse", `HEAD~${kept.length}`], { cwd: worktree }).stdout.trim();
            if (base !== upstreamSha) throw new SyncFailure(`replay ${head} is not ${kept.length} commit(s) on upstream ${upstreamSha} (base ${base})`);
        }
        return { worktree, head, tree, kept, dropped };
    } catch (error) {
        removeWorktree(worktree);
        throw error;
    }
}

function removeWorktree(worktree) {
    if (!worktree) return;
    git(["worktree", "remove", "--force", worktree], { ok: true });
    rmSync(worktree, { recursive: true, force: true });
}

function toolchainChannel(worktree) {
    const text = readFileSync(path.join(worktree, "rust-toolchain.toml"), "utf8");
    const match = text.match(/^\s*channel\s*=\s*"([^"]+)"/m);
    if (!match) throw new SyncFailure(`${worktree}/rust-toolchain.toml has no channel`);
    if (!/^[A-Za-z0-9._-]+$/.test(match[1])) throw new SyncFailure(`refusing toolchain channel ${match[1]}`);
    return match[1];
}

function typescriptCommit(worktree) {
    const text = readFileSync(path.join(worktree, "Cargo.toml"), "utf8");
    const section = text.split("[workspace.metadata.typescript]")[1];
    if (!section) throw new SyncFailure("Cargo.toml has no [workspace.metadata.typescript]");
    const body = section.split("\n[")[0];
    const match = body.match(/^\s*commit\s*=\s*"([0-9a-f]{40})"/m);
    if (!match) throw new SyncFailure("Cargo.toml has no typescript commit pin");
    return match[1];
}

function prepareTypeScript(worktree) {
    const commit = typescriptCommit(worktree);
    const dest = path.join(worktree, "ts-ref");
    const marker = path.join(dest, "packages/typescript/src/api/sync/client.ts");
    if (existsSync(dest)) {
        const head = git(["rev-parse", "HEAD"], { cwd: dest, ok: true });
        if (head.code === 0 && head.stdout.trim() === commit && existsSync(marker)) return;
        rmSync(dest, { recursive: true, force: true });
    }
    git(["init", "-b", "main", dest]);
    git(["-C", dest, "remote", "add", "origin", "https://github.com/microsoft/TypeScript.git"]);
    git(["-C", dest, "sparse-checkout", "init", "--cone"]);
    git(
        [
            "-C",
            dest,
            "sparse-checkout",
            "set",
            "tsc/testdata",
            "packages/typescript/src",
            "packages/typescript/lib",
            "packages/typescript/vendor",
            "tools/scripts/tsc",
        ],
    );
    git(["-C", dest, "fetch", "--depth", "1", "--filter=blob:none", "origin", commit]);
    git(["-c", "advice.detachedHead=false", "-C", dest, "checkout", "FETCH_HEAD"]);
    const head = git(["rev-parse", "HEAD"], { cwd: dest }).stdout.trim();
    if (head !== commit || !existsSync(marker)) {
        throw new SyncFailure(`TypeScript checkout at ${dest} is ${head}, expected ${commit}`);
    }
    console.log(`typescript ${commit}`);
}

function ensureNode(worktree) {
    const requested = readFileSync(path.join(worktree, ".node-version"), "utf8").trim();
    if (!/^\d+(?:\.\d+\.\d+)?$/.test(requested)) throw new SyncFailure(`refusing Node version ${requested}`);
    const major = requested.split(".")[0];
    const current = run(["node", "--version"], { ok: true }).stdout.trim();
    const matchesExact = current === `v${requested}`;
    const matchesMajor = !requested.includes(".") && current.startsWith(`v${major}.`);
    if (matchesExact || matchesMajor) return process.env.PATH ?? "";
    const arch = run(["uname", "-m"]).stdout.trim();
    const nodeArch = arch === "x86_64" ? "x64" : arch === "aarch64" ? "arm64" : "";
    if (!nodeArch) throw new SyncFailure(`unsupported architecture ${arch} for Node ${requested}`);
    const base = requested.includes(".")
        ? `https://nodejs.org/dist/v${requested}`
        : `https://nodejs.org/dist/latest-v${requested}.x`;
    const sums = run(["curl", "-fsSL", `${base}/SHASUMS256.txt`]).stdout;
    const row = sums.split("\n").find((line) => line.trim().endsWith(`linux-${nodeArch}.tar.xz`));
    if (!row) throw new SyncFailure(`no official linux-${nodeArch} Node tarball listed at ${base}`);
    const [expected, name] = row.trim().split(/\s+/);
    if (!/^node-v\d+\.\d+\.\d+-linux-(x64|arm64)\.tar\.xz$/.test(name) || !/^[0-9a-f]{64}$/.test(expected)) {
        throw new SyncFailure(`refusing Node tarball entry ${clip(row, 200)}`);
    }
    const version = name.slice("node-v".length, name.indexOf("-linux-"));
    const prefix = path.join(tmpdir(), `tsrs-node-v${version}`);
    const bin = path.join(prefix, "bin", "node");
    if (!existsSync(bin)) {
        const tarPath = path.join(tmpdir(), name);
        run(["curl", "-fsSL", "-o", tarPath, `${base}/${name}`]);
        const actual = createHash("sha256").update(readFileSync(tarPath)).digest("hex");
        if (actual !== expected) {
            rmSync(tarPath, { force: true });
            throw new SyncFailure(`Node tarball ${name} checksum did not match SHASUMS256.txt`);
        }
        mkdirSync(prefix, { recursive: true });
        run(["tar", "-xJf", tarPath, "-C", prefix, "--strip-components=1"]);
        rmSync(tarPath, { force: true });
    }
    const installed = run([bin, "--version"]).stdout.trim();
    if (!installed.startsWith(`v${major}.`)) throw new SyncFailure(`installed Node ${installed} does not match ${requested}`);
    console.log(`node ${installed}`);
    return `${path.join(prefix, "bin")}${path.delimiter}${process.env.PATH ?? ""}`;
}

function runGates(worktree) {
    const channel = toolchainChannel(worktree);
    console.log(`toolchain ${channel}`);
    run(
        ["rustup", "toolchain", "install", channel, "--profile", "minimal", "--component", "rustfmt,clippy"],
        { inherit: true },
    );
    const cargo = (args, env) =>
        run(["cargo", `+${channel}`, ...args], {
            cwd: worktree,
            inherit: true,
            env: { RUSTUP_TOOLCHAIN: channel, CARGO_TERM_COLOR: "always", ...env },
        });
    cargo(["fmt", "--all", "--check"]);
    cargo(["clippy", "--locked", "--all-targets", "--workspace", "--config", 'build.warnings="deny"']);
    cargo(["check", "--locked", "--workspace", "--all-targets", "--config", 'build.warnings="deny"']);
    const nodePath = ensureNode(worktree);
    prepareTypeScript(worktree);
    // Upstream CI's test command: the `ci` profile (release with debug assertions and overflow
    // checks). A debug build misses wall-time budgets in the tsrs_api integration tests.
    cargo(["test", "--profile", "ci", "--locked", "--workspace", "--config", 'build.warnings="deny"'], {
        PATH: nodePath,
    });
}

function remoteTag(name) {
    const listed = git(["ls-remote", originRemote, `refs/tags/${name}`]);
    const lines = listed.stdout.trim().split("\n").filter(Boolean);
    const exact = lines.find((entry) => entry.endsWith(`\trefs/tags/${name}`));
    if (!exact) return null;
    return exact.split(/\s+/)[0];
}

function pushWithToken(refspec, lease) {
    const destination = refspec.split(":")[1];
    if (destination === "refs/heads/main" || destination === "refs/heads/master") {
        throw new SyncFailure(`refusing to push ${destination}`);
    }
    const dir = mkdtempSync(path.join(tmpdir(), "tsrs-fork-ask-"));
    const helper = path.join(dir, "credential-helper.sh");
    writeFileSync(
        helper,
        "#!/bin/sh\ncat >/dev/null\nprintf 'username=x-access-token\\npassword=%s\\n' \"$FORK_PUSH_TOKEN\"\n",
        { mode: 0o700 },
    );
    try {
        const args = ["-c", "credential.helper=", "-c", `credential.helper=!${helper}`, "push"];
        if (lease) args.push(`--force-with-lease=${lease}`);
        args.push(`https://github.com/${repository}.git`, refspec);
        return git(args, { ok: true, env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" } });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

function publishPatched(remote, head) {
    if (remote) {
        const tag = `fork-backup-${remote.sha}`;
        const existing = remoteTag(tag);
        if (existing && existing !== remote.sha) {
            throw new SyncFailure(`${tag} already points at ${existing}, not ${remote.sha}. Refusing to move the backup tag.`);
        }
        if (!existing) {
            const tagged = pushWithToken(`${remote.sha}:refs/tags/${tag}`);
            if (tagged.code !== 0) {
                throw new SyncFailure(`backup tag ${tag} was rejected. ${patchedBranch} was not moved.\n${clip(`${tagged.stdout}\n${tagged.stderr}`)}`);
            }
        }
        const pushed = pushWithToken(`${head}:refs/heads/${patchedBranch}`, `refs/heads/${patchedBranch}:${remote.sha}`);
        if (pushed.code !== 0) {
            const now = git(["ls-remote", originRemote, `refs/heads/${patchedBranch}`], { ok: true });
            throw new SyncFailure(
                `force-with-lease push of ${patchedBranch} was rejected. The tip observed before the push was ${remote.sha}. ${patchedBranch} was not moved by this run.\n${clip(`${pushed.stdout}\n${pushed.stderr}`)}\nls-remote now:\n${clip(now.stdout || now.stderr, 500)}`,
            );
        }
        return `moved ${patchedBranch} from ${remote.sha} to ${head} (backup ${tag})`;
    }
    const pushed = pushWithToken(`${head}:refs/heads/${patchedBranch}`);
    if (pushed.code !== 0) {
        throw new SyncFailure(`push of ${patchedBranch} was rejected.\n${clip(`${pushed.stdout}\n${pushed.stderr}`)}`);
    }
    return `pushed ${patchedBranch} at ${head}`;
}

let reported = false;

function stepSummary(text) {
    if (!process.env.GITHUB_STEP_SUMMARY) return;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text.trim()}\n`);
}

function publishFailure(body) {
    if (dryRun || reported) return;
    reported = true;
    stepSummary(body);
    const authed = run(["gh", "auth", "status"], { ok: true });
    if (authed.code !== 0) {
        console.log(`GitHub auth is unavailable; not updating the failure pull request\n${clip(authed.stderr, 500)}`);
        return;
    }
    const text = `${body.trim()}\n`;
    const bodyFile = path.join(tmpdir(), "tsrs-fork-sync-failure.txt");
    writeFileSync(bodyFile, text);
    try {
        pushFailureBranch(text);
        const listed = run(
            ["gh", "pr", "list", "--repo", repository, "--head", failureBranch, "--state", "all", "--json", "number,state,title"],
            { ok: true },
        );
        if (listed.code !== 0) {
            console.error(`could not list pull requests\n${clip(listed.stderr)}`);
            return;
        }
        const match = JSON.parse(listed.stdout || "[]")[0];
        if (!match) {
            const created = run(
                ["gh", "pr", "create", "--repo", repository, "--base", "main", "--head", failureBranch, "--draft", "--title", failureTitle, "--body-file", bodyFile],
                { ok: true },
            );
            if (created.code !== 0) {
                console.error(`could not open the failure pull request:\n${clip(created.stderr)}`);
                return;
            }
            console.log(created.stdout.trim());
            return;
        }
        run(["gh", "pr", "edit", String(match.number), "--repo", repository, "--title", failureTitle, "--body-file", bodyFile], { ok: true });
        if (match.state !== "OPEN") run(["gh", "pr", "reopen", String(match.number), "--repo", repository], { ok: true });
        console.log(`updated pull request #${match.number}`);
    } finally {
        rmSync(bodyFile, { force: true });
    }
}

function pushFailureBranch(text) {
    const remoteRef = `refs/remotes/${originRemote}/${failureBranch}`;
    const fetched = git(["fetch", "--no-tags", originRemote, `refs/heads/${failureBranch}:${remoteRef}`], { ok: true });
    const worktree = mkdtempSync(path.join(tmpdir(), "tsrs-fork-sync-failure-"));
    try {
        if (fetched.code === 0) git(["worktree", "add", "--detach", worktree, remoteRef]);
        else git(["worktree", "add", "--detach", worktree, `${originRemote}/main`]);
        const file = path.join(worktree, "fork", "sync-failure.md");
        mkdirSync(path.dirname(file), { recursive: true });
        if (existsSync(file) && readFileSync(file, "utf8") === text) return;
        writeFileSync(file, text);
        git(["add", "fork/sync-failure.md"], { cwd: worktree });
        git(
            ["-c", `user.name=${committerName}`, "-c", `user.email=${committerEmail}`, "commit", "-m", "fork: record sync failure"],
            { cwd: worktree },
        );
        const commit = git(["rev-parse", "HEAD"], { cwd: worktree }).stdout.trim();
        const pushed = git(["push", originRemote, `${commit}:refs/heads/${failureBranch}`], { cwd: worktree, ok: true });
        if (pushed.code !== 0) {
            throw new SyncFailure(`push of ${failureBranch} was rejected:\n${clip(`${pushed.stdout}\n${pushed.stderr}`)}`);
        }
    } finally {
        git(["worktree", "remove", "--force", worktree], { ok: true });
        rmSync(worktree, { recursive: true, force: true });
    }
}

function closeFailure(note) {
    if (dryRun) return;
    const listed = run(
        ["gh", "pr", "list", "--repo", repository, "--head", failureBranch, "--state", "open", "--json", "number"],
        { ok: true },
    );
    if (listed.code !== 0) {
        console.log(`could not list the failure pull request\n${clip(listed.stderr, 500)}`);
        return;
    }
    const match = JSON.parse(listed.stdout || "[]")[0];
    if (!match) return;
    const closed = run(["gh", "pr", "close", String(match.number), "--repo", repository, "--comment", note], { ok: true });
    if (closed.code !== 0) console.log(`could not close pull request #${match.number}\n${clip(closed.stderr, 500)}`);
    else console.log(`closed pull request #${match.number}`);
}

function describe(upstreamSha, replayed) {
    const dropped = replayed.dropped.length ? replayed.dropped.join(" ") : "(none)";
    const kept = replayed.kept.length ? replayed.kept.join(" ") : "(none)";
    return [`upstream ${upstreamSha}`, `kept ${kept}`, `dropped ${dropped}`, `candidate ${replayed.head}`].join("\n");
}

function main() {
    assertRepository();
    requireToken();
    const shas = readPatchList();
    const upstreamSha = fetchUpstream();
    for (const sha of shas) fetchPatchCommit(sha);
    const replayed = replay(upstreamSha, shas);
    try {
        console.log(describe(upstreamSha, replayed));
        const remote = readRemoteTip();
        if (remote && remote.tree === replayed.tree) {
            const detail = `${patchedBranch} already has this tree at ${remote.sha}`;
            console.log(detail);
            stepSummary(`${describe(upstreamSha, replayed)}\n\n${detail}`);
            closeFailure(`Sync succeeded for upstream ${upstreamSha}. ${detail}`);
            return;
        }
        if (dryRun && !forceTest) {
            console.log(`would run the workspace gates and ${remote ? "force-with-lease " : ""}push ${patchedBranch}`);
            return;
        }
        runGates(replayed.worktree);
        if (dryRun) {
            console.log(`gates passed; would ${remote ? "force-with-lease " : ""}push ${replayed.head} to ${patchedBranch}`);
            return;
        }
        const detail = publishPatched(remote, replayed.head);
        console.log(detail);
        stepSummary(`${describe(upstreamSha, replayed)}\n\n${detail}`);
        closeFailure(`Sync succeeded for upstream ${upstreamSha}.\n\n${describe(upstreamSha, replayed)}\n${detail}`);
    } finally {
        removeWorktree(replayed.worktree);
    }
}

try {
    main();
} catch (error) {
    const text = redact(error.stack || error.message);
    console.error(text);
    try {
        publishFailure(
            [
                "Fork sync did not publish town/patched.",
                "main was not pushed. Backup tags are not moved.",
                "",
                clip(error.message || text),
                "",
                "Do not merge this pull request. It only records the failure. docs/FORK.md describes the stack and the token.",
            ].join("\n"),
        );
    } catch (publishError) {
        console.error(redact(publishError.stack || publishError.message));
    }
    process.exitCode = 1;
}
