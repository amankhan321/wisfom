#!/bin/bash
echo ""
echo "  🎬  PortraitShift — Video Converter"
echo "  ======================================"
echo ""

if ! command -v ffmpeg &> /dev/null; then
  echo "  ❌  FFmpeg not found. Install it:"
  echo "      macOS:   brew install ffmpeg"
  echo "      Ubuntu:  sudo apt install ffmpeg"
  exit 1
fi

if ! command -v node &> /dev/null; then
  echo "  ❌  Node.js not found. Install from https://nodejs.org"
  exit 1
fi

echo "  ✅  FFmpeg: $(ffmpeg -version 2>&1 | head -1 | cut -d' ' -f3)"
echo "  ✅  Node.js: $(node --version)"
echo ""

if [ ! -d "node_modules" ]; then
  echo "  📦  Installing dependencies..."
  npm install
fi

echo "  🚀  Starting on http://localhost:3000"
echo ""
node server.js
