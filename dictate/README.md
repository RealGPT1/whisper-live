# Whisper Live - Dictate

Browser-based speech transcription using OpenAI's Whisper AI. Runs entirely in the browser — no server, no uploads, complete privacy.

## Features

- **Live dictation** — real-time speech-to-text with automatic silence detection
- **File import** — transcribe WAV, MP3, M4A, OGG, WebM, FLAC, AAC files
- **Selectable model quality for file import** — Low (whisper-tiny), Medium (whisper-base), High (whisper-small)
- Live dictation always uses whisper-tiny for minimum latency regardless of the quality setting
- WebGPU acceleration with WASM fallback
- Adjustable silence threshold (drag the red marker on the audio meter)
- Click any transcript item to edit or delete it
- Copy transcript to clipboard or save as a text file
- Persist transcripts across sessions via local storage
- Dark mode

## Models

| Setting | Model | Use |
|---------|-------|-----|
| Low (default) | whisper-tiny.en | Live dictation & file import |
| Medium | whisper-base.en | File import only |
| High | whisper-small.en | File import only |

Live dictation is always whisper-tiny regardless of the file import setting.

## Usage

1. Open `index.html` in a browser (requires HTTPS or localhost)
2. Wait for the model to load
3. Press **Start** or **Space** to begin live dictation; press again to stop
4. Drag the red threshold marker to adjust mic sensitivity
5. To import an audio file, open the menu (☰) → **Import Audio**
6. Click any transcript item to edit or delete it
7. Use the clipboard icon to copy or save the full transcript

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| Space | Start / Stop recording |
| R | Force-transcribe the current audio buffer |

## Files

- `app.js` — main application logic
- `worker.js` — Web Worker for Whisper transcription (live mic and file import)
- `audio-file-transcriber.js` — file decoding, chunking, and import worker management
- `audio-processor.js` — AudioWorklet for microphone capture
- `styles.css` — UI styles with dark mode
- `index.html` — application shell

## Requirements

- Modern browser with AudioWorklet support (Chrome, Edge, Firefox)
- Microphone access for live dictation
- WebGPU for best performance (falls back to WASM automatically)
