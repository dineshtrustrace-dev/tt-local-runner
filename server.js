// TT Local Runner — zero-dependency control server for the local dev stack.
// Usage: node server.js   →   http://localhost:7777
//
// Processes are started detached with output redirected to logs/<id>.log, so they keep running
// if this server is restarted; on restart they are re-adopted by port / pid.

const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const config = require('./config');

const ROOT = __dirname;
const LOG_DIR = path.join(ROOT, 'logs');
const STATE_FILE = path.join(LOG_DIR, '.pids.json');
const SHELL = process.env.SHELL || '/bin/zsh';
const HOOP = path.join(os.homedir(), '.hoop/bin/hoop');

fs.mkdirSync(LOG_DIR, { recursive: true });
process.env.PATH = [path.dirname(HOOP), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].join(':');

// ─── State ──────────────────────────────────────────────────────────────

const services = new Map(config.services.map((s) => [s.id, s]));
const RUNNER_LOG = 'runner';
// A container card shows the ports of all its containers; each container logs to logs/<container>.log.
for (const s of config.services) if (s.containers) s.ports = s.containers.flatMap((c) => c.ports || []);
const LOG_IDS = [RUNNER_LOG, ...config.services.flatMap((s) => (s.containers ? s.containers.map((c) => c.name) : [s.id]))];

/** id → { status, message, pid, managed, lastExit, startedAt, busy } */
const state = new Map();
for (const s of config.services) state.set(s.id, { status: 'stopped', message: '', pid: null, busy: false });

let pids = {};
try {
  pids = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch {
  pids = {};
}
const savePids = () => fs.writeFileSync(STATE_FILE, JSON.stringify(pids, null, 2));

let podmanMachine = 'unknown';
let runAllActive = false;

// ─── Logging ────────────────────────────────────────────────────────────

const logPath = (id) => path.join(LOG_DIR, `${id}.log`);

function appendLog(id, text) {
  const line = text.endsWith('\n') ? text : text + '\n';
  fs.appendFileSync(logPath(id), line);
}

function runnerLog(msg) {
  const ts = new Date().toLocaleTimeString();
  appendLog(RUNNER_LOG, `[${ts}] ${msg}`);
}

/** Polls each log file for new bytes and pushes them to SSE clients. */
const logOffsets = new Map();
function pumpLogs() {
  for (const id of LOG_IDS) {
    let size;
    try {
      size = fs.statSync(logPath(id)).size;
    } catch {
      continue;
    }
    const from = logOffsets.get(id);
    if (from === undefined) {
      logOffsets.set(id, size);
      continue;
    }
    if (size < from) {
      logOffsets.set(id, size); // truncated (cleared)
      continue;
    }
    if (size === from) continue;
    const fd = fs.openSync(logPath(id), 'r');
    const buf = Buffer.alloc(Math.min(size - from, 512 * 1024));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    fs.closeSync(fd);
    logOffsets.set(id, size);
    broadcast({ type: 'log', id, text: buf.toString('utf8') });
  }
}

function readTail(id, maxBytes = 200 * 1024) {
  try {
    const size = fs.statSync(logPath(id)).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(logPath(id), 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, env: process.env }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) })
    );
  });
}

/** Runs a short command and streams its output into a service log. */
function runLogged(id, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    appendLog(id, `$ ${[cmd, ...args].join(' ')}`);
    const child = spawn(cmd, args, { env: process.env, ...opts });
    child.stdout.on('data', (d) => appendLog(id, d.toString()));
    child.stderr.on('data', (d) => appendLog(id, d.toString()));
    child.on('error', (e) => {
      appendLog(id, `[runner] ${e.message}`);
      resolve(false);
    });
    child.on('close', (code) => resolve(code === 0));
  });
}

function portOpen(port) {
  const probe = (host) =>
    new Promise((resolve, reject) => {
      const s = net.connect({ host, port });
      s.setTimeout(700);
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', reject);
      s.once('timeout', () => {
        s.destroy();
        reject(new Error('timeout'));
      });
    });
  return Promise.any([probe('127.0.0.1'), probe('::1')]).catch(() => false);
}

const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function listenerPids(port) {
  const r = await run('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']);
  return r.stdout
    .split('\n')
    .map((x) => parseInt(x, 10))
    .filter(Boolean);
}

/** Starts a detached process (own process group) with output appended to its log. */
function spawnManaged(svc, command) {
  const out = fs.openSync(logPath(svc.id), 'a');
  appendLog(svc.id, `\n[runner] ── start ${new Date().toLocaleString()} ──\n$ (cd ${svc.cwd || ROOT}) ${command}`);
  const child = spawn(SHELL, ['-lc', command], {
    cwd: svc.cwd || ROOT,
    env: { ...process.env, ...(svc.env || {}), FORCE_COLOR: '0', NO_COLOR: '1' },
    detached: true,
    stdio: ['ignore', out, out]
  });
  fs.closeSync(out);
  child.on('exit', (code, signal) => {
    const st = state.get(svc.id);
    st.lastExit = { code, signal };
    appendLog(svc.id, `[runner] process exited (code=${code}${signal ? `, signal=${signal}` : ''})`);
    if (pids[svc.id] === child.pid) {
      delete pids[svc.id];
      savePids();
    }
  });
  child.unref();
  pids[svc.id] = child.pid;
  savePids();
  return child.pid;
}

async function killGroup(pid, id) {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
  }
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(500);
  if (alive(pid)) {
    appendLog(id, '[runner] still alive after 10s — sending SIGKILL');
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
}

// ─── Podman ─────────────────────────────────────────────────────────────

/** container name → { state, ports } */
let containers = {};
const logFollowers = new Map();

async function refreshPodman() {
  const m = await run('podman', ['machine', 'inspect', '--format', '{{.State}}'], { timeout: 10000 });
  podmanMachine = m.ok ? m.stdout.trim().split('\n')[0] || 'unknown' : 'not available';
  if (podmanMachine !== 'running') {
    containers = {};
    return;
  }
  const r = await run('podman', ['ps', '-a', '--format', 'json'], { timeout: 10000 });
  if (!r.ok) return;
  const next = {};
  try {
    for (const c of JSON.parse(r.stdout || '[]')) {
      const name = (c.Names || [])[0];
      next[name] = { state: c.State, status: c.Status };
    }
  } catch {
    return;
  }
  containers = next;
}

function followContainerLogs(name) {
  if (logFollowers.has(name)) return;
  const out = fs.openSync(logPath(name), 'a');
  const child = spawn('podman', ['logs', '-f', '--since', '5s', name], { stdio: ['ignore', out, out] });
  fs.closeSync(out);
  logFollowers.set(name, child);
  child.on('exit', () => logFollowers.delete(name));
}

async function ensurePodmanMachine() {
  await refreshPodman();
  if (podmanMachine === 'running') return true;
  runnerLog('Podman machine is not running — starting it');
  const ok = await runLogged(RUNNER_LOG, 'podman', ['machine', 'start']);
  await refreshPodman();
  return ok && podmanMachine === 'running';
}

// ─── Hoop login ─────────────────────────────────────────────────────────

let hoopLoggedIn = null;
let hoopCheckedAt = 0;

async function refreshHoopLogin(force = false) {
  if (!force && Date.now() - hoopCheckedAt < 60000) return;
  hoopCheckedAt = Date.now();
  const r = await run(HOOP, ['admin', 'get', 'connections'], { timeout: 15000 });
  hoopLoggedIn = r.ok;
}

// After a browser login, close hoop's "You're logged-in!" tab (served by the CLI on :3587) and bring the
// runner tab back to the front. Chrome only; macOS asks once for permission to control Chrome.
const RETURN_TO_RUNNER = `
on run argv
  set runnerPort to item 1 of argv
  if application "Google Chrome" is not running then return "Chrome not running"
  tell application "Google Chrome"
    repeat with wi from (count of windows) to 1 by -1
      repeat with ti from (count of tabs of window wi) to 1 by -1
        set u to URL of tab ti of window wi
        if u starts with "http://127.0.0.1:3587" or u starts with "http://localhost:3587" then close tab ti of window wi
      end repeat
    end repeat
    repeat with wi from 1 to (count of windows)
      repeat with ti from 1 to (count of tabs of window wi)
        set u to URL of tab ti of window wi
        if u starts with ("http://localhost:" & runnerPort) or u starts with ("http://127.0.0.1:" & runnerPort) then
          set w to window wi
          set active tab index of w to ti
          set index of w to 1
          activate
          return "runner tab focused"
        end if
      end repeat
    end repeat
  end tell
  return "no runner tab open"
end run`;

function returnToRunnerTab() {
  return new Promise((resolve) => {
    const child = execFile('osascript', ['-', String(config.port)], { timeout: 15000 }, (err, stdout, stderr) =>
      resolve(err ? `could not switch tabs: ${String(stderr).trim() || err.message}` : String(stdout).trim())
    );
    child.stdin.end(RETURN_TO_RUNNER);
  });
}

// ─── Git ────────────────────────────────────────────────────────────────

/** cwd → { branch, added, deleted } — uncommitted changes (staged + unstaged) vs HEAD. */
const gitInfo = new Map();

async function refreshGit() {
  const cwds = [...new Set(config.services.filter((s) => s.cwd).map((s) => s.cwd))];
  await Promise.all(
    cwds.map(async (cwd) => {
      let b = await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 10000 });
      if (!b.ok) return gitInfo.delete(cwd);
      let branch = b.stdout.trim();
      if (branch === 'HEAD') branch = `detached @ ${(await run('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD'])).stdout.trim()}`;
      const d = await run('git', ['-C', cwd, 'diff', 'HEAD', '--shortstat'], { timeout: 20000 });
      const num = (re) => Number((d.stdout.match(re) || [])[1] || 0);
      gitInfo.set(cwd, { branch, added: num(/(\d+) insertion/), deleted: num(/(\d+) deletion/) });
    })
  );
}

// ─── Status ─────────────────────────────────────────────────────────────

async function computeStatus(svc) {
  const st = state.get(svc.id);
  const portsUp = svc.ports ? await Promise.all(svc.ports.map(portOpen)) : [];
  st.ports = (svc.ports || []).map((p, i) => ({ port: p, open: portsUp[i] }));
  const allUp = portsUp.length > 0 && portsUp.every(Boolean);
  const anyUp = portsUp.some(Boolean);

  if (st.waitingFor) return set(st, 'starting', `Waiting for ${st.waitingFor}…`);

  if (svc.kind === 'hoop-login') {
    if (st.busy) return set(st, 'starting', 'Waiting for browser login…');
    if (hoopLoggedIn === null) return set(st, 'starting', 'Checking…');
    return hoopLoggedIn ? set(st, 'running', 'Logged in') : set(st, 'stopped', 'Not logged in');
  }

  if (svc.kind === 'container') {
    st.containers = svc.containers.map(({ name }) => {
      const c = containers[name];
      const cs = !c ? 'missing' : c.state;
      if (cs === 'running') followContainerLogs(name);
      return { name, state: cs, status: c ? c.status || c.state : 'not found' };
    });
    if (podmanMachine !== 'running') return set(st, 'stopped', `Podman machine ${podmanMachine}`);
    const missing = st.containers.filter((c) => c.state === 'missing');
    if (missing.length) return set(st, 'failed', `Not found: ${missing.map((c) => c.name).join(', ')}`);
    const up = st.containers.filter((c) => c.state === 'running').length;
    const total = st.containers.length;
    if (up === total) return set(st, allUp ? 'running' : 'starting', allUp ? `All ${total} running` : 'Waiting for ports…');
    if (up > 0 || st.busy) return set(st, 'starting', `${up}/${total} running`);
    return set(st, 'stopped', 'Stopped');
  }

  // hoop + process: port-driven
  const pid = pids[svc.id];
  st.pid = alive(pid) ? pid : null;
  st.managed = !!st.pid;
  if (allUp) return set(st, 'running', st.managed ? 'Running' : 'Running (started outside runner)');
  if (st.pid) return set(st, 'starting', anyUp ? 'Partially up…' : 'Starting…');
  if (st.busy) return set(st, 'starting', 'Starting…');
  if (st.lastExit && st.lastExit.code !== 0 && st.lastExit.signal == null) {
    return set(st, 'failed', `Exited with code ${st.lastExit.code} — check log`);
  }
  return set(st, 'stopped', anyUp ? 'Partially up (outside runner)' : 'Stopped');
}

function set(st, status, message) {
  st.status = status;
  st.message = message;
}

function snapshot() {
  return {
    type: 'status',
    podmanMachine,
    runAllActive,
    services: config.services.map((s) => {
      const st = state.get(s.id);
      return {
        id: s.id,
        status: st.status,
        message: st.message,
        ports: st.ports || [],
        containers: st.containers,
        git: s.cwd ? gitInfo.get(s.cwd) : undefined,
        pid: st.pid,
        busy: st.busy
      };
    })
  };
}

async function refreshAll() {
  await Promise.all([refreshPodman(), refreshHoopLogin()]);
  await Promise.all(config.services.map(computeStatus));
  broadcast(snapshot());
}

// ─── Actions ────────────────────────────────────────────────────────────

async function startService(id) {
  const svc = services.get(id);
  const st = state.get(id);
  if (!svc) throw new Error(`Unknown service ${id}`);
  await computeStatus(svc);
  if (st.status === 'running' || (st.status === 'starting' && !st.busy)) return;
  st.busy = true;
  st.lastExit = null;
  try {
    switch (svc.kind) {
      case 'hoop-login': {
        appendLog(id, '[runner] opening browser for hoop login…');
        await runLogged(id, HOOP, ['login']);
        await refreshHoopLogin(true);
        if (hoopLoggedIn) {
          await sleep(1500); // let the success page show briefly
          runnerLog(`Hoop login done — ${await returnToRunnerTab()}`);
        }
        break;
      }
      case 'hoop':
        spawnManaged(svc, `exec "${HOOP}" connect ${svc.connection}${svc.args ? ' ' + svc.args : ''}`);
        break;
      case 'container':
        if (!(await ensurePodmanMachine())) throw new Error('Podman machine could not be started');
        await Promise.all(svc.containers.map((c) => runLogged(c.name, 'podman', ['start', c.name])));
        break;
      case 'process':
        spawnManaged(svc, svc.cmd);
        break;
    }
  } finally {
    st.busy = false;
  }
}

async function stopService(id) {
  const svc = services.get(id);
  const st = state.get(id);
  if (!svc) throw new Error(`Unknown service ${id}`);
  if (st.waitingFor) {
    st.startToken = null; // cancels a start that is still waiting on its dependencies
    st.waitingFor = null;
    appendLog(id, '[runner] start cancelled');
    return;
  }
  st.busy = true;
  try {
    if (svc.kind === 'hoop-login') {
      await runLogged(id, HOOP, ['logout']);
      await refreshHoopLogin(true);
      return;
    }
    if (svc.kind === 'container') {
      await Promise.all(svc.containers.map((c) => runLogged(c.name, 'podman', ['stop', c.name])));
      return;
    }
    const pid = pids[id];
    if (alive(pid)) {
      appendLog(id, `[runner] stopping process group ${pid}`);
      await killGroup(pid, id);
    }
    delete pids[id];
    savePids();
    // Anything still listening was started outside the runner — stop it by port.
    for (const port of svc.ports || []) {
      for (const p of await listenerPids(port)) {
        appendLog(id, `[runner] port ${port} still held by pid ${p} (started outside runner) — stopping it`);
        await killGroup(p, id);
      }
    }
    st.lastExit = null;
  } finally {
    st.busy = false;
  }
}

async function buildService(id) {
  const svc = services.get(id);
  if (!svc || !svc.build) throw new Error(`${id} has no build command`);
  const st = state.get(id);
  st.busy = true;
  try {
    appendLog(id, `\n[runner] ── build ${new Date().toLocaleString()} ──`);
    const ok = await runLogged(id, SHELL, ['-lc', svc.build], { cwd: svc.cwd });
    appendLog(id, ok ? '[runner] build succeeded' : '[runner] build FAILED');
  } finally {
    st.busy = false;
  }
}

const startTimeout = (s) => s.startTimeoutSec || (s.kind === 'hoop-login' ? 300 : 90);

/** id → promise that resolves once that service is up (shared, so a dependency is only started once). */
const ensuring = new Map();

function ensureUp(id) {
  if (ensuring.has(id)) return ensuring.get(id);
  const svc = services.get(id);
  const p = (async () => {
    await computeStatus(svc);
    if (state.get(id).status === 'running') return;
    await startWithDeps(id);
    if (!(await waitFor(id, startTimeout(svc)))) throw new Error(`${svc.name} did not come up — see its log`);
  })().finally(() => ensuring.delete(id));
  ensuring.set(id, p);
  return p;
}

/**
 * Starts every `dependsOn` service first (waiting until each is up), then the service itself.
 * `optionalDeps` are started and waited for the same way, but a failure there doesn't block the start.
 */
async function startWithDeps(id) {
  const svc = services.get(id);
  if (!svc) throw new Error(`Unknown service ${id}`);
  const optional = svc.optionalDeps || [];
  const deps = [...(svc.dependsOn || []), ...optional];
  if (deps.length) {
    const st = state.get(id);
    const token = (st.startToken = {});
    const pending = [];
    for (const d of deps) {
      await computeStatus(services.get(d));
      if (state.get(d).status !== 'running') pending.push(d);
    }
    if (pending.length) {
      const names = pending.map((d) => services.get(d).name).join(', ');
      st.waitingFor = names;
      appendLog(id, `[runner] waiting for ${names}`);
      runnerLog(`${svc.name} needs ${names} — starting them first`);
      refreshAll();
      try {
        await Promise.all(
          pending.map((d) =>
            optional.includes(d)
              ? ensureUp(d).catch((e) => appendLog(id, `[runner] optional ${services.get(d).name} unavailable (${e.message}) — continuing`))
              : ensureUp(d)
          )
        );
      } catch (e) {
        appendLog(id, `[runner] ✗ ${e.message} — not starting`);
        throw e;
      } finally {
        if (st.startToken === token) st.waitingFor = null;
      }
      if (st.startToken !== token) return; // stopped while waiting
      appendLog(id, '[runner] dependencies are up');
    }
  }
  await startService(id);
}

async function waitFor(id, timeoutSec) {
  const svc = services.get(id);
  const deadline = Date.now() + timeoutSec * 1000;
  // Give a just-spawned process a moment before judging it.
  await sleep(1500);
  while (Date.now() < deadline) {
    await computeStatus(svc);
    const st = state.get(id);
    if (st.status === 'running') return true;
    if (st.status === 'failed') return false;
    if (svc.kind === 'process' || svc.kind === 'hoop') {
      if (!st.pid && !st.busy) return false; // process died before its port opened
    }
    await sleep(2000);
  }
  return false;
}

async function runAll(ids) {
  if (runAllActive) throw new Error('Run all is already in progress');
  runAllActive = true;
  broadcast(snapshot());
  const wanted = new Set(ids && ids.length ? ids : config.services.map((s) => s.id));
  const stages = [...new Set(config.services.map((s) => s.stage))].sort((a, b) => a - b);
  runnerLog(`Run & connect all: ${[...wanted].join(', ')}`);
  try {
    for (const stage of stages) {
      const batch = config.services.filter((s) => s.stage === stage && wanted.has(s.id));
      if (!batch.length) continue;
      runnerLog(`Stage ${stage}: ${batch.map((s) => s.name).join(', ')}`);
      if (batch.some((s) => s.kind === 'container') && !(await ensurePodmanMachine())) {
        runnerLog('✗ Podman machine is not running — skipping containers');
        continue;
      }
      const results = await Promise.all(
        batch.map(async (s) => {
          try {
            await startWithDeps(s.id);
            const ok = await waitFor(s.id, startTimeout(s));
            runnerLog(`${ok ? '✓' : '✗'} ${s.name}${ok ? ' is up' : ' did not come up — see its log'}`);
            return ok;
          } catch (e) {
            runnerLog(`✗ ${s.name}: ${e.message}`);
            return false;
          }
        })
      );
      if (stage === 0 && results.includes(false)) {
        runnerLog('Hoop login failed — stopping here, tunnels need a session');
        return;
      }
    }
    runnerLog('Run & connect all finished');
  } finally {
    runAllActive = false;
    refreshAll();
  }
}

async function stopAll(ids) {
  const wanted = new Set(ids && ids.length ? ids : config.services.map((s) => s.id));
  wanted.delete('hoop-login'); // keep the SSO session; log out explicitly from its card
  const stages = [...new Set(config.services.map((s) => s.stage))].sort((a, b) => b - a);
  runnerLog('Stop / disconnect all');
  for (const stage of stages) {
    const batch = config.services.filter((s) => s.stage === stage && wanted.has(s.id));
    await Promise.all(
      batch.map(async (s) => {
        await computeStatus(s);
        if (state.get(s.id).status === 'stopped') return;
        try {
          await stopService(s.id);
          runnerLog(`■ ${s.name} stopped`);
        } catch (e) {
          runnerLog(`✗ ${s.name}: ${e.message}`);
        }
      })
    );
  }
  runnerLog('Stop / disconnect all finished');
  refreshAll();
}

// ─── HTTP ───────────────────────────────────────────────────────────────

const clients = new Set();
function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

/** Fire-and-forget: the UI follows progress through SSE. */
function kick(res, promise, label) {
  promise.catch((e) => runnerLog(`✗ ${label}: ${e.message}`)).finally(refreshAll);
  json(res, 202, { ok: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(ROOT, 'public/index.html')).pipe(res);
  }

  if (req.method === 'GET' && p === '/api/config') {
    return json(res, 200, { sections: config.sections, services: config.services.map(({ cmd, env, ...rest }) => rest) });
  }

  if (req.method === 'GET' && p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  const logMatch = p.match(/^\/api\/logs\/([\w-]+)$/);
  if (logMatch) {
    const id = logMatch[1];
    if (req.method === 'GET') return json(res, 200, { id, text: readTail(id) });
    if (req.method === 'DELETE') {
      fs.writeFileSync(logPath(id), '');
      return json(res, 200, { ok: true });
    }
  }

  if (req.method === 'POST' && p === '/api/run-all') {
    const body = await readBody(req);
    if (runAllActive) return json(res, 409, { error: 'Run all is already in progress' });
    return kick(res, runAll(body.ids), 'Run all');
  }
  if (req.method === 'POST' && p === '/api/stop-all') {
    const body = await readBody(req);
    return kick(res, stopAll(body.ids), 'Stop all');
  }

  const action = p.match(/^\/api\/services\/([\w-]+)\/(start|stop|restart|build)$/);
  if (req.method === 'POST' && action) {
    const [, id, verb] = action;
    if (!services.has(id)) return json(res, 404, { error: `Unknown service ${id}` });
    const name = services.get(id).name;
    const job =
      verb === 'start'
        ? startWithDeps(id)
        : verb === 'stop'
          ? stopService(id)
          : verb === 'build'
            ? buildService(id)
            : stopService(id).then(() => startWithDeps(id));
    return kick(res, job, `${verb} ${name}`);
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(config.port, '127.0.0.1', () => {
  runnerLog(`Runner started on http://localhost:${config.port}`);
  console.log(`TT Local Runner → http://localhost:${config.port}`);
});

setInterval(pumpLogs, 500);
setInterval(() => refreshAll().catch(() => {}), 3000);
setInterval(() => refreshGit().catch(() => {}), 10000);
refreshGit().catch(() => {});
refreshAll().catch(() => {});
