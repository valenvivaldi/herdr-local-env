import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bandEntries, latestPerEnv, runPercent, toRow } from "../mods/local-env/lib.js";
import { checkouts, probeEnvs, readRuns } from "../mods/local-env/probe.js";

const NOW = 1_800_000_000;

/** @returns {import("../mods/local-env/lib.js").Progress} */
const progress = (over = {}) => ({
  v: 1, cmd: "up", pid: 100, env: "main", root: "/w/main", phase: "build", step: 2, of: 6,
  label: "smartbuild", task: ":compileJava", started: NOW - 90, phaseStarted: NOW - 30,
  updated: NOW - 5, state: "running", error: "", urls: {}, ...over,
});

describe("runs", () => {
  test("the bar: only while running, by step, never full until done", () => {
    assert.equal(runPercent(toRow("f", progress({ step: 5, of: 8 }), NOW)), 63);
    assert.equal(runPercent(toRow("f", progress({ step: 8, of: 8 }), NOW)), 95);
    assert.equal(runPercent(toRow("f", progress({ step: 0, of: 0 }), NOW)), 0);
    assert.equal(runPercent(toRow("f", progress({ state: "done" }), NOW)), undefined);
    assert.equal(runPercent(toRow("f", progress({ state: "failed" }), NOW)), undefined);
    assert.equal(runPercent(toRow("f", progress(), NOW, false)), undefined);
  });

  test("a finished run stays a while (failures longer), a running one whose pid died is stale", () => {
    assert.equal(toRow("f", progress({ state: "done", updated: NOW - 100 }), NOW)?.state, "done");
    assert.equal(toRow("f", progress({ state: "done", updated: NOW - 200 }), NOW), undefined);
    assert.equal(toRow("f", progress({ state: "failed", updated: NOW - 500 }), NOW)?.state, "failed");
    assert.equal(toRow("f", progress({ state: "failed", updated: NOW - 700 }), NOW), undefined);
    const stale = toRow("f", progress(), NOW, false);
    assert.equal(stale?.state, "stale");
    assert.match(stale?.error ?? "", /pid 100/);
    assert.equal(toRow("f", progress({ state: "weird" }), NOW), undefined);
  });

  test("one run per environment: the one that started last wins, ties by last write", () => {
    const create = { file: "create", p: progress({ cmd: "worktree", started: NOW - 300, updated: NOW - 200 }) };
    const up = { file: "up", p: progress({ started: NOW - 100 }) };
    const other = { file: "other", p: progress({ root: "/w/other" }) };
    assert.deepEqual(latestPerEnv([create, up, other]).map((r) => r.file), ["up", "other"]);
    const a = { file: "a", p: progress({ updated: NOW - 9 }) };
    const b = { file: "b", p: progress({ updated: NOW - 1 }) };
    assert.deepEqual(latestPerEnv([a, b]).map((r) => r.file), ["b"]);
  });

  test("a finished run of an environment that is up becomes its entry; stopped ones stay out", () => {
    const service = (name, state) => ({ name, port: 1, url: name === "PG" ? "" : `http://localhost:1/${name}`, state });
    const env = (root, tomcat, updated) => ({
      name: root.slice(3), root, isMain: false, repos: [], source: "",
      services: [service("Tomcat", tomcat), service("PG", tomcat), service("SPA", "down"), service("BFF", "down")],
      lastRun: { cmd: "up", state: "done", updated },
    });
    const envs = [env("/w/old", "up", NOW - 900), env("/w/new", "up", NOW - 10), env("/w/off", "down", NOW)];
    const rows = [toRow("x", progress({ root: "/w/new", state: "done" }), NOW), toRow("y", progress({ root: "/w/run" }), NOW)];
    const { rows: shown, summary } = bandEntries(rows, envs);
    assert.deepEqual(shown.map((r) => r.root), ["/w/run"]);
    assert.deepEqual(summary.map((s) => s.root), ["/w/new", "/w/old"]);
    assert.equal(summary[0].parts[0].href, "http://localhost:1/Tomcat");
  });
});

describe("probe", () => {
  let base;
  const io = {
    read: (p) => readFile(p, "utf8").catch(() => ""),
    list: (d) => readdir(d, { withFileTypes: true }).then((es) => es.map((e) => ({ name: e.name, isDir: e.isDirectory() })), () => []),
    exists: (p) => stat(p).then(() => true, () => false),
    // ps: only pid 4242 lives; curl: the main checkout's Tomcat answers 200, the env's 503
    run: async (cmd, args) => {
      if (cmd === "ps") return { code: 0, stdout: args.at(-1).split(",").filter((p) => p === "4242").join("\n") };
      const url = args.at(-1);
      return { code: 0, stdout: url.includes(":8080/") ? "200" : url.includes(":8081/") ? "503" : "000" };
    },
  };
  const put = async (path, text) => {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await writeFile(join(base, path), text);
  };
  const checkout = async (dir) => {
    await put(`${dir}/build.xml`, "");
    await put(`${dir}/gradle.properties`, "context.name=etendo\n");
    await mkdir(join(base, dir, "src-db"), { recursive: true });
  };

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "local-env-"));
    await checkout("main");
    await put("main/.git/HEAD", "ref: refs/heads/develop\n");
    await put("main/build/local-env/pgdata/postmaster.pid", "4242\n/x\n0\n55432\n");
    await put("main/build/local-env/progress.json", JSON.stringify(progress({ root: join(base, "main"), state: "done" })));
    await mkdir(join(base, "main/schema_forge/src"), { recursive: true });

    await checkout(".worktrees/ETP-1");
    await put(".worktrees/ETP-1/build/local-env/env", "export PORT=8081\nexport SPA_PORT='3101'\n");
    await put(".worktrees/ETP-1/build/local-env/worktree-repos", "modules/com.etendoerp.go feature/ETP-1\nrepo:schema_forge feature/ETP-1 adopt /x/sf\n");
    await put(".worktrees/ETP-1/build/local-env/source-root", join(base, "main"));
    await put(".worktrees/ETP-1/build/local-env/plugins/etendo-go/spa.pid", "999\n");
    await put(".worktrees/.progress/ETP-2.json", JSON.stringify(progress({ cmd: "worktree", env: "ETP-2" })));
    await put(".worktrees/.progress/notes.txt", "");
    await mkdir(join(base, ".worktrees/plain"), { recursive: true });
  });

  after(() => rm(base, { recursive: true, force: true }));

  test("folders inside the main checkout and inside an environment are one checkout; others none", async () => {
    const found = await checkouts(io, [join(base, "main/schema_forge/src"), join(base, ".worktrees/ETP-1"), base]);
    assert.deepEqual(found, [{ main: join(base, "main"), base: join(base, ".worktrees") }]);
  });

  test("runs: the main checkout's, each environment's, and the .progress jobs", async () => {
    const [c] = await checkouts(io, [join(base, "main")]);
    const files = (await readRuns(io, c)).map((r) => r.file.slice(base.length + 1)).sort();
    assert.deepEqual(files, [".worktrees/.progress/ETP-2.json", "main/build/local-env/progress.json"]);
  });

  test("environments: services from pids and HTTP, repos applied, plain worktree dirs skipped", async () => {
    const [c] = await checkouts(io, [join(base, "main")]);
    const [main, env, ...rest] = await probeEnvs(io, c);
    assert.equal(rest.length, 0);
    const states = (e) => Object.fromEntries(e.services.map((s) => [s.name, `${s.port} ${s.state}`]));
    assert.deepEqual(states(main), { Tomcat: "8080 up", PG: "55432 up", SPA: "3100 down", BFF: "3400 down" });
    assert.deepEqual(states(env), { Tomcat: "8081 starting", PG: "55432 down", SPA: "3101 down", BFF: "3400 down" });
    assert.deepEqual(main.repos, [{ name: "core", branch: "develop", kind: "main", target: "" }]);
    assert.deepEqual(env.repos.map((r) => `${r.name} ${r.kind} ${r.target}`), ["core copy ", "modules/com.etendoerp.go worktree ", "schema_forge adopted /x/sf"]);
    assert.equal(env.source, join(base, "main"));
    assert.equal(main.lastRun?.state, "done");
  });
});
