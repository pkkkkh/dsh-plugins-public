/**
 * Contact-sheet composer for dsh-bilibili.
 *
 * 为什么：一次抓 6~9 张零散 PNG，模型要读 6~9 个图片单位，还很难对上时间。
 * 合并成一张宫格图、每格烧上「序号 + mm:ss」，读 1 张图就够了。
 * 参考思路：dsh-video-storyboard（MIT）的「可寻址宫格」。
 *
 * 只用 ffmpeg；烧字失败自动退回不烧字；再失败返回 ok:false（调用方保持原行为）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const BS = String.fromCharCode(92); // 反斜杠：用 fromCharCode 避免源码转义歧义
const FFMPEG_CANDIDATES = [process.env.FFMPEG_PATH, "ffmpeg", "D:/dsh-home/bin/ffmpeg.exe"].filter(Boolean);
const FONT_CANDIDATES = [
  "C:/Windows/Fonts/msyh.ttc",
  "C:/Windows/Fonts/msyhbd.ttc",
  "C:/Windows/Fonts/simhei.ttf",
  "C:/Windows/Fonts/arial.ttf",
];

/** 秒 → mm:ss（超过 1 小时用 h:mm:ss）。 */
export function formatStamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? h + ":" + mm + ":" + ss : mm + ":" + ss;
}

function runFfmpeg(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { windowsHide: true }); }
    catch (error) { resolve({ ok: false, error: "spawn: " + String(error?.message ?? error) }); return; }
    let stderr = "";
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve({ ok: false, error: "timeout" }); }, timeoutMs);
    child.stderr.on("data", (d) => { if (stderr.length < 4000) stderr += String(d); });
    child.on("error", (error) => { clearTimeout(timer); resolve({ ok: false, error: "spawn: " + String(error?.message ?? error) }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: "ffmpeg exit " + code + ": " + stderr.slice(-260) });
    });
  });
}

/** 路径 → filtergraph 安全写法：正斜杠 + 转义冒号。 */
function escapePath(p) {
  return String(p).split(BS).join("/").split(":").join(BS + ":");
}

/** 文本 → filtergraph 安全写法：转义冒号和百分号，去掉单引号。 */
function escapeText(t) {
  return String(t).replace(/'/g, "").split(":").join(BS + ":").split("%").join(BS + "%");
}

export async function buildSheet(opts) {
  const frames = (opts?.frames ?? []).filter((f) => f && f.path && existsSync(f.path));
  if (frames.length < 2) return { ok: false, error: "少于 2 张可用帧" };
  const cols = Math.max(2, Math.min(4, Number(opts?.cols ?? (frames.length <= 4 ? 2 : 3))));
  const tileW = Math.max(320, Math.min(960, Number(opts?.tileWidth ?? 480)));
  const tileH = Math.round((tileW * 9) / 16 / 2) * 2;
  const outPath = String(opts?.outPath ?? "");
  if (!outPath) return { ok: false, error: "缺少 outPath" };
  try { mkdirSync(dirname(outPath), { recursive: true }); } catch { /* 目录已存在 */ }

  const font = FONT_CANDIDATES.find((f) => existsSync(f)) || "";

  const labelChain = (i) => {
    if (!font) return "";
    const text = "#" + (i + 1) + " " + formatStamp(frames[i].time);
    const size = Math.max(14, Math.round(tileW / 26));
    return ",drawtext=fontfile='" + escapePath(font) + "'" +
      ":text='" + escapeText(text) + "'" +
      ":x=8:y=h-" + (size + 10) + ":fontsize=" + size +
      ":fontcolor=white:box=1:boxcolor=black@0.62:boxborderw=6";
  };

  const buildArgs = (withLabels) => {
    const inputs = [];
    const chains = [];
    for (let i = 0; i < frames.length; i++) {
      inputs.push("-i", frames[i].path);
      chains.push(
        "[" + i + ":v]scale=" + tileW + ":" + tileH + ":force_original_aspect_ratio=decrease," +
        "pad=" + tileW + ":" + tileH + ":(ow-iw)/2:(oh-ih)/2:color=black" +
        (withLabels ? labelChain(i) : "") + "[v" + i + "]",
      );
    }
    const positions = [];
    for (let i = 0; i < frames.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col === 0 ? "0" : Array(col).fill("w0").join("+");
      const y = row === 0 ? "0" : Array(row).fill("h0").join("+");
      positions.push(x + "_" + y);
    }
    const stack = frames.map((_f, i) => "[v" + i + "]").join("") +
      "xstack=inputs=" + frames.length + ":layout=" + positions.join("|") + ":fill=black[out]";
    return ["-y", ...inputs, "-filter_complex", chains.join(";") + ";" + stack, "-map", "[out]", "-frames:v", "1", outPath];
  };

  const cells = frames.map((f, i) => ({ index: i + 1, time: Number(f.time) || 0, stamp: formatStamp(f.time), path: f.path }));
  let lastError = "";
  const strategies = font ? [true, false] : [false];
  for (const withLabels of strategies) {
    for (const bin of FFMPEG_CANDIDATES) {
      const result = await runFfmpeg(bin, buildArgs(withLabels), Number(opts?.timeoutMs ?? 120000));
      if (result.ok && existsSync(outPath)) {
        return { ok: true, path: outPath, cols, tileWidth: tileW, tileHeight: tileH, labeled: withLabels, font, cells };
      }
      lastError = result.error || lastError;
      if (!/ENOENT|spawn/.test(String(result.error || ""))) break; // 不是找不到 ffmpeg，就换策略
    }
  }
  return { ok: false, error: String(lastError).slice(-300), cells };
}
