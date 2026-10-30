// local-env: the progress of every local-env run (up, worktree create/rm, sync) of the Etendo
// checkouts open in Herdr, and which environments are up, read from the files local-env
// writes. Herdr port of etendo-localenv's local-env-progress mods (omp, Claude Code).
// As a sidebar block (props {block: "<its layout id>"}): a row per run going or just
// finished, then each environment that is up with its ports (a click opens it); the block
// resizes itself to its rows; toasts when a run finishes. A click on a row opens the dialog.
// As a dialog (mod.open:local-env): every environment with services, repos and last run.
// r refresh, Esc close.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, readTextFile, spaces, focused, props, run, notify, closeOverlay, theme } from "herdr";
import * as fs from "fs/promises";

import { QUIET, RUN_STATE, agoText, bandEntries, barParts, detailText, elapsed, envState, latestPerEnv, toRow } from "./lib.js";
import { alivePids, checkouts, probeEnvs, readRuns } from "./probe.js";

/**
 * Herdr's fs throws synchronously outside the home folder (the walk up from a space's folder
 * reaches /Users), so every call is awaited inside a try: absent and unreadable look the same.
 * @type {import("./probe.js").Io}
 */
const io = {
  async read(path) {
    try {
      return (await readTextFile(path)) ?? "";
    } catch {
      return "";
    }
  },
  async list(dir) {
    try {
      return (await fs.readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    } catch {
      return [];
    }
  },
  async exists(path) {
    try {
      return await fs.exists(path);
    } catch {
      return false;
    }
  },
  async run(cmd, args) {
    try {
      const r = await exec(cmd, args);
      return { code: r.code, stdout: r.stdout };
    } catch {
      return undefined;
    }
  },
};

/** Progress files are read every SCAN_IDLE ticks, every tick while a run is going. */
const TICK_MS = 1000;
const SCAN_IDLE = 5;
/** Environments (ps, one curl per Tomcat) are probed every PROBE_EVERY ticks. */
const PROBE_EVERY = 15;

/** The panel's sizes, as the agents list draws them. */
const HEADER_PX = 41;
const ROW_PX = 30;
const PANEL_PAD_PX = 6;
const PANEL_MAX_PX = 260;

const now = () => Math.floor(Date.now() / 1000);
const openUrl = (/** @type {string} */ url) => void exec("open", [url]).catch(() => undefined);

/** The state both views draw: the checkouts open in Herdr, their runs and environments. */
class Monitor {
  constructor() {
    /** @type {import("./probe.js").Checkout[]} */
    this.checkouts = [];
    /** @type {import("./lib.js").Row[]} */
    this.rows = [];
    /** @type {import("./lib.js").Environment[]} */
    this.envs = [];
    this.envsAt = 0;
    /** Per progress file, `<state>:<started>` as last seen: a finish is toasted only if it was seen running. */
    this.seen = new Map();
    /** Per progress file, whether its quiet pid was alive, cached 10 s. */
    this.alive = new Map();
  }

  /** Local folders the person works in: every space's, and the focused terminal's. */
  folders() {
    const list = spaces().filter((s) => s.machine === null && s.folder !== "").map((s) => s.folder);
    const cwd = focused()?.cwd;
    return cwd ? [...list, cwd] : list;
  }

  async probe() {
    this.checkouts = await checkouts(io, this.folders());
    const envs = [];
    for (const c of this.checkouts) envs.push(...(await probeEnvs(io, c)));
    this.envs = envs;
    this.envsAt = now();
  }

  /** @param {string} file @param {number} pid @param {number} at */
  async isAlive(file, pid, at) {
    const cached = this.alive.get(file);
    if (cached !== undefined && at - cached.at < 10) return cached.isAlive;
    const isAlive = (await alivePids(io, [pid])).has(pid);
    this.alive.set(file, { at, isAlive });
    return isAlive;
  }

  /** Reads every progress file; returns the runs that finished since the last scan. */
  async scan() {
    const at = now();
    const runs = [];
    for (const c of this.checkouts) runs.push(...(await readRuns(io, c)));
    const rows = [];
    const finished = [];
    for (const { file, p } of latestPerEnv(runs)) {
      const isQuiet = p.state === "running" && at - p.updated > QUIET;
      const row = toRow(file, p, at, isQuiet ? await this.isAlive(file, p.pid, at) : true);
      if (row === undefined) continue;
      rows.push(row);
      const was = this.seen.get(file);
      if (was?.startsWith("running:") && row.state !== "running") finished.push(row);
      this.seen.set(file, `${row.state}:${p.started}`);
    }
    this.rows = rows.sort((a, b) => a.env.localeCompare(b.env));
    return finished;
  }

  get isRunning() {
    return this.rows.some((row) => row.state === "running");
  }
}

export default class LocalEnv extends View {
  init(_props, cx) {
    this.isDialog = Boolean(props()?.overlay);
    this.m = new Monitor();
    this.ticks = 0;
    this.busy = false;
    this.error = "";
    if (this.isDialog) {
      this.handle = cx.focus_handle();
      this.handle.focus();
    }
    this.refresh(cx, true);
    cx.timer.every(TICK_MS, (cx) => {
      this.ticks += 1;
      const probe = this.ticks % PROBE_EVERY === 0;
      if (probe || this.m.isRunning || this.ticks % SCAN_IDLE === 0) this.refresh(cx, probe);
    });
  }

  refresh(cx, probe) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        if (probe) await this.m.probe();
        const finished = await this.m.scan();
        // a run that just finished changed what is up: probe now rather than in up to 15 s
        if (finished.length > 0 && !probe) await this.m.probe();
        if (!this.isDialog) for (const row of finished) this.toast(row);
        this.error = "";
      } catch (e) {
        this.error = String(e?.stack ?? e?.message ?? e);
        console.log(`local-env: ${this.error}`);
      } finally {
        this.busy = false;
      }
      cx.notify();
    });
  }

  /** @param {import("./lib.js").Row} row */
  toast(row) {
    const done = row.state === "done";
    notify({
      title: `local-env ${row.env}: ${done ? "listo" : "falló"}`,
      body: done ? row.urls.map(([name, url]) => `${name} ${url}`).join("  ") : row.error,
      level: done ? "success" : "error",
      action: { name: "mod.open", args: { name: "local-env" } },
    });
  }

  link(id, text, url) {
    const t = theme();
    return div()
      .id(id)
      .text_color(t.accent)
      .cursor_pointer()
      .hover((s) => s.underline())
      .tooltip(url)
      .on_click(() => openUrl(url))
      .child(text);
  }

  /** @param {import("./lib.js").Row} row */
  runGlyph(row) {
    const t = theme();
    if (row.state === "running") return div().text_color(t.working).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90);
    return row.state === "done" ? div().text_color(t.done).child("✔") : div().text_color(t.blocked).child("✖");
  }

  /** A run in the dialog: bar, step or failure, elapsed. @param {import("./lib.js").Row} row */
  runRow(row) {
    const t = theme();
    const failed = row.state === "failed" || row.state === "stale";
    const [filled, empty] = barParts(row);
    const status =
      row.state === "running"
        ? h_flex().child(div().text_color(t.working).child(filled)).child(div().text_color(t.dim).child(empty))
        : div().text_color(failed ? t.blocked : t.done).child(row.state === "done" ? "listo" : row.state === "stale" ? "cortado" : "falló");
    return h_flex()
      .id(`run-${row.file}`)
      .gap(10)
      .items_center()
      .tooltip(failed ? row.error : row.file)
      .child(div().w(18).flex_none().child(this.runGlyph(row)))
      .child(div().w(120).flex_none().truncate().font_semibold().child(row.env))
      .child(div().w(84).flex_none().child(status))
      .child(div().flex_1().min_w(0).truncate().text_color(failed ? t.blocked : t.foreground).child(detailText(row)))
      .child(div().flex_none().text_color(t.dim).child(elapsed(row.elapsed)));
  }

  // ── The sidebar panel ─────────────────────────────────────────────────────────────

  /** A sidebar row, shaped like the agents list's: glyph, name, then what is on the right. */
  panelRow(id, glyph, name, right, tip) {
    const t = theme();
    return h_flex()
      .id(id)
      .px(8)
      .h(ROW_PX)
      .flex_none()
      .rounded(8)
      .items_center()
      .gap(9)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(tip)
      .on_click(() => run("mod.open", { name: "local-env" }))
      .child(div().w(14).flex_none().flex().justify_center().text_size(11).child(glyph))
      .when(!this.collapsed, (el) =>
        el
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(name))
          .child(h_flex().flex_none().gap(4).items_center().text_size(11).text_color(t.dim).children(right)),
      );
  }

  /** @param {import("./lib.js").Row} row */
  panelRun(row) {
    const t = theme();
    const right =
      row.state === "running"
        ? [div().child(`${row.step}/${row.of} ${row.phase}`), div().child(elapsed(row.elapsed))]
        : row.state === "done"
          ? [div().text_color(t.done).child(`${row.cmd} listo`)]
          : [div().text_color(t.blocked).child(row.state === "stale" ? "cortado" : "falló")];
    return this.panelRow(`run-${row.file}`, this.runGlyph(row), row.env, right, `${row.env}: ${detailText(row)}`);
  }

  /** @param {import("./lib.js").SummaryItem} item */
  panelEnv(item) {
    const t = theme();
    const tone = { success: t.ansi2, warning: t.working, dim: t.dim }[item.tone];
    const right = item.parts
      .filter((part) => part.text.trim() !== "·")
      .map((part, i) =>
        part.href !== undefined
          ? div()
              .id(`port-${item.root}-${i}`)
              .text_color(t.muted)
              .hover((s) => s.text_color(t.accent))
              .tooltip(`Abrir ${part.href}`)
              .on_click((_e, cx) => {
                cx.stop_propagation();
                openUrl(part.href);
              })
              .child(part.text.trim())
          : div().child(part.text.trim()),
      );
    return this.panelRow(`env-${item.root}`, div().text_color(tone).child("●"), item.name, right, item.root);
  }

  /** Rows the panel draws: runs going or just finished, then the environments that are up. */
  panelRows() {
    const { rows, summary } = bandEntries(this.m.rows, this.m.envs);
    return [...rows.map((row) => this.panelRun(row)), ...summary.map((item) => this.panelEnv(item))];
  }

  /** Sizes the panel's block to its rows, so it takes no room it does not use. */
  fit(count) {
    const px = Math.min(PANEL_MAX_PX, HEADER_PX + Math.max(1, count) * ROW_PX + PANEL_PAD_PX);
    if (px === this.px || props()?.block === undefined) return;
    this.px = px;
    run("layout.resize", { id: props().block, px });
  }

  renderPanel() {
    const t = theme();
    const rows = this.panelRows();
    if (this.m.envsAt > 0) this.fit(rows.length);
    const empty = this.m.envsAt === 0 ? "Buscando…" : this.m.checkouts.length === 0 ? "Sin checkout de Etendo abierto" : "Nada levantado";
    return v_flex()
      .id("local-env-panel")
      .on_size_change((size, cx) => {
        const collapsed = size.width < 160;
        if (collapsed !== this.collapsed) {
          this.collapsed = collapsed;
          cx.notify();
        }
      })
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!this.collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(HEADER_PX)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Local env"))
            .child(
              div()
                .id("local-env-all")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .tooltip("Ver todos los entornos")
                .on_click(() => run("mod.open", { name: "local-env" }))
                .child("Todos"),
            ),
        ),
      )
      .child(
        v_flex()
          .id("local-env-list")
          .flex_1()
          .min_h(0)
          .px(this.collapsed ? 0 : 8)
          .overflow_y_scrollbar()
          .when(rows.length === 0 && !this.collapsed, (el) => el.child(div().px(8).h(ROW_PX).flex().items_center().text_size(12).text_color(t.dim).child(empty)))
          .children(rows),
      );
  }

  /** @param {import("./lib.js").Environment} env @param {number} at */
  envBlock(env, at) {
    const t = theme();
    const glyph = { up: ["●", t.ansi2], starting: ["◐", t.ansi3], down: ["○", t.dim] };
    const kind = { adopted: "adoptado", worktree: "worktree", main: "checkout principal", copy: "copia" };
    const dim = (/** @type {string} */ text) => div().text_color(t.dim).child(text);
    return v_flex()
      .gap(3)
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(div().text_size(14).font_semibold().child(env.name))
          .child(dim(env.isMain ? `${env.root}  (checkout principal)` : env.root)),
      )
      .children(
        env.services.map((s) => {
          const [mark, color] = glyph[s.state];
          return h_flex()
            .gap(10)
            .pl(12)
            .child(div().w(60).child(s.name))
            .child(div().w(80).text_color(color).child(`${mark} :${s.port}`))
            .child(
              s.url === ""
                ? div()
                : s.state === "down"
                  ? dim(s.url)
                  : h_flex()
                      .gap(6)
                      .child(this.link(`url-${env.root}-${s.name}`, s.url, s.url))
                      .when(s.state === "starting", (el) => el.child(dim("arrancando"))),
            );
        }),
      )
      .children(
        env.repos.map((r) =>
          h_flex()
            .gap(10)
            .pl(12)
            .child(div().child(r.name))
            .child(div().text_color(t.muted).child(r.branch || "(detached)"))
            .child(dim(r.kind === "adopted" ? `adoptado ${r.target}` : kind[r.kind])),
        ),
      )
      .when(!env.isMain, (el) => el.child(dim(`el resto: copias de ${env.source || "el checkout principal"}`).pl(12)))
      .child(
        dim(
          env.lastRun === null
            ? "última ejecución: ninguna registrada"
            : `última ejecución: ${env.lastRun.cmd} · ${RUN_STATE[env.lastRun.state] ?? env.lastRun.state} · ${agoText(env.lastRun.updated, at)}`,
        ).pl(12),
      )
      .when(envState(env) === "stopped", (el) => el.child(div().pl(12).text_color(t.accent).child(`para levantarlo: cd ${env.root} && local-env up`)));
  }

  button(id, label, onClick) {
    const t = theme();
    return div()
      .id(id)
      .h(28)
      .px(12)
      .flex()
      .items_center()
      .rounded(7)
      .text_size(12.5)
      .bg(t.raised)
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover))
      .on_click(onClick)
      .child(label);
  }

  renderDialog() {
    const t = theme();
    const m = this.m;
    const at = now();
    const up = m.envs.filter((env) => envState(env) !== "stopped").length;
    const runs = m.rows.filter((row) => row.state !== "done");
    const body =
      m.envsAt === 0
        ? div().text_color(t.dim).child("Buscando entornos…")
        : m.envs.length === 0
          ? div().text_color(t.dim).child("Ningún checkout de Etendo abierto en los espacios de Herdr.")
          : v_flex()
              .gap(16)
              .when(runs.length > 0, (el) => el.child(v_flex().gap(4).children(runs.map((row) => this.runRow(row)))))
              .children(m.envs.map((env) => this.envBlock(env, at)));
    return v_flex()
      .id("local-env")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") closeOverlay(props().overlay);
        else if (e.key === "r") this.refresh(cx, true);
      })
      .size_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .bg(t.popover)
      .text_color(t.foreground)
      .text_size(12.5)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().text_size(15).font_semibold().mr(8).child("local-env"))
          .child(div().text_color(t.muted).child(m.envsAt === 0 ? "" : `${m.envs.length} entornos, ${up} levantados`))
          .child(div().flex_1())
          .child(this.button("refresh", "Actualizar  r", (_e, cx) => this.refresh(cx, true)))
          .child(this.button("close", "Esc", () => closeOverlay(props().overlay))),
      )
      .child(
        div()
          .id("local-env-body")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .rounded(9)
          .border_1()
          .border_color(t.border)
          .bg(t.background)
          .p(14)
          .child(body),
      )
      .child(
        this.error !== ""
          ? div().text_size(11.5).text_color(t.blocked).child(this.error)
          : div().text_size(11.5).text_color(t.dim).child(m.envsAt === 0 ? "" : `comprobado ${agoText(m.envsAt, at)} · cada 15 s`),
      );
  }

  render() {
    return this.isDialog ? this.renderDialog() : this.renderPanel();
  }
}
