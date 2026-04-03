import { analyzeFilesAI, checkModelStatus, parseAOResponse } from '../ollama_utils.js';
import axios from 'axios';

console.log('--- Commencing Ollama Utils Test Suite ---');

let testsPassed = 0;
let testsFailed = 0;

// Test 1: Advanced parsing over heavily hallucinated LLM responses
const badLLMResponse = `
Here is your analysis based on my internal heuristics:
\`\`\`json
{
  "saves/slot1.sav": { "category": "Save", "description": "Auto-saved checkpoint data." },
  "config/settings.ini": { "category": "Config", "description": "Graphics configurations.", }
}
\`\`\`
I hope this helps your script correctly catalog the files! Please let me know if you need more data!
`;

let parsed = parseAOResponse(badLLMResponse);
if (parsed["saves/slot1.sav"] && parsed["saves/slot1.sav"].category === "Save") {
    console.log('✅ PASS: parseAOResponse gracefully extracted JSON wrapped in conversational chatter and trailing commas.');
    testsPassed++;
} else {
    console.log('❌ FAIL: parseAOResponse failed to extract JSON.');
    testsFailed++;
}

// Override Axios calls to create a mock infrastructure globally for this runtime execution 
const originalPost = axios.post;
axios.post = async (url, data) => {
    if (url.includes('/api/generate')) {
        return {
            data: {
                response: '{"system.log": { "category": "Cache", "description": "Temp cache log file." }}'
            }
        };
    }
    throw new Error('Unexpected network call');
};

const originalGet = axios.get;
axios.get = async (url) => {
    if (url.includes('/api/tags')) {
        return {
            data: { models: [{ name: "qwen3.5:0.8b" }] }
        };
    }
    throw new Error('Unexpected get call');
}

// Test 2: Full Integration Wrapper Call
async function performAITest() {
    try {
        const mockFiles = [ { path: 'system.log', size: 1024, category: 'Other' } ];
        const res = await analyzeFilesAI('http://mockserver:11434', 'qwen3.5:0.8b', 'TestGame', mockFiles);
        if (res.success && res.analysis['system.log'].category === 'Cache') {
            console.log('✅ PASS: analyzeFilesAI executed via mocked axios and returned correct metadata.');
            testsPassed++;
        } else {
            console.log('❌ FAIL: analyzeFilesAI returned invalid metadata.');
            testsFailed++;
        }

        const stats = await checkModelStatus('http://mockserver:11434', 'qwen3.5:0.8b');
        if (stats.success && stats.exists) {
            console.log('✅ PASS: checkModelStatus recognized valid model string.');
            testsPassed++;
        } else {
             console.log('❌ FAIL: checkModelStatus validation misfired.');
             testsFailed++;
        }

        console.log(`\n--- Test Suite Complete ---\nPassed: ${testsPassed} | Failed: ${testsFailed}`);
        if (testsFailed > 0) process.exit(1);
    } finally {
        // Restore
        axios.post = originalPost;
        axios.get = originalGet;
    }
}

performAITest();
