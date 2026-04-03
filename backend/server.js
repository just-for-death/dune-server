import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { analyzeFilesAI, checkModelStatus } from './ollama_utils.js';
import { findSaveFolders, syncLocalFolder } from './local_scanner.js';

const execFileAsync = promisify(execFile);

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Persistent storage directories mapped into Docker
const DATA_DIR = path.join(process.cwd(), 'data');
const SAVES_DIR = path.join(DATA_DIR, 'saves');
const DB_PATH = path.join(DATA_DIR, 'db.json');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(SAVES_DIR)) fs.mkdirSync(SAVES_DIR, { recursive: true });

// ─── In-Memory DB Cache ───────────────────────────────────────────────────────
// Reading db.json from disk on every API request is wasteful.
// We cache the parsed object and invalidate it on every write.
let _dbCache = null;

function getDB() {
    if (_dbCache) return _dbCache;
    _dbCache = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    return _dbCache;
}

function saveDB(data) {
    _dbCache = data; // update cache first
    const tmpPath = DB_PATH + '.tmp';
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
        fs.renameSync(tmpPath, DB_PATH);
    } catch (e) {
        console.error('Failed to save DB atomically:', e);
        fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
    }
}
// ─────────────────────────────────────────────────────────────────────────────

// Setup DB — only runs once at startup, populates missing fields
if (!fs.existsSync(DB_PATH)) {
    saveDB({
        games: [],
        settings: {
            maxVersions: 10,
            steamGridApiKey: '',
            ollamaEndpoint: 'http://ollama:11434',
            ollamaModel: 'phi4-mini:latest',
            localSources: []
        }
    });
} else {
    const db = getDB();
    let changed = false;

    if (!db.settings) {
        db.settings = {
            maxVersions: 10,
            steamGridApiKey: '',
            ollamaEndpoint: 'http://ollama:11434',
            ollamaModel: 'phi4-mini:latest',
            localSources: []
        };
        changed = true;
    }
    // Patch individual missing fields
    const defaults = {
        ollamaEndpoint: 'http://ollama:11434',
        ollamaModel: 'phi4-mini:latest',
        localSources: []
    };
    for (const [key, val] of Object.entries(defaults)) {
        if (db.settings[key] === undefined) {
            db.settings[key] = val;
            changed = true;
        }
    }
    if (changed) saveDB(db);
}

function getFileCategory(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath).toLowerCase();
    const dirName = path.dirname(filePath).toLowerCase();

    if (dirName.includes('cache') || fileName.includes('cache') || ext === '.tmp' || ext === '.log') {
        return 'Cache';
    }
    if (ext === '.ini' || ext === '.cfg' || ext === '.xml' || ext === '.json' || ext === '.yaml' || ext === '.yml') {
        return 'Config';
    }
    if (ext === '.sav' || ext === '.bin' || ext === '.dat' || fileName.includes('save') || fileName.includes('prof')) {
        return 'Save';
    }
    return 'Other';
}

function getFileMetadata(root, relPath) {
    try {
        const fullPath = path.join(root, relPath);
        if (!fs.existsSync(fullPath)) return null;
        const stats = fs.statSync(fullPath);
        return {
            path: relPath,
            name: path.basename(relPath),
            size: stats.size,
            modified: stats.mtime.toISOString(),
            category: getFileCategory(relPath)
        };
    } catch (e) {
        return null;
    }
}

// API: Receive an individual save file (Streaming support)
app.post('/api/upload-file', (req, res) => {
    try {
        const game = req.headers['x-game'];
        const filePath = req.headers['x-path'];

        if (!game || !filePath) return res.status(400).json({ success: false, message: 'Game and path headers required.' });

        const gameName = path.basename(game.toString());
        const safePath = filePath.toString().replace(/\.\.[\\/]/g, '');
        const gameRoot = path.join(SAVES_DIR, gameName);
        const finalPath = path.join(gameRoot, safePath);
        const finalDir = path.dirname(finalPath);

        if (!fs.existsSync(finalDir)) fs.mkdirSync(finalDir, { recursive: true });

        // Versioning: If file exists, archive it before overwriting
        if (fs.existsSync(finalPath)) {
            const syncId = req.headers['x-sync-id'] || fs.statSync(finalPath).mtime.getTime().toString();
            const versionDir = path.join(gameRoot, '.versions', syncId);
            const archivePath = path.join(versionDir, safePath);

            if (!fs.existsSync(path.dirname(archivePath))) {
                fs.mkdirSync(path.dirname(archivePath), { recursive: true });
            }
            fs.copyFileSync(finalPath, archivePath);

            // Cleanup: Keep only maxVersions most recent versions
            const db = getDB();
            const maxVersions = db.settings?.maxVersions || 10;
            const versionsRoot = path.join(gameRoot, '.versions');
            const versions = fs.readdirSync(versionsRoot)
                .filter(v => !isNaN(Number(v)))
                .sort((a, b) => Number(b) - Number(a));

            if (versions.length > maxVersions) {
                versions.slice(maxVersions).forEach(v => {
                    fs.rmSync(path.join(versionsRoot, v), { recursive: true, force: true });
                });
            }
        }

        const writer = fs.createWriteStream(finalPath);
        req.pipe(writer);

        req.on('error', (err) => {
            writer.destroy();
            res.status(500).json({ success: false, message: 'Stream error: ' + err.message });
        });

        writer.on('finish', async () => {
            const db = getDB();
            // Use ISO timestamp for consistent, sortable date storage
            const timestampStr = new Date().toISOString();
            const gameEntry = db.games.find(g => g.name.toLowerCase() === gameName.toLowerCase());

            // AUTOMATIC EXTRACTION: If we uploaded a saves.zip, extract it immediately
            if (safePath === 'saves.zip') {
                try {
                    const tempExtractDir = path.join(gameRoot, '_extract_tmp');
                    if (fs.existsSync(tempExtractDir)) fs.rmSync(tempExtractDir, { recursive: true });
                    fs.mkdirSync(tempExtractDir, { recursive: true });

                    // Use execFile safely without shell interpretation to completely prevent Command Injection vulnerabilities via x-game / filename
                    await execFileAsync('unzip', ['-o', finalPath, '-d', tempExtractDir]);
                    await fs.promises.cp(tempExtractDir, gameRoot, { recursive: true });

                    fs.rmSync(tempExtractDir, { recursive: true });
                    fs.unlinkSync(finalPath); // Remove zip after extraction
                } catch (err) {
                    console.error('Failed to extract saves.zip:', err.message);
                }
            }

            if (gameEntry) {
                gameEntry.status = 'In Sync';
                gameEntry.lastSync = timestampStr;
            } else {
                db.games.push({
                    id: Date.now() + Math.random(),
                    name: gameName,
                    status: 'In Sync',
                    lastSync: timestampStr,
                    thumbnail: ''
                });
            }
            saveDB(db);
            res.json({ success: true, message: `Uploaded and processed ${gameName} saves.` });
        });

        writer.on('error', (err) => {
            res.status(500).json({ success: false, message: err.message });
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// API: Set game thumbnail
app.post('/api/update-thumbnail', (req, res) => {
    try {
        const { gameName, url } = req.body;
        if (!gameName || !url) return res.status(400).json({ success: false });
        const db = getDB();
        const game = db.games.find(g => g.name === gameName);
        if (game) {
            game.thumbnail = url;
            saveDB(db);
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, message: 'Game not found.' });
        }
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// API: List versions for a game
app.get('/api/versions', (req, res) => {
    try {
        const { game } = req.query;
        if (!game) return res.status(400).json({ success: false });
        const gameName = path.basename(game.toString());
        const versionsRoot = path.join(SAVES_DIR, gameName, '.versions');
        if (!fs.existsSync(versionsRoot)) return res.json({ success: true, versions: [] });

        const folders = fs.readdirSync(versionsRoot).filter(f => !isNaN(Number(f)));
        const versions = folders.map(f => ({
            id: f,
            timestamp: new Date(parseInt(f)).toISOString()
        })).sort((a, b) => parseInt(b.id) - parseInt(a.id));

        res.json({ success: true, versions });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// API: List files in a specific version
app.get('/api/version-files', (req, res) => {
    try {
        const { game, versionId } = req.query;
        if (!game || !versionId) return res.status(400).json({ success: false });
        const gameName = path.basename(game.toString());
        const versionDir = path.join(SAVES_DIR, gameName, '.versions', versionId.toString());
        if (!fs.existsSync(versionDir)) return res.json({ success: true, files: [] });

        const files = [];
        const walk = (dir) => {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const fullPath = path.join(dir, item);
                const lstats = fs.lstatSync(fullPath);
                if (lstats.isSymbolicLink()) continue;
                if (lstats.isDirectory()) {
                    walk(fullPath);
                } else {
                    const rel = path.relative(versionDir, fullPath);
                    const metadata = getFileMetadata(versionDir, rel);
                    if (metadata) files.push(metadata);
                }
            }
        };
        walk(versionDir);
        res.json({ success: true, files: files.filter(f => f !== null) });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// API: Download versioned file
app.get('/api/download-version-file', (req, res) => {
    try {
        const { game, versionId, path: filePath } = req.query;
        if (!game || !versionId || !filePath) return res.status(400).json({ success: false });

        const versionRoot = path.join(SAVES_DIR, game.toString(), '.versions', versionId.toString());
        const safePath = filePath.toString().replace(/\.\.[\\/]/g, '');
        const fullPath = path.join(versionRoot, safePath);

        if (!fs.existsSync(fullPath)) return res.status(404).json({ success: false, message: 'Version file not found.' });
        res.download(fullPath);
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// API: Dashboard List Saves
app.get('/api/saves', (req, res) => {
    try {
        const db = getDB();
        res.json({ success: true, games: db.games });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// API: List files for a specific game
app.get('/api/list-files', (req, res) => {
    try {
        const { game } = req.query;
        if (!game) return res.status(400).json({ success: false, message: 'Game required.' });

        const gameName = path.basename(game.toString());
        const gameDir = path.join(SAVES_DIR, gameName);
        if (!fs.existsSync(gameDir)) return res.json({ success: true, files: [] });

        const files = [];
        const walk = (dir) => {
            const items = fs.readdirSync(dir);
            for (const item of items) {
                const fullPath = path.join(dir, item);
                if (item === '.versions') continue;
                const lstats = fs.lstatSync(fullPath);
                if (lstats.isSymbolicLink()) continue;
                if (lstats.isDirectory()) {
                    walk(fullPath);
                } else {
                    const rel = path.relative(gameDir, fullPath);
                    const metadata = getFileMetadata(gameDir, rel);
                    if (metadata) files.push(metadata);
                }
            }
        };
        walk(gameDir);
        res.json({ success: true, files: files.filter(f => f !== null) });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// API: AI File Analysis (Ollama)
app.post('/api/analyze-files-ai', async (req, res) => {
    try {
        const { gameName, files } = req.body;
        if (!gameName || !files || !Array.isArray(files)) {
            return res.status(400).json({ success: false, message: 'Game name and files array required.' });
        }

        const db = getDB();
        const endpoint = db.settings?.ollamaEndpoint || 'http://ollama:11434';
        const model = db.settings?.ollamaModel || 'phi4-mini:latest';

        const result = await analyzeFilesAI(endpoint, model, gameName, files);

        if (result.success) {
            const gameIdx = db.games.findIndex(g => g.name.toLowerCase() === gameName.toLowerCase());
            if (gameIdx !== -1) {
                db.games[gameIdx].analysis = result.analysis;
                saveDB(db);
            }
            res.json({ success: true, analysis: result.analysis });
        } else {
            res.status(500).json({ success: false, message: 'Ollama analysis failed: ' + result.message });
        }
    } catch (e) {
        console.error('Ollama API Error:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

// API: Check Ollama Model Health
app.get('/api/ollama-health', async (req, res) => {
    try {
        const db = getDB();
        const endpoint = db.settings?.ollamaEndpoint || 'http://ollama:11434';
        const model = db.settings?.ollamaModel || 'phi4-mini:latest';
        const result = await checkModelStatus(endpoint, model);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// API: Trigger Local Sync from Windows Mounted Drive
app.post('/api/local-sync', async (req, res) => {
    try {
        const db = getDB();
        const sources = db.settings?.localSources || [];
        const maxVersions = db.settings?.maxVersions || 10;
        let totalFilesSynced = 0;
        let syncedGames = [];

        for (const source of sources) {
            if (!fs.existsSync(source.path)) continue;

            const gamesInSource = findSaveFolders(source.path, 1);
            for (const gamePath of gamesInSource) {
                const gameName = path.basename(gamePath);
                const result = syncLocalFolder(gamePath, gameName, SAVES_DIR, maxVersions);

                if (result.filesSynced > 0) {
                    totalFilesSynced += result.filesSynced;
                    syncedGames.push(gameName);

                    const gEntry = db.games.find(g => g.name.toLowerCase() === gameName.toLowerCase());
                    const ts = new Date().toISOString();
                    if (gEntry) {
                        gEntry.status = 'In Sync';
                        gEntry.lastSync = ts;
                    } else {
                        db.games.push({
                            id: Date.now() + Math.random(),
                            name: gameName,
                            status: 'In Sync',
                            lastSync: ts,
                            thumbnail: ''
                        });
                    }
                }
            }
        }

        if (syncedGames.length > 0) saveDB(db);
        res.json({ success: true, count: totalFilesSynced, games: syncedGames });
    } catch (e) {
        console.error('Local Sync Error:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

// API: Manage Local Sources
app.get('/api/local-sources', (req, res) => {
    try {
        const db = getDB();
        res.json({ success: true, sources: db.settings?.localSources || [] });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/local-sources', (req, res) => {
    try {
        const { path: sourcePath } = req.body;
        if (!sourcePath || !fs.existsSync(sourcePath)) {
            return res.status(400).json({ success: false, message: 'Valid path required.' });
        }

        const db = getDB();
        if (!db.settings.localSources) db.settings.localSources = [];
        if (db.settings.localSources.some(s => s.path === sourcePath)) {
            return res.status(400).json({ success: false, message: 'Source already exists.' });
        }

        db.settings.localSources.push({ id: Date.now(), path: sourcePath });
        saveDB(db);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.delete('/api/local-sources/:id', (req, res) => {
    try {
        const { id } = req.params;
        const db = getDB();
        db.settings.localSources = (db.settings.localSources || []).filter(s => s.id.toString() !== id);
        saveDB(db);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// API: Fetch available Ollama models
app.get('/api/ollama-models', async (req, res) => {
    try {
        const { endpoint } = req.query;
        if (!endpoint) return res.status(400).json({ success: false, message: 'Endpoint required.' });

        const response = await axios.get(`${endpoint}/api/tags`, { timeout: 5000 });
        const models = response.data.models?.map(m => m.name) || [];
        res.json({ success: true, models });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Failed to fetch models: ' + e.message });
    }
});

// API: Get Settings
app.get('/api/settings', (req, res) => {
    try {
        const db = getDB();
        res.json({ success: true, settings: db.settings });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// API: Save Settings
app.post('/api/settings', (req, res) => {
    try {
        const { settings } = req.body;
        if (!settings) return res.status(400).json({ success: false });
        const db = getDB();
        db.settings = { ...db.settings, ...settings };
        saveDB(db);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// API: Search SteamGridDB Proxy
app.get('/api/search-art', async (req, res) => {
    try {
        const { query } = req.query;
        if (!query) return res.status(400).json({ success: false });

        const db = getDB();
        const apiKey = db.settings?.steamGridApiKey;
        if (!apiKey) return res.status(401).json({ success: false, message: 'SteamGridDB API Key not configured.' });

        const searchRes = await axios.get(
            `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(query.toString())}`,
            { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 10000 }
        );

        if (!searchRes.data.success || searchRes.data.data.length === 0) {
            return res.json({ success: true, results: [] });
        }

        const gameId = searchRes.data.data[0].id;
        const gridsRes = await axios.get(
            `https://www.steamgriddb.com/api/v2/grids/game/${gameId}`,
            { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 10000 }
        );

        const results = gridsRes.data.data.map(g => g.url);
        res.json({ success: true, results });
    } catch (e) {
        const errorDetail = e.response?.data?.errors?.[0] || e.response?.data?.message || e.message;
        console.warn('⚠️ SteamGridDB Proxy:', errorDetail);

        if (e.response?.status === 401) {
            return res.status(401).json({ success: false, message: 'Invalid SteamGridDB API Key.' });
        }
        res.status(500).json({ success: false, message: 'Error searching SteamGridDB. Ensure your API key is correct.' });
    }
});

// API: Bulk Auto-Match All Games
app.get('/api/auto-match-all', async (req, res) => {
    try {
        const db = getDB();
        const apiKey = db.settings?.steamGridApiKey;
        if (!apiKey) return res.status(401).json({ success: false, message: 'SteamGridDB key required.' });

        let matched = 0;
        for (const game of db.games) {
            if (game.thumbnail) continue;
            try {
                const s = await axios.get(
                    `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(game.name)}`,
                    { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 10000 }
                );
                if (s.data.success && s.data.data.length > 0) {
                    const gameId = s.data.data[0].id;
                    const g = await axios.get(
                        `https://www.steamgriddb.com/api/v2/grids/game/${gameId}`,
                        { headers: { 'Authorization': `Bearer ${apiKey}` }, timeout: 10000 }
                    );
                    if (g.data.success && g.data.data.length > 0) {
                        game.thumbnail = g.data.data[0].url;
                        matched++;
                    }
                }
                // Rate-limit spacing
                await new Promise(r => setTimeout(r, 300));
            } catch (innerErr) {
                console.error(`Bulk match failed for ${game.name}:`, innerErr.message);
            }
        }
        saveDB(db);
        res.json({ success: true, count: matched });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// API: Download individual file
app.get('/api/download-file', (req, res) => {
    try {
        const { game, path: filePath } = req.query;
        if (!game || !filePath) return res.status(400).json({ success: false, message: 'Game and path required.' });

        const gameName = path.basename(game.toString());
        const safePath = filePath.toString().replace(/\.\.[\\/]/g, '');
        const fullPath = path.join(SAVES_DIR, gameName, safePath);
        if (!fs.existsSync(fullPath)) return res.status(404).json({ success: false, message: 'File not found.' });

        res.download(fullPath);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// API: Delete Entire Game (and its saves)
app.delete('/api/games/:id', (req, res) => {
    try {
        const { id } = req.params;
        const db = getDB();
        const gameIdx = db.games.findIndex(g => g.id.toString() === id);

        if (gameIdx === -1) return res.status(404).json({ success: false, message: 'Game not found' });

        const gameName = db.games[gameIdx].name;

        if (gameName.includes('..') || gameName.includes('/') || gameName.includes('\\')) {
            return res.status(400).json({ success: false, message: 'Invalid game path for deletion' });
        }

        const gameRoot = path.join(SAVES_DIR, gameName);
        if (fs.existsSync(gameRoot)) {
            fs.rmSync(gameRoot, { recursive: true, force: true });
        }

        db.games.splice(gameIdx, 1);
        saveDB(db);
        res.json({ success: true, message: `Deleted ${gameName}` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// API: Delete Specific Version
app.delete('/api/versions/:game/:versionId', (req, res) => {
    try {
        const { game, versionId } = req.params;
        const gameName = path.basename(game);

        if (versionId.includes('..') || versionId.includes('/') || versionId.includes('\\')) {
            return res.status(400).json({ success: false, message: 'Invalid version ID format' });
        }

        const versionDir = path.join(SAVES_DIR, gameName, '.versions', versionId);
        if (fs.existsSync(versionDir)) {
            fs.rmSync(versionDir, { recursive: true, force: true });
            res.json({ success: true, message: 'Version purged' });
        } else {
            res.status(404).json({ success: false, message: 'Version not found' });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Serve compiled Vite frontend
const FRONTEND_DIR = path.join(process.cwd(), 'frontend', 'dist');
if (fs.existsSync(FRONTEND_DIR)) {
    app.use(express.static(FRONTEND_DIR));
    app.get('*', (req, res) => {
        res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
    });
}

const PORT = process.env.PORT || 3030;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Dune Server listening on port ${PORT}`);
});
