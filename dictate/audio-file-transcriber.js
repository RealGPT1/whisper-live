// Audio file transcription module
// Handles decoding and transcribing audio files using the shared Whisper worker.
// Uses IDs starting at 1_000_000 to avoid colliding with live mic transcription IDs.

const SAMPLE_RATE = 16000;
const ID_BASE = 1_000_000;

let idCounter = ID_BASE;
const pending = new Map(); // id -> { resolve, reject }

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
    // Unexpected type for a tracked ID — put it back and don't intercept
    pending.set(id, { resolve, reject });
    return false;
  }
  return true;
}

/**
 * Decode an audio File, resample to 16 kHz, and send to the shared worker.
 * Returns a Promise that resolves with the transcription text.
 *
 * @param {File} file          - Audio file to transcribe
 * @param {Worker} worker      - The shared Whisper web worker
 * @param {Function} [onStatus] - Optional callback(string) for progress messages
 */
export async function transcribeAudioFile(file, worker, onStatus) {
  onStatus?.('Reading audio file…');

  const arrayBuffer = await file.arrayBuffer();

  onStatus?.('Decoding audio…');
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } finally {
    await audioCtx.close();
  }

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

  onStatus?.('Transcribing…');
  const id = ++idCounter;

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'transcribe', audioData: resampled, id });
  });
}
