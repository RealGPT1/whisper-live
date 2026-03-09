import { transcribeAudioFile, cancelCurrentFileTranscription, handleWorkerMessage as handleFileWorkerMessage } from './audio-file-transcriber.js';

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
const titleMicIcon = document.getElementById('titleMicIcon');

// Dark mode
function setDarkMode(enabled) {
  document.documentElement.setAttribute('data-theme', enabled ? 'dark' : 'light');
  darkModeIcon.classList.toggle('bi-moon-fill', !enabled);
  darkModeIcon.classList.toggle('bi-sun-fill', enabled);
  localStorage.setItem('darkMode', enabled ? '1' : '0');
}

const savedDarkMode = localStorage.getItem('darkMode') === '1';
setDarkMode(savedDarkMode);

darkModeBtn.addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  setDarkMode(!isDark);
});

let running = false;
const dictationsEl = document.getElementById('dictations');
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
let hasDictations = false;
let transcriptionId = 0;
let pendingTranscriptions = 0;

// Track whether user has manually scrolled away from bottom
let userScrolledAway = false;

dictationsEl.addEventListener('scroll', () => {
  const { scrollTop, scrollHeight, clientHeight } = dictationsEl;
  const distFromBottom = scrollHeight - scrollTop - clientHeight;
  userScrolledAway = distFromBottom > 20;
});

function scrollToBottom() {
  if (!userScrolledAway) {
    dictationsEl.scrollTop = dictationsEl.scrollHeight;
  }
}

// Worker for background transcription
let worker = null;
let modelReady = false;
let onModelReady = null;

function log(...args) { console.log(...args); }

function initWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  modelReady = false;

  worker.onmessage = (e) => {
    // Let the file transcriber intercept messages that belong to it
    if (handleFileWorkerMessage(e.data)) return;

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
          addDictation(text);
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

function setMicIconListening(isListening) {
  if (isListening) {
    titleMicIcon.classList.remove('bi-mic-mute-fill');
    titleMicIcon.classList.add('bi-mic-fill');
  } else {
    titleMicIcon.classList.remove('bi-mic-fill');
    titleMicIcon.classList.add('bi-mic-mute-fill');
  }
}

function updateToggleButton() {
  if (running) {
    toggleBtn.classList.remove('btn-success');
    toggleBtn.classList.add('btn-danger');
    toggleIcon.classList.remove('bi-play-fill');
    toggleIcon.classList.add('bi-stop-fill');
    toggleLabel.textContent = 'Stop';
    setMicIconListening(true);
  } else {
    toggleBtn.classList.remove('btn-danger');
    toggleBtn.classList.add('btn-success');
    toggleIcon.classList.remove('bi-stop-fill');
    toggleIcon.classList.add('bi-play-fill');
    toggleLabel.textContent = 'Start';
    setMicIconListening(false);
  }
}

async function startCapture() {
  running = true;
  toggleBtn.disabled = true;
  updateToggleButton();

  if (!modelReady) {
    status('Waiting for model...');
    await new Promise(resolve => { onModelReady = resolve; });
    onModelReady = null;
  }

  audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule('audio-processor.js');

  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  if (!audioCtx) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
    toggleBtn.disabled = false;
    return;
  }

  toggleBtn.disabled = false;
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

// ----- Settings: save transcripts to local storage -----
let saveTranscriptsEnabled = localStorage.getItem('saveTranscripts') === '1';

function saveTranscriptsToStorage() {
  if (!saveTranscriptsEnabled) return;
  const texts = [...dictationsEl.querySelectorAll('.dictation-item')]
    .map(el => el.dataset.text || el.querySelector('.dictation-text').textContent.trim());
  localStorage.setItem('savedTranscript', JSON.stringify(texts));
}

function restoreTranscriptsFromStorage() {
  if (!saveTranscriptsEnabled) return;
  const saved = localStorage.getItem('savedTranscript');
  if (!saved) return;
  try {
    const texts = JSON.parse(saved);
    if (texts.length > 0) {
      texts.forEach(t => addDictation(t, false));
    }
  } catch (e) {
    log('failed to restore transcripts:', e);
  }
}
// -------------------------------------------------------

function addDictation(txt, doSave = true) {
  if (!hasDictations) {
    dictationsEl.innerHTML = '';
    hasDictations = true;
  }

  const el = document.createElement('div');
  el.className = 'dictation-item';
  el.dataset.text = txt;
  el.title = 'Click to edit';

  el.innerHTML = `<div class="dictation-text">${txt}</div>`;

  el.addEventListener('click', () => openItemModal(el));

  dictationsEl.appendChild(el);
  scrollToBottom();
  log('transcribed:', txt);

  if (doSave) saveTranscriptsToStorage();
}

function getAllTranscriptText() {
  return [...dictationsEl.querySelectorAll('.dictation-item')]
    .map(el => el.dataset.text || el.querySelector('.dictation-text').textContent.trim())
    .join('\n');
}

function clearTranscript() {
  hasDictations = false;
  userScrolledAway = false;
  dictationsEl.innerHTML = `
    <div class="empty-state">
      <i class="bi bi-mic d-block mb-2" style="font-size:3rem;"></i>
      <p class="mb-0 small">Speak to start transcribing</p>
    </div>
  `;
  localStorage.removeItem('savedTranscript');
}

function generateDefaultFilename() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.txt`;
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
    catch (e) { log('start failed', e); status('Start failed'); running = false; toggleBtn.disabled = false; updateToggleButton(); }
  }
});

// Keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.target.closest('input, textarea')) {
    e.preventDefault();
    toggleBtn.click();
    return;
  }

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

// ----- Transcript Options Modal (clipboard icon) -----
const transcriptOptionsBtn = document.getElementById('transcriptOptionsBtn');
const titleModalEl = document.getElementById('titleModal');
const titleModal = new bootstrap.Modal(titleModalEl);
const saveFilenameInput = document.getElementById('saveFilename');

transcriptOptionsBtn.addEventListener('click', () => {
  saveFilenameInput.value = generateDefaultFilename();
  titleModal.show();
});

document.getElementById('modalCopyBtn').addEventListener('click', () => {
  const text = getAllTranscriptText();
  if (!text) { titleModal.hide(); return; }
  navigator.clipboard.writeText(text).then(() => {
    titleModal.hide();
  });
});

document.getElementById('modalSaveBtn').addEventListener('click', () => {
  const text = getAllTranscriptText();
  if (!text) { titleModal.hide(); return; }
  const filename = saveFilenameInput.value.trim() || generateDefaultFilename();
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  titleModal.hide();
});

document.getElementById('modalNewBtn').addEventListener('click', () => {
  clearTranscript();
  titleModal.hide();
});

// ----- Transcript Item Edit Modal -----
const itemModalEl = document.getElementById('itemModal');
const itemModal = new bootstrap.Modal(itemModalEl);
const itemModalText = document.getElementById('itemModalText');
const itemModalCopyIcon = document.getElementById('itemModalCopyIcon');
let currentEditItem = null;

function openItemModal(el) {
  currentEditItem = el;
  itemModalText.value = el.dataset.text || el.querySelector('.dictation-text').textContent.trim();
  itemModal.show();
}

document.getElementById('itemModalUpdateBtn').addEventListener('click', () => {
  if (currentEditItem) {
    const newText = itemModalText.value;
    currentEditItem.dataset.text = newText;
    currentEditItem.querySelector('.dictation-text').textContent = newText;
    saveTranscriptsToStorage();
  }
  itemModal.hide();
});

document.getElementById('itemModalCopyBtn').addEventListener('click', () => {
  navigator.clipboard.writeText(itemModalText.value).then(() => {
    itemModalCopyIcon.classList.replace('bi-clipboard', 'bi-check2');
    setTimeout(() => itemModalCopyIcon.classList.replace('bi-check2', 'bi-clipboard'), 1500);
  });
});

document.getElementById('itemModalDeleteBtn').addEventListener('click', () => {
  if (currentEditItem) {
    currentEditItem.remove();
    if (!dictationsEl.querySelector('.dictation-item')) {
      hasDictations = false;
      dictationsEl.innerHTML = `
        <div class="empty-state">
          <i class="bi bi-mic d-block mb-2" style="font-size:3rem;"></i>
          <p class="mb-0 small">Speak to start transcribing</p>
        </div>
      `;
    }
    saveTranscriptsToStorage();
  }
  itemModal.hide();
});

document.getElementById('itemModalCancelBtn').addEventListener('click', () => {
  itemModal.hide();
});

// ----- Settings Modal -----
const settingsModalEl = document.getElementById('settingsModal');
const settingsModal = new bootstrap.Modal(settingsModalEl);
const saveToLocalStorageToggle = document.getElementById('saveToLocalStorageToggle');
const modelQualitySelect = document.getElementById('modelQualitySelect');

saveToLocalStorageToggle.checked = saveTranscriptsEnabled;

saveToLocalStorageToggle.addEventListener('change', () => {
  saveTranscriptsEnabled = saveToLocalStorageToggle.checked;
  localStorage.setItem('saveTranscripts', saveTranscriptsEnabled ? '1' : '0');
  if (saveTranscriptsEnabled) {
    saveTranscriptsToStorage();
  } else {
    localStorage.removeItem('savedTranscript');
  }
});

modelQualitySelect.value = localStorage.getItem('modelQuality') || 'low';
modelQualitySelect.addEventListener('change', () => {
  localStorage.setItem('modelQuality', modelQualitySelect.value);
});

document.getElementById('menuSettings').addEventListener('click', () => {
  settingsModal.show();
});

// ----- About Modal -----
const aboutModalEl = document.getElementById('aboutModal');
const aboutModal = new bootstrap.Modal(aboutModalEl);

document.getElementById('menuAbout').addEventListener('click', () => {
  aboutModal.show();
});

// ----- Import Audio Modal -----
const importAudioModalEl = document.getElementById('importAudioModal');
const importAudioModal = new bootstrap.Modal(importAudioModalEl);
const audioFileInput = document.getElementById('audioFileInput');
const transcribeFileBtn = document.getElementById('transcribeFileBtn');
const importAudioStatus = document.getElementById('importAudioStatus');
const cancelImportBtn = document.getElementById('cancelImportBtn');
const importProgressWrap = document.getElementById('importProgress');
const importProgressBar = document.getElementById('importProgressBar');

let importInProgress = false;

function updateImportProgress(completed, total) {
  importProgressWrap.style.display = '';
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  importProgressBar.style.width = pct + '%';
  importProgressBar.setAttribute('aria-valuenow', String(pct));
}

function resetImportModal() {
  importProgressWrap.style.display = 'none';
  importProgressBar.style.width = '0%';
  importInProgress = false;
  transcribeFileBtn.disabled = !audioFileInput.files.length;
  cancelImportBtn.textContent = 'Cancel';
}

document.getElementById('menuImportAudio').addEventListener('click', () => {
  audioFileInput.value = '';
  transcribeFileBtn.disabled = true;
  importAudioStatus.textContent = '';
  resetImportModal();
  importAudioModal.show();
});

audioFileInput.addEventListener('change', () => {
  transcribeFileBtn.disabled = !audioFileInput.files.length;
  if (audioFileInput.files.length) {
    importAudioStatus.textContent = `Selected: ${audioFileInput.files[0].name}`;
  }
});

cancelImportBtn.addEventListener('click', () => {
  if (importInProgress) {
    cancelCurrentFileTranscription();
    // Modal will close when the promise rejects/resolves
  } else {
    importAudioModal.hide();
  }
});

// Prevent closing via the X button or backdrop while import is in progress
importAudioModalEl.addEventListener('hide.bs.modal', (e) => {
  if (importInProgress) e.preventDefault();
});

transcribeFileBtn.addEventListener('click', async () => {
  const file = audioFileInput.files[0];
  if (!file) return;

  if (!modelReady) {
    importAudioStatus.textContent = 'Please wait for the model to finish loading…';
    return;
  }

  importInProgress = true;
  transcribeFileBtn.disabled = true;
  cancelImportBtn.textContent = 'Cancel Import';

  try {
    const text = await transcribeAudioFile(
      file,
      (msg) => { importAudioStatus.textContent = msg; },
      (completed, total) => { updateImportProgress(completed, total); },
    );

    if (text) {
      const isNoise = /^\[.*\]$|^\(.*\)$|^\{.*\}$|^\*.*\*$/i.test(text);
      if (!isNoise) {
        addDictation(text);
        importAudioStatus.textContent = 'Transcription complete!';
        importInProgress = false;
        setTimeout(() => importAudioModal.hide(), 900);
      } else {
        importAudioStatus.textContent = 'No speech detected in file.';
        resetImportModal();
      }
    } else {
      importAudioStatus.textContent = 'No speech detected in file.';
      resetImportModal();
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      log('file import cancelled');
      resetImportModal();
      importAudioModal.hide();
      return;
    }
    log('file transcription error:', err);
    importAudioStatus.textContent = `Error: ${err.message}`;
    resetImportModal();
  }
});

// Restore saved transcripts on load (before model starts, DOM is ready)
restoreTranscriptsFromStorage();

// Preload model on init
initWorker();
// Main worker always uses whisper-tiny for live mic latency.
// File import uses its own separate worker with the quality from Settings.
worker.postMessage({ type: 'load', modelQuality: 'low' });
log('App loaded');
