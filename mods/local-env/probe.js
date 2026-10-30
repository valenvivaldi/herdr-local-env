// What the mod reads from disk and from the machine: the checkouts, every environment's
// progress files, its ports and pids. Everything goes through `io` (main.js passes Herdr's
// fs and exec, the tests node's), so the tests can point it at a temp directory.
import {
  basename,
  contextName,
  dirname,
  headBranch,
  parseEnvFile,
  parsePostmaster,
  parseProgress,
  parseWorktreeRepos,
  portOf,
} from "./lib.js";

/**
 * @typedef {import("./lib.js").Environment} Environment
 * @typedef {import("./lib.js").Service} Service
 * @typedef {{
 *   read(path: string): Promise<string>,
 *   list(dir: string): Promise<{ name: string, isDir: boolean }[]>,
 *   exists(path: string): Promise<boolean>,
 *   run(cmd: string, args: string[]): Promise<{ code: number, stdout: string } | undefined>,
 * }} Io
 * @typedef {{ main: string, base: string }} Checkout
 */

/** @param {Io} io @param {string} dir */
async function isCheckout(io, dir) {
  return (await io.exists(`${dir}/build.xml`)) && (await io.exists(`${dir}/gradle.properties`)) && (await io.exists(`${dir}/src-db`));
}

/** The Etendo checkout holding `start`, found the way local-env finds it. @param {Io} io @param {string} start */
export async function findCheckout(io, start) {
  let dir = start.replace(/\/+$/, "");
  while (dir !== "" && dir !== "/") {
    if (await isCheckout(io, dir)) return dir;
    dir = dirname(dir);
  }
  return undefined;
}

/**
 * The main checkout behind `root` (itself, or the one an environment was made from) and
 * where its worktree environments live (`$LOCALENV_WORKTREES` is not visible from Herdr:
 * an environment's own parent, else `<main>/../.worktrees`, local-env's default).
 * @param {Io} io @param {string} root @returns {Promise<Checkout>}
 */
export async function layout(io, root) {
  const isEnv = await io.exists(`${root}/build/local-env/worktree-repos`);
  const source = isEnv ? (await io.read(`${root}/build/local-env/source-root`)).trim() : "";
  const main = source || root;
  return { main, base: isEnv ? dirname(root) : `${dirname(main)}/.worktrees` };
}

/**
 * Every distinct checkout the folders belong to (spaces' folders, the focused terminal's).
 * @param {Io} io @param {readonly string[]} folders @returns {Promise<Checkout[]>}
 */
export async function checkouts(io, folders) {
  /** @type {Map<string, Checkout>} */
  const found = new Map();
  for (const folder of new Set(folders)) {
    const root = await findCheckout(io, folder);
    if (root === undefined) continue;
    const c = await layout(io, root);
    found.set(c.main, c);
  }
  return [...found.values()];
}

/**
 * Every progress file of a checkout: the main checkout's, each worktree environment's, and
 * `<base>/.progress/*.json` (worktree create/rm).
 * @param {Io} io @param {Checkout} c
 */
export async function progressFiles(io, { main, base }) {
  const files = [`${main}/build/local-env/progress.json`];
  for (const entry of await io.list(base)) {
    if (entry.name === ".progress") {
      for (const job of await io.list(`${base}/.progress`)) {
        if (job.name.endsWith(".json")) files.push(`${base}/.progress/${job.name}`);
      }
    } else if (!entry.name.startsWith(".") && entry.isDir) {
      files.push(`${base}/${entry.name}/build/local-env/progress.json`);
    }
  }
  return files;
}

/** Every progress file that parses, with its contents. @param {Io} io @param {Checkout} c */
export async function readRuns(io, c) {
  const runs = [];
  for (const file of await progressFiles(io, c)) {
    const p = parseProgress(await io.read(file));
    if (p !== undefined) runs.push({ file, p });
  }
  return runs;
}

/** The main checkout, then every `<base>/<name>` with a `build/local-env/env`, sorted. @param {Io} io @param {Checkout} c */
async function envRoots(io, { main, base }) {
  const roots = [];
  for (const entry of await io.list(base)) {
    if (entry.name.startsWith(".") || !entry.isDir) continue;
    const dir = `${base}/${entry.name}`;
    if (dir !== main && (await io.exists(`${dir}/build/local-env/env`))) roots.push(dir);
  }
  return [main, ...roots.sort()];
}

/** Pids among `pids` that are alive: one `ps` for all of them. @param {Io} io @param {number[]} pids */
export async function alivePids(io, pids) {
  if (pids.length === 0) return new Set();
  const ran = await io.run("ps", ["-o", "pid=", "-p", pids.join(",")]);
  if (ran === undefined) return new Set(pids); // cannot tell: trust the pid files
  return new Set(ran.stdout.split("\n").map(Number).filter((n) => Number.isInteger(n) && n > 0));
}

/**
 * The HTTP status of `url`, undefined when it does not answer within 3 s: a hung Tomcat
 * must not hold the probe. Through curl, since Herdr's fetch takes no timeout.
 * @param {Io} io @param {string} url
 */
async function httpStatus(io, url) {
  const ran = await io.run("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "3", url]);
  const code = Number(ran?.stdout.trim());
  return Number.isInteger(code) && code > 0 ? code : undefined;
}

/**
 * Every environment of a checkout as it stands: one `ps` for all the PG and SPA pids, one
 * HTTP GET of `<context>/security/Login` per environment for Tomcat.
 * @param {Io} io @param {Checkout} c @returns {Promise<Environment[]>}
 */
export async function probeEnvs(io, c) {
  const roots = await envRoots(io, c);
  const disk = await Promise.all(
    roots.map(async (dir, i) => {
      const state = `${dir}/build/local-env`;
      return {
        dir,
        isMain: i === 0,
        vars: parseEnvFile(await io.read(`${state}/env`)),
        pg: parsePostmaster(await io.read(`${state}/pgdata/postmaster.pid`)),
        spaPid: Number((await io.read(`${state}/plugins/etendo-go/spa.pid`)).trim()) || 0,
        progress: parseProgress(await io.read(`${state}/progress.json`)),
        ctx: contextName(await io.read(`${dir}/gradle.properties`)),
        applied: parseWorktreeRepos(await io.read(`${state}/worktree-repos`)),
        coreHead: headBranch(await io.read(`${dir}/.git/HEAD`)),
        source: i === 0 ? "" : (await io.read(`${state}/source-root`)).trim(),
      };
    }),
  );
  const pids = await alivePids(io, disk.flatMap((d) => [d.pg?.pid ?? 0, d.spaPid].filter((n) => n > 0)));
  const statuses = await Promise.all(disk.map((d) => httpStatus(io, `http://localhost:${portOf(d.vars, "PORT")}/${d.ctx}/security/Login`)));
  return disk.map((d, i) => {
    const port = portOf(d.vars, "PORT");
    const code = statuses[i];
    const spaUp = d.spaPid > 0 && pids.has(d.spaPid);
    const spaUrl = d.progress?.urls?.SPA ?? `http://localhost:${portOf(d.vars, "SPA_PORT")}`;
    const spaPort = Number(/:(\d+)/.exec(spaUrl.replace(/^https?:\/\//, "x"))?.[1]) || portOf(d.vars, "SPA_PORT");
    /** @type {Service[]} */
    const services = [
      { name: "Tomcat", port, url: `http://localhost:${port}/${d.ctx}`, state: code === 200 ? "up" : code === undefined ? "down" : "starting" },
      { name: "PG", port: d.pg?.port || portOf(d.vars, "LOCALENV_PG_PORT"), url: "", state: d.pg !== undefined && pids.has(d.pg.pid) ? "up" : "down" },
      { name: "SPA", port: spaPort, url: spaUrl, state: spaUp ? "up" : "down" },
      // the BFF runs in the SPA's process group: up and down with it
      { name: "BFF", port: portOf(d.vars, "BFF_PORT"), url: "", state: spaUp ? "up" : "down" },
    ];
    const hasCore = d.applied.some((r) => r.name === "core");
    /** @type {import("./lib.js").Repo[]} */
    const repos = [
      ...(hasCore ? [] : [{ name: "core", branch: d.coreHead, kind: /** @type {const} */ (d.isMain ? "main" : "copy"), target: "" }]),
      ...d.applied,
    ];
    const p = d.progress;
    return {
      name: basename(d.dir),
      root: d.dir,
      isMain: d.isMain,
      services,
      repos,
      source: d.source,
      lastRun: p === undefined ? null : { cmd: p.cmd, state: p.state, updated: p.updated },
    };
  });
}
