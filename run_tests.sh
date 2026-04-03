#!/bin/bash
echo "Starting Dune Server Tests..."

# The test environment has been fully relocated inside the `backend` folder module boundaries
# Node natively traverses upward from the FILE's physical directory, not CWD, for resolving ESM imports!

cd "$(dirname "$0")/backend" || exit
node test/test_ollama.js

if [ $? -eq 0 ]; then
    echo "✅ All tests passed successfully!"
else
    echo "❌ Some tests failed!"
    exit 1
fi
