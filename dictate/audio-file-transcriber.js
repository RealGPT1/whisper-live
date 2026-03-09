// Audio file transcription module
// Handles decoding and transcribing audio files using the shared Whisper worker.
// Uses IDs starting at 1_000_000 to avoid colliding with live mic transcription IDs.
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

export function cancelCurrentFileTranscription() {
  currentAbortController?.abort();
}

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
 * Call this from the worker's onmessage handler first.
 * Returns true if the message was handled (belongs to a file transcription).
 */
export function handleWorkerMessage(data) {
  const { id, type } = data;
  if (!pending.has(id)) return false;

  const { resolve, reject } = pending.get(id);
  pending.delete(id);

  if (type === 'transcription') {
    resolve(data.text || '');
  } else if (type === 'error') {
    reject(new Error(data.error || 'Transcription failed'));
  } else {
    pending.set(id, { resolve, reject });
    return false;
  }
  return true;
}

/**
 * Decode an audio File, resample to 16 kHz, split into chunks, and transcribe.
 * Returns a Promise that resolves with the full transcription text.
 *
 * @param {File} file            - Audio file to transcribe
 * @param {Worker} worker        - The shared Whisper web worker
 * @param {Function} [onStatus]  - Optional callback(string) for status messages
 * @param {Function} [onProgress]- Optional callback(completedChunks, totalChunks)
 */
export async function transcribeAudioFile(file, worker, onStatus, onProgress) {
  const abortController = new AbortController();
  currentAbortController = abortController;
  const { signal } = abortController;

  function checkCancelled() {
    if (signal.aborted) throw new DOMException('Import cancelled', 'AbortError');
  }

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
      worker.postMessage({ type: 'transcribe', audioData: chunk, id });
    });

    if (text) texts.push(text.trim());
    onProgress?.(i + 1, numChunks);
  }

  currentAbortController = null;
  return texts.join(' ');
}
