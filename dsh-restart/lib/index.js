/**
 * dsh-restart — model-facing tools that schedule a safe self-restart.
 *
 * Why a plugin: the restart itself is a desktop-side operation (kill this
 * process and bring it back), but from IM or the Web GUI the agent cannot
 * "press the button". This plugin lets the agent arm the restart on the
 * user's behalf — with an explicit confirm, preflight checks, and a log
 * readback so the caller can see the tasks were really registered.
 *
 * The kill/start work deliberately stays in the vetted scripts:
 *   scripts/restart-dsh-arm.ps1      start-first ordering + rollback (default)
 *   scripts/restart-dsh-arm2.ps1     same, plus -StartScript / -WatchAfterSeconds
 *   scripts/restart-dsh-fallback.cmd one retry if the app dies at startup
 *   scripts/restart-dsh-start.ps1    explorer launch + 20s "did it stay up" check
 *   scripts/dsh-restart-tasks.ps1    status / cancel of the armed tasks
 * This module only wraps them; it does not re-implement Task Scheduler logic.
 *
 * 2026-11-10: tool results are plain strings on purpose. `output.schema` is an
 * author-facing spec and a malformed one throws at defineTool() compile time,
 * which kills the whole plugin (the first load attempt failed exactly that way).
 *
 * @module dsh-restart
 */
import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { fileURLToPath } from "node:url";
import { describeTimings, resolveTimings, DEFAULT_KILL_SECONDS } from "./timings.js";

// DSH 家目录：只从环境推导，**不写死本机路径**（发布包不能带机器目录结构）
const DSH_HOME_DIR = (() => {
  const raw = process.env.DSH_HOME || (process.env.USERPROFILE ? process.env.USERPROFILE.replace(/[\\/]+$/, "") + "/.dsh" : "");
  return String(raw || "").replace(/[\\/]+$/, "");
})();

// 2026-11-16：本机绝对路径的自动回退。配置里的路径不存在时（换电脑/换用户名），
// 按「插件自身位置」推导工作区根，再拼同名相对路径——旧机行为完全不变。
const WS_ROOT = (() => {
  try { return fileURLToPath(new URL("../../../../", import.meta.url)).replace(/[\\/]+$/, ""); }
  catch { return ""; }
})();

/** 配置文件类路径：父目录存在就用配置值，否则用回退值。 */
function resolveFile(configured, fallback) {
  const value = String(configured ?? "").trim();
  if (!value) return fallback;
  try { if (existsSync(dirname(value))) return value; } catch { /* fall through */ }
  return fallback || value;
}

// 插件自带一份脚本副本（2026-11-16 起入库），换机器时优先用它
const PLUGIN_ROOT = (() => {
  try { return fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]+$/, ""); }
  catch { return ""; }
})();

/** 脚本类路径：配置的必须真实存在才用，否则按「插件内 → 工作区」顺序找。 */
function resolveScript(configured, candidates) {
  const value = String(configured ?? "").trim();
  if (value && existsSync(value)) return value;
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return value || candidates.find(Boolean) || "";
}

/** 目录类路径：本来就不存在的目录（如备份根）同样按父目录判断。 */
function resolveDir(configured, fallback) {
  const value = String(configured ?? "").trim();
  if (!value) return fallback;
  try { if (existsSync(value) || existsSync(dirname(value))) return value; } catch { /* fall through */ }
  return fallback || value;
}
import { buildArmArgs, needsExtendedScript, normalizeWatchSeconds, parseTaskStatus } from "./args.js";
// 公开版（由私有仓库导出）：脚本用插件自带的 scripts/，日志与状态用 DSH_HOME 或插件目录下的 .state。
const pubStrip = (s) => { let r = String(s ?? ""); while (r.length && (r.endsWith("/") || r.charCodeAt(r.length - 1) === 92)) r = r.slice(0, -1); return r; };
const STATE_HOME = pubStrip(process.env.DSH_HOME ?? "") || PLUGIN_ROOT + "/.state";
const SCRIPT_ROOT = (() => { try { const local = fileURLToPath(new URL("../scripts", import.meta.url)); if (existsSync(local)) return pubStrip(local); } catch {} return PLUGIN_ROOT + "/scripts"; })();
const DEFAULT_ARM_SCRIPT = SCRIPT_ROOT + "/restart-dsh-arm.ps1";
const DEFAULT_MAINT_ARM_SCRIPT = SCRIPT_ROOT + "/restart-dsh-arm2.ps1";
const DEFAULT_TASKS_SCRIPT = SCRIPT_ROOT + "/dsh-restart-tasks.ps1";
const DEFAULT_LOG_FILE = STATE_HOME + "/logs/restart-dsh.log";
const DEFAULT_ANNOUNCE_FILE = STATE_HOME + "/logs/restart-announce.json";
// 本机 DSH home 也是私有路径，公开版改为「DSH_HOME → 用户主目录/dsh-home」推导。
const DSH_HOME_DEFAULT = pubStrip(process.env.DSH_HOME ?? "") || pubStrip(process.env.USERPROFILE ?? process.env.HOME ?? "") + "/dsh-home";

// Import-time breadcrumb: proves the loader reached this module at all.
// Without it we cannot tell "never imported" from "apply() failed".
// 公开版：import 面包屑已移除（原来写死日志路径）
import {
  DEFAULT_ANNOUNCE_TEXT,
  DEFAULT_MAX_AGE_MINUTES,
  clearMarker,
  isFresh,
  readMarker,
  resolveDelivery,
  writeMarker,
} from "./announce.js";

export const name = "dsh-restart";
export const inject = ["tools", "commands"];



/** 进程身份：pid + startedAt（用 performance.timeOrigin 反推，避开系统时钟跳变）。
 *  借鉴自 anweat/dsh-restart 的「pid + startedAt 双因子」思路（MIT）。 */
function processStartedAtISO() {
  try {
    return new Date(Date.now() - Math.round(performance.now())).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function writeJsonSafe(path, value) {
  try { writeFileSync(path, JSON.stringify(value, null, 2), "utf8"); return true; } catch { return false; }
}

export const Config = z.object({
  armScript: z.string().default(DEFAULT_ARM_SCRIPT),
  maintArmScript: z.string().default(DEFAULT_MAINT_ARM_SCRIPT),
  tasksScript: z.string().default(DEFAULT_TASKS_SCRIPT),
  logFile: z.string().default(DEFAULT_LOG_FILE),
  // 插件自己的日志：与脚本写的 logFile 分开，避免脚本独占锁导致 EBUSY
  pluginLogFile: z.string().default(STATE_HOME + "/logs/restart-plugin.log"),
  // ── 重启前备份 profile 的三个关键文件（改动前留一份，最便宜的回滚点）──
  backupEnabled: z.boolean().default(true),
  backupDir: z.string().default(STATE_HOME + "/logs/restart-backups"),
  backupKeep: z.number().default(10),
  profileDir: z.string().default(DSH_HOME_DIR ? DSH_HOME_DIR + "/profiles/desktop" : ""),
  powershell: z.string().default("powershell.exe"),
  defaultKillSeconds: z.number().default(DEFAULT_KILL_SECONDS),
  announce: z.boolean().default(true),
  announceText: z.string().default(DEFAULT_ANNOUNCE_TEXT),
  announceMaxAgeMinutes: z.number().default(DEFAULT_MAX_AGE_MINUTES),
  announceFile: z.string().default(DEFAULT_ANNOUNCE_FILE),
  // ── 常驻看门狗（默认关；心跳文件超时没更新就拉起 DSH）──
  watchdogEnabled: z.boolean().default(false),
  watchdogPollMs: z.number().default(2000),
  watchdogStaleMs: z.number().default(15000),
  watchdogCooldownMs: z.number().default(60000),
  watchdogScript: z.string().default(SCRIPT_ROOT + "/dsh-watchdog.cjs"),
  // 显式指定 node 可执行文件；留空则自动探测（Electron 里 process.execPath 是 exe，不能直接跑 .cjs）
  watchdogNode: z.string().default(""),
  announceBotId: z.string().default(""),
  announceTargetId: z.string().default(""),
  announceAutoTarget: z.boolean().default(true),
});

/** Run one process with pipes; resolves (never rejects) with {code, output}. */
function runProcess(file, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    const chunks = [];
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: -1, output: String(error?.message ?? error) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({ code: -1, output: chunks.join("") + "\ntimed out after " + timeoutMs + "ms" });
    }, timeoutMs);
    child.stdout?.on("data", (data) => chunks.push(String(data)));
    child.stderr?.on("data", (data) => chunks.push(String(data)));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: String(error?.message ?? error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output: chunks.join("") });
    });
  });
}

function tailLines(text, count) {
  return String(text ?? "").trimEnd().split(/\r?\n/).slice(-count).join("\n");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for the dshIm service. At boot the IM plugin registers its service
 * asynchronously — at +3s it was still missing (2026-11-10 18:18), so poll.
 */
async function waitForIm(ctx, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const im = typeof ctx.get === "function" ? ctx.get("dshIm") : null;
    if (im && typeof im.send === "function") return im;
    if (Date.now() >= deadline) return null;
    await sleep(1500);
  }
}

/**
 * Wait until a delivery route is resolvable. The bot list fills in after the
 * channels connect, so an early "no-bot" is retried instead of giving up.
 */
async function waitForRoute(im, opts, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let route = { error: "no-bot" };
  for (;;) {
    route = await resolveDelivery(im, { botId: opts.botId, targetId: opts.targetId, channel: opts.channel });
    if (route.targetId) return route;
    if (route.error === "no-target" || String(route.error).startsWith("list-targets-failed")) return route;
    if (Date.now() >= deadline) return route;
    await sleep(1500);
  }
}

/** Post-restart greeting. Marker is cleared BEFORE sending (no crash-loop spam). */
async function announceIfPending(ctx, opts) {
  const marker = readMarker(opts.file);
  if (!marker) return;
  if (!isFresh(marker, new Date(), opts.maxAgeMinutes)) {
    clearMarker(opts.file);
    opts.log("[announce] marker too old, dropped");
    return;
  }
  clearMarker(opts.file);
  try {
    const im = await waitForIm(ctx, opts.waitServiceMs ?? 25000);
    if (!im) {
      opts.log("[announce] IM service still unavailable after wait, greeting not delivered: " + marker.text);
      return;
    }
    const route = await waitForRoute(im, { ...opts, channel: marker.channel }, opts.waitRouteMs ?? 60000);
    if (!route.targetId) {
      opts.log("[announce] " + route.error + " — configured target needed: 设置 → IM机器人 → 新建目标");
      return;
    }
    await im.send(route.botId, route.targetId, marker.text);
    opts.log("[announce] sent after restart via " + route.botId + "/" + route.targetId + ": " + marker.text);
  } catch (error) {
    opts.log("[announce] failed: " + String(error?.message ?? error));
  }
}

/**
 * defineTool requires output.render (verified against the real host module:
 * omitting output throws "Cannot read properties of undefined (reading 'render')").
 * Our execute() returns plain strings, so render is a passthrough.
 */
function toolOutput() {
  return {
    schema: { type: "object", additionalProperties: true, properties: {} },
    render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }],
  };
}

export function apply(ctx, config) {
  const armScript = resolveScript(config?.armScript ?? DEFAULT_ARM_SCRIPT, [PLUGIN_ROOT + "/scripts/restart-dsh-arm.ps1", WS_ROOT + "/scripts/restart-dsh-arm.ps1"]);
  const maintArmScript = resolveScript(config?.maintArmScript ?? DEFAULT_MAINT_ARM_SCRIPT, [PLUGIN_ROOT + "/scripts/restart-dsh-arm2.ps1", WS_ROOT + "/scripts/restart-dsh-arm2.ps1"]);
  const tasksScript = resolveScript(config?.tasksScript ?? DEFAULT_TASKS_SCRIPT, [PLUGIN_ROOT + "/scripts/dsh-restart-tasks.ps1", WS_ROOT + "/scripts/dsh-restart-tasks.ps1"]);
  const logFile = resolveFile(config?.logFile ?? DEFAULT_LOG_FILE, WS_ROOT + "/logs/restart-dsh.log");
  const pluginLogFile = resolveFile(config?.pluginLogFile ?? STATE_HOME + "/logs/restart-plugin.log", WS_ROOT + "/logs/restart-plugin.log");
  const powershell = String(config?.powershell ?? "powershell.exe").trim();
  const defaultKillSeconds = Number(config?.defaultKillSeconds ?? DEFAULT_KILL_SECONDS);
  const announce = config?.announce !== false;
  const announceText = String(config?.announceText ?? DEFAULT_ANNOUNCE_TEXT).trim() || DEFAULT_ANNOUNCE_TEXT;
  const announceFile = resolveFile(config?.announceFile ?? DEFAULT_ANNOUNCE_FILE, WS_ROOT + "/logs/restart-announce.json");
  const announceMaxAgeMinutes = Number(config?.announceMaxAgeMinutes ?? DEFAULT_MAX_AGE_MINUTES);

  const log = (msg) => {
    const line = "[" + new Date().toISOString() + "] " + msg + "\n";
    try {
      appendFileSync(pluginLogFile, line, "utf8");
    } catch (error) {
      // 写不进去时留证据到 .fallback，别静默吞掉
      try { appendFileSync(pluginLogFile + ".fallback", line + "   (append failed: " + String(error?.message ?? error) + ")\n", "utf8"); } catch { /* give up */ }
    }
  };

  log("[boot] dsh-restart loaded (announce=" + announce + ", marker=" + (existsSync(announceFile) ? "pending" : "none") + ")");

  // ---------- 进程身份（pid + startedAt）----------
  const stateDir = dirname(logFile);
  const processFile = stateDir + "/dsh-process.json";
  const armRecordFile = stateDir + "/dsh-arm-record.json";
  const me = {
    pid: process.pid,
    startedAt: processStartedAtISO(),
    cwd: process.cwd(),
    recordedAt: new Date().toISOString(),
  };
  writeJsonSafe(processFile, me);
  log("[boot] process identity pid=" + me.pid + " startedAt=" + me.startedAt);

  // ---------- 重启前备份 + 停机时长 ----------
  const killRecordFile = stateDir + "/dsh-kill-record.json";
  const backupEnabled = config?.backupEnabled !== false;
  const backupRoot = resolveDir(config?.backupDir ?? STATE_HOME + "/logs/restart-backups", WS_ROOT + "/logs/restart-backups");
  const backupKeep = Math.max(1, Math.min(50, Number(config?.backupKeep ?? 10)));
  const profileDir = resolveDir(config?.profileDir ?? DSH_HOME_DEFAULT + "/profiles/desktop", DSH_HOME_DIR + "/profiles/desktop");

  const backupProfile = () => {
    if (!backupEnabled) return { ok: false, reason: "已关闭" };
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dir = backupRoot + "/" + stamp;
    try { mkdirSync(dir, { recursive: true }); }
    catch (error) { return { ok: false, reason: "建目录失败:" + String(error?.message ?? error) }; }
    const copied = [];
    for (const name of ["package.json", "pnpm-lock.yaml", "cordis.patch.yml"]) {
      try { copyFileSync(profileDir + "/" + name, dir + "/" + name); copied.push(name); } catch { /* 缺文件就跳过 */ }
    }
    try {
      const all = readdirSync(backupRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
      for (const old of all.slice(0, Math.max(0, all.length - backupKeep))) {
        try { rmSync(backupRoot + "/" + old, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    } catch { /* prune 失败不影响备份 */ }
    log("[backup] " + dir + " files=" + copied.length);
    return { ok: true, dir, files: copied };
  };

  // 停机时长：排程时记下预计 kill 时刻，启动后算差（±1 秒，够用）
  let downtimeSeconds = null;
  {
    const rec = readJsonSafe(killRecordFile);
    if (rec && Number(rec.killAt)) {
      const secs = Math.round((Date.now() - Number(rec.killAt)) / 1000);
      if (secs >= 0 && secs < 3600) {
        downtimeSeconds = secs;
        me.downtimeSeconds = secs;
        writeJsonSafe(processFile, me);
        log("[boot] downtime ≈ " + secs + "s");
      }
    }
  }

  // ---------- 心跳 + 常驻看门狗 ----------
  const heartbeatFile = stateDir + "/dsh-heartbeat.json";
  const restartFlagFile = stateDir + "/dsh-restarting.flag";
  const stopFlagFile = stateDir + "/dsh-stop.flag";
  const watchdogConfigFile = stateDir + "/dsh-watchdog.json";
  const watchdogPidFile = stateDir + "/dsh-watchdog.pid";
  const watchdogLog = stateDir + "/dsh-watchdog.log";
  const watchdogEnabled = config?.watchdogEnabled === true;
  const watchdogScript = resolveScript(config?.watchdogScript ?? SCRIPT_ROOT + "/dsh-watchdog.cjs", [PLUGIN_ROOT + "/scripts/dsh-watchdog.cjs", WS_ROOT + "/scripts/dsh-watchdog.cjs"]);
  const watchdogPollMs = Math.max(500, Number(config?.watchdogPollMs ?? 2000));
  const watchdogStaleMs = Math.max(5000, Number(config?.watchdogStaleMs ?? 15000));
  const watchdogCooldownMs = Math.max(20000, Number(config?.watchdogCooldownMs ?? 60000));

  const touchHeartbeat = () => writeJsonSafe(heartbeatFile, { pid: me.pid, startedAt: me.startedAt, ts: Date.now() });
  touchHeartbeat();
  const hbTimer = setInterval(touchHeartbeat, 5000);
  if (typeof hbTimer.unref === "function") hbTimer.unref();
  ctx.effect(() => () => clearInterval(hbTimer));

  // 上一次重启留下的「重启中」标志：超过 3 分钟就是死的，清掉
  try {
    if (existsSync(restartFlagFile) && Date.now() - statSync(restartFlagFile).mtimeMs > 180000) unlinkSync(restartFlagFile);
  } catch { /* best effort */ }

  const watchdogPid = () => {
    try {
      const pid = Number(String(readFileSync(watchdogPidFile, "utf8")).trim());
      if (!pid) return 0;
      process.kill(pid, 0);
      return pid;
    } catch { return 0; }
  };
  // Electron 里 process.execPath 指向 "DeepSeek Harness.exe"，拿它跑 .cjs 起不来，
  // 所以按顺序探测真正的 node：配置 > 环境变量 > 运行时目录 > 已知安装路径。
  const resolveNode = () => {
    const configured = String(config?.watchdogNode ?? "").trim();
    const candidates = [
      configured,
      process.env.DSH_NODE || "",
      process.env.DSH_RUNTIME ? process.env.DSH_RUNTIME + "/dependencies/node/bin/node.exe" : "",
      // 不写死安装路径：跟着当前 Electron 的 execPath 推导，再退回 DSH_HOME 下的运行时目录
      (() => { try { return join(dirname(process.execPath), "resources", "runtime", "primary-runtime", "dependencies", "node", "bin", "node.exe"); } catch { return ""; } })(),
      process.env.DSH_HOME ? join(process.env.DSH_HOME, "dsh-runtimes", "dsh-primary-runtime", "dependencies", "node", "bin", "node.exe") : "",
    ].filter(Boolean);
    for (const candidate of candidates) {
      try { if (existsSync(candidate)) return { path: candidate, electron: false }; } catch { /* next */ }
    }
    // 兜底：让 Electron 以 node 模式运行自己
    return { path: process.execPath, electron: true };
  };
  const startWatchdog = () => {
    if (!existsSync(watchdogScript)) return { ok: false, error: "找不到看门狗脚本 " + watchdogScript };
    writeJsonSafe(watchdogConfigFile, {
      heartbeat: heartbeatFile,
      stopFlag: stopFlagFile,
      restartFlag: restartFlagFile,
      pidFile: watchdogPidFile,
      startScript: resolveScript(SCRIPT_ROOT + "/restart-dsh-start.ps1", [PLUGIN_ROOT + "/scripts/restart-dsh-start.ps1", WS_ROOT + "/scripts/restart-dsh-start.ps1"]),
      logFile: watchdogLog,
      pollMs: watchdogPollMs,
      staleMs: watchdogStaleMs,
      cooldownMs: watchdogCooldownMs,
    });
    try { if (existsSync(stopFlagFile)) unlinkSync(stopFlagFile); } catch { /* best effort */ }
    const node = resolveNode();
    const env = node.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" } : process.env;
    const child = spawn(node.path, [watchdogScript, watchdogConfigFile], { detached: true, stdio: "ignore", windowsHide: true, env });
    child.on("error", (e) => {
      log("[watchdog] spawn error: " + String(e));
      try { appendFileSync(watchdogLog, "[" + new Date().toISOString() + "] spawn error: " + String(e) + "\n", "utf8"); } catch { /* best effort */ }
    });
    child.unref();
    log("[watchdog] started pid=" + child.pid + " via " + node.path + (node.electron ? " (ELECTRON_RUN_AS_NODE)" : ""));
    try {
      appendFileSync(watchdogLog, "[" + new Date().toISOString() + "] spawn requested pid=" + child.pid + " via " + node.path + "\n", "utf8");
    } catch { /* best effort */ }
    return { ok: true, pid: child.pid, node: node.path };
  };
  const stopWatchdog = () => {
    try { writeFileSync(stopFlagFile, new Date().toISOString(), "utf8"); } catch { /* best effort */ }
    const pid = watchdogPid();
    if (pid) { try { process.kill(pid); } catch { /* best effort */ } }
    log("[watchdog] stop requested (pid=" + (pid || "none") + ")");
    return pid;
  };
  if (watchdogEnabled && !watchdogPid()) {
    const started = startWatchdog();
    log("[boot] watchdog " + (started.ok ? "spawned pid=" + started.pid : "failed: " + started.error));
  }

  // ---------- restart_dsh ----------
  try {
    ctx.tools.register(defineTool({
      name: "restart_dsh",
      description:
        "Restart DeepSeek Harness safely. Arms a scheduled kill + start pair: DSH is killed after " +
        "delay_seconds (20-600, default 45) and started again ~11s later if it is still down. The whole " +
        "app — including this conversation — goes down and comes back in 60-90 seconds; the next session " +
        "can continue. Optional start_script replaces the start half (e.g. run pnpm install before the " +
        "app comes back); optional watch_seconds adds a third watchdog task. " +
        "Requires confirm:true. Never call this unless the user explicitly asked to restart DSH.",
      parameters: {
        confirm: { type: "boolean", required: true, description: "Must be true. A restart kills the whole app." },
        delay_seconds: { type: "integer", description: "Seconds until DSH is killed (20-600, default 45)." },
        start_script: {
          type: "string",
          description:
            "Optional absolute path of a .cmd/.ps1 used as the start half. It runs after the kill in its " +
            "own scheduled task and must bring DSH back (call restart-dsh-start.ps1 at the end).",
        },
        watch_seconds: {
          type: "integer",
          description: "Optional watchdog delay (0/omitted = off). Starts DSH if it is still down then.",
        },
        reason: { type: "string", description: "Optional one-line reason, echoed in the result." },
        announce_channel: {
          type: "string",
          description:
            "Which IM channel should receive the post-restart greeting: weixin | qq. Pass the channel this conversation lives on; omit = auto pick.",
        },
      },
      output: toolOutput(),
      async execute(args) {
        // The host validates tool results against output.schema: a bare string
        // is rejected as `"value" must be an object`. Always return { ok, text }.
        if (args?.confirm !== true) {
          return { ok: false, text: "重启没有排上 ❌\n原因：缺少 confirm:true\n提示：重启会杀掉整个 DSH 并打断本对话；先向用户确认，再带 confirm:true 调用。" };
        }
        const timings = resolveTimings(args?.delay_seconds, { defaultKillSeconds });
        const startScript = String(args?.start_script ?? "").trim();
        const extended = needsExtendedScript({ startScript, watchSeconds: args?.watch_seconds });
        const watchSeconds = extended
          ? normalizeWatchSeconds(args?.watch_seconds, { startSeconds: timings.startSeconds })
          : 0;
        const script = extended ? maintArmScript : armScript;

        if (!existsSync(script)) {
          return { ok: false, text: "重启没有排上 ❌\n原因：找不到重启脚本 " + script + "\n提示：检查 armScript / maintArmScript 配置。" };
        }
        if (startScript && !existsSync(startScript)) {
          return { ok: false, text: "重启没有排上 ❌\n原因：找不到启动半段脚本 " + startScript };
        }
        if (!existsSync(dirname(logFile))) {
          return { ok: false, text: "重启没有排上 ❌\n原因：找不到日志目录 " + dirname(logFile) };
        }

        // 公开版不写死 exe 路径：把当前 app 的可执行文件记下来，start 半段脚本会优先读它。
        try {
          const stateDir = PLUGIN_ROOT + "/.state";
          mkdirSync(stateDir, { recursive: true });
          writeFileSync(stateDir + "/app-exe.txt", process.execPath, "utf8");
        } catch { /* 记不下来就让 start 脚本走候选探测 */ }
        // arm 脚本与两个 cmd 半段用同一个日志文件（配置里的 logFile）。
        try { process.env.DSH_RESTART_LOG = logFile; } catch { /* ignore */ }

        const result = await runProcess(powershell,
          buildArmArgs({ script, killSeconds: timings.killSeconds, startSeconds: timings.startSeconds, startScript, watchSeconds }),
          20000);

        if (result.code !== 0) {
          return { ok: false, text: "重启没有排上 ❌\n原因：arm 脚本失败（exit " + result.code + "）\n输出：\n" + tailLines(result.output, 8) };
        }

        if (announce) {
          const marked = writeMarker(announceFile, announceText, new Date(), String(args?.announce_channel ?? ""));
          if (!marked.ok) log("[announce] marker write failed: " + marked.error);
        }

        writeJsonSafe(armRecordFile, {
          pid: me.pid,
          startedAt: me.startedAt,
          armedAt: new Date().toISOString(),
          delaySeconds: timings.killSeconds,
          startSeconds: timings.startSeconds,
          startScript,
          watchSeconds,
          reason: String(args?.reason ?? ""),
          source: "tool",
        });
        writeJsonSafe(restartFlagFile, { at: new Date().toISOString(), by: "tool", pid: me.pid, delaySeconds: timings.killSeconds });
        const backup = backupProfile();
        writeJsonSafe(killRecordFile, { killAt: Date.now() + timings.killSeconds * 1000, armedAt: Date.now(), by: "tool" });

        let logTail = "";
        try { logTail = tailLines(await readFile(logFile, "utf8"), 6); } catch { /* best effort */ }

        return {
          ok: true,
          text: [
            "重启已排程 ✅",
            "计划：" + describeTimings(timings),
            startScript ? "启动半段：" + startScript : "",
            watchSeconds > 0 ? "看门狗：+" + watchSeconds + "s 后补拉" : "",
            "原因：" + (String(args?.reason ?? "").trim() || "（未填）"),
            announce ? "回来后会发一句：「" + announceText + "」" : "",
            logTail ? "日志：" + logTail : "",
            "本对话会中断，重启后新会话可继续。",
          ].filter(Boolean).join("\n"),
        };
      },
    }));
  } catch (error) {
    log("[boot] register restart_dsh failed: " + String(error?.message ?? error));
  }

  // ---------- restart_watchdog ----------
  try {
    ctx.tools.register(defineTool({
      name: "restart_watchdog",
      description:
        "常驻看门狗：盯心跳文件，DSH 心跳超过阈值没更新就用 vetted 的 start 脚本把 DSH 拉起来。" +
        "action = status / start / stop。",
      parameters: { action: { type: "string", required: true, description: "status | start | stop" } },
      output: toolOutput(),
      async execute(args) {
        const action = String(args?.action ?? "status").trim().toLowerCase();
        if (action === "stop") {
          const pid = stopWatchdog();
          return { ok: true, text: "已请求停止看门狗" + (pid ? "（pid=" + pid + "）" : "（原本没在跑）") };
        }
        if (action === "start") {
          const running = watchdogPid();
          if (running) return { ok: true, text: "看门狗已在运行，pid=" + running };
          const started = startWatchdog();
          return started.ok
            ? { ok: true, text: "看门狗已启动，pid=" + started.pid + "\n脚本：" + watchdogScript }
            : { ok: false, text: "启动失败 ❌\n原因：" + started.error };
        }
        const pid = watchdogPid();
        let hb = "无";
        try { hb = Math.round((Date.now() - statSync(heartbeatFile).mtimeMs) / 1000) + "s 前"; } catch { /* best effort */ }
        return {
          ok: true,
          text: [
            "看门狗：" + (pid ? "运行中 pid=" + pid : "未运行"),
            "配置开关：watchdogEnabled=" + watchdogEnabled,
            "心跳：" + hb,
            "阈值：stale=" + watchdogStaleMs + "ms / poll=" + watchdogPollMs + "ms / cooldown=" + watchdogCooldownMs + "ms",
            "脚本：" + watchdogScript,
            "日志：" + watchdogLog,
          ].join("\n"),
        };
      },
    }));
  } catch (error) {
    log("[boot] register restart_watchdog failed: " + String(error?.message ?? error));
  }

  // ---------- restart_status ----------
  try {
    ctx.tools.register(defineTool({
      name: "restart_status",
      description:
        "Show the restart-related scheduled tasks (DSH-Restart-*) and the tail of the restart log. " +
        "Use it to check whether a restart was really armed or why the last one failed.",
      parameters: {},
      output: toolOutput(),
      async execute() {
        if (!existsSync(tasksScript)) return { ok: false, text: "查询失败 ❌\n原因：找不到任务查询脚本 " + tasksScript };
        const result = await runProcess(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tasksScript, "-Action", "status"], 15000);
        if (result.code !== 0) return { ok: false, text: "查询失败 ❌\n原因：查询脚本失败（exit " + result.code + "）\n" + tailLines(result.output, 6) };
        let logTail = "";
        try { logTail = tailLines(await readFile(logFile, "utf8"), 12); } catch { /* best effort */ }
        const rows = parseTaskStatus(result.output).map(
          (t) => "- " + t.name + "：" + (t.state || "未注册") + (t.next ? "（下次 " + t.next + "）" : ""),
        );
        const armed = readJsonSafe(armRecordFile);
        const identity = ["当前进程：pid=" + me.pid + "，startedAt=" + me.startedAt];
        if (downtimeSeconds !== null) identity.push("上次停机：约 " + downtimeSeconds + " 秒");
        if (backupEnabled) {
          try {
            const dirs = readdirSync(backupRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
            identity.push("重启前备份：" + dirs.length + " 份" + (dirs.length ? "，最新 " + dirs[dirs.length - 1] : "（还没有）") + " → " + backupRoot);
          } catch {
            identity.push("重启前备份：目录还没建 → " + backupRoot);
          }
        } else {
          identity.push("重启前备份：已关闭");
        }
        if (armed && armed.pid) {
          const same = Number(armed.pid) === Number(me.pid) && String(armed.startedAt) === String(me.startedAt);
          identity.push("上次排程时的进程：pid=" + armed.pid + "，startedAt=" + armed.startedAt);
          identity.push(same ? "判定：仍是同一进程（重启可能没发生 / 或还没到点）" : "判定：进程已更替 ✅（重启确实发生过）");
        } else {
          identity.push("上次排程记录：无");
        }
        return { ok: true, text: [...identity, "", "重启任务：", ...(rows.length ? rows : ["- （无）"]), "", "日志尾部：", logTail || "（空）"].join("\n") };
      },
    }));
  } catch (error) {
    log("[boot] register restart_status failed: " + String(error?.message ?? error));
  }

  // ---------- restart_announce_test ----------
  try {
    ctx.tools.register(defineTool({
      name: "restart_announce_test",
      description:
        "Send the post-restart greeting right now, without restarting. Verifies that IM proactive " +
        "delivery actually works and reports which bot/target was used, or the exact reason it failed.",
      parameters: { channel: { type: "string", description: "Which IM channel to greet: weixin | qq (omit = auto)." } },
      output: toolOutput(),
      async execute(args) {
        const im = await waitForIm(ctx, 8000);
        if (!im) return { ok: false, text: "发送失败 ❌\n原因：IM 服务不可用（等了 8 秒）" };
        const route = await waitForRoute(im, { botId: config?.announceBotId, targetId: config?.announceTargetId, channel: String(args?.channel ?? "") }, 6000);
        if (!route.targetId) {
          return {
            ok: false,
            text: "发送失败 ❌\n原因：" + route.error +
              "\n修法：设置 → IM机器人 → 对应机器人卡片 → 新建目标 → 「从已聊会话选择」→ 测试 → 保存。",
          };
        }
        try {
          await im.send(route.botId, route.targetId, announceText);
          log("[announce] test sent via " + route.botId + "/" + route.targetId);
          let botsInfo = "";
          try { const bs = typeof im.listBots === "function" ? await im.listBots() : []; botsInfo = "\n可用机器人：" + (Array.isArray(bs) ? bs.map((b) => String(b?.botId) + "(" + String(b?.channel) + ")").join(" ") : "?"); } catch { botsInfo = "\n可用机器人：读不到"; }
          return { ok: true, text: "已发送 ✅\n机器人：" + route.botId + "\n目标：" + route.targetId + "\n内容：" + announceText + botsInfo };
        } catch (error) {
          return { ok: false, text: "发送失败 ❌\n原因：" + String(error?.message ?? error) };
        }
      },
    }));
  } catch (error) {
    log("[boot] register restart_announce_test failed: " + String(error?.message ?? error));
  }

  // ---------- restart_cancel ----------
  try {
    ctx.tools.register(defineTool({
      name: "restart_cancel",
      description:
        "Cancel an armed restart: unregister every DSH-Restart-* scheduled task. Only useful before the " +
        "kill task fires.",
      parameters: {},
      output: toolOutput(),
      async execute() {
        if (!existsSync(tasksScript)) return { ok: false, text: "取消失败 ❌\n原因：找不到任务查询脚本 " + tasksScript };
        const result = await runProcess(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tasksScript, "-Action", "cancel"], 15000);
        if (result.code !== 0) return { ok: false, text: "取消失败 ❌\n原因：取消脚本失败（exit " + result.code + "）\n" + tailLines(result.output, 6) };
        return { ok: true, text: "已取消重启任务：\n" + (tailLines(result.output, 10) || "（没有可取消的任务）") };
      },
    }));
  } catch (error) {
    log("[boot] register restart_cancel failed: " + String(error?.message ?? error));
  }

  // ---------- /restart 斜杠命令（人敲，确定性执行，不花推理 token）----------
  // 设计借鉴 anweat/dsh-restart 的 /restart 命令（MIT）：命令行只做排程，不改配置。
  try {
    const commands = ctx.commands;
    if (commands && typeof commands.register === "function") {
      commands.register({
        definitionId: "dsh-restart",
        name: "restart",
        description: "重启 DSH（默认 45 秒后杀进程、约 11 秒后拉起）",
        input: { hint: "[秒数 20-600] [--watch 看门狗秒数]" },
        handler: async (invocation) => {
          const raw = String(invocation?.rawInput ?? "").trim();
          const parts = raw.split(/\s+/).filter(Boolean);
          let delay = defaultKillSeconds;
          let watch = 0;
          for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (p === "--watch") { watch = Number(parts[++i] ?? 0); continue; }
            const n = Number(p);
            if (Number.isFinite(n) && n > 0) delay = n;
          }
          const timings = resolveTimings(delay, { defaultKillSeconds });
          const watchSeconds = watch > 0
            ? normalizeWatchSeconds(watch, { startSeconds: timings.startSeconds })
            : 0;
          const script = watchSeconds > 0 ? maintArmScript : armScript;
          if (!existsSync(script)) {
            return { kind: "error", text: "重启没有排上 ❌ 找不到重启脚本 " + script };
          }
          const result = await runProcess(
            powershell,
            buildArmArgs({ script, killSeconds: timings.killSeconds, startSeconds: timings.startSeconds, startScript: "", watchSeconds }),
            20000,
          );
          if (result.code !== 0) {
            return { kind: "error", text: "重启没有排上 ❌ arm 脚本失败（exit " + result.code + "）\n" + tailLines(result.output, 6) };
          }
          if (announce) writeMarker(announceFile, announceText);
          writeJsonSafe(armRecordFile, {
            pid: me.pid,
            startedAt: me.startedAt,
            armedAt: new Date().toISOString(),
            delaySeconds: timings.killSeconds,
            startSeconds: timings.startSeconds,
            startScript: "",
            watchSeconds,
            reason: "/restart",
            source: "command",
          });
          writeJsonSafe(restartFlagFile, { at: new Date().toISOString(), by: "command", pid: me.pid, delaySeconds: timings.killSeconds });
          backupProfile();
          writeJsonSafe(killRecordFile, { killAt: Date.now() + timings.killSeconds * 1000, armedAt: Date.now(), by: "command" });
          log("[/restart] armed by command: " + describeTimings(timings));
          return {
            kind: "success",
            text: "重启已排程 ✅\n计划：" + describeTimings(timings) +
              (watchSeconds > 0 ? "\n看门狗：+" + watchSeconds + "s 后补拉" : "") +
              "\n约 60-90 秒后回来；本对话会中断。",
          };
        },
      });
      log("[boot] /restart command registered");
    } else {
      log("[boot] /restart skipped: commands service unavailable");
    }
  } catch (error) {
    log("[boot] register /restart failed: " + String(error?.message ?? error));
  }

  // ---------- boot hook: "我回来啦" ----------
  if (announce) {
    const timer = setTimeout(() => {
      void announceIfPending(ctx, {
        file: announceFile,
        maxAgeMinutes: announceMaxAgeMinutes,
        botId: config?.announceBotId,
        targetId: config?.announceTargetId,
        autoTarget: config?.announceAutoTarget !== false,
        log,
      }).catch((error) => log("[announce] unexpected failure: " + String(error?.message ?? error)));
    }, 3000);
    if (typeof timer.unref === "function") timer.unref();
  }
}
