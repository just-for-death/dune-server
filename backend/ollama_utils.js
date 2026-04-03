import axios from 'axios';

/**
 * Clean and parse JSON from LLM response
 * Handles conversational "chatter" before/after actual JSON
 */
function parseAOResponse(raw) {
    if (!raw) return {};
    try {
        // 1. Clean the string (sometimes LLMs add markdown code blocks)
        let cleaned = raw.trim();
        if (cleaned.startsWith('```json')) {
            cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
        } else if (cleaned.startsWith('```')) {
            cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
        }

        // 2. Attempt direct parse
        return JSON.parse(cleaned);
    } catch (e) {
        // 3. Robust regex to find the outermost JSON object
        // This handles cases where the LLM talks before or after the JSON
        const firstOpen = raw.indexOf('{');
        const lastClose = raw.lastIndexOf('}');
        
        if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
            const potentialJson = raw.substring(firstOpen, lastClose + 1);
            try {
                return JSON.parse(potentialJson);
            } catch (inner) {
                console.error('LLM JSON parsing failed even after extraction:', inner.message);
                // Attempt to fix common LLM JSON errors (like trailing commas)
                const fixed = potentialJson.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
                try {
                    return JSON.parse(fixed);
                } catch (final) {
                    console.error('Final JSON recovery attempt failed.');
                }
            }
        }
    }
    return {};
}

/**
 * Build an optimized prompt for file analysis
 */
function buildAnalysisPrompt(gameName, files) {
    const fileListStr = files.map(f => 
        `- Path: "${f.path}" | Size: ${Math.round(f.size / 1024)}KB | Initial Category: ${f.category}`
    ).join('\n');

    return `
You are a game save file expert. I will give you a list of files from a backup of the game "${gameName}".
For each file, determine its category (Save, Config, Cache, or Other) and write a 1-sentence description of its purpose.

Rules:
1. "Save" files usually have extensions like .sav, .bin, .dat or are in a "Saved Games" or "Saves" directory.
2. "Config" files often have .ini, .xml, .json, .cfg, .yaml extensions and contain settings.
3. "Cache" files are temporary and can be safely ignored (e.g., .tmp, .log, Unity cache).
4. Use the provided file size as a hint: Large binary files are more likely to be Saves than Configs.

FILES TO ANALYZE:
${fileListStr}

Return ONLY a valid JSON object where keys are the original file paths and values are objects with "category" and "description" fields.
Example structure:
{
  "path/to/slot1.sav": { "category": "Save", "description": "Binary save data for player progress." }
}
    `.trim();
}

/**
 * Main analysis function
 */
export async function analyzeFilesAI(endpoint, model, gameName, files) {
    try {
        const prompt = buildAnalysisPrompt(gameName, files);
        
        const response = await axios.post(`${endpoint}/api/generate`, {
            model: model,
            prompt: prompt,
            stream: false,
            format: 'json'
        }, { timeout: 180000 }); // 3-minute timeout for stability on slower GPUs

        const analysis = parseAOResponse(response.data.response);
        return { success: true, analysis };
    } catch (err) {
        let errorMessage = err.response?.data?.error || err.message;
        
        // Handle VRAM / Memory crashes specifically for low-VRAM GPUs (GTX 1650)
        if (errorMessage.toLowerCase().includes('llama runner process has terminated')) {
            errorMessage = 'Ollama analysis failed: GPU VRAM Overflow. Your GTX 1650 (4GB) is out of memory. Try closing your browser or switching to a smaller model like qwen2.5:1.5b.';
        }

        console.error('Ollama Analysis Error:', errorMessage);
        return { 
            success: false, 
            message: errorMessage 
        };
    }
}

/**
 * Check if a model is pulled and ready
 */
export async function checkModelStatus(endpoint, model) {
    try {
        const response = await axios.get(`${endpoint}/api/tags`, { timeout: 5000 });
        const exists = response.data.models?.some(m => m.name === model || m.name.split(':')[0] === model);
        return { success: true, exists };
    } catch (err) {
        return { success: false, message: err.message };
    }
}
