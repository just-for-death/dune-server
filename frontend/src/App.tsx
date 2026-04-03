import { useState, useEffect } from 'react';
import './index.css';

export default function App() {
  const [saves, setSaves] = useState<any[]>([]);
  const [currentView, setCurrentView] = useState<'dashboard' | 'settings'>('dashboard');
  const [selectedGame, setSelectedGame] = useState<any>(null);
  const [vFiles, setVFiles] = useState<any>({});
  const [activeTab, setActiveTab] = useState<'files' | 'versions' | 'art'>('files');
  const [fileList, setFileList] = useState<any[]>([]);
  const [versions, setVersions] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [isBulkMatching, setIsBulkMatching] = useState(false);
  const [analysis, setAnalysis] = useState<any>({});
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'categories'>('categories');
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);
  const [healthStatus, setHealthStatus] = useState<{ success: boolean; exists?: boolean; message?: string } | null>(null);
  const [isSyncingLocal, setIsSyncingLocal] = useState(false);
  const [localSources, setLocalSources] = useState<any[]>([]);
  const [newSourcePath, setNewSourcePath] = useState('');
  const [toasts, setToasts] = useState<{ id: number; message: string; type: 'success' | 'error' | 'info' }[]>([]);
  
  // Settings state
  const [settings, setSettings] = useState({ 
    maxVersions: 10, 
    steamGridApiKey: '',
    ollamaEndpoint: 'http://ollama:11434',
    ollamaModel: 'phi4-mini:latest'
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

  const loadSaves = async () => {
    try {
        const res = await fetch('/api/saves');
        const json = await res.json();
        if (json.success) {
            setSaves(json.games);
        }
    } catch (e) {
        console.error('Failed to load saves');
    }
  };

  const loadSettings = async () => {
    const res = await fetch('/api/settings');
    const json = await res.json();
    if (json.success) setSettings(json.settings);
  };

  const saveSettings = async () => {
    try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings })
        });
        const json = await res.json();
        if (json.success) showToast('Settings saved!', 'success');
        else showToast('Failed to save settings: ' + (json.message || 'Unknown error'), 'error');
    } catch (e) {
        showToast('Network error while saving settings.', 'error');
    }
  };

  const loadFiles = async (gameName: string, existingAnalysis?: any) => {
      try {
          const fRes = await fetch(`/api/list-files?game=${encodeURIComponent(gameName)}`);
          const fJson = await fRes.json();
          setFileList(fJson.files || []);
          
          if (existingAnalysis) {
              setAnalysis(existingAnalysis);
              setViewMode('categories');
          } else {
              setAnalysis({});
              setViewMode('list');
          }
      } catch (e) {
          console.error('Failed to load files', e);
          setFileList([]);
      }
  };

  const analyzeFilesWithAI = async () => {
    if (!selectedGame) return;
    setIsAnalyzing(true);
    try {
      // PROMPT OPTIMIZATION: Filter items but keep metadata for ones we send
      const relevantFiles = fileList
        .filter((f: any) => f.category !== 'Cache' && f.category !== 'Other')
        .slice(0, 50); // Hard limit for safety

      if (relevantFiles.length === 0) {
          const otherFiles = fileList
            .filter((f: any) => f.category === 'Other')
            .slice(0, 20);
          relevantFiles.push(...otherFiles);
      }

      if (relevantFiles.length === 0) {
          showToast('No relevant files found to analyze.', 'info');
          setIsAnalyzing(false);
          return;
      }

      const res = await fetch('/api/analyze-files-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            gameName: selectedGame.name, 
            files: relevantFiles.map(f => ({ path: f.path, size: f.size, category: f.category })) 
        })
      });
      const json = await res.json();
      if (json.success) {
        setAnalysis(json.analysis);
        // LOCAL PERSISTENCE: Update selectedGame so the UI reflects the analysis immediately
        if (selectedGame) {
            setSelectedGame((prev: any) => ({ ...prev, analysis: json.analysis }));
        }
        showToast('Analysis complete and saved!', 'success');
        setViewMode('categories');
      } else {
        showToast(json.message || 'AI analysis failed', 'error');
      }
    } catch (e) {
      showToast('Could not connect to analysis engine. Check if Ollama is running.', 'error');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  };

  const checkOllamaHealth = async () => {
    setIsCheckingHealth(true);
    setHealthStatus(null);
    try {
        const res = await fetch('/api/ollama-health');
        const json = await res.json();
        setHealthStatus(json);
    } catch (e) {
        setHealthStatus({ success: false, message: 'Failed to reach server API' });
    } finally {
        setIsCheckingHealth(false);
    }
  };

  const loadLocalSources = async () => {
      try {
          const res = await fetch('/api/local-sources');
          const json = await res.json();
          if (json.success) setLocalSources(json.sources);
      } catch (e) {
          console.error('Failed to load local sources');
      }
  };

  const addLocalSource = async () => {
      if (!newSourcePath) return;
      try {
          const res = await fetch('/api/local-sources', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: newSourcePath })
          });
          const json = await res.json();
          if (json.success) {
              setNewSourcePath('');
              loadLocalSources();
              showToast('Source added successfully', 'success');
          } else {
              showToast(json.message || 'Failed to add source', 'error');
          }
      } catch (e) {
          showToast('Error adding source', 'error');
      }
  };

  const removeLocalSource = async (id: string) => {
      try {
          const res = await fetch(`/api/local-sources/${id}`, { method: 'DELETE' });
          const json = await res.json();
          if (json.success) {
              loadLocalSources();
              showToast('Source removed', 'info');
          }
      } catch (e) {
          showToast('Error removing source', 'error');
      }
  };

  const runLocalSync = async () => {
      setIsSyncingLocal(true);
      try {
          const res = await fetch('/api/local-sync', { method: 'POST' });
          const json = await res.json();
          if (json.success) {
              showToast(`Sync Complete! Synced ${json.count} files across ${json.games.length} games.`, 'success');
              loadSaves();
          } else {
              showToast(json.message || 'Sync failed', 'error');
          }
      } catch (e) {
          showToast('Network error during sync', 'error');
      } finally {
          setIsSyncingLocal(false);
      }
  };

  const deleteGame = async (e: React.MouseEvent, id: number, name: string) => {
    e.stopPropagation(); // Don't open the modal
    if (!window.confirm(`Are you sure you want to permanently delete "${name}" and all its backups? This cannot be undone.`)) return;

    try {
        const res = await fetch(`/api/games/${id}`, { method: 'DELETE' });
        const json = await res.json();
        if (json.success) {
            showToast(`Deleted ${name}`, 'info');
            loadSaves();
        } else {
            showToast(json.message || 'Delete failed', 'error');
        }
    } catch (e) {
        showToast('Network error during deletion', 'error');
    }
  };

  const deleteVersion = async (versionId: string) => {
    if (!selectedGame || !window.confirm('Delete this backup permanently?')) return;

    try {
        const res = await fetch(`/api/versions/${encodeURIComponent(selectedGame.name)}/${versionId}`, { method: 'DELETE' });
        const json = await res.json();
        if (json.success) {
            showToast('Backup deleted', 'info');
            loadVersions(selectedGame.name);
        } else {
            showToast(json.message || 'Failed to delete version', 'error');
        }
    } catch (e) {
        showToast('Error deleting backup', 'error');
    }
  };

  const fetchOllamaModels = async () => {
    if (!settings.ollamaEndpoint) return showToast('Please enter an Ollama URL first', 'info');
    setIsFetchingModels(true);
    setOllamaModels([]); // Clear current list while fetching
    try {
      const res = await fetch(`/api/ollama-models?endpoint=${encodeURIComponent(settings.ollamaEndpoint)}`);
      const json = await res.json();
      if (json.success) {
        setOllamaModels(json.models);
        showToast(`Found ${json.models.length} models`, 'success');
        if (json.models.length > 0 && !json.models.includes(settings.ollamaModel)) {
            setSettings(prev => ({ ...prev, ollamaModel: json.models[0] }));
        }
      } else {
        showToast(json.message || 'Failed to fetch models', 'error');
      }
    } catch (e) {
      showToast('Check if the backend is running and Ollama URL is correct', 'error');
    } finally {
      setIsFetchingModels(false);
    }
  };

  const loadVersions = async (gameName: string) => {
      try {
          const vRes = await fetch(`/api/versions?game=${encodeURIComponent(gameName)}`);
          const vJson = await vRes.json();
          setVersions(vJson.versions || []);
      } catch (e) {
          console.error('Failed to load versions', e);
          setVersions([]);
      }
  };

  const openGameModal = async (game: any) => {
      setSelectedGame(game);
      setNewArtUrl(game.thumbnail || '');
      setArtQuery(game.name);
      setArtResults([]);
      
      if (game) {
          loadVersions(game.name);
          loadFiles(game.name, game.analysis);
          setActiveTab('files');
      }
  };

  const loadVersionFiles = async (vId: string) => {
      const cacheKey = `${selectedGame.name}_${vId}`;
      if (vFiles[cacheKey]) return;
      try {
          const res = await fetch(`/api/version-files?game=${encodeURIComponent(selectedGame.name)}&versionId=${vId}`);
          const json = await res.json();
          setVFiles((prev: any) => ({ ...prev, [cacheKey]: json.files || [] }));
      } catch (e) {
          console.error('Failed to load version files', e);
      }
  };

  const searchArt = async () => {
    setIsSearchingArt(true);
    try {
      const res = await fetch(`/api/search-art?query=${encodeURIComponent(artQuery)}`);
      const json = await res.json();
      if (json.success) setArtResults(json.results || []);
      else showToast(json.message || 'Search failed', 'error');
    } catch (e) {
      showToast('Search failed', 'error');
    } finally {
      setIsSearchingArt(false);
    }
  };

  const updateArt = async (url?: string) => {
      const finalUrl = url || newArtUrl;
      if (!finalUrl) return showToast('Please provide an image URL', 'info');

      try {
          const res = await fetch('/api/update-thumbnail', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ gameName: selectedGame.name, url: finalUrl })
          });
          const json = await res.json();
          if (json.success) {
            loadSaves();
            setSelectedGame((prev: any) => ({ ...prev, thumbnail: finalUrl }));
            setNewArtUrl(finalUrl);
            showToast('Art updated successfully', 'success');
          } else {
            showToast('Failed to update art: ' + (json.message || 'Unknown error'), 'error');
          }
      } catch (e) {
          showToast('Network error while updating art', 'error');
      }
  };

  const autoMatchAll = async () => {
    if (!settings.steamGridApiKey) return alert('Please set your SteamGridDB API key in settings first!');
    setIsBulkMatching(true);
    try {
        const res = await fetch('/api/auto-match-all');
        const data = await res.json();
        if (data.success) {
            showToast(`Auto-matched ${data.count} games!`, 'success');
            loadSaves();
        } else {
            showToast('Bulk matching failed: ' + data.message, 'error');
        }
    } catch (e) {
        showToast('Error during bulk match.', 'error');
    } finally {
        setIsBulkMatching(false);
    }
  };

  const switchView = (view: 'dashboard' | 'settings') => {
    setCurrentView(view);
    setSelectedGame(null); // Close modal when navigating
  };

  const filteredSaves = saves.filter(s => 
    s.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="layout">
      <div className="sidebar">
        <div className="sidebar-title">DUNE SERVER</div>
        <button 
          className={`nav-item ${currentView === 'dashboard' ? 'active' : ''}`}
          onClick={() => switchView('dashboard')}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>
          Dashboard
        </button>
        <button 
          className={`nav-item ${currentView === 'settings' ? 'active' : ''}`}
          onClick={() => switchView('settings')}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          Settings
        </button>

        <div style={{ margin: '16px 0', borderTop: '1px solid rgba(255,255,255,0.05)' }}></div>

        <button 
          className={`nav-item ${isSyncingLocal ? 'loading' : ''}`}
          onClick={runLocalSync}
          disabled={isSyncingLocal || localSources.length === 0}
          title={localSources.length === 0 ? 'Add a Windows scan path in Settings first' : 'Scan and sync saves from Windows partitions'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          Sync Windows Drive
        </button>

        <div style={{ marginTop: 'auto', padding: '16px', borderRadius: '12px', background: 'rgba(255,255,255,0.03)' }}>
            <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '8px' }}>SERVER STATUS</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--success)' }}></div>
                ONLINE (PORT 3030)
            </div>
        </div>
      </div>

      <div className="main-content">
        {currentView === 'dashboard' ? (
          <>
            <div className="dashboard-header">
              <div className="header-left">
                <h2>Game Library</h2>
                <p>Welcome back! You have {saves.length} games synced across your ecosystem.</p>
              </div>
              <div className="header-right">
                <button 
                  className={`bulk-btn ${isBulkMatching ? 'loading' : ''} ${!settings.steamGridApiKey ? 'disabled' : ''}`}
                  onClick={autoMatchAll}
                  disabled={isBulkMatching || !settings.steamGridApiKey}
                  title={!settings.steamGridApiKey ? "Add SteamGridDB API key in Settings to enable" : "Automatically find art for all games"}
                >
                  {settings.steamGridApiKey ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                  )}
                  {isBulkMatching ? 'Matching...' : 'Auto-Match All'}
                </button>
                <div className="search-wrapper">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                  <input 
                    type="text" 
                    className="search-input" 
                    placeholder="Search games..." 
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="stats-row">
              <div className="stat-card glass">
                <div className="stat-label">Total Saves</div>
                <div className="stat-value">{saves.length}</div>
              </div>
              <div className="stat-card glass">
                <div className="stat-label">System Health</div>
                <div className="stat-value" style={{ color: 'var(--success)' }}>Healthy</div>
              </div>
              <div className="stat-card glass">
                <div className="stat-label">Port Status</div>
                <div className="stat-value">3030</div>
              </div>
            </div>

            <div className="games-grid">
                {filteredSaves.length === 0 && (
                    <div style={{ gridColumn: '1/-1', padding: '60px', textAlign: 'center', background: 'rgba(255,255,255,0.02)', borderRadius: '24px', border: '1px dashed var(--surface-border)' }}>
                        <p className="text-muted">No games found matching your search.</p>
                    </div>
                )}
                {filteredSaves.map(game => (
                  <div key={game.id} className="game-card" onClick={() => openGameModal(game)}>
                    <button 
                      className="delete-card-btn" 
                      onClick={(e) => deleteGame(e, game.id, game.name)}
                      title="Delete Game"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                    </button>
                    {game.thumbnail ? (
                      <img src={game.thumbnail} className="game-cover" alt={game.name} />
                    ) : (
                      <div className="game-cover-placeholder">
                          {game.name.substring(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div className="game-info">
                      <div className="game-title">{game.name}</div>
                      <div className="game-status-pill">
                        <span>✓ Synchronized</span>
                      </div>
                      <div className="sync-time">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                        {game.lastSync}
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          </>
        ) : (
          <div className="settings-container">
            <div className="dashboard-header">
              <h2>Server Settings</h2>
              <p>Configure backend parameters and third-party integrations.</p>
            </div>

            <div className="settings-group">
               <h3>Backup Policy</h3>
               <div className="form-field">
                  <label>Max Versions to Keep</label>
                  <input 
                    type="number" 
                    className="modern-input" 
                    value={settings.maxVersions}
                    onChange={e => setSettings({...settings, maxVersions: parseInt(e.target.value)})}
                  />
                  <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '8px' }}>
                    Number of historical backups to retain per game before pruning old data.
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
                    placeholder="Enter your SteamGridDB API Key"
                    value={settings.steamGridApiKey}
                    onChange={e => setSettings({...settings, steamGridApiKey: e.target.value})}
                  />
               </div>
               
               <div className="form-field" style={{ marginTop: '24px' }}>
                  <label>Ollama Endpoint</label>
                  <div style={{ display: 'flex', gap: '12px' }}>
                     <input 
                        type="text" 
                        className="modern-input" 
                        placeholder="http://ollama:11434"
                        value={settings.ollamaEndpoint}
                        onChange={e => setSettings({...settings, ollamaEndpoint: e.target.value})}
                     />
                     <button 
                        className="small-btn" 
                        style={{ height: '48px', whiteSpace: 'nowrap' }}
                        onClick={fetchOllamaModels}
                        disabled={isFetchingModels}
                     >
                        {isFetchingModels ? '...' : 'Fetch Models'}
                     </button>
                  </div>
                  <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '8px' }}>
                    The URL of your Ollama API. Use <code>http://ollama:11434</code> if in Docker.
                  </p>
               </div>

               <div className="form-field" style={{ marginTop: '24px' }}>
                  <label>Ollama Model</label>
                  {ollamaModels.length > 0 ? (
                      <select 
                        className="modern-input"
                        value={settings.ollamaModel}
                        onChange={e => setSettings({...settings, ollamaModel: e.target.value})}
                      >
                         {ollamaModels.map(m => (
                             <option key={m} value={m}>{m}</option>
                         ))}
                      </select>
                  ) : (
                      <input 
                        type="text" 
                        className="modern-input" 
                        placeholder="phi4-mini:latest"
                        value={settings.ollamaModel}
                        onChange={e => setSettings({...settings, ollamaModel: e.target.value})}
                      />
                  )}
                  <button 
                         className="small-btn" 
                         style={{ marginTop: '12px', background: 'rgba(255,255,255,0.05)', color: 'var(--text-main)' }}
                         onClick={checkOllamaHealth}
                         disabled={isCheckingHealth}
                      >
                         {isCheckingHealth ? 'Checking Model Status...' : 'Verify Model Health'}
                  </button>
                  {healthStatus && (
                      <div style={{ 
                          marginTop: '12px', 
                          padding: '12px', 
                          borderRadius: '8px', 
                          fontSize: '13px',
                          background: healthStatus.success ? (healthStatus.exists ? 'rgba(0,255,0,0.1)' : 'rgba(255,165,0,0.1)') : 'rgba(255,0,0,0.1)',
                          color: healthStatus.success ? (healthStatus.exists ? '#4ade80' : '#fbbf24') : '#f87171',
                          border: `1px solid ${healthStatus.success ? (healthStatus.exists ? '#4ade8055' : '#fbbf2455') : '#f8717155'}`
                      }}>
                          {healthStatus.success 
                            ? (healthStatus.exists ? '✅ Model is pulled and ready to use.' : '⚠️ Model not found on host. Please pull it manually or via Ollama CLI.') 
                            : `❌ Error: ${healthStatus.message}`}
                      </div>
                  )}
                  <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '8px' }}>
                    Pick a model from your Ollama instance.
                  </p>
               </div>
            </div>

            <button className="save-btn" onClick={saveSettings}>Apply Changes</button>

            <div className="settings-group" style={{ marginTop: '40px' }}>
                <h3>Dual-Boot Ingestion</h3>
                <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
                  Manage local paths on your mounted Windows Drive. Dune will scan these folders for game saves when you trigger a sync.
                </p>
                
                <div className="form-field">
                    <label>Add New Scan Path</label>
                    <div style={{ display: 'flex', gap: '12px' }}>
                        <input 
                            type="text" 
                            className="modern-input" 
                            placeholder="/mnt/Windows X-Lite/Users/Admin/AppData/Local"
                            value={newSourcePath}
                            onChange={e => setNewSourcePath(e.target.value)}
                        />
                        <button className="small-btn" onClick={addLocalSource}>Add Source</button>
                    </div>
                </div>

                <div className="source-list" style={{ marginTop: '24px' }}>
                    {localSources.length === 0 && <p className="text-muted">No local sources configured.</p>}
                    {localSources.map(s => (
                        <div key={s.id} className="file-row" style={{ padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', marginBottom: '8px' }}>
                             <div className="file-main">
                                 <span className="file-name" style={{ fontSize: '13px' }}>{s.path}</span>
                             </div>
                             <button className="download-link" style={{ background: 'transparent', border: 'none', color: '#f87171' }} onClick={() => removeLocalSource(s.id)}>Remove</button>
                        </div>
                    ))}
                </div>
            </div>
          </div>
        )}
      </div>

      {selectedGame && (
          <div className="modal-overlay" onClick={() => setSelectedGame(null)}>
              <div className="modal-content" onClick={e => e.stopPropagation()}>
                  <div className="modal-header">
                      <div>
                        <h2>{selectedGame.name}</h2>
                        <div style={{ color: 'var(--text-muted)', marginTop: '4px' }}>File & Version Management</div>
                      </div>
                      <button className="close-btn" onClick={() => setSelectedGame(null)}>✕</button>
                  </div>
                  
                  <div className="modal-tabs">
                      <button className={`tab-btn ${activeTab === 'files' ? 'active' : ''}`} onClick={() => setActiveTab('files')}>Current Files</button>
                      <button className={`tab-btn ${activeTab === 'versions' ? 'active' : ''}`} onClick={() => setActiveTab('versions')}>Version History</button>
                      <button className={`tab-btn ${activeTab === 'art' ? 'active' : ''}`} onClick={() => setActiveTab('art')}>Metadata & Art</button>
                  </div>

                  <div className="tab-pane">
                      {activeTab === 'files' && (
                          <div className="file-section">
                              <div className="file-controls">
                                  <div className="view-toggle">
                                      <button 
                                        className={`view-btn ${viewMode === 'list' ? 'active' : ''}`}
                                        onClick={() => setViewMode('list')}
                                      >List View</button>
                                      <button 
                                        className={`view-btn ${viewMode === 'categories' ? 'active' : ''}`}
                                        onClick={() => setViewMode('categories')}
                                      >Categories</button>
                                  </div>
                                <div style={{ display: 'flex', gap: '12px' }}>
                                    {Object.keys(analysis).length > 0 && (
                                        <button 
                                            className="small-btn" 
                                            style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}
                                            onClick={analyzeFilesWithAI}
                                            disabled={isAnalyzing}
                                        >
                                            {isAnalyzing ? 'Thinking...' : 'Refresh AI'}
                                        </button>
                                    )}
                                    <button 
                                        className={`ai-btn ${isAnalyzing ? 'loading' : ''}`}
                                        onClick={analyzeFilesWithAI}
                                        disabled={isAnalyzing || fileList.length === 0}
                                    >
                                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                                        {isAnalyzing ? 'Analyzing...' : (Object.keys(analysis).length > 0 ? 'AI Analyzed' : 'Ask AI')}
                                    </button>
                                </div>
                              </div>

                              <div className="file-list">
                                  {fileList.length === 0 && <p className="text-muted" style={{ padding: '20px' }}>No files found in this backup.</p>}
                                  {viewMode === 'list' ? (
                                      fileList.map((f: any) => (
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
                                  ) : (
                                      ['Save', 'Config', 'Cache', 'Other'].map(cat => {
                                          const catFiles = fileList.filter((f: any) => (analysis[f.path]?.category || f.category) === cat);
                                          if (catFiles.length === 0) return null;
                                          return (
                                              <div key={cat} className="category-group">
                                                  <div className="category-header">
                                                      <span className={`cat-badge ${cat.toLowerCase()}`}>{cat}</span>
                                                      <span className="cat-count">{catFiles.length} files</span>
                                                  </div>
                                                  {catFiles.map((f: any) => (
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
                                  )}
                              </div>
                          </div>
                      )}

                      {activeTab === 'versions' && (
                          <div className="version-list">
                              {Object.keys(analysis).length > 0 && (
                                  <div className="ai-summary-box" style={{ 
                                      background: 'rgba(99, 102, 241, 0.05)', 
                                      border: '1px solid rgba(99, 102, 241, 0.2)', 
                                      borderRadius: '16px', 
                                      padding: '20px', 
                                      marginBottom: '24px'
                                  }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px' }}>
                                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                                          <span style={{ fontWeight: 600, color: '#818cf8', fontSize: '14px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>AI Storage Insights</span>
                                      </div>
                                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
                                          {['Save', 'Config', 'Cache'].map(cat => {
                                              const count = Object.values(analysis).filter((a: any) => a.category === cat).length;
                                              if (count === 0) return null;
                                              return (
                                                  <div key={cat} style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                                                      <strong style={{ color: 'var(--text-main)' }}>{count} {cat}</strong> files identified.
                                                  </div>
                                              );
                                          })}
                                      </div>
                                  </div>
                              )}
                              {versions.length === 0 && <p className="text-muted">No historical versions available.</p>}
                              {versions.map((v: any) => (
                                  <div key={v.id} className="version-card">
                                      <div className="version-header">
                                          <span>{v.timestamp}</span>
                                          <div style={{ display: 'flex', gap: '8px' }}><button className="small-btn" onClick={() => loadVersionFiles(v.id)}>Inspect Contents</button><button className="small-btn" style={{ background: 'rgba(248,113,113,0.1)', color: '#f87171' }} onClick={() => deleteVersion(v.id)}>Delete</button></div>
                                      </div>
                                      {vFiles[`${selectedGame.name}_${v.id}`] && (
                                          <div className="v-file-list">
                                               {vFiles[`${selectedGame.name}_${v.id}`].map((f: any) => (
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

                      {activeTab === 'art' && (
                          <div className="tab-pane" style={{ padding: 0 }}>
                              <p className="text-muted" style={{ marginBottom: '24px' }}>Discover high-resolution cover art via SteamGridDB integration.</p>
                              <div style={{ display: 'flex', gap: '12px', marginBottom: '32px' }}>
                                  <input 
                                      className="modern-input" 
                                      placeholder="Search SteamGridDB..." 
                                      value={artQuery}
                                      onChange={e => setArtQuery(e.target.value)}
                                  />
                                  <button 
                                    className="save-btn" 
                                    style={{ whiteSpace: 'nowrap' }} 
                                    onClick={searchArt}
                                    disabled={isSearchingArt}
                                  >
                                    {isSearchingArt ? 'Searching...' : 'Find Art'}
                                  </button>
                              </div>

                              {artResults.length > 0 && (
                                <div className="art-grid">
                                    {artResults.map(url => (
                                        <div 
                                          key={url} 
                                          className={`art-option ${newArtUrl === url ? 'selected' : ''}`}
                                          onClick={() => updateArt(url)}
                                        >
                                            <img src={url} alt="Grid Result" />
                                        </div>
                                    ))}
                                </div>
                              )}
                              
                              <div style={{ marginTop: '40px', paddingTop: '32px', borderTop: '1px solid var(--surface-border)' }}>
                                <label style={{ display: 'block', fontSize: '13px', fontWeight: '600', marginBottom: '12px' }}>CUSTOM URL</label>
                                <div style={{ display: 'flex', gap: '12px' }}>
                                    <input 
                                        className="modern-input" 
                                        value={newArtUrl}
                                        onChange={e => setNewArtUrl(e.target.value)}
                                    />
                                    <button className="save-btn" onClick={() => updateArt()}>Set Manual</button>
                                </div>
                              </div>
                          </div>
                      )}
                  </div>
              </div>
          </div>
      )}
      {/* Toast Notifications */}
      <div className="toast-container">
          {toasts.map(t => (
              <div key={t.id} className={`toast toast-${t.type}`}>
                  {t.type === 'success' && '✅ '}
                  {t.type === 'error' && '❌ '}
                  {t.type === 'info' && 'ℹ️ '}
                  {t.message}
              </div>
          ))}
      </div>
    </div>
  );
}
