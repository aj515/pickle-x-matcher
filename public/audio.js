/* Pickle X Matcher — Web Audio Synthesizer & Haptic Engine.
 * Zero external audio files; pure Web Audio API synthesis for instant response.
 */
'use strict';
window.PXAudio = (() => {
  let ctx = null;
  const STORAGE_KEY = 'pxm:sound';
  let enabled = localStorage.getItem(STORAGE_KEY) !== '0';

  function getContext() {
    if (!ctx && (window.AudioContext || window.webkitAudioContext)) {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        ctx = null;
      }
    }
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  // Unlock audio context on user gesture
  function unlock() {
    getContext();
  }

  function isEnabled() {
    return enabled;
  }

  function setEnabled(val) {
    enabled = !!val;
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
    } catch (e) {}
  }

  function toggle() {
    setEnabled(!enabled);
    if (enabled) play('tap');
    return enabled;
  }

  function buzz(pattern = 10) {
    try {
      if (navigator.vibrate) {
        navigator.vibrate(pattern);
      }
    } catch (e) {}
  }

  /**
   * Play procedural sound effect by name
   */
  function play(type) {
    if (!enabled) return;
    const ac = getContext();
    if (!ac) return;

    const t = ac.currentTime;

    try {
      switch (type) {
        // Paddle hit / button tap: short wooden pop (30ms)
        case 'tap':
        case 'pop': {
          buzz(8);
          const osc = ac.createOscillator();
          const gain = ac.createGain();
          const filter = ac.createBiquadFilter();

          filter.type = 'bandpass';
          filter.frequency.setValueAtTime(680, t);
          filter.Q.setValueAtTime(3.5, t);

          osc.type = 'triangle';
          osc.frequency.setValueAtTime(260, t);
          osc.frequency.exponentialRampToValueAtTime(80, t + 0.035);

          gain.gain.setValueAtTime(0.35, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.035);

          osc.connect(filter);
          filter.connect(gain);
          gain.connect(ac.destination);

          osc.start(t);
          osc.stop(t + 0.04);
          break;
        }

        // Player check-in chime: bright ascending double chime (D5 -> A5)
        case 'checkin': {
          buzz([15, 30, 25]);
          const notes = [587.33, 880.0]; // D5, A5
          notes.forEach((freq, idx) => {
            const st = t + idx * 0.09;
            const osc = ac.createOscillator();
            const gain = ac.createGain();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, st);
            osc.frequency.exponentialRampToValueAtTime(freq * 1.02, st + 0.18);

            gain.gain.setValueAtTime(0.28, st);
            gain.gain.exponentialRampToValueAtTime(0.001, st + 0.22);

            osc.connect(gain);
            gain.connect(ac.destination);

            osc.start(st);
            osc.stop(st + 0.24);
          });
          break;
        }

        // Camera QR scan success: bright confirmation chime (1046Hz -> 1318Hz -> 1568Hz)
        case 'scanSuccess': {
          buzz([30, 40, 60]);
          const notes = [1046.5, 1318.5, 1567.98]; // C6, E6, G6
          notes.forEach((freq, idx) => {
            const st = t + idx * 0.07;
            const osc = ac.createOscillator();
            const gain = ac.createGain();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, st);

            gain.gain.setValueAtTime(0.22, st);
            gain.gain.exponentialRampToValueAtTime(0.001, st + 0.16);

            osc.connect(gain);
            gain.connect(ac.destination);

            osc.start(st);
            osc.stop(st + 0.18);
          });
          break;
        }

        // Court match started / whistle: energetic game whistle chord
        case 'matchStart':
        case 'whistle': {
          buzz([40, 50, 40, 50, 80]);
          // Whistle tone with subtle vibrato
          const osc1 = ac.createOscillator();
          const osc2 = ac.createOscillator();
          const gain = ac.createGain();

          osc1.type = 'sine';
          osc2.type = 'sine';

          osc1.frequency.setValueAtTime(1760, t); // A6
          osc1.frequency.linearRampToValueAtTime(2093, t + 0.12); // C7
          osc1.frequency.setValueAtTime(2093, t + 0.28);

          osc2.frequency.setValueAtTime(1765, t); // slight beat
          osc2.frequency.linearRampToValueAtTime(2100, t + 0.12);

          gain.gain.setValueAtTime(0.25, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);

          osc1.connect(gain);
          osc2.connect(gain);
          gain.connect(ac.destination);

          osc1.start(t);
          osc2.start(t);
          osc1.stop(t + 0.36);
          osc2.stop(t + 0.36);
          break;
        }

        // Game victory / score recorded: triumph arpeggio (C5 - E5 - G5 - C6)
        case 'victory':
        case 'gameFinish': {
          buzz([30, 40, 30, 40, 100]);
          const notes = [523.25, 659.25, 783.99, 1046.5];
          notes.forEach((freq, idx) => {
            const st = t + idx * 0.08;
            const osc = ac.createOscillator();
            const gain = ac.createGain();

            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, st);

            gain.gain.setValueAtTime(0.24, st);
            gain.gain.exponentialRampToValueAtTime(0.001, st + 0.32);

            osc.connect(gain);
            gain.connect(ac.destination);

            osc.start(st);
            osc.stop(st + 0.35);
          });
          break;
        }

        // Point score stepper: subtle high ping
        case 'scorePoint': {
          buzz(12);
          const osc = ac.createOscillator();
          const gain = ac.createGain();

          osc.type = 'sine';
          osc.frequency.setValueAtTime(740, t);
          osc.frequency.exponentialRampToValueAtTime(980, t + 0.06);

          gain.gain.setValueAtTime(0.2, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);

          osc.connect(gain);
          gain.connect(ac.destination);

          osc.start(t);
          osc.stop(t + 0.08);
          break;
        }

        // Undo: descending slide
        case 'undo': {
          buzz(15);
          const osc = ac.createOscillator();
          const gain = ac.createGain();

          osc.type = 'sine';
          osc.frequency.setValueAtTime(580, t);
          osc.frequency.exponentialRampToValueAtTime(240, t + 0.14);

          gain.gain.setValueAtTime(0.25, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);

          osc.connect(gain);
          gain.connect(ac.destination);

          osc.start(t);
          osc.stop(t + 0.18);
          break;
        }

        // Error / warning: low double buzz
        case 'error': {
          buzz([40, 50, 40]);
          [0, 0.11].forEach((delay) => {
            const st = t + delay;
            const osc = ac.createOscillator();
            const gain = ac.createGain();

            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(180, st);

            gain.gain.setValueAtTime(0.18, st);
            gain.gain.exponentialRampToValueAtTime(0.001, st + 0.08);

            osc.connect(gain);
            gain.connect(ac.destination);

            osc.start(st);
            osc.stop(st + 0.09);
          });
          break;
        }
      }
    } catch (e) {
      // Audio playback failed silently
    }
  }

  // Pre-unlock on any user interaction
  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
  window.addEventListener('keydown', unlock, { once: true, passive: true });

  return {
    unlock,
    play,
    buzz,
    isEnabled,
    setEnabled,
    toggle,
  };
})();
