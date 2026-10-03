const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { spawn } = require('child_process');
const net = require('net');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = 7691;
const BUFFER_SIZE = 512 * 1024;
const RECONNECT_DELAY = 3000;
const TTYD_PATH = '/opt/homebrew/bin/ttyd';
const SHELL = '/bin/zsh';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';

const failedAttempts = {};
const MAX_FAILS = 5;
const LOCKOUT_MS = 60000;

// Single source of truth for the project list — file-server.js and the web
// selection page read the same file, so adding a project is one JSON edit.
// A project's own `password` (e.g. a friend's short code)
// unlocks only that project; ADMIN_PASSWORD unlocks everything.
const PROJECTS_FILE = path.join(__dirname, '..', 'config', 'projects.json');

let PROJECTS = {};

function loadProjects() {
    try {
        // Replace wholesale so removals and password changes both take effect.
        // (The old work-pc relay merged instead, which is why editing an
        // existing project's password there silently did nothing.)
        PROJECTS = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
        console.log('Projects:', Object.keys(PROJECTS).join(', '));
    } catch (e) {
        console.log('Failed to load projects.json:', e.message);
    }
}

loadProjects();
fs.watchFile(PROJECTS_FILE, { interval: 1500 }, loadProjects);

const sessions = {};

function getSession(project) {
    if (!sessions[project]) {
        sessions[project] = {
            ttydWs: null,
            ttydProcess: null,
            buffer: Buffer.alloc(0),
            browsers: new Set(),
            connecting: false,
            activated: false,
            cols: 80,
            rows: 24,
        };
    }
    return sessions[project];
}

function isPortListening(port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(1000);
        socket.on('connect', () => { socket.destroy(); resolve(true); });
        socket.on('timeout', () => { socket.destroy(); resolve(false); });
        socket.on('error', () => { resolve(false); });
        socket.connect(port, '127.0.0.1');
    });
}

async function ensureTtyd(project) {
    const config = PROJECTS[project];
    if (!config) return false;
    if (await isPortListening(config.port)) return true;

    console.log(`[${project}] Starting ttyd on :${config.port}...`);
    const session = getSession(project);

    // Fresh ttyd process — claude -c was never sent into this one yet.
    // Don't clear activated on ws-close: a flaky local ws (which closes without
    // killing ttyd) would otherwise re-inject the command into a live session.
    session.activated = false;

    const args = ['-p', String(config.port), '-W', '-b', `/t/${project}`, '-w', config.path, SHELL];
    const child = spawn(TTYD_PATH, args, {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, TERM: 'xterm-256color' },
    });
    child.unref();
    session.ttydProcess = child;

    child.on('error', (e) => {
        console.log(`[${project}] ttyd spawn error: ${e.message}`);
    });

    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (await isPortListening(config.port)) {
            console.log(`[${project}] ttyd ready on :${config.port}`);
            return true;
        }
    }

    console.log(`[${project}] ttyd failed to start`);
    return false;
}

async function connectToTtyd(project) {
    const session = getSession(project);
    const config = PROJECTS[project];
    if (!config || session.connecting) return;
    if (session.ttydWs && session.ttydWs.readyState === WebSocket.OPEN) return;

    session.connecting = true;

    const ttydReady = await ensureTtyd(project);
    if (!ttydReady) {
        session.connecting = false;
        if (session.browsers.size > 0) {
            setTimeout(() => connectToTtyd(project), RECONNECT_DELAY);
        }
        return;
    }

    const port = config.port;

    let token = '';
    try {
        const resp = await fetch(`http://127.0.0.1:${port}/t/${project}/token`);
        if (resp.ok) {
            const data = await resp.json();
            token = data.token || '';
        }
    } catch (e) {}

    const wsUrl = `ws://127.0.0.1:${port}/t/${project}/ws`;
    let ws;
    try {
        ws = new WebSocket(wsUrl, ['tty']);
    } catch (e) {
        console.log(`[${project}] Failed to create WebSocket: ${e.message}`);
        session.connecting = false;
        if (session.browsers.size > 0) {
            setTimeout(() => connectToTtyd(project), RECONNECT_DELAY);
        }
        return;
    }

    ws.binaryType = 'arraybuffer';

    ws.on('open', () => {
        console.log(`[${project}] Connected to ttyd :${port}`);
        session.ttydWs = ws;
        session.connecting = false;

        ws.send(JSON.stringify({
            AuthToken: token,
            columns: session.cols,
            rows: session.rows,
        }));

        // `-c` exits with "No conversation found to continue" on a project that
        // has no history yet, dumping the user back to a bare shell. Fall back
        // to a fresh session so a first-time project still lands in Claude.
        const LAUNCH = 'claude -c --dangerously-skip-permissions || claude --dangerously-skip-permissions';

        if (!session.activated) {
            setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    sendToTtyd(project, LAUNCH + '\r');
                    session.activated = true;
                    console.log(`[${project}] Sent launch command`);
                }
            }, 1500);
        }
    });

    ws.on('message', (data) => {
        const buf = Buffer.from(data);
        if (buf.length < 1) return;
        const cmd = buf[0];

        if (cmd === 0x30) {
            const output = buf.slice(1);
            session.buffer = Buffer.concat([session.buffer, output]);
            if (session.buffer.length > BUFFER_SIZE) {
                session.buffer = session.buffer.slice(session.buffer.length - BUFFER_SIZE);
            }
        }

        for (const browser of session.browsers) {
            if (browser.readyState === WebSocket.OPEN) {
                browser.send(buf);
            }
        }
    });

    ws.on('close', () => {
        session.ttydWs = null;
        session.connecting = false;
        // NOTE: do NOT clear session.activated here. ttyd-relay ws can drop
        // without the ttyd process dying; re-injecting claude -c would write
        // it into the live claude REPL as user input. activated resets only
        // when ttyd itself is respawned (see ensureTtyd).
        if (session.browsers.size > 0) {
            console.log(`[${project}] ttyd disconnected, reconnecting (${session.browsers.size} browsers)...`);
            setTimeout(() => connectToTtyd(project), RECONNECT_DELAY);
        } else {
            console.log(`[${project}] ttyd disconnected, no browsers, idle.`);
        }
    });

    ws.on('error', (e) => {
        console.log(`[${project}] ttyd error: ${e.message}`);
        session.connecting = false;
    });
}

function sendToTtyd(project, data) {
    const session = getSession(project);
    if (!session.ttydWs || session.ttydWs.readyState !== WebSocket.OPEN) return false;
    const encoder = new TextEncoder();
    session.ttydWs.send(encoder.encode('0' + data));
    return true;
}

const server = http.createServer((req, res) => {
    if (req.url === '/api/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end('{"ok":true}');
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('relay-server running');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const parsed = url.parse(req.url);
    const match = parsed.pathname.match(/^\/claude\/([^/]+)\/ws$/);
    if (!match || !PROJECTS[match[1]]) {
        ws.close(4000, 'Invalid project');
        return;
    }

    const project = match[1];
    const session = getSession(project);
    const xff = req.headers['x-forwarded-for'] || '';
    const realIp = req.headers['x-real-ip'] || '';
    const clientIp = (xff.split(',')[0] || realIp || req.socket.remoteAddress || '?').trim();
    ws.clientIp = clientIp;
    console.log(`[${project}] Browser connected (total: ${session.browsers.size + 1}) ip=${clientIp}`);

    let authReceived = false;

    ws.on('message', (data) => {
        const buf = Buffer.from(data);

        if (!authReceived) {
            try {
                const str = buf.toString('utf8');
                if (str.startsWith('{')) {
                    authReceived = true;
                    const auth = JSON.parse(str);

                    const pwd = (auth.password || '').toLowerCase();
                    const isAdmin = pwd === ADMIN_PASSWORD.toLowerCase();
                    const ownPwd = (PROJECTS[project].password || '').toLowerCase();
                    const isOwnPwdAuth = ownPwd !== '' && pwd === ownPwd;
                    const authorized = isAdmin || isOwnPwdAuth;

                    // Must be clientIp, not req.socket.remoteAddress: every
                    // request arrives through the frp tunnel, so the socket
                    // address is always 127.0.0.1 — one person fat-fingering
                    // their password five times would lock out everybody.
                    const ip = clientIp;
                    const fails = failedAttempts[ip];
                    if (fails && fails.count >= MAX_FAILS && Date.now() - fails.lastFail < LOCKOUT_MS) {
                        console.log(`[${project}] IP ${ip} locked out`);
                        ws.close(4001, 'Too many attempts');
                        return;
                    }

                    if (!authorized) {
                        console.log(`[${project}] Auth failed from ${ip}`);
                        if (!failedAttempts[ip]) failedAttempts[ip] = { count: 0, lastFail: 0 };
                        failedAttempts[ip].count++;
                        failedAttempts[ip].lastFail = Date.now();
                        ws.close(4001, 'Auth failed');
                        return;
                    }

                    if (failedAttempts[ip]) delete failedAttempts[ip];

                    if (auth.columns) session.cols = auth.columns;
                    if (auth.rows) session.rows = auth.rows;

                    ws.send(Buffer.from([0x30]));

                    if (session.buffer.length > 0) {
                        const header = Buffer.from([0x30]);
                        ws.send(Buffer.concat([header, session.buffer]));
                    }

                    connectToTtyd(project);
                    return;
                }
            } catch (e) {}
            authReceived = true;
        }

        if (buf.length >= 1 && buf[0] === 0x32) {
            session.buffer = Buffer.alloc(0);
            console.log(`[${project}] Buffer cleared by browser`);
            return;
        }

        if (session.ttydWs && session.ttydWs.readyState === WebSocket.OPEN) {
            session.ttydWs.send(buf);
        }
    });

    session.browsers.add(ws);

    ws.missedPongs = 0;
    ws.connectedAt = Date.now();
    ws.on('pong', () => { ws.missedPongs = 0; });

    ws.on('close', (code, reason) => {
        const alive = ((Date.now() - ws.connectedAt) / 1000).toFixed(0);
        session.browsers.delete(ws);
        console.log(`[${project}] Browser disconnected (remaining: ${session.browsers.size}) lived=${alive}s code=${code} ip=${ws.clientIp} reason=${reason && reason.toString().slice(0,80)}`);
    });

    ws.on('error', (e) => {
        session.browsers.delete(ws);
        console.log(`[${project}] Browser error: ${e.message}`);
    });
});

// Keep-alive: every 20s send an application-data byte (cmd '4' / 0x34) on each
// open ws. Client ignores it (only cmd '0' is rendered) but every middlebox in
// the path (Cloudflare, frps user-conn, NAT) sees real traffic and resets its
// idle timer. WebSocket PING/PONG control frames are NOT used because Cloudflare
// (and possibly frps) doesn't reliably forward PONG back, which made server
// pong-counting wrongly terminate healthy connections. TCP-layer death of a
// real disconnect still surfaces as ws.onclose naturally — no manual cleanup
// needed.
const APP_KEEPALIVE = Buffer.from([0x34]);
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(APP_KEEPALIVE); } catch (e) {}
        }
    });
}, 20000);

server.listen(PORT, '127.0.0.1', () => {
    console.log(`Relay server on http://127.0.0.1:${PORT}`);
});
