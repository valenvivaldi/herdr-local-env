// Reading local-env's progress files and environments: pure functions, no Herdr API, so the
// tests run them under node. Ported from etendo-localenv's omp/Claude Code mods
// (omp-mod/local-env-progress/lib.ts); the file format is the contract in that repo's
// docs/design.md §7.1.

/**
 * @typedef {{ v: 1, cmd: string, pid: number, env: string, root: string, phase: string,
 *   step: number, of: number, label: string, task: string, started: number,
 *   phaseStarted: number, updated: number, state: string, error: string,
 *   urls: Record<string, string> }} Progress
 * @typedef {{ file: string, env: string, root: string, cmd: string,
 *   state: "running" | "done" | "failed" | "stale", phase: string, label: string, task: string,
 *   step: number, of: number, elapsed: number, error: string, urls: [string, string][] }} Row
 * @typedef {{ name: "Tomcat" | "PG" | "SPA" | "BFF", port: number, url: string,
 *   state: "up" | "starting" | "down" }} Service
 * @typedef {{ name: string, branch: string, kind: "worktree" | "adopted" | "copy" | "main",
 *   target: string }} Repo
 * @typedef {{ name: string, root: string, isMain: boolean, services: Service[], repos: Repo[],
 *   source: string, lastRun: { cmd: string, state: string, updated: number } | null }} Environment
 * @typedef {{ text: string, href?: string }} SummaryPart
 * @typedef {{ name: string, root: string, mark: string, tone: "success" | "warning" | "dim",
 *   parts: SummaryPart[] }} SummaryItem
 */

/** A finished row stays this long after its last write, in seconds. */
export const DONE_HOLD = 120;
export const FAILED_HOLD = 600;
/** A running file this quiet gets its pid checked: phases without gradle write nothing. */
export const QUIET = 30;

/** @param {string | null} text @returns {Progress | undefined} */
export function parseProgress(text) {
  if (!text) return undefined;
  try {
    const p = JSON.parse(text);
    return p !== null && typeof p === "object" && p.v === 1 && typeof p.state === "string" ? p : undefined;
  } catch {
    return undefined;
  }
}

/** @param {string} path */
export const dirname = (path) => path.slice(0, path.lastIndexOf("/")) || "/";

/** @param {string} path */
export const basename = (path) => path.slice(path.lastIndexOf("/") + 1);

/**
 * The row for a file, or undefined when it is not worth showing (finished long ago).
 * @param {string} file @param {Progress} p @param {number} now @returns {Row | undefined}
 */
export function toRow(file, p, now, isAlive = true) {
  const age = now - p.updated;
  /** @type {Row["state"]} */
  let state;
  if (p.state === "running") state = isAlive ? "running" : "stale";
  else if (p.state === "done" || p.state === "failed") state = p.state;
  else return undefined;
  if (state === "done" && age > DONE_HOLD) return undefined;
  if ((state === "failed" || state === "stale") && age > FAILED_HOLD) return undefined;
  return {
    file,
    env: p.env,
    root: p.root ?? "",
    cmd: p.cmd,
    state,
    phase: p.phase,
    label: p.label,
    task: p.task,
    step: p.step,
    of: p.of,
    elapsed: Math.max(0, (state === "running" ? now : p.updated) - p.started),
    error: state === "stale" ? `local-env terminó sin informar (pid ${p.pid})` : p.error,
    urls: Object.entries(p.urls ?? {}),
  };
}

/**
 * The bar as [filled, empty] glyph runs. Running counts the current step but never fills
 * the bar: a full one means done.
 * @param {Row} row @returns {[string, string]}
 */
export function barParts(row, width = 10) {
  const ratio = row.state === "done" ? 1 : row.of > 0 ? row.step / row.of : 0;
  let filled = Math.min(width, Math.max(0, Math.round(width * ratio)));
  if (row.state !== "done" && filled === width) filled = width - 1;
  return ["█".repeat(filled), "░".repeat(width - filled)];
}

/**
 * One run per environment: the worktree create that made it and the `up` running in it
 * write different files. The run that started last wins (ties: the last write).
 * @template {{ p: Progress }} T @param {readonly T[]} runs @returns {T[]}
 */
export function latestPerEnv(runs) {
  /** @type {Map<string, T>} */
  const byEnv = new Map();
  for (const run of runs) {
    const key = run.p.root || run.p.env;
    const best = byEnv.get(key);
    const isNewer =
      best === undefined || run.p.started > best.p.started || (run.p.started === best.p.started && run.p.updated > best.p.updated);
    if (isNewer) byEnv.set(key, run);
  }
  return [...byEnv.values()];
}

/** @param {number} seconds */
export function elapsed(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export const LOG_HINT = "ver build/local-env/local-env.log";

/**
 * A failure in a few words: the phase and the gradle task it stopped in, else the first
 * clause of the error (the full text stays in progress.json and the log).
 * @param {Row} row
 */
export function failReason(row) {
  if (row.state === "stale") return `en ${row.phase} · ${row.error}`;
  if (row.task !== "") return `en ${row.phase} · ${row.task}`;
  const first = (row.error.split(" · ")[0] ?? "").replace(/\s*\(.*$/, "").trim();
  return `en ${row.phase}${first !== "" ? ` · ${first.length > 60 ? `${first.slice(0, 59)}…` : first}` : ""}`;
}

/** What a run row says after its bar: the step, or why it failed. @param {Row} row */
export function detailText(row) {
  if (row.state === "running") return `${row.step}/${row.of} ${row.phase}: ${row.label}${row.task !== "" ? ` ${row.task}` : ""}`;
  if (row.state === "done") return `${row.urls.map(([name, url]) => (name === "tomcat" ? url : `${name} ${url}`)).join("  ")} (${row.cmd})`;
  return `${failReason(row)} · ${LOG_HINT}`;
}

// ── Environments: what is up, read from each environment's own files ──────────────────

/** Ports an environment runs on when its `build/local-env/env` does not say (the main checkout). */
export const DEFAULT_PORTS = { LOCALENV_PG_PORT: 55432, PORT: 8080, SPA_PORT: 3100, BFF_PORT: 3400 };

/** `export NAME=value` lines of `build/local-env/env` (quotes stripped). @param {string} text */
export function parseEnvFile(text) {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m?.[1] !== undefined) vars[m[1]] = (m[2] ?? "").trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return vars;
}

/** @param {Record<string, string>} vars @param {keyof typeof DEFAULT_PORTS} name */
export function portOf(vars, name) {
  const n = Number(vars[name]);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PORTS[name];
}

/** `pgdata/postmaster.pid`: line 1 the postmaster's pid, line 4 its port. @param {string} text */
export function parsePostmaster(text) {
  const lines = text.split("\n");
  const pid = Number(lines[0]);
  const port = Number(lines[3]);
  return Number.isInteger(pid) && pid > 0 ? { pid, port: Number.isInteger(port) && port > 0 ? port : 0 } : undefined;
}

/** `context.name` of a gradle.properties, `etendo` by default. @param {string} text */
export const contextName = (text) => /^context\.name=(.*)$/m.exec(text)?.[1]?.trim() || "etendo";

/** The branch a `.git/HEAD` names, empty when detached. @param {string} text */
export const headBranch = (text) => /^ref: refs\/heads\/(.+)$/m.exec(text)?.[1]?.trim() ?? "";

/**
 * `build/local-env/worktree-repos`, what `worktree`/`sync` applied: one line per repo,
 * `core <branch>`, `<module> <branch> [adopt <target>]`, `repo:<dir> <branch> [adopt <target>]`.
 * @param {string} text @returns {Repo[]}
 */
export function parseWorktreeRepos(text) {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f.length >= 2 && f[0] !== "" && !f[0].startsWith("#"))
    .map(([rel = "", branch = "", mode = "", ...target]) => ({
      name: rel.replace(/^repo:/, ""),
      branch,
      kind: mode.startsWith("adopt") ? "adopted" : "worktree",
      target: mode.startsWith("adopt") ? target.join(" ") : "",
    }));
}

/**
 * `up`: Tomcat ready; `partial`: something runs (PG, the SPA, a starting Tomcat); else `stopped`.
 * @param {Environment} env @returns {"up" | "partial" | "stopped"}
 */
export function envState(env) {
  const tomcat = env.services.find((s) => s.name === "Tomcat");
  if (tomcat?.state === "up") return "up";
  return env.services.some((s) => s.state !== "down") ? "partial" : "stopped";
}

/**
 * One summary entry: `ETP-5670 ● :8081 · SPA :3102`. A part with `href` is the port of a
 * service that is up and has a URL, so a click opens the app.
 * @param {Environment} env @returns {SummaryItem}
 */
export function summaryItem(env) {
  const state = envState(env);
  if (state === "stopped") return { name: env.name, root: env.root, mark: "○", tone: "dim", parts: [{ text: "parado" }] };
  const by = (/** @type {string} */ name) => env.services.find((s) => s.name === name);
  /** @param {Service} s @returns {SummaryPart} */
  const port = (s) => (s.state === "up" && s.url !== "" ? { text: `:${s.port}`, href: s.url } : { text: `:${s.port}` });
  const tomcat = by("Tomcat");
  const pg = by("PG");
  const spa = by("SPA");
  /** @type {SummaryPart[][]} */
  const groups = [];
  if (tomcat !== undefined && tomcat.state !== "down") {
    groups.push(tomcat.state === "starting" ? [port(tomcat), { text: " arrancando" }] : [port(tomcat)]);
  } else if (pg?.state === "up") groups.push([{ text: "PG " }, port(pg)]);
  if (spa?.state === "up") groups.push([{ text: "SPA " }, port(spa)]);
  return {
    name: env.name,
    root: env.root,
    mark: state === "up" ? "●" : "◐",
    tone: state === "up" ? "success" : "warning",
    parts: groups.flatMap((g, i) => (i === 0 ? g : [{ text: " · " }, ...g])),
  };
}

/**
 * What the band draws: the run rows and the summary entries. A finished run of an
 * environment that is up reads as that environment's summary entry, so it looks
 * the same just after `up` as later. Stopped environments stay out: the dialog lists them.
 * Entries go most recently touched first; environments with no run keep the probe's order.
 * @param {readonly Row[]} allRows @param {readonly Environment[]} envs
 * @returns {{ rows: Row[], summary: SummaryItem[] }}
 */
export function bandEntries(allRows, envs) {
  const upRoots = new Set(envs.filter((env) => envState(env) !== "stopped").map((env) => env.root));
  const rows = allRows.filter((row) => !(row.state === "done" && upRoots.has(row.root)));
  const inRows = new Set(rows.map((row) => row.root));
  const summary = envs
    .filter((env) => envState(env) !== "stopped" && !inRows.has(env.root))
    .sort((a, b) => (b.lastRun?.updated ?? 0) - (a.lastRun?.updated ?? 0))
    .map(summaryItem);
  return { rows, summary };
}

/** `hace 5 min` from two epoch seconds. @param {number} then @param {number} now */
export function agoText(then, now) {
  const s = Math.max(0, now - then);
  if (s < 60) return "hace un momento";
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86_400)} d`;
}

/** @type {Record<string, string>} */
export const RUN_STATE = { running: "en curso", done: "listo", failed: "falló" };
