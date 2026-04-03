import { useState, useEffect, useCallback } from 'react';
import './index.css';

// ── TypeScript Interfaces ─────────────────────────────────────────────────────
interface Game {
  id: number;
  name: string;
  status: string;
  lastSync: string;
  thumbnail: string;
  analysis?: Record<string, FileAnalysis>;
}

interface GameFile {
  path: string;
  name: string;
  size: number;
  modified: string;
  category: 'Save' | 'Config' | 'Cache' | 'Other';
}

interface Version {
  id: string;
  timestamp: string;
}

interface Settings {
  maxVersions: number;
  steamGridApiKey: string;
  ollamaEndpoint: string;
  ollamaModel: string;
  localSources?: LocalSource[];
}

interface LocalSource {
  id: number;
  path: string;
}

interface Toast {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface FileAnalysis {
  category: 'Save' | 'Config' | 'Cache' | 'Other';
  description: string;
}

interface HealthStatus {
  success: boolean;
  exists?: boolean;
  message?: string;
}
// ─────────────────────────────────────────────────────────────────────────────

type View = 'dashboard' | 'settings';
type TabId = 'files' | 'versions' | 'art';
type ViewMode = 'list' | 'categories';

export default function App() {
  const [saves, setSaves] = useState<Game[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [currentView, setCurrentView] = useState<View>('dashboard');
  const [selectedGame, setSelectedGame] = useState<Game | null>(null);
  // vFiles: cache of version file listings, keyed by "<gameName>_<versionId>"
  const [vFiles, setVFiles] = useState<Record<string, GameFile[]>>({});
  const [activeTab, setActiveTab] = useState<TabId>('files');
  const [fileList, setFileList] = useState<GameFile[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [isBulkMatching, setIsBulkMatching] = useState(false);
  const [analysis, setAnalysis] = useState<Record<string, FileAnalysis>>({});
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('categories');
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);
  const [healthStatus, setHealthStatus] = useState<HealthStatus | null>(null);
  const [isSyncingLocal, setIsSyncingLocal] = useState(false);
  const [localSources, setLocalSources] = useState<LocalSource[]>([]);
  const [newSourcePath, setNewSourcePath] = useState('');
  const [toasts, setToasts] = useState<Toast[]>([]);

  // Settings state
  const [settings, setSettings] = useState<Settings>({
    maxVersions: 10,
    steamGridApiKey: '',
    ollamaEndpoint: 'http://ollama:11434',
    ollamaModel: 'phi4-mini:latest',
  });

  // Art Search state
  const [artQuery, setArtQuery] = useState('');
  const [artResults, setArtResults] = useState<string[]>([]);
  const [isSearchingArt, setIsSearchingArt] = useState(false);
  const [newArtUrl, setNewArtUrl] = useState('');

  useEffect(() => {
    loadSaves();
    loadSettings();
    loadLocalSources();

    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedGame(null);
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, []);

  // ── Data Loaders ────────────────────────────────────────────────────────────

  const loadSaves = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/saves');
      const json = await res.json();
      if (json.success) setSaves(json.games ?? []);
    } catch {
      console.error('Failed to load saves');
    } finally {
      setIsLoading(false);
    }
  };

  const loadSettings = async () => {
    try {
      const res = await fetch('/api/settings');
      const json = await res.json();
      if (json.success) setSettings(json.settings);
    } catch {
      console.error('Failed to load settings');
    }
  };

  const loadLocalSources = async () => {
    try {
      const res = await fetch('/api/local-sources');
      const json = await res.json();
      if (json.success) setLocalSources(json.sources ?? []);
    } catch {
      console.error('Failed to load local sources');
    }
  };

  const loadFiles = async (gameName: string, existingAnalysis?: Record<string, FileAnalysis>) => {
    try {
      const fRes = await fetch(`/api/list-files?game=${encodeURIComponent(gameName)}`);
      const fJson = await fRes.json();
      setFileList(fJson.files ?? []);
      if (existingAnalysis && Object.keys(existingAnalysis).length > 0) {
        setAnalysis(existingAnalysis);
        setViewMode('categories');
      } else {
        setAnalysis({});
        setViewMode('list');
      }
    } catch {
      console.error('Failed to load files');
      setFileList([]);
    }
  };

  const loadVersions = async (gameName: string) => {
    try {
      const vRes = await fetch(`/api/versions?game=${encodeURIComponent(gameName)}`);
      const vJson = await vRes.json();
      setVersions(vJson.versions ?? []);
    } catch {
      console.error('Failed to load versions');
      setVersions([]);
    }
  };

  // ── Toast ────────────────────────────────────────────────────────────────────

  const showToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  // ── Actions ──────────────────────────────────────────────────────────────────

  const saveSettings = async () => {
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
      });
      const json = await res.json();
      if (json.success) showToast('Settings saved!', 'success');
      else showToast('Failed to save settings: ' + (json.message ?? 'Unknown error'), 'error');
    } catch {
      showToast('Network error while saving settings.', 'error');
    }
  };

  const analyzeFilesWithAI = async () => {
    if (!selectedGame) return;
    setIsAnalyzing(true);
    try {
      const relevantFiles = fileList
        .filter(f => f.category !== 'Cache' && f.category !== 'Other')
        .slice(0, 50);

      // Fallback to 'Other' if nothing more specific found
      if (relevantFiles.length === 0) {
        relevantFiles.push(...fileList.filter(f => f.category === 'Other').slice(0, 20));
      }

      if (relevantFiles.length === 0) {
        showToast('No relevant files found to analyze.', 'info');
        return;
      }

      const res = await fetch('/api/analyze-files-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gameName: selectedGame.name,
          files: relevantFiles.map(f => ({ path: f.path, size: f.size, category: f.category })),
        }),
      });
      const json = await res.json();
      if (json.success) {
        setAnalysis(json.analysis);
        setSelectedGame(prev => prev ? { ...prev, analysis: json.analysis } : null);
        showToast('AI analysis complete and saved!', 'success');
        setViewMode('categories');
      } else {
        showToast(json.message ?? 'AI analysis failed', 'error');
      }
    } catch {
      showToast('Could not connect to analysis engine. Check if Ollama is running.', 'error');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const checkOllamaHealth = async () => {
    setIsCheckingHealth(true);
    setHealthStatus(null);
    try {
      const res = await fetch('/api/ollama-health');
      const json = await res.json();
      setHealthStatus(json);
    } catch {
      setHealthStatus({ success: false, message: 'Failed to reach server API' });
    } finally {
      setIsCheckingHealth(false);
    }
  };

  const addLocalSource = async () => {
    if (!newSourcePath) return;
    try {
      const res = await fetch('/api/local-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newSourcePath }),
      });
      const json = await res.json();
      if (json.success) {
        setNewSourcePath('');
        loadLocalSources();
        showToast('Source added successfully', 'success');
      } else {
        showToast(json.message ?? 'Failed to add source', 'error');
      }
    } catch {
      showToast('Error adding source', 'error');
    }
  };

  const removeLocalSource = async (id: number) => {
    try {
      const res = await fetch(`/api/local-sources/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        loadLocalSources();
        showToast('Source removed', 'info');
      }
    } catch {
      showToast('Error removing source', 'error');
    }
  };

  const runLocalSync = async () => {
    setIsSyncingLocal(true);
    try {
      const res = await fetch('/api/local-sync', { method: 'POST' });
      const json = await res.json();
      if (json.success) {
        showToast(`Sync complete — ${json.count} files across ${json.games.length} games.`, 'success');
        loadSaves();
      } else {
        showToast(json.message ?? 'Sync failed', 'error');
      }
    } catch {
      showToast('Network error during sync', 'error');
    } finally {
      setIsSyncingLocal(false);
    }
  };

  const deleteGame = async (e: React.MouseEvent, id: number, name: string) => {
    e.stopPropagation();
    if (!window.confirm(`Permanently delete "${name}" and all its backups? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/games/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.success) {
        showToast(`Deleted "${name}"`, 'info');
        loadSaves();
      } else {
        showToast(json.message ?? 'Delete failed', 'error');
      }
    } catch {
      showToast('Network error during deletion', 'error');
    }
  };

  const deleteVersion = async (versionId: string) => {
    if (!selectedGame || !window.confirm('Delete this backup permanently?')) return;
    try {
      const res = await fetch(
        `/api/versions/${encodeURIComponent(selectedGame.name)}/${versionId}`,
        { method: 'DELETE' }
      );
      const json = await res.json();
      if (json.success) {
        showToast('Backup deleted', 'info');
        loadVersions(selectedGame.name);
      } else {
        showToast(json.message ?? 'Failed to delete version', 'error');
      }
    } catch {
      showToast('Error deleting backup', 'error');
    }
  };

  const fetchOllamaModels = async () => {
    if (!settings.ollamaEndpoint) return showToast('Please enter an Ollama URL first', 'info');
    setIsFetchingModels(true);
    setOllamaModels([]);
    try {
      const res = await fetch(`/api/ollama-models?endpoint=${encodeURIComponent(settings.ollamaEndpoint)}`);
      const json = await res.json();
      if (json.success) {
        setOllamaModels(json.models);
        showToast(`Found ${json.models.length} model(s)`, 'success');
        if (json.models.length > 0 && !json.models.includes(settings.ollamaModel)) {
          setSettings(prev => ({ ...prev, ollamaModel: json.models[0] }));
        }
      } else {
        showToast(json.message ?? 'Failed to fetch models', 'error');
      }
    } catch {
      showToast('Check if Ollama URL is reachable', 'error');
    } finally {
      setIsFetchingModels(false);
    }
  };

  const openGameModal = async (game: Game) => {
    setSelectedGame(game);
    setNewArtUrl(game.thumbnail ?? '');
    setArtQuery(game.name);
    setArtResults([]);
    setActiveTab('files');
    // Clear vFiles cache for the newly opened game to avoid stale memory growth
    setVFiles({});
    loadVersions(game.name);
    loadFiles(game.name, game.analysis);
  };

  const loadVersionFiles = async (vId: string) => {
    if (!selectedGame) return;
    const cacheKey = `${selectedGame.name}_${vId}`;
    if (vFiles[cacheKey]) return; // already fetched
    try {
      const res = await fetch(
        `/api/version-files?game=${encodeURIComponent(selectedGame.name)}&versionId=${vId}`
      );
      const json = await res.json();
      setVFiles(prev => ({ ...prev, [cacheKey]: json.files ?? [] }));
    } catch {
      console.error('Failed to load version files');
    }
  };

  const searchArt = async () => {
    if (!artQuery.trim()) return;
    setIsSearchingArt(true);
    try {
      const res = await fetch(`/api/search-art?query=${encodeURIComponent(artQuery)}`);
      const json = await res.json();
      if (json.success) setArtResults(json.results ?? []);
      else showToast(json.message ?? 'Search failed', 'error');
    } catch {
      showToast('Art search failed', 'error');
    } finally {
      setIsSearchingArt(false);
    }
  };

  const updateArt = async (url?: string) => {
    if (!selectedGame) return;
    const finalUrl = url ?? newArtUrl;
    if (!finalUrl) return showToast('Please provide an image URL', 'info');
    try {
      const res = await fetch('/api/update-thumbnail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameName: selectedGame.name, url: finalUrl }),
      });
      const json = await res.json();
      if (json.success) {
        loadSaves();
        setSelectedGame(prev => prev ? { ...prev, thumbnail: finalUrl } : null);
        setNewArtUrl(finalUrl);
        showToast('Cover art updated!', 'success');
      } else {
        showToast('Failed to update art: ' + (json.message ?? 'Unknown error'), 'error');
      }
    } catch {
      showToast('Network error while updating art', 'error');
    }
  };

  const autoMatchAll = async () => {
    if (!settings.steamGridApiKey) {
      return showToast('Add your SteamGridDB API key in Settings first.', 'info');
    }
    setIsBulkMatching(true);
    try {
      const res = await fetch('/api/auto-match-all');
      const data = await res.json();
      if (data.success) {
        showToast(`Auto-matched ${data.count} game(s)!`, 'success');
        loadSaves();
      } else {
        showToast('Bulk matching failed: ' + data.message, 'error');
      }
    } catch {
      showToast('Error during bulk match.', 'error');
    } finally {
      setIsBulkMatching(false);
    }
  };

  const switchView = (view: View) => {
    setCurrentView(view);
    setSelectedGame(null);
  };

  const filteredSaves = saves.filter(s =>
    s.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const hasAnalysis = Object.keys(analysis).length > 0;

  // ── Derived helpers ─────────────────────────────────────────────────────────
  const formatDate = (iso: string) => {
    try { return new Date(iso).toLocaleString(); }
    catch { return iso; }
  };

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="layout">

      {/* ── Sidebar ── */}
      <div className="sidebar">
        <div className="sidebar-title">DUNE SERVER</div>

        <button
          className={`nav-item ${currentView === 'dashboard' ? 'active' : ''}`}
          onClick={() => switchView('dashboard')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
            <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
          </svg>
          Dashboard
        </button>

        <button
          className={`nav-item ${currentView === 'settings' ? 'active' : ''}`}
          onClick={() => switchView('settings')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          Settings
        </button>

        <div style={{ margin: '8px 0', borderTop: '1px solid var(--surface-border)' }} />

        <button
          className={`nav-item ${isSyncingLocal ? 'loading' : ''}`}
          onClick={runLocalSync}
          disabled={isSyncingLocal || localSources.length === 0}
          title={localSources.length === 0 ? 'Add a scan path in Settings first' : 'Sync saves from Windows drive'}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          {isSyncingLocal ? 'Syncing…' : 'Sync Windows Drive'}
        </button>

        <div style={{ marginTop: 'auto', padding: '16px', borderRadius: '12px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--surface-border)' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: '11px', fontWeight: 700, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Server Status</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
            <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--success)', boxShadow: '0 0 6px var(--success)' }} />
            Online · Port 3030
          </div>
        </div>
      </div>

      {/* ── Main Content ── */}
      <div className="main-content">

        {/* ── Dashboard View ── */}
        {currentView === 'dashboard' ? (
          <>
            <div className="dashboard-header">
              <div className="header-left">
                <h2>Game Library</h2>
                <p>
                  {isLoading
                    ? 'Loading your game library…'
                    : `${saves.length} game${saves.length !== 1 ? 's' : ''} backed up across your ecosystem.`}
                </p>
              </div>
              <div className="header-right">
                <button
                  className={`bulk-btn ${isBulkMatching ? 'loading' : ''}`}
                  onClick={autoMatchAll}
                  disabled={isBulkMatching || !settings.steamGridApiKey}
                  title={!settings.steamGridApiKey ? 'Add SteamGridDB API key in Settings to enable' : 'Auto-find cover art for all games'}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                  </svg>
                  {isBulkMatching ? 'Matching…' : 'Auto-Match All'}
                </button>
                <div className="search-wrapper">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  </svg>
                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search games…"
                    value={searchTerm}
                    onChange={e => setSearchTerm(e.target.value)}
                  />
                </div>
              </div>
            </div>

            {/* Stat Cards */}
            <div className="stats-row">
              <div className="stat-card glass">
                <div className="stat-label">Total Games</div>
                <div className="stat-value">{saves.length}</div>
              </div>
              <div className="stat-card glass">
                <div className="stat-label">System Health</div>
                <div className="stat-value" style={{ color: 'var(--success)' }}>Healthy</div>
              </div>
              <div className="stat-card glass">
                <div className="stat-label">Active Port</div>
                <div className="stat-value">3030</div>
              </div>
            </div>

            {/* Game Grid */}
            <div className="games-grid">
              {/* Loading skeleton */}
              {isLoading && Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="skeleton-card">
                  <div className="skeleton" style={{ height: 240 }} />
                  <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div className="skeleton" style={{ height: 18, width: '70%' }} />
                    <div className="skeleton" style={{ height: 14, width: '45%' }} />
                    <div className="skeleton" style={{ height: 14, width: '55%' }} />
                  </div>
                </div>
              ))}

              {/* Empty state */}
              {!isLoading && filteredSaves.length === 0 && (
                <div style={{ gridColumn: '1/-1', padding: '60px', textAlign: 'center', background: 'rgba(255,255,255,0.02)', borderRadius: '24px', border: '1px dashed var(--surface-border)' }}>
                  <div style={{ fontSize: '48px', marginBottom: '16px' }}>🎮</div>
                  <p className="text-muted">
                    {searchTerm ? 'No games match your search.' : 'No games backed up yet. Push saves via the Playnite plugin to get started.'}
                  </p>
                </div>
              )}

              {/* Game Cards */}
              {!isLoading && filteredSaves.map(game => (
                <div key={game.id} className="game-card" onClick={() => openGameModal(game)}>
                  <button
                    className="delete-card-btn"
                    onClick={e => deleteGame(e, game.id, game.name)}
                    title="Delete Game"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                  </button>

                  {game.thumbnail ? (
                    <img src={game.thumbnail} className="game-cover" alt={game.name} loading="lazy" />
                  ) : (
                    <div className="game-cover-placeholder">
                      {game.name.substring(0, 2).toUpperCase()}
                    </div>
                  )}

                  <div className="game-info">
                    <div className="game-title" title={game.name}>{game.name}</div>
                    <div className="game-status-pill">
                      <span>✓ Synchronized</span>
                    </div>
                    <div className="sync-time">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                      </svg>
                      {formatDate(game.lastSync)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (

          /* ── Settings View ── */
          <div className="settings-container">
            <div className="dashboard-header">
              <div className="header-left">
                <h2>Server Settings</h2>
                <p>Configure backup policies and third-party integrations.</p>
              </div>
            </div>

            <div className="settings-group">
              <h3>Backup Policy</h3>
              <div className="form-field">
                <label>Max Versions to Keep</label>
                <input
                  type="number"
                  className="modern-input"
                  value={settings.maxVersions}
                  onChange={e => setSettings({ ...settings, maxVersions: parseInt(e.target.value) || 1 })}
                  min={1}
                  max={100}
                />
                <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '8px' }}>
                  Number of historical backups retained per game before old ones are pruned.
                </p>
              </div>
            </div>

            <div className="settings-group">
              <h3>Integrations</h3>

              <div className="form-field">
                <label>SteamGridDB API Key</label>
                <input
                  type="password"
                  className="modern-input"
                  placeholder="Enter your SteamGridDB API key…"
                  value={settings.steamGridApiKey}
                  onChange={e => setSettings({ ...settings, steamGridApiKey: e.target.value })}
                />
              </div>

              <div className="form-field">
                <label>Ollama Endpoint</label>
                <div style={{ display: 'flex', gap: '12px' }}>
                  <input
                    type="text"
                    className="modern-input"
                    placeholder="http://ollama:11434"
                    value={settings.ollamaEndpoint}
                    onChange={e => setSettings({ ...settings, ollamaEndpoint: e.target.value })}
                  />
                  <button className="small-btn" style={{ height: '52px' }} onClick={fetchOllamaModels} disabled={isFetchingModels}>
                    {isFetchingModels ? '…' : 'Fetch Models'}
                  </button>
                </div>
                <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '8px' }}>
                  Use <code style={{ background: 'rgba(255,255,255,0.06)', padding: '2px 6px', borderRadius: '4px' }}>http://ollama:11434</code> when running inside Docker.
                </p>
              </div>

              <div className="form-field">
                <label>Ollama Model</label>
                {ollamaModels.length > 0 ? (
                  <select
                    className="modern-input"
                    value={settings.ollamaModel}
                    onChange={e => setSettings({ ...settings, ollamaModel: e.target.value })}
                  >
                    {ollamaModels.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input
                    type="text"
                    className="modern-input"
                    placeholder="phi4-mini:latest"
                    value={settings.ollamaModel}
                    onChange={e => setSettings({ ...settings, ollamaModel: e.target.value })}
                  />
                )}
                <button
                  className="small-btn"
                  style={{ marginTop: '12px' }}
                  onClick={checkOllamaHealth}
                  disabled={isCheckingHealth}
                >
                  {isCheckingHealth ? 'Checking…' : 'Verify Model Health'}
                </button>
                {healthStatus && (
                  <div style={{
                    marginTop: '12px', padding: '12px', borderRadius: '10px', fontSize: '13px',
                    background: healthStatus.success
                      ? (healthStatus.exists ? 'rgba(16,185,129,0.1)' : 'rgba(251,191,36,0.1)')
                      : 'rgba(239,68,68,0.1)',
                    color: healthStatus.success
                      ? (healthStatus.exists ? '#4ade80' : '#fbbf24')
                      : '#f87171',
                    border: `1px solid ${healthStatus.success
                      ? (healthStatus.exists ? '#4ade8055' : '#fbbf2455')
                      : '#f8717155'}`
                  }}>
                    {healthStatus.success
                      ? (healthStatus.exists ? '✅ Model is pulled and ready.' : '⚠️ Model not found. Pull it via Ollama CLI.')
                      : `❌ ${healthStatus.message}`}
                  </div>
                )}
                <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '8px' }}>
                  Select which model to use for AI save file analysis.
                </p>
              </div>
            </div>

            <button className="save-btn" onClick={saveSettings}>Apply Changes</button>

            <div className="settings-group" style={{ marginTop: '40px' }}>
              <h3>Dual-Boot Ingestion</h3>
              <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px' }}>
                Add paths on your mounted Windows drive. Dune will scan these folders for game saves when you trigger a sync.
              </p>

              <div className="form-field">
                <label>Add Scan Path</label>
                <div style={{ display: 'flex', gap: '12px' }}>
                  <input
                    type="text"
                    className="modern-input"
                    placeholder="/mnt/Windows/Users/Admin/AppData/Local"
                    value={newSourcePath}
                    onChange={e => setNewSourcePath(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addLocalSource()}
                  />
                  <button className="small-btn" onClick={addLocalSource}>Add Source</button>
                </div>
              </div>

              <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {localSources.length === 0 && (
                  <p className="text-muted" style={{ fontSize: '14px' }}>No scan paths configured.</p>
                )}
                {localSources.map(s => (
                  <div key={s.id} className="file-row">
                    <div className="file-main">
                      <span className="file-name" style={{ fontSize: '13px' }}>{s.path}</span>
                    </div>
                    <button
                      className="small-btn"
                      style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}
                      onClick={() => removeLocalSource(s.id)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Game Modal ── */}
      {selectedGame && (
        <div className="modal-overlay" onClick={() => setSelectedGame(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>

            <div className="modal-header">
              <div>
                <h2>{selectedGame.name}</h2>
                <div style={{ color: 'var(--text-muted)', marginTop: '4px', fontSize: '14px' }}>File & Version Management</div>
              </div>
              <button className="close-btn" onClick={() => setSelectedGame(null)}>✕</button>
            </div>

            <div className="modal-tabs">
              <button className={`tab-btn ${activeTab === 'files' ? 'active' : ''}`} onClick={() => setActiveTab('files')}>Current Files</button>
              <button className={`tab-btn ${activeTab === 'versions' ? 'active' : ''}`} onClick={() => setActiveTab('versions')}>Version History</button>
              <button className={`tab-btn ${activeTab === 'art' ? 'active' : ''}`} onClick={() => setActiveTab('art')}>Metadata & Art</button>
            </div>

            <div className="tab-pane">

              {/* ── Files Tab ── */}
              {activeTab === 'files' && (
                <div className="file-section">
                  <div className="file-controls">
                    <div className="view-toggle">
                      <button className={`view-btn ${viewMode === 'list' ? 'active' : ''}`} onClick={() => setViewMode('list')}>List</button>
                      <button className={`view-btn ${viewMode === 'categories' ? 'active' : ''}`} onClick={() => setViewMode('categories')}>Categories</button>
                    </div>
                    {/* Single unified AI button — label adapts to current state */}
                    <button
                      className={`ai-btn ${isAnalyzing ? 'loading' : ''} ${hasAnalysis && !isAnalyzing ? 'analyzed' : ''}`}
                      onClick={analyzeFilesWithAI}
                      disabled={isAnalyzing || fileList.length === 0}
                      title={hasAnalysis ? 'Re-run AI analysis' : 'Classify files with AI'}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                      </svg>
                      {isAnalyzing ? 'Analyzing…' : hasAnalysis ? '✓ Re-analyze' : 'Ask AI'}
                    </button>
                  </div>

                  <div className="file-list">
                    {fileList.length === 0 && (
                      <p className="text-muted" style={{ padding: '20px 0' }}>No files found in this backup.</p>
                    )}

                    {viewMode === 'list'
                      ? fileList.map(f => (
                          <div key={f.path} className="file-row">
                            <div className="file-main">
                              <span className="file-name">{f.path}</span>
                              {analysis[f.path] && (
                                <div className="file-desc">{analysis[f.path].description}</div>
                              )}
                            </div>
                            <div className="file-actions">
                              <span className="file-size">{((f.size || 0) / 1024).toFixed(1)} KB</span>
                              <a className="download-link" href={`/api/download-file?game=${encodeURIComponent(selectedGame.name)}&path=${encodeURIComponent(f.path)}`}>Download</a>
                            </div>
                          </div>
                        ))
                      : (['Save', 'Config', 'Cache', 'Other'] as const).map(cat => {
                          const catFiles = fileList.filter(f => (analysis[f.path]?.category ?? f.category) === cat);
                          if (catFiles.length === 0) return null;
                          return (
                            <div key={cat} className="category-group">
                              <div className="category-header">
                                <span className={`cat-badge ${cat.toLowerCase()}`}>{cat}</span>
                                <span className="cat-count">{catFiles.length} file{catFiles.length !== 1 ? 's' : ''}</span>
                              </div>
                              {catFiles.map(f => (
                                <div key={f.path} className="file-row">
                                  <div className="file-main">
                                    <span className="file-name">{f.name}</span>
                                    <span className="file-path-sub">{f.path}</span>
                                    {analysis[f.path] && (
                                      <div className="file-desc">{analysis[f.path].description}</div>
                                    )}
                                  </div>
                                  <div className="file-actions">
                                    <span className="file-size">{((f.size || 0) / 1024).toFixed(1)} KB</span>
                                    <a className="download-link" href={`/api/download-file?game=${encodeURIComponent(selectedGame.name)}&path=${encodeURIComponent(f.path)}`}>Download</a>
                                  </div>
                                </div>
                              ))}
                            </div>
                          );
                        })
                    }
                  </div>
                </div>
              )}

              {/* ── Versions Tab ── */}
              {activeTab === 'versions' && (
                <div className="version-list">
                  {hasAnalysis && (
                    <div style={{
                      background: 'rgba(99, 102, 241, 0.05)',
                      border: '1px solid rgba(99, 102, 241, 0.2)',
                      borderRadius: '14px',
                      padding: '20px',
                      marginBottom: '24px'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                        </svg>
                        <span style={{ fontWeight: 700, color: '#818cf8', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '0.6px' }}>AI Storage Insights</span>
                      </div>
                      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                        {(['Save', 'Config', 'Cache'] as const).map(cat => {
                          const count = Object.values(analysis).filter(a => a.category === cat).length;
                          if (count === 0) return null;
                          return (
                            <div key={cat} style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                              <strong style={{ color: 'var(--text-main)' }}>{count} {cat}</strong> file{count !== 1 ? 's' : ''} identified
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {versions.length === 0 && (
                    <p className="text-muted">No historical versions available yet.</p>
                  )}

                  {versions.map(v => (
                    <div key={v.id} className="version-card">
                      <div className="version-header">
                        <span style={{ fontSize: '14px', color: 'var(--text-muted)' }}>{formatDate(v.timestamp)}</span>
                        <div style={{ display: 'flex', gap: '8px' }}>
                          <button className="small-btn" onClick={() => loadVersionFiles(v.id)}>Inspect</button>
                          <button
                            className="small-btn"
                            style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}
                            onClick={() => deleteVersion(v.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                      {vFiles[`${selectedGame.name}_${v.id}`] && (
                        <div className="v-file-list">
                          {vFiles[`${selectedGame.name}_${v.id}`].map(f => (
                            <div key={f.path} className="v-file-row">
                              <div className="file-main">
                                <span className="file-name">{f.name}</span>
                                <span className="file-path-sub">{f.path}</span>
                              </div>
                              <div className="file-actions">
                                <span className="file-size">{((f.size || 0) / 1024).toFixed(1)} KB</span>
                                <a className="download-link" href={`/api/download-version-file?game=${encodeURIComponent(selectedGame.name)}&versionId=${v.id}&path=${encodeURIComponent(f.path)}`}>Download</a>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* ── Art Tab ── */}
              {activeTab === 'art' && (
                <div>
                  <p className="text-muted" style={{ marginBottom: '24px' }}>
                    Discover high-resolution cover art via SteamGridDB or provide a direct URL.
                  </p>

                  <div style={{ display: 'flex', gap: '12px', marginBottom: '32px' }}>
                    <input
                      className="modern-input"
                      placeholder="Search SteamGridDB…"
                      value={artQuery}
                      onChange={e => setArtQuery(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && searchArt()}
                    />
                    <button className="save-btn" style={{ whiteSpace: 'nowrap' }} onClick={searchArt} disabled={isSearchingArt}>
                      {isSearchingArt ? 'Searching…' : 'Find Art'}
                    </button>
                  </div>

                  {artResults.length > 0 && (
                    <div className="art-grid">
                      {artResults.map(url => (
                        <div
                          key={url}
                          className={`art-option ${newArtUrl === url ? 'selected' : ''}`}
                          onClick={() => updateArt(url)}
                          title="Click to set as cover"
                        >
                          <img src={url} alt="Cover option" loading="lazy" />
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ marginTop: '40px', paddingTop: '28px', borderTop: '1px solid var(--surface-border)' }}>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.8px', color: 'var(--text-muted)' }}>
                      Custom URL
                    </label>
                    <div style={{ display: 'flex', gap: '12px' }}>
                      <input
                        className="modern-input"
                        placeholder="https://…"
                        value={newArtUrl}
                        onChange={e => setNewArtUrl(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && updateArt()}
                      />
                      <button className="save-btn" onClick={() => updateArt()}>Set Art</button>
                    </div>
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>
      )}

      {/* ── Toast Notifications ── */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`}>
            {t.type === 'success' && '✅ '}
            {t.type === 'error'   && '❌ '}
            {t.type === 'info'    && 'ℹ️ '}
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
