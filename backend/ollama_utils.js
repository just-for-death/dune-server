import axios from 'axios';

/**
 * Clean and parse JSON from LLM response
 * Robust against conversational "chatter", markdown formatting, and minor syntax errors
 */
export function parseAOResponse(raw) {
    if (!raw || typeof raw !== 'string') return {};
    
    let cleaned = raw.trim();

    // 1. Strip common markdown blocks
    cleaned = cleaned.replace(/```json\s*/gi, '').replace(/```\s*/g, '');

    // 2. Direct simple parse
    try {
        return JSON.parse(cleaned);
    } catch (e) {
        // Continue to robust extraction
    }

    // 3. Extract the outermost JSON object strictly
    const firstOpen = cleaned.indexOf('{');
    const lastClose = cleaned.lastIndexOf('}');
    
    if (firstOpen !== -1 && lastClose !== -1 && lastClose >= firstOpen) {
        let potentialJson = cleaned.substring(firstOpen, lastClose + 1);
        try {
            return JSON.parse(potentialJson);
        } catch (innerErr) {
            // 4. Attempt to fix common LLM JSON syntax errors
            // Remove trailing commas before closing braces/brackets
            potentialJson = potentialJson.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
            try {
                return JSON.parse(potentialJson);
            } catch (finalErr) {
                console.error('Final JSON recovery attempt failed:', finalErr.message);
                console.error('Violating String snippet:', potentialJson.substring(0, 50) + '...');
            }
        }
    }
    
    return {};
}

/**
 * Build an optimized prompt for file analysis tailored for strict JSON response
 */
function buildAnalysisPrompt(gameName, files) {
    const fileListStr = files.map(f => 
        `- Path: "${f.path}" | Size: ${Math.round(f.size / 1024)}KB | Ext: ${f.path.split('.').pop()}`
    ).join('\n');

    return `
You are a highly analytical expert system parsing game save backups. Identify the category of each file provided from the game "${gameName}".

Categories must ONLY be one of exactly: "Save", "Config", "Cache", or "Other".
Descriptions must be exactly ONE sentence.

Rules:
1. "Save" files contain player progress (.sav, .bin, .dat, .sl2).
2. "Config" files contain user settings (.ini, .json, .xml, .cfg).
3. "Cache" files are temporary and disposable (.tmp, .log).
4. Do NOT output any conversational text. Return ONLY a valid JSON object.

FILES:
${fileListStr}

JSON FORMAT EXAMPLES:
{
  "path/to/file1.ext": { "category": "Save", "description": "Specific purpose." },
  "path/to/file2.ext": { "category": "Config", "description": "Specific purpose." }
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
            // Provide exact JSON enforcement if the server supports it natively
            format: 'json'
        }, { timeout: 180000 }); // 3 minutes timeout

        const analysis = parseAOResponse(response.data.response);
        
        if (Object.keys(analysis).length === 0) {
            return { success: false, message: 'Ollama returned an invalid or empty formatting.' };
        }

        return { success: true, analysis };
    } catch (err) {
        let errorMessage = err.message;
        
        if (err.response?.data?.error) {
            errorMessage = err.response.data.error;
        }

        // Catch specific network issues
        if (err.code === 'ECONNREFUSED') {
            errorMessage = `Could not connect to Ollama at ${endpoint}. Ensure the Ollama engine is running.`;
        } else if (err.code === 'ENOTFOUND') {
            errorMessage = `Ollama server endpoint address not found: ${endpoint}`;
        }
        
        // Handle VRAM overflow crashes for low-end GPUs
        if (errorMessage.toLowerCase().includes('llama runner process has terminated') || errorMessage.toLowerCase().includes('out of memory')) {
            errorMessage = 'Ollama analysis failed: GPU VRAM Overflow. Try closing your browser or switching to a smaller model.';
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
        let msg = err.message;
        if (err.code === 'ECONNREFUSED') msg = 'Ollama server is offline connection refused.';
        return { success: false, message: msg };
    }
}
