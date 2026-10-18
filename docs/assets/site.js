// ClickHouse Dash home page. It has the video theatre, the sticky story, the install panel and the small motions.
// This code is progressive. The page is complete without it. The video has controls through the buttons that this code adds.
(() => {
  "use strict";
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fine = window.matchMedia("(pointer: fine)").matches;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  // Reveal on scroll. This code adds the class. A page without JavaScript shows everything.
  const revealTargets = $$(".inside h2, .feature, .otel h2, .otel .sub, .flow, .run h2, .platforms, .runStep, .runFoot, .foot > *");
  if (!reduce && "IntersectionObserver" in window) {
    const seen = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("in");
        seen.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    revealTargets.forEach((el, i) => { el.classList.add("reveal"); el.style.transitionDelay = `${(i % 4) * 70}ms`; seen.observe(el); });
  }

  // The player starts when the page is idle. The text, the fonts and the poster load first.
  // The video plays once, without an endless loop. The player pauses off screen and in hidden tabs.
  // It never starts by itself with reduced motion or Save-Data.
  const video = $("#tour-video");
  const frame = $("#tilt");
  const sound = $("#sound");
  const toggle = $("#toggle");
  const progress = $("#progress");
  const SPRITE = "assets/icons.svg#i-";
  if (video) {
    const saveData = !!(navigator.connection && navigator.connection.saveData);
    // Use Full HD by default. Use the 720p copy for Save-Data and for phones. This copy has a third of the weight.
    if (saveData || window.matchMedia("(max-width: 700px)").matches) video.src = video.getAttribute("src").replace("-1080.mp4", "-720.mp4");
    let wantsPlay = !reduce && !saveData;
    let hideTimer = 0;
    // The bar shows on hover and focus (CSS). It also shows when the video is paused or ended. It shows for a few seconds after a tap or at the start.
    const showBar = (ms = 3500) => {
      frame.classList.add("ui");
      clearTimeout(hideTimer);
      if (!video.paused) hideTimer = setTimeout(() => frame.classList.remove("ui"), ms);
    };
    const paint = () => {
      const idle = video.paused || video.ended;
      $("#toggleIcon").setAttribute("href", SPRITE + (idle ? "player-play" : "player-pause"));
      toggle.setAttribute("aria-label", video.ended ? "Replay the video" : idle ? "Play the video" : "Pause the video");
      sound.setAttribute("aria-pressed", String(!video.muted));
      $("#soundIcon").setAttribute("href", SPRITE + (video.muted ? "volume-off" : "volume"));
      $("span", sound).textContent = video.muted ? "Sound on" : "Sound off";
      if (idle) frame.classList.add("ui");
    };
    const play = () => { video.preload = "auto"; const p = video.play(); if (p && p.catch) p.catch(() => { wantsPlay = false; paint(); }); };
    const flip = () => { wantsPlay = video.paused || video.ended; if (wantsPlay) play(); else video.pause(); paint(); showBar(); };
    // Full screen: use the frame, so the bar stays. Use the video itself where only that is allowed (iOS Safari).
    const full = $("#full");
    const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
    const paintFull = () => {
      const on = fsElement() === frame;
      $("#fullIcon").setAttribute("href", SPRITE + (on ? "minimize" : "maximize"));
      full.setAttribute("aria-label", on ? "Leave full screen" : "Full screen");
    };
    if (frame.requestFullscreen || frame.webkitRequestFullscreen || video.webkitEnterFullscreen) {
      full.addEventListener("click", () => {
        if (fsElement()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
        if (frame.requestFullscreen) frame.requestFullscreen().catch(() => {});
        else if (frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
        else video.webkitEnterFullscreen();
        showBar();
      });
      document.addEventListener("fullscreenchange", paintFull);
      document.addEventListener("webkitfullscreenchange", paintFull);
    } else full.hidden = true;
    toggle.addEventListener("click", flip);
    video.addEventListener("click", flip);
    sound.addEventListener("click", () => { video.muted = !video.muted; if (video.paused || video.ended) { wantsPlay = true; play(); } paint(); showBar(); });
    let lastMove = 0;
    frame.addEventListener("pointermove", () => { const n = performance.now(); if (n - lastMove > 400) { lastMove = n; showBar(2500); } }, { passive: true });
    video.addEventListener("play", () => { paint(); showBar(); });
    video.addEventListener("pause", paint);
    video.addEventListener("ended", () => { wantsPlay = false; paint(); });
    video.addEventListener("timeupdate", () => {
      progress.style.transform = `scaleX(${Math.min(1, video.currentTime / (video.duration || 74.2))})`;
    });
    document.addEventListener("visibilitychange", () => { if (document.hidden && !video.paused) video.pause(); else if (!document.hidden && wantsPlay && visible) play(); });
    let visible = true;
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((entries) => {
        for (const entry of entries) {
          visible = entry.isIntersecting;
          if (visible && wantsPlay && !video.ended && video.preload !== "none") play();
          else if (!visible && !video.paused) video.pause();
        }
      }, { threshold: 0.35 }).observe(video);
    }
    paint();
    showBar(4500);
    // First start: after the load event, when the browser is idle
    const first = () => { if (wantsPlay && visible) play(); else if (wantsPlay) video.preload = "auto"; };
    const whenIdle = () => ("requestIdleCallback" in window ? requestIdleCallback(first, { timeout: 2000 }) : setTimeout(first, 600));
    if (document.readyState === "complete") whenIdle(); else window.addEventListener("load", whenIdle, { once: true });
  }

  // The packets of the flow move while the section is on screen.
  const flow = $(".flow");
  if (flow && "IntersectionObserver" in window) {
    new IntersectionObserver((entries) => entries.forEach((e) => flow.classList.toggle("is-live", e.isIntersecting)), { threshold: 0.1 }).observe(flow);
  } else if (flow) flow.classList.add("is-live");

  // Install panel: the platform selects the archive.
  const VERSION = "1.1.0";
  const BASE = `https://github.com/Circular-fi/Clickhouse-dash/releases/download/v${VERSION}`;
  const download = $("#cmd-download");
  const tabs = $$(".platforms button");
  const setPlatform = (tab) => {
    const archive = `chdash_${VERSION}_${tab.dataset.os}_${tab.dataset.arch}.tar.gz`;
    download.textContent = `curl -fsSLO ${BASE}/${archive}\ntar xzf ${archive}`;
    if (window.chdashHighlight) window.chdashHighlight(download, "sh");
    tabs.forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
  };
  tabs.forEach((tab) => tab.addEventListener("click", () => setPlatform(tab)));
  // Most Macs use Apple silicon today. The other tabs stay one click away.
  if (/Mac/i.test(navigator.platform || navigator.userAgent)) setPlatform(tabs.find((t) => t.dataset.os === "darwin" && t.dataset.arch === "arm64") || tabs[0]);
  else if (/aarch64|arm64/i.test(navigator.userAgent)) setPlatform(tabs.find((t) => t.dataset.os === "linux" && t.dataset.arch === "arm64") || tabs[0]);

  // Copy buttons
  $$(".copy").forEach((button) => button.addEventListener("click", async () => {
    const text = document.getElementById(button.dataset.copy).textContent;
    try { await navigator.clipboard.writeText(text); } catch (error) {
      const area = document.createElement("textarea"); area.value = text; document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove();
    }
    const span = $("span", button);
    span.textContent = "Copied";
    button.classList.add("done");
    setTimeout(() => { span.textContent = "Copy"; button.classList.remove("done"); }, 1600);
  }));
})();
