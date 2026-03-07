import { classifyIntent } from './intents.js';

// ----- CONFIG -----
const SILENCE_MS = 800;
const MIN_SPEECH_MS = 300;
const SAMPLE_RATE = 16000;
const MAX_THRESHOLD = 0.1;

const DEFAULT_THRESHOLD_PERCENT = 10;
let thresholdPercent = parseFloat(localStorage.getItem('thresholdPercent')) || DEFAULT_THRESHOLD_PERCENT;
let silenceThreshold = (thresholdPercent / 100) * MAX_THRESHOLD;
// ------------------

const toggleBtn = document.getElementById('toggleBtn');
const toggleIcon = document.getElementById('toggleIcon');
const toggleLabel = document.getElementById('toggleLabel');
const statusEl = document.getElementById('status');
const darkModeBtn = document.getElementById('darkModeBtn');
const darkModeIcon = document.getElementById('darkModeIcon');

// Dark mode
function setDarkMode(enabled) {
  document.documentElement.setAttribute('data-theme', enabled ? 'dark' : 'light');
  darkModeIcon.classList.toggle('bi-moon-fill', !enabled);
  darkModeIcon.classList.toggle('bi-sun-fill', enabled);
  localStorage.setItem('darkMode', enabled ? '1' : '0');
}

// Initialize dark mode from localStorage
const savedDarkMode = localStorage.getItem('darkMode') === '1';
setDarkMode(savedDarkMode);

darkModeBtn.addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  setDarkMode(!isDark);
});
let running = false;
const commandsEl = document.getElementById('commands');
const levelBar = document.getElementById('levelBar');
const audioMeter = document.getElementById('audioMeter');
const thresholdMarker = document.getElementById('thresholdMarker');
const stateSpeaking = document.getElementById('stateSpeaking');
const stateProcessing = document.getElementById('stateProcessing');

function updateThresholdMarker() {
  thresholdMarker.style.left = `calc(${thresholdPercent}% - 2px)`;
}
updateThresholdMarker();

// Draggable threshold (mouse + touch)
let dragging = false;

function startDrag(e) {
  dragging = true;
  e.preventDefault();
}

function endDrag() {
  dragging = false;
}

function moveDrag(e) {
  if (!dragging) return;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const rect = audioMeter.getBoundingClientRect();
  let pct = ((clientX - rect.left) / rect.width) * 100;
  pct = Math.max(2, Math.min(98, pct));
  thresholdPercent = pct;
  silenceThreshold = (pct / 100) * MAX_THRESHOLD;
  updateThresholdMarker();
  localStorage.setItem('thresholdPercent', pct);
}

thresholdMarker.addEventListener('mousedown', startDrag);
thresholdMarker.addEventListener('touchstart', startDrag, { passive: false });
document.addEventListener('mouseup', endDrag);
document.addEventListener('touchend', endDrag);
document.addEventListener('mousemove', moveDrag);
document.addEventListener('touchmove', moveDrag, { passive: false });

let audioCtx = null;
let micStream = null;
let workletNode = null;
let buffer = [];
let lastSpokeAt = 0;
let speechStartedAt = 0;
let talking = false;
let hasCommands = false;
let transcriptionId = 0;
let pendingTranscriptions = 0;

// Worker for background transcription
let worker = null;
let modelReady = false;
let onModelReady = null;

function log(...args) { console.log(...args); }

function initWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  modelReady = false;

  worker.onmessage = (e) => {
    const { type, text, id, duration, took, progress, error } = e.data;

    if (type === 'progress') {
      status(`Loading... ${progress}%`);
    } else if (type === 'ready') {
      const deviceLabel = e.data.device === 'webgpu' ? 'WebGPU' : 'WASM';
      log(`worker: model ready (${deviceLabel})`);
      status('Ready');
      modelReady = true;
      toggleBtn.disabled = false;
      if (onModelReady) onModelReady();
    } else if (type === 'status') {
      status(e.data.text);
    } else if (type === 'transcription') {
      pendingTranscriptions--;
      log(`transcription #${id} took ${took}ms, duration: ${duration.toFixed(2)}s`);

      if (text) {
        const isNoise = /^\[.*\]$|^\(.*\)$|^\{.*\}$|^\*.*\*$/i.test(text);
        if (isNoise) {
          log('filtered noise:', text);
        } else {
          addCommand(text);
        }
      } else {
        log('no text returned');
      }

      updateProcessingState();
    } else if (type === 'error') {
      log('worker error:', error);
      pendingTranscriptions--;
      updateProcessingState();
    }
  };

  worker.onerror = (err) => {
    log('worker error:', err);
    status('Worker error');
  };
}

function updateProcessingState() {
  if (pendingTranscriptions > 0) {
    stateProcessing.classList.add('active');
    if (!talking) {
      status(`Processing (${pendingTranscriptions} pending)...`);
    }
  } else {
    stateProcessing.classList.remove('active');
    if (!talking) {
      status('Ready');
    }
  }
}

function setState(state) {
  stateSpeaking.classList.toggle('active', state === 'speaking');
  if (state === 'processing') {
    stateProcessing.classList.add('active');
  }
  // Don't remove processing state here - let updateProcessingState handle it
}

function rms(samples) {
  let s = 0;
  for (let i = 0; i < samples.length; i++) { const v = samples[i]; s += v * v; }
  return Math.sqrt(s / samples.length);
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

function status(txt) { statusEl.textContent = txt; }

function updateToggleButton() {
  if (running) {
    toggleBtn.classList.remove('btn-success');
    toggleBtn.classList.add('btn-danger');
    toggleIcon.classList.remove('bi-play-fill');
    toggleIcon.classList.add('bi-stop-fill');
    toggleLabel.textContent = 'Stop';
  } else {
    toggleBtn.classList.remove('btn-danger');
    toggleBtn.classList.add('btn-success');
    toggleIcon.classList.remove('bi-stop-fill');
    toggleIcon.classList.add('bi-play-fill');
    toggleLabel.textContent = 'Start';
  }
}

async function startCapture() {
  running = true;
  updateToggleButton();

  // Wait for model to be ready before starting audio
  if (!modelReady) {
    status('Waiting for model...');
    await new Promise(resolve => { onModelReady = resolve; });
    onModelReady = null;
  }

  audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule('audio-processor.js');

  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const source = audioCtx.createMediaStreamSource(micStream);

  workletNode = new AudioWorkletNode(audioCtx, 'audio-processor');
  source.connect(workletNode);

  const inputSampleRate = audioCtx.sampleRate;

  workletNode.port.onmessage = (ev) => {
    const { samples, rms: r } = ev.data;

    const levelPct = Math.min(100, (r / MAX_THRESHOLD) * 100);
    levelBar.style.width = levelPct + '%';

    const now = performance.now();

    if (r > silenceThreshold) {
      lastSpokeAt = now;
      if (!talking) {
        talking = true;
        speechStartedAt = now;
        buffer = [];
        log('speech started, RMS:', r.toFixed(4));
        status('Listening...');
        setState('speaking');
      }
      if (talking) buffer.push(samples);
    } else {
      if (talking) buffer.push(samples);

      if (talking && (now - lastSpokeAt) > SILENCE_MS) {
        const speechDuration = lastSpokeAt - speechStartedAt;

        if (speechDuration < MIN_SPEECH_MS) {
          log('speech too short:', speechDuration.toFixed(0) + 'ms');
          buffer = [];
          talking = false;
          stateSpeaking.classList.remove('active');
          updateProcessingState();
          return;
        }

        log('pause detected, duration:', speechDuration.toFixed(0) + 'ms');
        talking = false;
        stateSpeaking.classList.remove('active');

        // Send to worker for background transcription
        const assembled = flattenFloat32Array(buffer);
        buffer = [];

        const resampled = resampleToTarget(assembled, inputSampleRate, SAMPLE_RATE);
        const id = ++transcriptionId;
        pendingTranscriptions++;

        log(`sending audio clip #${id} to worker, ${resampled.length} samples`);
        worker.postMessage({ type: 'transcribe', audioData: resampled, id });

        updateProcessingState();
      }
    }
  };

  status('Listening...');
}

function flattenFloat32Array(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function addCommand(txt) {
  const { intent, object } = classifyIntent(txt);

  if (!hasCommands) {
    commandsEl.innerHTML = '';
    hasCommands = true;
  }

  const el = document.createElement('div');
  el.className = `command-card intent-${intent || 'other'}`;

  const intentIcon = {
    'search': 'bi-search',
    'navigate-to': 'bi-arrow-right-circle',
    'question': 'bi-question-circle',
    'other': 'bi-chat'
  }[intent] || 'bi-chat';

  el.innerHTML = `
    <div class="command-speech">
      <i class="bi bi-quote text-muted me-1"></i>${txt}
    </div>
    <div class="command-meta">
      <span class="command-badge badge-intent">
        <i class="bi ${intentIcon}"></i>${intent || 'unknown'}
      </span>
      ${object ? `<span class="command-badge badge-object"><i class="bi bi-box"></i>${object}</span>` : ''}
    </div>
  `;

  commandsEl.prepend(el);
  log('result:', { text: txt, intent, object });
  log('');
}

async function stopCapture() {
  running = false;
  updateToggleButton();
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  if (audioCtx) { await audioCtx.close(); audioCtx = null; }
  // Keep worker alive for instant restart
  buffer = [];
  talking = false;
  pendingTranscriptions = 0;
  stateSpeaking.classList.remove('active');
  stateProcessing.classList.remove('active');
  status(modelReady ? 'Ready' : 'Stopped');
}

toggleBtn.addEventListener('click', async () => {
  if (running) {
    await stopCapture();
  } else {
    try { await startCapture(); }
    catch (e) { log('start failed', e); status('Start failed'); running = false; updateToggleButton(); }
  }
});

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  // Space to toggle start/stop (ignore if typing in an input)
  if (e.code === 'Space' && !e.target.closest('input, textarea')) {
    e.preventDefault();
    toggleBtn.click();
    return;
  }

  // Press R to force transcription
  if (e.key.toLowerCase() === 'r' && buffer.length > 0 && worker) {
    log('manual transcribe');
    talking = false;
    stateSpeaking.classList.remove('active');

    const assembled = flattenFloat32Array(buffer);
    buffer = [];

    const resampled = resampleToTarget(assembled, audioCtx ? audioCtx.sampleRate : SAMPLE_RATE, SAMPLE_RATE);
    const id = ++transcriptionId;
    pendingTranscriptions++;

    worker.postMessage({ type: 'transcribe', audioData: resampled, id });
    updateProcessingState();
  }
});

// Preload model on init
initWorker();
worker.postMessage({ type: 'load' });
log('App loaded');
