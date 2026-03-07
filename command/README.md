# Whisper Live

Browser-based voice command transcription using Whisper AI. Runs entirely in the browser with no server required.

## Features

- Real-time speech-to-text using Whisper (tiny.en model)
- WebGPU acceleration with WASM fallback
- Automatic speech detection with adjustable threshold
- Intent classification for voice commands
- Dark mode support
- Keyboard shortcuts: Space to toggle, R to force transcription

## Intent Classification

The app classifies spoken commands into intents:

| Intent | Triggers | Example |
|--------|----------|---------|
| **search** | "search for", "find", "look up", "google" | "Search for restaurants nearby" |
| **navigate-to** | "go to", "open", "show me", "take me to" | "Go to settings" |
| **question** | "what is", "who is", "how do", "explain" | "What is the weather today" |
| **other** | (fallback) | Any unmatched command |

Fuzzy matching is used to handle minor speech recognition errors.

## Usage

1. Open `index.html` in a browser (requires HTTPS or localhost)
2. Wait for the model to load
3. Press the play button or Space to start listening
4. Speak commands - they'll be transcribed and classified
5. Drag the red threshold marker to adjust mic sensitivity

## Files

- `app.js` - Main application logic
- `worker.js` - Web Worker for Whisper transcription
- `audio-processor.js` - AudioWorklet for mic capture
- `intents.js` - Intent classification with fuzzy matching
- `styles.css` - UI styles with dark mode
- `index.html` - Application shell

## Requirements

- Modern browser with AudioWorklet support
- Microphone access
- WebGPU for best performance (falls back to WASM)
