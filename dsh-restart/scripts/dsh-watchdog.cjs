// dsh-watchdog.cjs — DSH 常驻看门狗（由 dsh-restart 插件拉起）。
// 机制：插件每 5s 写一次心跳文件；本脚本发现心跳超过 staleMs 没更新且没有
// 「重启中」标志，就用 vetted 的 start 脚本把 DSH 拉起来（冷却期内不重复拉）。
// 设计参考 anweat/dsh-restart 的看门狗思路（MIT），实现独立。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// 配置路径：优先取命令行第 1 个参数（插件传进来），退回脚本同目录。
const CFG_PATH = process.argv[2] || path.join(__dirname, 'dsh-watchdog.json');
const CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));

function log(msg) {
  try { fs.appendFileSync(CFG.logFile, '[' + new Date().toISOString() + '] ' + msg + '\n', 'utf8'); } catch {}
}
function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}
function rm(file) { try { fs.unlinkSync(file); } catch {} }

try { fs.writeFileSync(CFG.pidFile, String(process.pid), 'utf8'); } catch {}
log('watchdog up pid=' + process.pid + ' poll=' + CFG.pollMs + 'ms stale=' + CFG.staleMs + 'ms cooldown=' + CFG.cooldownMs + 'ms');

let lastLaunch = 0;

const timer = setInterval(function () {
  if (fs.existsSync(CFG.stopFlag)) {
    log('stop flag found → exiting');
    rm(CFG.pidFile);
    clearInterval(timer);
    process.exit(0);
  }
  const hb = mtime(CFG.heartbeat);
  const age = hb ? Date.now() - hb : Number.MAX_SAFE_INTEGER;
  if (hb && age < CFG.staleMs) return;

  if (fs.existsSync(CFG.restartFlag)) {
    const rAge = Date.now() - mtime(CFG.restartFlag);
    if (rAge < CFG.cooldownMs) return;   // 正在重启，别插手
    rm(CFG.restartFlag);                  // 过期标志，清掉
  }
  if (Date.now() - lastLaunch < CFG.cooldownMs) return;

  lastLaunch = Date.now();
  try {
    fs.writeFileSync(CFG.restartFlag, JSON.stringify({ at: new Date().toISOString(), by: 'watchdog' }), 'utf8');
  } catch {}
  log('heartbeat stale for ' + (hb ? Math.round(age / 1000) + 's' : 'ever') + ' → relaunching via ' + CFG.startScript);
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CFG.startScript], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', function (e) { log('spawn error: ' + String(e)); });
    child.unref();
  } catch (e) {
    log('spawn threw: ' + String(e));
  }
}, CFG.pollMs);

