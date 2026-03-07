import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.1';

// Silence ONNX runtime warnings
env.backends.onnx.logSeverityLevel = 3;

const SAMPLE_RATE = 16000;
const MODEL_ID = 'onnx-community/whisper-tiny.en';

let model = null;
let device = 'wasm';

async function loadModel() {
  // Check WebGPU availability
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        device = 'webgpu';
        self.postMessage({ type: 'status', text: 'Loading model (WebGPU)...' });
      }
    } catch (e) {
      // WebGPU not available, fall back to WASM
    }
  }

  if (device === 'wasm') {
    self.postMessage({ type: 'status', text: 'Loading model (WASM)...' });
  }

  try {
    model = await pipeline('automatic-speech-recognition', MODEL_ID, {
      device,
      dtype: {
        encoder_model: device === 'webgpu' ? 'fp32' : 'q8',
        decoder_model_merged: device === 'webgpu' ? 'q4' : 'q8',
      },
      progress_callback: (progress) => {
        if (progress.status === 'progress') {
          self.postMessage({ type: 'progress', progress: Math.round(progress.progress) });
        }
      }
    });
    self.postMessage({ type: 'ready', device });
  } catch (err) {
    self.postMessage({ type: 'error', error: 'Model load failed: ' + err.message });
  }
}

async function transcribe(audioData, id) {
  if (!model) {
    self.postMessage({ type: 'error', error: 'Model not loaded' });
    return;
  }

  const start = performance.now();

  try {
    const result = await model(audioData, {
      sampling_rate: SAMPLE_RATE,
      return_timestamps: false
    });

    const took = Math.round(performance.now() - start);
    const text = result?.text?.trim() || '';

    self.postMessage({
      type: 'transcription',
      id,
      text,
      duration: audioData.length / SAMPLE_RATE,
      took
    });
  } catch (err) {
    self.postMessage({ type: 'error', error: 'Transcription failed: ' + err.message, id });
  }
}

self.onmessage = async (e) => {
  const { type, audioData, id } = e.data;

  if (type === 'load') {
    await loadModel();
  } else if (type === 'transcribe') {
    await transcribe(audioData, id);
  }
};
