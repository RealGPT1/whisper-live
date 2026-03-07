# Whisper Live - dictate

Browser-based voice transcription using Whisper AI. Runs entirely in the browser with no server required.

## Features

- Real-time speech-to-text using Whisper (tiny.en model)
- WebGPU acceleration with WASM fallback
- Automatic speech detection with adjustable threshold
- Copy any transcription to clipboard with one click
- Dark mode support
- Keyboard shortcuts: Space to toggle, R to force transcription

## Usage

1. Open `index.html` in a browser (requires HTTPS or localhost)
2. Wait for the model to load
3. Press the play button or Space to start listening
4. Speak — transcriptions appear as cards, newest first
5. Click the copy icon on any card to copy the text to clipboard
6. Drag the red threshold marker to adjust mic sensitivity

## Files

- `app.js` - Main application logic
- `worker.js` - Web Worker for Whisper transcription
- `audio-processor.js` - AudioWorklet for mic capture
- `styles.css` - UI styles with dark mode
- `index.html` - Application shell

## Requirements

- Modern browser with AudioWorklet support
- Microphone access
- WebGPU for best performance (falls back to WASM)
