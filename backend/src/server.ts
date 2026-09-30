import express from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { database } from './db/index.js';
import { authMiddleware, optionalAuthMiddleware, AuthenticatedRequest } from './middleware/auth.js';
import { helmetConfig, corsConfig, apiRateLimiter, uploadRateLimiter } from './middleware/security.js';
import { normalizeUrl, getGameRoot, validateGamePath, listFilesInDir } from './utils/path.js';
import { handleUploadFile, handleLocalSync } from './services/sync.js';
import { analyzeFilesAI, checkModelStatus, fetchModels } from './services/ollama.js';
import { getHLTBTimes, bulkFetchHLTB } from './services/hltb.js';
import { searchArt, autoMatchAll } from './services/steamGridDB.js';
import { recordPlaytimeSession, getPlaytimeSummary, getRecentSessions, getTotalPlaytime } from './services/playtime.js';
import { upsertAchievements, getGameAchievements, getAchievementSummary, getRecentUnlocks, handleSentinelWebhook } from './services/achievements.js';
import { triggerRemoteSync } from './services/remoteSync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(helmetConfig);
app.use(corsConfig);
app.use(express.json({ limit: '10mb' }));
app.use(apiRateLimiter);
app.use(optionalAuthMiddleware);

const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(FRONTEND_DIR)) {
  app.use(express.static(FRONTEND_DIR));
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/saves', authMiddleware, (_req, res) => {
  try {
    const games = database.getGames();
    res.json({ success: true, games });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/list-files', authMiddleware, (req, res) => {
  try {
    const { game } = req.query;
    if (!game) return res.status(400).json({ success: false, message: 'Game required' });

    const gameName = path.basename(game.toString());
    const gameDir = getGameRoot(gameName);
    
    if (!fs.existsSync(gameDir)) return res.json({ success: true, files: [] });

    const files = listFilesInDir(gameDir);
    res.json({ success: true, files });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.post('/api/upload-file', authMiddleware, uploadRateLimiter, async (req: AuthenticatedRequest, res) => {
  try {
    const game = req.headers['x-game'] as string;
    const filePath = req.headers['x-path'] as string;
    const syncId = (req.headers['x-sync-id'] as string) || Date.now().toString();

    if (!game || !filePath) {
      return res.status(400).json({ success: false, message: 'Game and path headers required' });
    }

    const result = await handleUploadFile(game, filePath, req, syncId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.post('/api/local-sync', authMiddleware, async (_req, res) => {
  try {
    const result = await handleLocalSync();
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/versions', authMiddleware, (req, res) => {
  try {
    const { game } = req.query;
    if (!game) return res.status(400).json({ success: false, message: 'Game required' });

    const gameName = path.basename(game.toString());
    const versionsRoot = path.join(getGameRoot(gameName), '.versions');
    
    if (!fs.existsSync(versionsRoot)) return res.json({ success: true, versions: [] });

    const folders = fs.readdirSync(versionsRoot).filter(f => !isNaN(Number(f)));
    const versions = folders.map(f => ({
      id: f,
      timestamp: new Date(parseInt(f)).toISOString()
    })).sort((a, b) => parseInt(b.id) - parseInt(a.id));

    res.json({ success: true, versions });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/version-files', authMiddleware, (req, res) => {
  try {
    const { game, versionId } = req.query;
    if (!game || !versionId) return res.status(400).json({ success: false, message: 'Game and versionId required' });

    const gameName = path.basename(game.toString());
    const versionDir = path.join(getGameRoot(gameName), '.versions', versionId.toString());
    
    if (!fs.existsSync(versionDir)) return res.json({ success: true, files: [] });

    const files = listFilesInDir(versionDir);
    res.json({ success: true, files });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/download-version-file', authMiddleware, (req, res) => {
  try {
    const { game, versionId, path: filePath } = req.query;
    if (!game || !versionId || !filePath) return res.status(400).json({ success: false, message: 'Missing params' });

    const gameName = path.basename(game.toString());
    const safePath = filePath.toString().replace(/\.\.[\\/]/g, '');
    const fullPath = path.join(getGameRoot(gameName), '.versions', versionId.toString(), safePath);

    if (!fs.existsSync(fullPath)) return res.status(404).json({ success: false, message: 'File not found' });
    res.download(fullPath);
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/download-file', authMiddleware, (req, res) => {
  try {
    const { game, path: filePath } = req.query;
    if (!game || !filePath) return res.status(400).json({ success: false, message: 'Game and path required' });

    const gameName = path.basename(game.toString());
    const safePath = filePath.toString().replace(/\.\.[\\/]/g, '');
    const fullPath = path.join(getGameRoot(gameName), safePath);

    if (!fs.existsSync(fullPath)) return res.status(404).json({ success: false, message: 'File not found' });
    res.download(fullPath);
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.delete('/api/games/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const games = database.getGames();
    const game = games.find((g: { id: number }) => g.id.toString() === id);
    
    if (!game) return res.status(404).json({ success: false, message: 'Game not found' });

    const gameRoot = getGameRoot(game.name);
    if (fs.existsSync(gameRoot)) {
      fs.rmSync(gameRoot, { recursive: true, force: true });
    }

    const deleted = database.deleteGame(Number(id));
    if (deleted) {
      res.json({ success: true, message: `Deleted ${game.name}` });
    } else {
      res.status(404).json({ success: false, message: 'Game not found' });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.delete('/api/versions/:game/:versionId', authMiddleware, (req, res) => {
  try {
    const { game, versionId } = req.params;
    const gameName = path.basename(game);
    
    if (versionId.includes('..') || versionId.includes('/') || versionId.includes('\\')) {
      return res.status(400).json({ success: false, message: 'Invalid version ID' });
    }

    const versionDir = path.join(getGameRoot(gameName), '.versions', versionId);
    if (fs.existsSync(versionDir)) {
      fs.rmSync(versionDir, { recursive: true, force: true });
      res.json({ success: true, message: 'Version purged' });
    } else {
      res.status(404).json({ success: false, message: 'Version not found' });
    }
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.post('/api/update-thumbnail', authMiddleware, (req, res) => {
  try {
    const { gameName, url } = req.body;
    if (!gameName || !url) return res.status(400).json({ success: false, message: 'Game name and URL required' });

    const games = database.getGames();
    const game = games.find((g: { name: string }) => g.name === gameName);
    if (!game) return res.status(404).json({ success: false, message: 'Game not found' });

    game.thumbnail = url;
    database.upsertGame(game);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/search-art', authMiddleware, async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) return res.status(400).json({ success: false, message: 'Query required' });

    const settings = database.getSettings();
    const apiKey = settings.steamGridApiKey;
    if (!apiKey) return res.status(401).json({ success: false, message: 'SteamGridDB API key not configured' });

    const result = await searchArt(apiKey, query.toString());
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/auto-match-all', authMiddleware, async (req, res) => {
  try {
    const settings = database.getSettings();
    const apiKey = settings.steamGridApiKey;
    if (!apiKey) return res.status(401).json({ success: false, message: 'SteamGridDB key required' });

    const games = database.getGames();
    const count = await autoMatchAll(apiKey, games);
    res.json({ success: true, count });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.post('/api/analyze-files-ai', authMiddleware, async (req, res) => {
  try {
    const { gameName, files } = req.body;
    if (!gameName || !files || !Array.isArray(files)) {
      return res.status(400).json({ success: false, message: 'Game name and files array required' });
    }

    const settings = database.getSettings();
    const endpoint = settings.ollamaEndpoint || 'http://ollama:11434';
    const model = settings.ollamaModel || 'phi4-mini:latest';

    const result = await analyzeFilesAI(endpoint, model, gameName, files);

    if (result.success && result.analysis) {
      const games = database.getGames();
      const gameIdx = games.findIndex((g: { name: string }) => g.name.toLowerCase() === gameName.toLowerCase());
      if (gameIdx !== -1) {
        games[gameIdx].analysis = result.analysis;
        database.upsertGame(games[gameIdx]);
      }
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/ollama-health', authMiddleware, async (req, res) => {
  try {
    const settings = database.getSettings();
    const endpoint = settings.ollamaEndpoint || 'http://ollama:11434';
    const model = settings.ollamaModel || 'phi4-mini:latest';
    const result = await checkModelStatus(endpoint, model);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/ollama-models', authMiddleware, async (req, res) => {
  try {
    const { endpoint } = req.query;
    if (!endpoint) return res.status(400).json({ success: false, message: 'Endpoint required' });

    const result = await fetchModels(endpoint.toString());
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/hltb/:gameName', authMiddleware, async (req, res) => {
  try {
    const { gameName } = req.params;
    const result = await getHLTBTimes(decodeURIComponent(gameName));
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.post('/api/hltb/bulk', authMiddleware, async (req, res) => {
  try {
    const { gameNames } = req.body;
    if (!gameNames || !Array.isArray(gameNames)) {
      return res.status(400).json({ success: false, message: 'gameNames array required' });
    }

    const results = await bulkFetchHLTB(gameNames);
    const formatted = Object.fromEntries(results);
    res.json({ success: true, times: formatted });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.post('/api/playtime', authMiddleware, (req, res) => {
  try {
    const { game, platform, sessionStart, sessionEnd } = req.body;
    if (!game || !platform || !sessionStart || !sessionEnd) {
      return res.status(400).json({ success: false, message: 'game, platform, sessionStart, sessionEnd required' });
    }

    const result = recordPlaytimeSession(game, platform, sessionStart, sessionEnd);
    if (result.success) {
      res.json({ success: true });
    } else {
      res.status(400).json(result);
    }
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/playtime', authMiddleware, (req, res) => {
  try {
    const { game } = req.query;
    const summary = getPlaytimeSummary(game as string);
    res.json({ success: true, summary });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/playtime/recent', authMiddleware, (req, res) => {
  try {
    const { limit } = req.query;
    const sessions = getRecentSessions(limit ? parseInt(limit as string) : 50);
    res.json({ success: true, sessions });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/playtime/total', authMiddleware, (_req, res) => {
  try {
    const total = getTotalPlaytime();
    res.json({ success: true, totalMinutes: total });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.post('/api/achievements/webhook', authMiddleware, (req, res) => {
  try {
    const { game, achievements } = req.body;
    if (!game || !achievements || !Array.isArray(achievements)) {
      return res.status(400).json({ success: false, message: 'game and achievements array required' });
    }

    const result = handleSentinelWebhook(game, achievements);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/achievements/:game', authMiddleware, (req, res) => {
  try {
    const { game } = req.params;
    const achievements = getGameAchievements(decodeURIComponent(game));
    res.json({ success: true, achievements });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/achievements', authMiddleware, (req, res) => {
  try {
    const { game } = req.query;
    const summary = getAchievementSummary(game as string);
    res.json({ success: true, summary });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/achievements/recent', authMiddleware, (req, res) => {
  try {
    const { limit } = req.query;
    const unlocks = getRecentUnlocks(limit ? parseInt(limit as string) : 20);
    res.json({ success: true, unlocks });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/settings', authMiddleware, (_req, res) => {
  try {
    const settings = database.getSettings();
    const safeSettings = { ...settings, apiKeys: settings.apiKeys.map(() => '****') };
    res.json({ success: true, settings: safeSettings });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.post('/api/settings', authMiddleware, (req, res) => {
  try {
    const { settings } = req.body;
    if (!settings) return res.status(400).json({ success: false, message: 'Settings required' });

    const current = database.getSettings();
    const merged = { ...current, ...settings };
    
    if (settings.apiKeys) {
      for (const key of current.apiKeys) {
        database.removeApiKey(key);
      }
      for (const key of settings.apiKeys) {
        database.addApiKey(key);
      }
    }
    
    database.saveSettings(merged);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/local-sources', authMiddleware, (_req, res) => {
  try {
    const sources = database.getLocalSources();
    res.json({ success: true, sources });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.post('/api/local-sources', authMiddleware, (req, res) => {
  try {
    const { path: sourcePath } = req.body;
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return res.status(400).json({ success: false, message: 'Valid path required' });
    }

    const source = database.addLocalSource(sourcePath);
    res.json({ success: true, source });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.delete('/api/local-sources/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const deleted = database.removeLocalSource(Number(id));
    res.json({ success: deleted });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/remote-servers', authMiddleware, (_req, res) => {
  try {
    const servers = database.getRemoteServers();
    res.json({ success: true, servers });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.post('/api/remote-servers', authMiddleware, (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !url.startsWith('http')) {
      return res.status(400).json({ success: false, message: 'Valid HTTP URL required' });
    }

    const server = database.addRemoteServer(url);
    res.json({ success: true, server });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.delete('/api/remote-servers/:id', authMiddleware, (req, res) => {
  try {
    const { id } = req.params;
    const deleted = database.removeRemoteServer(Number(id));
    res.json({ success: deleted });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.get('/api/api-keys', authMiddleware, (_req, res) => {
  try {
    const keys = database.getApiKeys().map(k => k.replace(/./g, '*'));
    res.json({ success: true, keys });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.post('/api/api-keys', authMiddleware, (req, res) => {
  try {
    const { key, description } = req.body;
    if (!key) return res.status(400).json({ success: false, message: 'Key required' });
    
    database.addApiKey(key, description);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

app.delete('/api/api-keys/:key', authMiddleware, (req, res) => {
  try {
    const { key } = req.params;
    const deleted = database.removeApiKey(key);
    res.json({ success: deleted });
  } catch (e) {
    res.status(500).json({ success: false, message: String(e) });
  }
});

if (fs.existsSync(FRONTEND_DIR)) {
  app.get('*', (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  });
}

const PORT = parseInt(process.env.PORT || '3030', 10);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Dune Server] Listening on port ${PORT}`);
  console.log(`[Dune Server] Frontend: ${fs.existsSync(FRONTEND_DIR) ? 'served' : 'not built'}`);
  console.log(`[Dune Server] Data dir: ${path.join(process.cwd(), 'data')}`);
});
