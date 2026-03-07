class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const samples = input[0];
      // Calculate RMS
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        sum += samples[i] * samples[i];
      }
      const rms = Math.sqrt(sum / samples.length);

      // Send audio data and RMS to main thread
      this.port.postMessage({
        samples: new Float32Array(samples),
        rms
      });
    }
    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor);
