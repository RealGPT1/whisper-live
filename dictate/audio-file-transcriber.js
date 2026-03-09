// Audio file transcription module
// Uses its own dedicated worker (separate from the live-mic worker) so that:
//  - Live mic always uses whisper-tiny for low latency
//  - File import uses the quality selected in Settings, picked up fresh each import
//
// We split audio manually into CHUNK_S-second windows and send each to the worker
// as an independent clip. This bypasses the Transformers.js internal chunked pipeline
// (chunk_length_s option), which does not reliably cover the full audio — observed
// behaviour is that only the last context window (~30 s) is transcribed.

const SAMPLE_RATE = 16000;
const ID_BASE = 1_000_000;
const CHUNK_S = 28; // safely under Whisper's 30 s context limit
const CHUNK_SAMPLES = Math.round(CHUNK_S * SAMPLE_RATE);

let idCounter = ID_BASE;
const pending = new Map(); // id -> { resolve, reject }

let currentAbortController = null;

// Dedicated import worker, cached by quality so the model isn't reloaded
// on every import. Recreated automatically when the quality setting changes.
let importWorker = null;
let importWorkerQuality = null;
let importWorkerReady = null; // Promise<void>

function createImportWorker(quality, onStatus) {
  // Reject any in-flight chunk promises from the old worker
  for (const [id, { reject }] of pending) {
    reject(new Error('Import worker restarted'));
    pending.delete(id);
  }
  if (importWorker) importWorker.terminate();

  importWorker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  importWorkerQuality = quality;

  importWorkerReady = new Promise((resolve, reject) => {
    importWorker.onmessage = (e) => {
      const { type, id } = e.data;

      // Model loading lifecycle
      if (type === 'ready') { resolve(); return; }
      if (type === 'progress') { onStatus?.(`Loading model… ${e.data.progress}%`); return; }
      if (type === 'status')   { onStatus?.(e.data.text); return; }
      if (type === 'error' && id === undefined) { reject(new Error(e.data.error)); return; }

      // Chunk transcription results
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);

      if (type === 'transcription') {
        const text = (e.data.text || '').trim().replace(/^["""'']+|["""'']+$/g, '').trim();
        entry.resolve(text);
      } else if (type === 'error') {
        entry.reject(new Error(e.data.error || 'Transcription failed'));
      }
    };

    importWorker.onerror = (err) => reject(new Error('Worker error: ' + err.message));
  });

  importWorker.postMessage({ type: 'load', modelQuality: quality });
  return importWorkerReady;
}

async function ensureImportWorker(quality, onStatus) {
  if (importWorker && importWorkerQuality === quality) {
    return importWorkerReady; // already loaded (or loading) with the right model
  }
  return createImportWorker(quality, onStatus);
}

export function cancelCurrentFileTranscription() {
  currentAbortController?.abort();
}

// No longer needed — file transcription messages go to the import worker, not the
// main worker. Kept as a stub so the import in app.js doesn't need updating.
export function handleWorkerMessage(_data) { return false; }

function resampleToTarget(input, inRate, outRate) {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const outLength = Math.round(input.length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const t = idx - i0;
    out[i] = (1 - t) * input[i0] + t * input[i1];
  }
  return out;
}

/**
 * Decode an audio File, resample to 16 kHz, split into chunks, and transcribe.
 * Uses a dedicated worker loaded with the quality from Settings (read fresh each call).
 * Returns a Promise that resolves with the full transcription text.
 *
 * @param {File} file            - Audio file to transcribe
 * @param {Function} [onStatus]  - Optional callback(string) for status messages
 * @param {Function} [onProgress]- Optional callback(completedChunks, totalChunks)
 */
export async function transcribeAudioFile(file, onStatus, onProgress) {
  const quality = localStorage.getItem('modelQuality') || 'low';

  const abortController = new AbortController();
  currentAbortController = abortController;
  const { signal } = abortController;

  function checkCancelled() {
    if (signal.aborted) throw new DOMException('Import cancelled', 'AbortError');
  }

  // Ensure the import worker is ready with the correct model.
  // If quality changed since last import this recreates the worker.
  const needsLoad = !importWorker || importWorkerQuality !== quality;
  if (needsLoad) onStatus?.('Loading transcription model…');
  await ensureImportWorker(quality, onStatus);
  checkCancelled();

  onStatus?.('Reading audio file…');
  const arrayBuffer = await file.arrayBuffer();
  checkCancelled();

  onStatus?.('Decoding audio…');
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    await audioCtx.close();
  }
  checkCancelled();

  // Mix down to mono
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;
  const mono = new Float32Array(length);
  for (let c = 0; c < numChannels; c++) {
    const ch = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += ch[i];
  }
  if (numChannels > 1) {
    for (let i = 0; i < length; i++) mono[i] /= numChannels;
  }

  const resampled = resampleToTarget(mono, audioBuffer.sampleRate, SAMPLE_RATE);

  const durationSec = resampled.length / SAMPLE_RATE;
  const durationLabel = durationSec >= 60
    ? `${Math.floor(durationSec / 60)}m ${Math.round(durationSec % 60)}s`
    : `${Math.round(durationSec)}s`;

  const numChunks = Math.ceil(resampled.length / CHUNK_SAMPLES);
  onProgress?.(0, numChunks);
  onStatus?.(`Transcribing ${durationLabel} of audio…`);

  const texts = [];

  for (let i = 0; i < numChunks; i++) {
    checkCancelled();

    const start = i * CHUNK_SAMPLES;
    const chunk = resampled.slice(start, Math.min(start + CHUNK_SAMPLES, resampled.length));
    const id = ++idCounter;

    const text = await new Promise((resolve, reject) => {
      const onAbort = () => {
        pending.delete(id);
        reject(new DOMException('Import cancelled', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.set(id, {
        resolve: (t) => { signal.removeEventListener('abort', onAbort); resolve(t); },
        reject: (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
      });
      importWorker.postMessage({ type: 'transcribe', audioData: chunk, id });
    });

    if (text) texts.push(text.trim());
    onProgress?.(i + 1, numChunks);
  }

  currentAbortController = null;
  return texts.join(' ');
}
