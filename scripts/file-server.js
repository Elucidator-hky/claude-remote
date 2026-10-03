const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 7690;

// Same config/projects.json that relay-server.js and the selection page use.
const PROJECTS_FILE = path.join(__dirname, '..', 'config', 'projects.json');

let PROJECTS = {};

function loadProjects() {
    try {
        PROJECTS = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
        console.log('Projects:', Object.keys(PROJECTS).join(', '));
    } catch (e) {
        console.log('Failed to load projects.json:', e.message);
    }
}

loadProjects();
fs.watchFile(PROJECTS_FILE, { interval: 1500 }, loadProjects);

const HIDDEN = new Set(['.git', 'node_modules', '.next', '__pycache__', '.venv', 'dist', '.claude']);

function getRoot(project) {
    const cfg = PROJECTS[project];
    return cfg ? cfg.path : null;
}

function safe(root, p) {
    const resolved = path.resolve(root, p || '.');
    return resolved.startsWith(root) ? resolved : null;
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
}

const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const q = parsed.query;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (parsed.pathname === '/api/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
    }

    // Drives the selection page. Passwords are deliberately not included —
    // the page only needs to render buttons; relay-server does the auth.
    if (parsed.pathname === '/api/projects') {
        const list = Object.entries(PROJECTS).map(([key, cfg]) => ({
            key,
            name: cfg.name || key,
            path: cfg.path,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
        return;
    }

    const root = getRoot(q.project);
    if (!root) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project' }));
        return;
    }

    try {
        if (parsed.pathname === '/api/list') {
            const target = safe(root, q.path);
            if (!target) { res.writeHead(403); res.end('{}'); return; }

            const entries = await fs.promises.readdir(target, { withFileTypes: true });
            const files = [];
            for (const e of entries) {
                if (HIDDEN.has(e.name)) continue;
                try {
                    const s = await fs.promises.stat(path.join(target, e.name));
                    files.push({
                        name: e.name,
                        isDir: e.isDirectory(),
                        size: s.size,
                        sizeStr: formatSize(s.size),
                        modified: s.mtime.toISOString(),
                    });
                } catch (_) {}
            }
            files.sort((a, b) => a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name));

            const rel = path.relative(root, target) || '.';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ path: rel, files }));

        } else if (parsed.pathname === '/api/download') {
            const target = safe(root, q.path);
            if (!target) { res.writeHead(403); res.end(); return; }

            const s = await fs.promises.stat(target);
            if (s.isDirectory()) { res.writeHead(400); res.end('Cannot download directory'); return; }

            const name = path.basename(target);
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': 'attachment; filename="' + encodeURIComponent(name) + '"',
                'Content-Length': s.size,
            });
            fs.createReadStream(target).pipe(res);

        } else if (parsed.pathname === '/api/upload' && req.method === 'POST') {
            if (!q.name) { res.writeHead(400); res.end('{}'); return; }

            const target = safe(root, path.join(q.path || '.', q.name));
            if (!target) { res.writeHead(403); res.end('{}'); return; }

            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            const ws = fs.createWriteStream(target);
            req.pipe(ws);
            ws.on('finish', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, path: path.relative(root, target) }));
            });
            ws.on('error', (e) => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            });

        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('File server on http://127.0.0.1:' + PORT);
    console.log('Projects:', Object.keys(PROJECTS).join(', '));
});
