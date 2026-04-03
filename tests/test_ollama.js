import { analyzeFilesAI } from '../backend/ollama_utils.js';
import axios from 'axios';

// Mock axios
const mockAxios = {
    post: async (url, data) => {
        console.log('MOCK POST to:', url);
        if (data.prompt.includes('test_game')) {
            return {
                data: {
                    response: JSON.stringify({
                        "saves/test.sav": { "category": "Save", "description": "Mocked analysis." }
                    })
                }
            };
        }
        throw new Error('Unexpected prompt');
    }
};

// Simple test runner
async function runTests() {
    console.log('--- Testing Ollama Utils ---');

    const mockFiles = [
        { path: 'saves/test.sav', size: 10240, category: 'Other' },
        { path: 'config/user.cfg', size: 50, category: 'Other' }
    ];

    try {
        // Test with mocked axios in the environment
        // Note: For a real test we'd use a testing framework, but here we just check logic.
        const res = await analyzeFilesAI('http://mock', 'model', 'test_game', mockFiles);
        console.log('Analysis Result:', JSON.stringify(res, null, 2));
        
        if (res.success && res.analysis['saves/test.sav']) {
            console.log('✅ Basic analysis test passed!');
        } else {
            console.log('❌ Basic analysis test failed!');
        }

    } catch (e) {
        console.error('Test threw error:', e);
    }
}

runTests();
