import fs from 'fs';
import path from 'path';

/**
 * Heuristic to check if a folder is a "Game Save" folder
 */
function isSaveCandidate(dirPath) {
    try {
        const files = fs.readdirSync(dirPath, { withFileTypes: true });
        const saveExts = ['.sav', '.bin', '.dat', '.json', '.xml', '.cfg', '.ini', '.txt', '.sl2', '.prof'];
        
        // Check for specific subdirectories often found in save folders
        const hasSaveDir = files.some(f => f.isDirectory() && (f.name.toLowerCase().includes('save') || f.name.toLowerCase() === 'profiles'));
        if (hasSaveDir) return true;

        const hasSaveFile = files.some(f => {
            if (f.isDirectory()) return false;
            const ext = path.extname(f.name).toLowerCase();
            return saveExts.includes(ext) || f.name.toLowerCase().includes('save') || f.name.toLowerCase().includes('prof');
        });
        
        // Folders with thousands of files are likely game installs, not saves
        if (files.length > 300) return false;
        
        return hasSaveFile;
    } catch (e) {
        return false;
    }
}

/**
 * Recursively find save folders up to a certain depth
 */
export function findSaveFolders(rootPath, depth = 3) {
    let results = [];
    if (depth < 0) return results;

    const normalizedRoot = path.normalize(rootPath);

    try {
        if (!fs.existsSync(normalizedRoot)) return [];
        const items = fs.readdirSync(normalizedRoot, { withFileTypes: true });
        
        if (isSaveCandidate(normalizedRoot)) {
            results.push(normalizedRoot);
            // Even if this is a candidate, we might want to check children for "more specific" save folders
        }

        for (const item of items) {
            if (item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules') {
                const childPath = path.join(normalizedRoot, item.name);
                results = results.concat(findSaveFolders(childPath, depth - 1));
            }
        }
    } catch (e) {
        // Skip inaccessible folders
    }
    
    // Remove duplicates and nested results if a parent was also a candidate
    return [...new Set(results)];
}

export function syncLocalFolder(sourcePath, gameName, savesDir, maxVersions = 10) {
    const targetDir = path.join(savesDir, gameName);
    const syncId = Date.now().toString();
    const normalizedSource = path.normalize(sourcePath);
    let filesSynced = 0;

    const walk = (dir, rel = '') => {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
            // SYMLINK PROTECTION: Skip links to avoid infinite recursion/out-of-bounds sync
            if (item.isSymbolicLink()) continue;

            const sourceFile = path.join(dir, item.name);
            const relativePath = path.join(rel, item.name);
            const targetFile = path.join(targetDir, relativePath);

            if (item.isDirectory()) {
                walk(sourceFile, relativePath);
            } else {
                let shouldSync = true;
                if (fs.existsSync(targetFile)) {
                    const sStats = fs.statSync(sourceFile);
                    const tStats = fs.statSync(targetFile);
                    // Only sync if the source is strictly newer OR size changed
                    if (sStats.mtimeMs <= tStats.mtimeMs && sStats.size === tStats.size) {
                        shouldSync = false;
                    }
                }

                if (shouldSync) {
                    if (fs.existsSync(targetFile)) {
                        const versionDir = path.join(targetDir, '.versions', syncId);
                        const archivePath = path.join(versionDir, relativePath);
                        if (!fs.existsSync(path.dirname(archivePath))) {
                            fs.mkdirSync(path.dirname(archivePath), { recursive: true });
                        }
                        fs.copyFileSync(targetFile, archivePath);
                    }

                    if (!fs.existsSync(path.dirname(targetFile))) {
                        fs.mkdirSync(path.dirname(targetFile), { recursive: true });
                    }
                    fs.copyFileSync(sourceFile, targetFile);
                    filesSynced++;
                }
            }
        }
    };

    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    walk(normalizedSource);

    // VERSION PRUNING: Keep storage clean
    const versionsDir = path.join(targetDir, '.versions');
    if (fs.existsSync(versionsDir)) {
        const versions = fs.readdirSync(versionsDir)
            .filter(v => fs.statSync(path.join(versionsDir, v)).isDirectory())
            .sort((a, b) => parseInt(a) - parseInt(b)); // Date-based sorting

        if (versions.length > maxVersions) {
            const toDelete = versions.slice(0, versions.length - maxVersions);
            toDelete.forEach(v => {
                fs.rmSync(path.join(versionsDir, v), { recursive: true, force: true });
            });
        }
    }

    return { filesSynced, syncId };
}
