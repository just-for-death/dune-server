import { findSaveFolders } from '../backend/local_scanner.js';
import fs from 'fs';

async function runTest() {
    console.log('--- Testing Local Save Discovery ---');
    
    // Testing the User's actual AppData/Local path based on previous lsblk
    const testPath = '/mnt/Windows X-Lite/Users/Admin/AppData/Local';
    
    if (!fs.existsSync(testPath)) {
        console.log(`❌ Test path ${testPath} does not exist. Are you sure the drive is mounted?`);
        return;
    }

    console.log(`Scanning ${testPath}...`);
    const folders = findSaveFolders(testPath, 1); // Depth 1 to find direct game folders
    
    console.log('Found candidates:');
    folders.forEach(f => console.log(`- ${f}`));

    if (folders.length > 0) {
        console.log('\n✅ Local discovery logic working!');
    } else {
        console.log('\n⚠️ No save candidates found in this specific path.');
    }
}

runTest();
