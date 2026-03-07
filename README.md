# Whisper Live

Browser-based real-time speech transcription powered by [Whisper](https://github.com/openai/whisper). Everything runs locally in the browser — no server, no API keys, no data sent anywhere.

## Apps

### [dictate/](dictate/)
Pure speech-to-text. Speak and each utterance appears as a card. Click the copy icon to send any transcription to the clipboard.

### [intent/](intent/)
Speech-to-text with intent classification. Spoken commands are labelled as **search**, **navigate-to**, **question**, or **other** using fuzzy keyword matching.

## How it works

- **Whisper tiny.en** model runs entirely in the browser via [Transformers.js](https://github.com/xenova/transformers.js)
- **WebGPU** is used when available, with automatic fallback to WASM
- Audio is captured via `getUserMedia` and processed in an `AudioWorklet`
- Voice activity detection uses RMS energy with a draggable threshold marker
- Transcription runs in a `Web Worker` to keep the UI responsive

## Usage

Open either app's `index.html` via a local server (HTTPS or localhost required for mic access):

```bash
npx serve .
# then open http://localhost:3000/dictate or /intent
```

1. Wait for the model to load (~10–30s first run, cached after)
2. Press **Start** or **Space** to begin listening
3. Speak — transcriptions appear as cards, newest first
4. Drag the **red threshold marker** left/right to adjust mic sensitivity
5. Press **R** to force-transcribe the current buffer

## Requirements

- Modern browser with `AudioWorklet` support (Chrome, Edge, Firefox)
- Microphone access
- WebGPU for best performance (Chrome 113+, Edge 113+)
