const players = [];
let activePlayer = null;

const audioVariantByLabel = {
  cloning: {
    "Warm reference": "reference",
    "Dry reference": "reference",
    "Breathy reference": "reference",
    "Bright reference": "reference",
    "Soft reference": "reference",
    Target: "ground_truth",
    "VAE reconstruction": "vae_reconstruction",
    TokenSynth: "tokensynth",
    CTD: "ctd",
    LiveSynth: "livesynth"
  },
  text: {
    "TokenSynth · Raw": "tokensynth_raw",
    "TokenSynth · Procrustes": "tokensynth_procrustes",
    "LiveSynth · Raw": "livesynth_raw",
    "LiveSynth · Procrustes": "livesynth_procrustes"
  },
  morphing: {
    "Reference A": "reference_a",
    "Reference B": "reference_b",
    "Morph A to B": "livesynth_morph"
  }
};

function resolveAudioSource(slot) {
  const group = slot.closest("[data-player-group]")?.dataset.playerGroup;
  if (!group) return null;
  const [task, rawIndex] = group.split("-");
  const index = String(rawIndex).padStart(2, "0");
  const folder = task === "clone" ? "cloning" : task === "morph" ? "morphing" : task;
  if (task === "continue") return `audio/continuation/${index}_livesynth_full.flac`;
  const variants = audioVariantByLabel[folder];
  const variant = variants?.[slot.dataset.audioSlot];
  return variant ? `audio/${folder}/${index}_${variant}.flac` : null;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeWaveform(container, seed, count = 44) {
  if (!container || container.children.length) return;
  const random = seededRandom(Number(seed) || 1);
  for (let i = 0; i < count; i += 1) {
    const bar = document.createElement("i");
    bar.className = "wave-bar";
    const envelope = 0.56 + 0.44 * Math.sin((i / count) * Math.PI);
    const amp = Math.round((18 + random() * 78) * envelope);
    bar.style.setProperty("--amp", amp);
    container.appendChild(bar);
  }
}

function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

function createToneWav(seed, duration = 5, profile = "live") {
  const sampleRate = 12000;
  const sampleCount = Math.floor(sampleRate * duration);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  const random = seededRandom(seed);
  const base = 98 * Math.pow(2, (seed % 15) / 12);
  const notes = [0, 7, 12, 3, 10, 5, 12, 7];

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, sampleCount * 2, true);

  const timbre = {
    reference: [1, .28, .12, .05],
    clean: [1, .42, .19, .08],
    token: [1, .35, .25, .14],
    diffusion: [1, .52, .22, .1],
    live: [1, .46, .16, .07],
    hero: [1, .44, .2, .08],
    morph: [1, .32, .22, .1],
    continuation: [1, .45, .18, .08]
  }[profile] || [1, .4, .2, .08];

  let phase = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate;
    const stepLength = profile === "continuation" && t > duration / 2 ? .38 : .52;
    const step = Math.floor(t / stepLength);
    const note = notes[(step + seed) % notes.length];
    const freq = base * Math.pow(2, note / 12);
    phase += 2 * Math.PI * freq / sampleRate;
    const local = (t % stepLength) / stepLength;
    const attack = Math.min(1, local * 22);
    const decay = Math.exp(-local * (profile === "reference" ? 2.2 : 3.8));
    let value = 0;
    timbre.forEach((gain, harmonic) => {
      value += gain * Math.sin(phase * (harmonic + 1) + harmonic * .23);
    });
    if (profile === "morph") {
      const mix = t / duration;
      value = (1 - mix) * value + mix * (Math.sin(phase) + .55 * Math.sin(phase * 5));
    }
    value *= .18 * attack * decay;
    value += (random() - .5) * (profile === "token" ? .018 : .005);
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, value)) * 32767, true);
  }
  return URL.createObjectURL(new Blob([view], { type: "audio/wav" }));
}

function formatTime(value, round = false) {
  const seconds = Math.max(0, round ? Math.round(value) : Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function pauseAll(except = null) {
  players.forEach((player) => {
    if (player !== except) player.audio.pause();
  });
}

function stopProgressLoop(player) {
  if (player.animationFrame !== null) {
    cancelAnimationFrame(player.animationFrame);
    player.animationFrame = null;
  }
}

function startProgressLoop(player) {
  stopProgressLoop(player);
  const tick = () => {
    updatePlayer(player);
    if (!player.audio.paused && !player.audio.ended) {
      player.animationFrame = requestAnimationFrame(tick);
    } else {
      player.animationFrame = null;
    }
  };
  player.animationFrame = requestAnimationFrame(tick);
}

function updatePlayer(player) {
  const duration = Number.isFinite(player.audio.duration) ? player.audio.duration : player.duration;
  const progress = duration ? player.audio.currentTime / duration : 0;
  const played = Math.floor(progress * player.bars.length);
  player.bars.forEach((bar, index) => bar.classList.toggle("played", index < played));
  player.time.textContent = `${formatTime(player.audio.currentTime)} / ${formatTime(duration, true)}`;
  player.button.classList.toggle("is-playing", !player.audio.paused);
  player.button.setAttribute("aria-label", player.audio.paused ? `Play ${player.name}` : `Pause ${player.name}`);
  player.slot.style.setProperty("--audio-progress", `${progress * 100}%`);

  if (player.hero) {
    player.hero.style.setProperty("--progress", progress);
    const heroTime = player.hero.querySelector(".hero-time");
    if (heroTime) heroTime.textContent = `${formatTime(player.audio.currentTime)} / ${formatTime(duration, true)}`;
  }
}

function initializePlayer(slot, options = {}) {
  const name = slot.dataset.audioSlot || options.name || "Audio example";
  const seed = Number(slot.dataset.seed || options.seed || 1);
  const profile = slot.dataset.profile || options.profile || "live";
  const duration = Number(slot.dataset.duration || options.duration || (profile === "continuation" || profile === "morph" || profile === "hero" ? 10 : 5));
  const preserved = [...slot.children];
  const wrapper = document.createElement("div");
  wrapper.className = "audio-player";
  wrapper.innerHTML = `
    <div class="audio-player-top">
      <button class="player-button" type="button"><span class="play-icon" aria-hidden="true"></span></button>
      <span class="audio-player-name"></span>
      <div class="waveform" data-waveform></div>
      <span class="player-time">0:00 / ${formatTime(duration, true)}</span>
    </div>`;
  preserved.forEach((child) => slot.appendChild(child));
  slot.appendChild(wrapper);

  const audio = new Audio();
  audio.preload = "metadata";
  audio.src = slot.dataset.src || createToneWav(seed, duration, profile);
  const button = wrapper.querySelector(".player-button");
  const waveform = wrapper.querySelector(".waveform");
  const time = wrapper.querySelector(".player-time");
  wrapper.querySelector(".audio-player-name").textContent = name;
  makeWaveform(waveform, seed);

  const player = { slot, wrapper, audio, button, waveform, time, name, duration, bars: [...waveform.children], hero: null, animationFrame: null };
  players.push(player);

  button.setAttribute("aria-label", `Play ${name}`);
  button.addEventListener("click", async () => {
    if (!audio.paused) {
      audio.pause();
      return;
    }
    const group = slot.closest("[data-player-group]");
    const previousTime = activePlayer && activePlayer.slot.closest("[data-player-group]") === group ? activePlayer.audio.currentTime : 0;
    pauseAll(player);
    if (previousTime > 0 && previousTime < duration) audio.currentTime = previousTime;
    activePlayer = player;
    try { await audio.play(); } catch (_) { /* Browser may block playback before interaction. */ }
  });
  waveform.addEventListener("click", (event) => {
    const rect = waveform.getBoundingClientRect();
    audio.currentTime = ((event.clientX - rect.left) / rect.width) * (audio.duration || duration);
    updatePlayer(player);
  });
  audio.addEventListener("play", () => startProgressLoop(player));
  audio.addEventListener("pause", () => { stopProgressLoop(player); updatePlayer(player); });
  audio.addEventListener("loadedmetadata", () => updatePlayer(player));
  audio.addEventListener("timeupdate", () => updatePlayer(player));
  audio.addEventListener("ended", () => { stopProgressLoop(player); audio.currentTime = 0; updatePlayer(player); });
  updatePlayer(player);
  return player;
}

document.querySelectorAll("[data-audio-slot]").forEach((slot) => {
  const source = resolveAudioSource(slot);
  if (source) slot.dataset.src = source;
  initializePlayer(slot);
});

document.querySelectorAll("[data-demo-player]").forEach((button) => {
  const hero = button.closest(".signal-demo");
  const seed = Number(button.dataset.seed || 91);
  const duration = Number(button.dataset.duration || 10);
  const profile = button.dataset.profile || "hero";
  const audio = new Audio(createToneWav(seed, duration, profile));
  const waveform = hero.querySelector("[data-waveform]");
  makeWaveform(waveform, seed, 70);
  const hiddenTime = document.createElement("span");
  hiddenTime.hidden = true;
  const player = { slot: hero, wrapper: hero, audio, button, waveform, time: hiddenTime, name: "streaming example", duration, bars: [...waveform.children], hero, animationFrame: null };
  players.push(player);
  button.addEventListener("click", async () => {
    if (!audio.paused) return audio.pause();
    pauseAll(player);
    activePlayer = player;
    try { await audio.play(); } catch (_) { /* Browser may block playback before interaction. */ }
  });
  audio.addEventListener("play", () => startProgressLoop(player));
  audio.addEventListener("pause", () => { stopProgressLoop(player); updatePlayer(player); });
  audio.addEventListener("timeupdate", () => updatePlayer(player));
  audio.addEventListener("ended", () => { stopProgressLoop(player); audio.currentTime = 0; updatePlayer(player); });
  waveform.addEventListener("click", (event) => {
    const rect = waveform.getBoundingClientRect();
    audio.currentTime = ((event.clientX - rect.left) / rect.width) * duration;
  });
  updatePlayer(player);
});

document.querySelectorAll(".stop-all").forEach((button) => button.addEventListener("click", () => pauseAll()));

const navLinks = [...document.querySelectorAll(".task-nav a")];
const sections = navLinks.map((link) => document.querySelector(link.getAttribute("href"))).filter(Boolean);
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      navLinks.forEach((link) => link.classList.toggle("active", link.getAttribute("href") === `#${entry.target.id}`));
    });
  }, { rootMargin: "-25% 0px -65%", threshold: 0 });
  sections.forEach((section) => observer.observe(section));
}
