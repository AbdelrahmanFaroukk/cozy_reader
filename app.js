// Cozy Reader — PWA app logic.
// Vanilla JS. PDF.js + epub.js. IndexedDB storage. No build step.

(() => {
  "use strict";

  // ---------- Helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const fmt = {
    short(n) {
      if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k";
      return String(n);
    },
    mins(ms) {
      const m = Math.round(ms / 60000);
      if (m < 60) return m + "m";
      const h = Math.floor(m / 60), rem = m % 60;
      return rem ? `${h}h ${rem}m` : `${h}h`;
    },
    dateKey(ts) {
      const d = new Date(ts);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    },
    relTime(ts) {
      const diff = Date.now() - ts;
      const m = Math.round(diff / 60000);
      if (m < 1) return "just now";
      if (m < 60) return `${m}m ago`;
      const h = Math.round(m / 60);
      if (h < 24) return `${h}h ago`;
      const d = Math.round(h / 24);
      return `${d}d ago`;
    },
  };
  const toast = (msg, ms = 2000) => {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add("hidden"), ms);
  };
  const waitFor = (cond, timeoutMs = 15000) =>
    new Promise((res, rej) => {
      const t0 = Date.now();
      (function poll() {
        if (cond()) return res();
        if (Date.now() - t0 > timeoutMs) return rej(new Error("timeout"));
        setTimeout(poll, 50);
      })();
    });
  function escapeHtml(s = "") {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- IndexedDB ----------
  const DB_NAME = "cozy-reader";
  const DB_VERSION = 3;
  let dbp = null;
  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        const trans = req.transaction;
        if (e.oldVersion < 1) {
          const s = db.createObjectStore("books", { keyPath: "id" });
          s.createIndex("addedAt", "addedAt");
          s.createIndex("lastReadAt", "lastReadAt");
          const ss = db.createObjectStore("sessions", { keyPath: "id", autoIncrement: true });
          ss.createIndex("bookId", "bookId");
          ss.createIndex("endAt", "endAt");
          db.createObjectStore("prefs", { keyPath: "key" });
        }
        if (e.oldVersion < 2) {
          if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "id" });
          const booksStore = trans.objectStore("books");
          const filesStore = trans.objectStore("files");
          const cursorReq = booksStore.openCursor();
          cursorReq.onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (!cursor) return;
            const b = cursor.value;
            if (b && b.fileBlob) {
              filesStore.put({ id: b.id, blob: b.fileBlob });
              delete b.fileBlob;
              cursor.update(b);
            }
            cursor.continue();
          };
        }
        if (e.oldVersion < 3) {
          if (!db.objectStoreNames.contains("highlights")) {
            const hs = db.createObjectStore("highlights", { keyPath: "id" });
            hs.createIndex("bookId", "bookId");
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function tx(store, mode = "readonly") {
    const db = await openDB();
    return db.transaction(store, mode).objectStore(store);
  }
  const idb = {
    async put(store, val) { const s = await tx(store, "readwrite"); return new Promise((res, rej) => { const r = s.put(val); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async get(store, key) { const s = await tx(store); return new Promise((res, rej) => { const r = s.get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async del(store, key) { const s = await tx(store, "readwrite"); return new Promise((res, rej) => { const r = s.delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); },
    async all(store) { const s = await tx(store); return new Promise((res, rej) => { const r = s.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }); },
    async allByIndex(store, indexName, key) {
      const s = await tx(store);
      return new Promise((res, rej) => {
        const r = s.index(indexName).getAll(key);
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => rej(r.error);
      });
    },
    async clear(store) { const s = await tx(store, "readwrite"); return new Promise((res, rej) => { const r = s.clear(); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); },
  };

  // ---------- Prefs ----------
  const PREF_DEFAULTS = {
    theme: "light",        // light | sepia | dark
    pageWidth: 720,        // PDF page width
    brightness: 100,       // 40..100 (% effective)
    fontFamily: "Literata",
    fontSize: 18,          // EPUB px
    lineHeight: 16,        // EPUB 1.x10 (16 = 1.6)
    margin: 24,            // EPUB margin px
  };
  let cachedPrefs = { ...PREF_DEFAULTS };
  async function loadPrefs() {
    const all = await idb.all("prefs");
    const out = { ...PREF_DEFAULTS };
    for (const p of all) out[p.key] = p.value;
    return out;
  }
  async function setPref(key, value) {
    cachedPrefs[key] = value;
    await idb.put("prefs", { key, value });
  }

  // ---------- Theme ----------
  const THEME_BG = { light: "#fbf9f4", sepia: "#f3e8d2", dark: "#14130e" };
  function applyTheme(theme) {
    if (!["light", "sepia", "dark"].includes(theme)) theme = "light";
    document.documentElement.setAttribute("data-theme", theme);
    const meta = document.getElementById("themeColorMeta");
    if (meta) meta.setAttribute("content", THEME_BG[theme]);
    // Update quick-toggle icon
    const icon = document.getElementById("themeQuickIcon");
    if (icon) icon.textContent = theme === "dark" ? "light_mode" : "dark_mode";
    // Re-apply EPUB theme if reading
    if (readerState && readerState.format === "epub" && readerState.rendition) {
      applyEpubReaderStyles();
    }
    // Mark active theme pickers
    $$("[data-theme-pick]").forEach((b) => b.classList.toggle("is-active", b.dataset.themePick === theme));
  }
  function applyBrightness(pct) {
    const clamped = Math.max(40, Math.min(100, +pct || 100));
    const f = clamped >= 100 ? "" : `brightness(${(clamped / 100).toFixed(2)})`;
    const apply = (id) => { const el = document.getElementById(id); if (el) el.style.filter = f; };
    apply("pdfStage"); apply("epubStage");
  }

  // ---------- PDF helpers ----------
  async function loadPdfFromBlob(blob) {
    await waitFor(() => !!window.pdfjsLib);
    const buf = await blob.arrayBuffer();
    return await window.pdfjsLib.getDocument({ data: buf }).promise;
  }
  async function renderPageToCanvas(pdf, pageNum, canvas, cssWidth) {
    const page = await pdf.getPage(pageNum);
    const baseViewport = page.getViewport({ scale: 1 });
    const cssScale = cssWidth / baseViewport.width;
    const viewport = page.getViewport({ scale: cssScale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = viewport.width + "px";
    canvas.style.height = viewport.height + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return { page, viewport, cssScale };
  }
  async function renderPdfTextLayer(page, viewport, container, cssScale) {
    if (!container) return;
    container.innerHTML = "";
    container.style.width = viewport.width + "px";
    container.style.height = viewport.height + "px";
    container.style.setProperty("--scale-factor", String(cssScale));
    try {
      if (window.pdfjsLib && window.pdfjsLib.TextLayer) {
        const textContent = await page.getTextContent();
        const tl = new window.pdfjsLib.TextLayer({
          textContentSource: textContent,
          container, viewport,
        });
        await tl.render();
      }
    } catch (e) {
      // Text layer is a nice-to-have; failure shouldn't break reading.
      console.warn("text layer failed", e);
    }
  }
  async function extractPdfCoverBlob(pdf, maxWidth = 480) {
    const page = await pdf.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = maxWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });
    const c = document.createElement("canvas");
    c.width = Math.floor(viewport.width);
    c.height = Math.floor(viewport.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport }).promise;
    return await new Promise((res) => c.toBlob((b) => res(b), "image/jpeg", 0.82));
  }
  async function extractPdfMeta(pdf, fallback) {
    try {
      const md = await pdf.getMetadata();
      const info = md && md.info ? md.info : {};
      const title = (info.Title || "").trim();
      const author = (info.Author || "").trim();
      return { title: title || fallback, author: author || "Unknown author" };
    } catch { return { title: fallback, author: "Unknown author" }; }
  }

  // ---------- EPUB helpers ----------
  async function openEpubFromBlob(blob) {
    await waitFor(() => !!window.ePub);
    const buf = await blob.arrayBuffer();
    const book = window.ePub(buf);
    await book.ready;
    return book;
  }
  async function extractEpubCoverBlob(book) {
    try {
      const url = await book.coverUrl();
      if (!url) return null;
      const res = await fetch(url);
      if (!res.ok) return null;
      return await res.blob();
    } catch { return null; }
  }
  function getEpubMeta(book, fallback) {
    const m = (book.packaging && book.packaging.metadata) || {};
    return {
      title: (m.title || "").trim() || fallback,
      author: (m.creator || "").trim() || "Unknown author",
    };
  }

  // ---------- Cover URL cache ----------
  let coverUrls = new Map();
  function coverURL(book) {
    if (!book.coverBlob) return null;
    if (!coverUrls.has(book.id)) coverUrls.set(book.id, URL.createObjectURL(book.coverBlob));
    return coverUrls.get(book.id);
  }
  function revokeCovers() {
    for (const url of coverUrls.values()) URL.revokeObjectURL(url);
    coverUrls.clear();
  }

  // ---------- Slider behavior ----------
  function bindSlider(host) {
    const track = host.querySelector("[data-slider-track]");
    const left = host.querySelector('.slider-arrow[data-dir="-1"]');
    const right = host.querySelector('.slider-arrow[data-dir="1"]');
    const scrub = host.querySelector(".slider-scrub");
    function maxScroll() { return Math.max(0, track.scrollWidth - track.clientWidth); }
    function pct() { const max = maxScroll(); return max ? (track.scrollLeft / max) * 100 : 0; }
    function updateScrub() { const p = pct(); scrub.value = p; scrub.style.setProperty("--p", p + "%"); }
    function step(dir) {
      const card = track.querySelector(":scope > *");
      const cardW = card ? card.getBoundingClientRect().width + 16 : track.clientWidth * 0.8;
      track.scrollBy({ left: dir * cardW * 2, behavior: "smooth" });
    }
    left.addEventListener("click", () => step(-1));
    right.addEventListener("click", () => step(1));
    track.addEventListener("scroll", () => requestAnimationFrame(updateScrub), { passive: true });
    scrub.addEventListener("input", () => {
      const max = maxScroll();
      track.scrollLeft = (parseFloat(scrub.value) / 100) * max;
      scrub.style.setProperty("--p", scrub.value + "%");
    });
    requestAnimationFrame(updateScrub);
    function evalScrollable() {
      const scrollable = maxScroll() > 4;
      host.querySelector(".slider-controls").style.display = scrollable ? "" : "none";
    }
    evalScrollable();
    new ResizeObserver(evalScrollable).observe(track);
  }

  function bindRangeFill(input) {
    const update = () => {
      const min = parseFloat(input.min) || 0;
      const max = parseFloat(input.max) || 100;
      const val = parseFloat(input.value) || 0;
      const p = max === min ? 0 : ((val - min) / (max - min)) * 100;
      input.style.setProperty("--p", p + "%");
    };
    input.addEventListener("input", update);
    update();
  }

  // ---------- Router ----------
  const routes = {
    "#/library": renderLibrary,
    "#/progress": renderProgress,
    "#/settings": renderSettings,
  };
  let viewCleanup = null;
  function navigate(hash) {
    if (location.hash !== hash) { location.hash = hash; return; }
    handleRoute();
  }
  function activeNav() {
    const hash = location.hash || "#/library";
    const base = hash.split("/").slice(0, 2).join("/");
    $$(".route-btn").forEach((b) => {
      const t = b.dataset.route;
      b.classList.toggle("is-active", t === base);
    });
  }
  async function handleRoute() {
    if (viewCleanup) {
      try { await viewCleanup(); } catch (e) { console.error(e); }
      viewCleanup = null;
    }
    revokeCovers();
    activeNav();
    closeOptionsSheet();
    const hash = location.hash || "#/library";
    const inReader = hash.startsWith("#/reader/");
    document.body.classList.toggle("is-reader", inReader);
    if (inReader) {
      const id = decodeURIComponent(hash.slice("#/reader/".length));
      await renderReader(id);
      return;
    }
    const fn = routes[hash] || renderLibrary;
    await fn();
  }

  // ---------- Templates ----------
  function mountTemplate(id) {
    const root = $("#viewRoot");
    root.innerHTML = "";
    const tpl = $("#" + id);
    const node = tpl.content.cloneNode(true);
    root.appendChild(node);
    return root;
  }

  // ---------- Book card ----------
  function makeCard(book, opts = {}) {
    const wide = !!opts.wide;
    const wrap = document.createElement("article");
    wrap.className = "book-card" + (wide ? " wide" : "");
    wrap.dataset.id = book.id;
    const cur = book.lastPage || 0;
    const tot = book.pageCount || 0;
    const pct = tot ? Math.round((cur / tot) * 100) : 0;
    const url = coverURL(book);
    const formatBadge = book.format === "epub" ? `<span class="format-badge">EPUB</span>` : `<span class="format-badge">PDF</span>`;
    const coverInner = (url
      ? `<img alt="${escapeHtml(book.title)} cover" src="${url}" loading="lazy" decoding="async" />`
      : `<div class="placeholder">${escapeHtml(book.title.slice(0, 60))}</div>`
    ) + formatBadge;
    if (wide) {
      wrap.innerHTML = `
        <div class="row">
          <div class="cover">${coverInner}</div>
          <div class="meta">
            <span class="kicker">${book.lastReadAt ? "Reading · " + fmt.relTime(book.lastReadAt) : "Not started"}</span>
            <h4>${escapeHtml(book.title)}</h4>
            <p>${escapeHtml(book.author || "Unknown author")}</p>
            <div class="row-bottom">
              <div class="stats"><span>${pct}%</span><span>${tot ? `${Math.max(0, tot - cur)} ${book.format === 'epub' ? 'locations' : 'pages'} left` : "—"}</span></div>
              <div class="progress-line"><div style="width:${pct}%"></div></div>
            </div>
          </div>
        </div>`;
    } else {
      wrap.innerHTML = `
        <div class="cover">${coverInner}</div>
        ${tot ? `<div class="progress-line"><div style="width:${pct}%"></div></div>` : ""}
        <h4>${escapeHtml(book.title)}</h4>
        <p>${escapeHtml(book.author || "Unknown author")}</p>`;
    }
    wrap.addEventListener("click", () => navigate("#/reader/" + encodeURIComponent(book.id)));
    return wrap;
  }

  // ---------- Library ----------
  function bookProgress(b) {
    if (!b.pageCount || b.pageCount < 1) return 0;
    return Math.min(1, (b.lastPage || 0) / b.pageCount);
  }
  function isFinished(b) {
    return b.finishedAt || (b.pageCount > 0 && (b.lastPage || 0) >= b.pageCount);
  }
  function isStarted(b) { return (b.lastPage || 0) > 0 && !isFinished(b); }

  async function renderLibrary() {
    mountTemplate("tpl-library");
    const root = $("#viewRoot");
    const hr = new Date().getHours();
    const greet = hr < 5 ? "Still up, reader" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
    root.querySelector("[data-greet]").textContent = greet;

    const books = await idb.all("books");
    books.sort((a, b) => (b.lastReadAt || b.addedAt || 0) - (a.lastReadAt || a.addedAt || 0));

    const empty = root.querySelector("[data-empty]");
    if (!books.length) {
      empty.classList.remove("hidden");
      empty.querySelector('[data-act="empty-import"]').addEventListener("click", () => $("#pdfInput").click());
      root.querySelector("[data-subgreet]").textContent = "Add your first book to get started.";
      return;
    }
    empty.classList.add("hidden");
    root.querySelector("[data-subgreet]").textContent =
      `${books.length} book${books.length === 1 ? "" : "s"} on your shelf.`;

    const readingNow = books.filter(isStarted);
    const finished = books.filter(isFinished);
    fillSection(root.querySelector('[data-section="reading-now"]'), readingNow, { wide: true });
    fillSection(root.querySelector('[data-section="all-books"]'), books, { wide: false });
    fillSection(root.querySelector('[data-section="finished"]'), finished, { wide: false });
  }
  function fillSection(section, list, opts) {
    if (!list.length) { section.classList.add("hidden"); return; }
    section.classList.remove("hidden");
    const track = section.querySelector("[data-slider-track]");
    track.innerHTML = "";
    for (const b of list) track.appendChild(makeCard(b, opts));
    section.querySelector("[data-count]").textContent = `${list.length} book${list.length === 1 ? "" : "s"}`;
    bindRangeFill(section.querySelector(".slider-scrub"));
    bindSlider(section.querySelector("[data-slider-host]"));
  }

  // ---------- Progress ----------
  function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
  function daysAgo(n) { const d = startOfDay(); d.setDate(d.getDate() - n); return d; }
  async function renderProgress() {
    mountTemplate("tpl-progress");
    const root = $("#viewRoot");
    const [books, sessions] = await Promise.all([idb.all("books"), idb.all("sessions")]);
    const todayStart = startOfDay().getTime();
    const weekStart = daysAgo(6).getTime();

    const pagesToday = sessions.filter(s => s.endAt >= todayStart).reduce((a, s) => a + (s.pagesRead || 0), 0);
    const pagesWeek = sessions.filter(s => s.endAt >= weekStart).reduce((a, s) => a + (s.pagesRead || 0), 0);
    const pagesTotal = sessions.reduce((a, s) => a + (s.pagesRead || 0), 0);
    const msToday = sessions.filter(s => s.endAt >= todayStart).reduce((a, s) => a + (s.durationMs || 0), 0);
    const msWeek = sessions.filter(s => s.endAt >= weekStart).reduce((a, s) => a + (s.durationMs || 0), 0);
    const inprogress = books.filter(isStarted);

    const dayKeysWithReading = new Set(
      sessions.filter(s => (s.pagesRead || 0) > 0).map(s => fmt.dateKey(s.endAt))
    );
    let streak = 0;
    let cursor = dayKeysWithReading.has(fmt.dateKey(daysAgo(0).getTime())) ? 0 : 1;
    while (cursor < 365) {
      if (dayKeysWithReading.has(fmt.dateKey(daysAgo(cursor).getTime()))) { streak++; cursor++; }
      else break;
    }

    setMetric(root, "books", books.length, books.length ? "on your shelf" : "import your first book");
    setMetric(root, "inprogress", inprogress.length, inprogress.length ? "actively reading" : "none in progress");
    setMetric(root, "pagesToday", pagesToday, pagesToday ? "keep going" : "no pages yet today");
    setMetric(root, "streak", streak, streak === 1 ? "day" : "days");
    setMetric(root, "pagesWeek", pagesWeek, "last 7 days");
    setMetric(root, "timeToday", fmt.mins(msToday), msToday ? "active today" : "no time logged");
    setMetric(root, "timeWeek", fmt.mins(msWeek), "last 7 days");
    setMetric(root, "pagesTotal", pagesTotal, "all-time");

    renderWeekChart(root, sessions);

    const host = root.querySelector("#progressSliderHost");
    const track = root.querySelector("#progressSliderTrack");
    const inProgList = books.filter(isStarted).sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0));
    if (!inProgList.length) {
      host.parentElement.classList.add("opacity-60");
      track.innerHTML = `<div class="text-on-surface-variant text-sm font-sans-ui px-2 py-6">No books in progress yet. Open a book to start tracking.</div>`;
      root.querySelector("[data-progress-count]").textContent = "0 books";
    } else {
      track.innerHTML = "";
      for (const b of inProgList) track.appendChild(makeCard(b, { wide: true }));
      root.querySelector("[data-progress-count]").textContent =
        `${inProgList.length} book${inProgList.length === 1 ? "" : "s"}`;
    }
    bindRangeFill(host.querySelector(".slider-scrub"));
    bindSlider(host);
  }
  function setMetric(root, key, value, sub) {
    const v = root.querySelector(`[data-metric="${key}"]`);
    const s = root.querySelector(`[data-metric-sub="${key}"]`);
    if (v) v.textContent = value;
    if (s && sub !== undefined) s.textContent = sub;
  }
  function renderWeekChart(root, sessions) {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = daysAgo(i);
      const next = new Date(d); next.setDate(next.getDate() + 1);
      const a = d.getTime(), b = next.getTime();
      const pages = sessions.filter(s => s.endAt >= a && s.endAt < b).reduce((acc, s) => acc + (s.pagesRead || 0), 0);
      days.push({ date: d, pages });
    }
    const maxPages = Math.max(1, ...days.map(d => d.pages));
    const chart = root.querySelector("#weekChart");
    chart.innerHTML = "";
    const dayNames = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    for (const d of days) {
      const h = Math.round((d.pages / maxPages) * 100);
      const div = document.createElement("div");
      div.className = "bar";
      div.innerHTML = `
        <span class="num">${d.pages || ""}</span>
        <div class="col${d.pages ? "" : " empty"}" style="height:${Math.max(4, h)}%"></div>
        <span class="lbl">${dayNames[d.date.getDay()]}</span>`;
      chart.appendChild(div);
    }
    const total = days.reduce((a, d) => a + d.pages, 0);
    root.querySelector("[data-week-total]").textContent = `${total} pages`;
  }

  // ---------- Settings ----------
  async function renderSettings() {
    mountTemplate("tpl-settings");
    const root = $("#viewRoot");
    cachedPrefs = await loadPrefs();

    // Theme pickers
    $$("[data-theme-pick]", root).forEach((b) => {
      b.classList.toggle("is-active", b.dataset.themePick === cachedPrefs.theme);
      b.addEventListener("click", () => {
        cachedPrefs.theme = b.dataset.themePick;
        applyTheme(cachedPrefs.theme);
        setPref("theme", cachedPrefs.theme);
        $$("[data-theme-pick]").forEach((x) => x.classList.toggle("is-active", x.dataset.themePick === cachedPrefs.theme));
      });
    });

    // Page width
    const pw = root.querySelector("#prefPageWidth");
    const pwLbl = root.querySelector('[data-val="prefPageWidth"]');
    if (pw) {
      pw.value = cachedPrefs.pageWidth;
      const refresh = () => {
        pwLbl.textContent = pw.value + "px";
        pw.style.setProperty("--p", ((pw.value - pw.min) / (pw.max - pw.min) * 100) + "%");
      };
      pw.addEventListener("input", () => { cachedPrefs.pageWidth = parseFloat(pw.value); refresh(); });
      pw.addEventListener("change", () => setPref("pageWidth", parseFloat(pw.value)));
      refresh();
    }

    // Backup / restore / update buttons
    root.querySelector("#exportBtn").addEventListener("click", exportLibrary);
    root.querySelector("#importBtn").addEventListener("click", () => $("#restoreInput").click());
    root.querySelector("#checkUpdateBtn").addEventListener("click", () => {
      if (window.__cozyCheckUpdate) window.__cozyCheckUpdate();
      else window.location.reload();
    });

    // Reset / wipe
    root.querySelector("#resetSessions").addEventListener("click", async () => {
      if (!confirm("Reset all reading metrics? Books stay; sessions get cleared.")) return;
      await idb.clear("sessions");
      toast("Metrics reset.");
    });
    root.querySelector("#wipeAll").addEventListener("click", async () => {
      if (!confirm("Delete ALL books and reading data? This cannot be undone.")) return;
      await Promise.all(["books", "files", "sessions", "prefs", "highlights"].map((s) => idb.clear(s)));
      cachedPrefs = { ...PREF_DEFAULTS };
      applyTheme(cachedPrefs.theme);
      toast("All data deleted.");
      navigate("#/library");
    });

    // Storage usage
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        const used = Math.round((est.usage || 0) / 1024 / 1024 * 10) / 10;
        const quota = Math.round((est.quota || 0) / 1024 / 1024);
        root.querySelector("#storageInfo").textContent = `Storage used: ${used} MB of ~${quota} MB available.`;
      } catch {}
    }
  }

  // ---------- Reader ----------
  let readerState = null;
  async function renderReader(bookId) {
    mountTemplate("tpl-reader");
    const root = $("#viewRoot");

    const book = await idb.get("books", bookId);
    if (!book) { toast("Book not found."); navigate("#/library"); return; }

    root.querySelector("[data-reader-title]").textContent = book.title;
    root.querySelector("[data-reader-meta]").textContent = book.author || "Unknown author";

    // Fetch file blob
    let fileBlob = null;
    try {
      const rec = await idb.get("files", bookId);
      fileBlob = rec ? rec.blob : (book.fileBlob || null);
    } catch { fileBlob = book.fileBlob || null; }
    if (!fileBlob) { toast("File missing. Re-import the book."); navigate("#/library"); return; }

    const format = book.format || "pdf";
    readerState = {
      book, format,
      session: { startAt: Date.now(), startTickLoc: 0, lastTickLoc: 0 },
    };

    if (format === "epub") {
      await openEpubReader(root, book, fileBlob);
    } else {
      await openPdfReader(root, book, fileBlob);
    }
  }

  // ----- PDF reader -----
  async function openPdfReader(root, book, fileBlob) {
    const stage = root.querySelector("#pdfStage");
    const epubStage = root.querySelector("#epubStage");
    stage.classList.remove("hidden");
    epubStage.classList.add("hidden");
    // Hide EPUB-only stuff in controls
    $$("[data-pdf-only]", root).forEach((el) => el.classList.remove("hidden"));

    const canvas = root.querySelector("#pdfCanvas");
    const pan = root.querySelector("#pdfPan");
    const textLayer = root.querySelector("#pdfTextLayer");
    const pageSlider = root.querySelector("#pageSlider");
    const pageCur = root.querySelector("[data-page-cur]");
    const pageTot = root.querySelector("[data-page-tot]");
    const zoomLabel = root.querySelector("[data-zoom-label]");
    const fsIcon = root.querySelector("[data-fs-icon]");

    let pdf;
    try {
      pdf = await loadPdfFromBlob(fileBlob);
    } catch (e) {
      console.error(e);
      try {
        const buf = await fileBlob.arrayBuffer();
        const fresh = new Blob([buf], { type: "application/pdf" });
        pdf = await loadPdfFromBlob(fresh);
        await idb.put("files", { id: book.id, blob: fresh });
      } catch (e2) {
        console.error("retry failed", e2);
        toast("Could not open this PDF.");
        navigate("#/library");
        return;
      }
    }

    const initialPage = Math.min(Math.max(1, book.lastPage || 1), pdf.numPages);
    readerState.pdf = pdf;
    readerState.currentPage = initialPage;
    readerState.pageCount = pdf.numPages;
    readerState.zoom = 1;
    readerState.rendering = false;
    readerState.pendingPage = null;
    readerState.session.startTickLoc = initialPage;
    readerState.session.lastTickLoc = initialPage;

    pageSlider.min = 1;
    pageSlider.max = pdf.numPages;
    pageSlider.value = initialPage;
    bindRangeFill(pageSlider);
    pageTot.textContent = pdf.numPages;

    function fitWidth() { return Math.min(stage.clientWidth - 8, cachedPrefs.pageWidth); }

    async function showPage(n) {
      n = Math.min(Math.max(1, n | 0), readerState.pageCount);
      if (readerState.rendering) { readerState.pendingPage = n; return; }
      readerState.rendering = true;
      try {
        const cssWidth = Math.max(120, fitWidth() * readerState.zoom);
        const { page, viewport, cssScale } = await renderPageToCanvas(readerState.pdf, n, canvas, cssWidth);
        await renderPdfTextLayer(page, viewport, textLayer, cssScale);
        const pageChanged = readerState.currentPage !== n;
        readerState.currentPage = n;
        readerState.session.lastTickLoc = n;
        pageCur.textContent = n;
        pageSlider.value = n;
        pageSlider.style.setProperty("--p", ((n - 1) / Math.max(1, readerState.pageCount - 1) * 100) + "%");
        if (pageChanged) { stage.scrollTop = 0; stage.scrollLeft = 0; }
      } finally {
        readerState.rendering = false;
        if (readerState.pendingPage != null) {
          const p = readerState.pendingPage; readerState.pendingPage = null;
          showPage(p);
        }
      }
    }
    function updateZoomLabel() { if (zoomLabel) zoomLabel.textContent = Math.round(readerState.zoom * 100) + "%"; }
    async function setZoom(z) {
      z = Math.max(0.5, Math.min(4, z));
      if (Math.abs(z - readerState.zoom) < 0.005) return;
      readerState.zoom = z;
      updateZoomLabel();
      await showPage(readerState.currentPage);
    }
    function toggleImmersive(force) {
      const on = force !== undefined ? force : !document.body.classList.contains("is-immersive");
      document.body.classList.toggle("is-immersive", on);
      if (fsIcon) fsIcon.textContent = on ? "fullscreen_exit" : "fullscreen";
      try {
        if (on && document.documentElement.requestFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
        else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
      } catch {}
      requestAnimationFrame(() => showPage(readerState.currentPage));
    }

    await showPage(initialPage);
    updateZoomLabel();
    applyBrightness(cachedPrefs.brightness);

    // Bookmark
    const bmIcon = root.querySelector("[data-bookmark-icon]");
    function refreshBookmark() {
      const fav = !!book.bookmarked;
      bmIcon.textContent = fav ? "bookmark" : "bookmark_border";
      bmIcon.style.fontVariationSettings = `'FILL' ${fav ? 1 : 0}`;
    }
    refreshBookmark();
    root.querySelector('[data-act="bookmark"]').addEventListener("click", async () => {
      book.bookmarked = !book.bookmarked;
      await persistReaderProgress();
      refreshBookmark();
    });

    // Nav buttons + slider
    root.querySelector('[data-act="prev"]').addEventListener("click", () => showPage(readerState.currentPage - 1));
    root.querySelector('[data-act="next"]').addEventListener("click", () => showPage(readerState.currentPage + 1));
    pageSlider.addEventListener("input", () => {
      pageCur.textContent = pageSlider.value;
      pageSlider.style.setProperty("--p", ((pageSlider.value - 1) / Math.max(1, readerState.pageCount - 1) * 100) + "%");
    });
    pageSlider.addEventListener("change", () => showPage(parseInt(pageSlider.value, 10)));

    // Zoom + fullscreen + options
    root.querySelector('[data-act="zoom-in"]').addEventListener("click", () => setZoom(readerState.zoom * 1.25));
    root.querySelector('[data-act="zoom-out"]').addEventListener("click", () => setZoom(readerState.zoom / 1.25));
    root.querySelector('[data-act="zoom-reset"]').addEventListener("click", () => setZoom(1));
    root.querySelector('[data-act="fit-width"]').addEventListener("click", () => setZoom(1));
    root.querySelector('[data-act="fullscreen"]').addEventListener("click", () => toggleImmersive());
    root.querySelector('[data-act="exit-fullscreen"]').addEventListener("click", () => toggleImmersive(false));
    root.querySelector('[data-act="options"]').addEventListener("click", () => openOptionsSheet("pdf"));

    function onKey(e) {
      if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); showPage(readerState.currentPage + 1); }
      else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); showPage(readerState.currentPage - 1); }
      else if (e.key === "+" || e.key === "=") { e.preventDefault(); setZoom(readerState.zoom * 1.25); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); setZoom(readerState.zoom / 1.25); }
      else if (e.key === "0") { e.preventDefault(); setZoom(1); }
      else if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleImmersive(); }
      else if (e.key === "Escape" && document.body.classList.contains("is-immersive")) toggleImmersive(false);
    }
    document.addEventListener("keydown", onKey);

    // Touch (swipe + pinch). Skip when target is inside text layer (user is selecting).
    function dist(a, b) { return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
    let touchStart = null;
    let pinchStart = null;
    function onTouchStart(e) {
      if (e.target && e.target.closest(".textLayer")) return; // let native selection win
      if (e.touches.length === 2) {
        touchStart = null;
        pinchStart = { d: dist(e.touches[0], e.touches[1]), zoom: readerState.zoom, pending: readerState.zoom };
        pan.style.transformOrigin = "top left";
      } else if (e.touches.length === 1 && !pinchStart) {
        touchStart = {
          x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(),
          sl: stage.scrollLeft, st: stage.scrollTop,
        };
      }
    }
    function onTouchMove(e) {
      if (pinchStart && e.touches.length === 2) {
        if (e.cancelable) e.preventDefault();
        const d = dist(e.touches[0], e.touches[1]);
        const k = d / pinchStart.d;
        const newZoom = Math.max(0.5, Math.min(4, pinchStart.zoom * k));
        pinchStart.pending = newZoom;
        pan.style.transform = `scale(${newZoom / readerState.zoom})`;
      }
    }
    function onTouchEnd(e) {
      if (pinchStart && e.touches.length < 2) {
        const target = pinchStart.pending;
        pan.style.transform = "";
        pinchStart = null;
        setZoom(target);
        return;
      }
      if (!touchStart) return;
      const ts = touchStart; touchStart = null;
      if (Math.abs(stage.scrollLeft - ts.sl) > 4 || Math.abs(stage.scrollTop - ts.st) > 4) return;
      if (readerState.zoom > 1.01) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - ts.x, dy = t.clientY - ts.y, dt = Date.now() - ts.t;
      if (dt > 600) return;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx < 0) showPage(readerState.currentPage + 1);
      else showPage(readerState.currentPage - 1);
    }
    stage.addEventListener("touchstart", onTouchStart, { passive: true });
    stage.addEventListener("touchmove", onTouchMove, { passive: false });
    stage.addEventListener("touchend", onTouchEnd, { passive: true });
    stage.addEventListener("touchcancel", onTouchEnd, { passive: true });

    function onWheel(e) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setZoom(readerState.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      }
    }
    stage.addEventListener("wheel", onWheel, { passive: false });

    const ro = new ResizeObserver(() => showPage(readerState.currentPage));
    ro.observe(stage);

    const saveTimer = setInterval(() => persistReaderProgress(), 4000);
    const onVis = () => { if (document.visibilityState === "hidden") persistReaderProgress(); };
    document.addEventListener("visibilitychange", onVis);
    const onUnload = () => { try { persistReaderProgress(); } catch {} };
    window.addEventListener("beforeunload", onUnload);

    viewCleanup = async () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("beforeunload", onUnload);
      stage.removeEventListener("touchstart", onTouchStart);
      stage.removeEventListener("touchmove", onTouchMove);
      stage.removeEventListener("touchend", onTouchEnd);
      stage.removeEventListener("touchcancel", onTouchEnd);
      stage.removeEventListener("wheel", onWheel);
      clearInterval(saveTimer);
      ro.disconnect();
      document.body.classList.remove("is-immersive");
      if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch {} }
      const pdfRef = readerState && readerState.pdf;
      await finalizeSession();
      if (pdfRef) { try { await pdfRef.destroy(); } catch {} }
    };
  }

  // ----- EPUB reader -----
  async function openEpubReader(root, book, fileBlob) {
    const stage = root.querySelector("#epubStage");
    const pdfStage = root.querySelector("#pdfStage");
    pdfStage.classList.add("hidden");
    stage.classList.remove("hidden");
    $$("[data-pdf-only]", root).forEach((el) => el.classList.add("hidden"));

    const pageSlider = root.querySelector("#pageSlider");
    const pageCur = root.querySelector("[data-page-cur]");
    const pageTot = root.querySelector("[data-page-tot]");
    const fsIcon = root.querySelector("[data-fs-icon]");

    let epub;
    try {
      epub = await openEpubFromBlob(fileBlob);
    } catch (e) {
      console.error(e);
      toast("Could not open this EPUB.");
      navigate("#/library");
      return;
    }

    // Mount rendition
    stage.innerHTML = "";
    const rendition = epub.renderTo(stage, {
      width: stage.clientWidth || 600,
      height: stage.clientHeight || 800,
      flow: "paginated",
      spread: "none",
      manager: "default",
      allowScriptedContent: false,
    });

    readerState.book = book;
    readerState.epub = epub;
    readerState.rendition = rendition;
    readerState.format = "epub";
    readerState.currentCfi = book.lastCfi || null;
    readerState.pageCount = 0;
    readerState.currentPage = 0;

    // Display first / saved location
    try {
      await rendition.display(book.lastCfi || undefined);
    } catch (e) {
      console.error(e);
      try { await rendition.display(); } catch {}
    }

    // Generate / restore locations for page mapping
    (async () => {
      try {
        if (book.epubLocations) {
          await epub.locations.load(book.epubLocations);
        } else {
          await epub.locations.generate(1024);
          // Save for next time
          try {
            const json = epub.locations.save();
            const stored = (await idb.get("books", book.id)) || book;
            stored.epubLocations = json;
            if (stored.fileBlob) delete stored.fileBlob;
            await idb.put("books", stored);
          } catch {}
        }
        readerState.pageCount = epub.locations.total || 0;
        pageSlider.max = Math.max(1, readerState.pageCount);
        pageTot.textContent = String(readerState.pageCount || 0);
        // Sync current
        if (readerState.currentCfi) {
          const idx = epub.locations.locationFromCfi(readerState.currentCfi);
          if (idx != null) {
            readerState.currentPage = idx;
            pageSlider.value = idx;
            pageCur.textContent = String(idx);
            pageSlider.style.setProperty("--p", (idx / Math.max(1, readerState.pageCount - 1) * 100) + "%");
          }
        }
        // Persist initial state into session start
        readerState.session.startTickLoc = readerState.currentPage;
        readerState.session.lastTickLoc = readerState.currentPage;
      } catch (e) { console.warn("locations failed", e); }
    })();

    bindRangeFill(pageSlider);

    rendition.on("relocated", (location) => {
      readerState.currentCfi = location.start.cfi;
      if (epub.locations && epub.locations.total) {
        const idx = epub.locations.locationFromCfi(location.start.cfi) || 0;
        readerState.currentPage = idx;
        readerState.session.lastTickLoc = idx;
        pageSlider.max = Math.max(1, epub.locations.total);
        pageSlider.value = idx;
        pageCur.textContent = String(idx);
        pageTot.textContent = String(epub.locations.total);
        pageSlider.style.setProperty("--p", (idx / Math.max(1, epub.locations.total - 1) * 100) + "%");
        readerState.pageCount = epub.locations.total;
      }
      if (location.atEnd) { book.finishedAt = book.finishedAt || Date.now(); }
    });

    // Apply theme + font + brightness
    applyEpubReaderStyles();
    applyBrightness(cachedPrefs.brightness);

    // Restore highlights
    try {
      const highlights = await idb.allByIndex("highlights", "bookId", book.id);
      for (const h of highlights) {
        try { rendition.annotations.add("highlight", h.cfi, { id: h.id }, null, "cozy-hl", { fill: "rgba(255,196,0,0.35)" }); } catch {}
      }
    } catch {}

    // Bookmark
    const bmIcon = root.querySelector("[data-bookmark-icon]");
    function refreshBookmark() {
      const fav = !!book.bookmarked;
      bmIcon.textContent = fav ? "bookmark" : "bookmark_border";
      bmIcon.style.fontVariationSettings = `'FILL' ${fav ? 1 : 0}`;
    }
    refreshBookmark();
    root.querySelector('[data-act="bookmark"]').addEventListener("click", async () => {
      book.bookmarked = !book.bookmarked;
      await persistReaderProgress();
      refreshBookmark();
    });

    // Page nav
    root.querySelector('[data-act="prev"]').addEventListener("click", () => rendition.prev());
    root.querySelector('[data-act="next"]').addEventListener("click", () => rendition.next());
    pageSlider.addEventListener("input", () => {
      pageCur.textContent = pageSlider.value;
      pageSlider.style.setProperty("--p", (pageSlider.value / Math.max(1, pageSlider.max - 1) * 100) + "%");
    });
    pageSlider.addEventListener("change", () => {
      const idx = parseInt(pageSlider.value, 10);
      if (epub.locations && epub.locations.total) {
        const cfi = epub.locations.cfiFromLocation(idx);
        if (cfi) rendition.display(cfi);
      }
    });

    // Fullscreen
    function toggleImmersive(force) {
      const on = force !== undefined ? force : !document.body.classList.contains("is-immersive");
      document.body.classList.toggle("is-immersive", on);
      if (fsIcon) fsIcon.textContent = on ? "fullscreen_exit" : "fullscreen";
      try {
        if (on && document.documentElement.requestFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
        else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
      } catch {}
      // Resize rendition shortly after layout settles
      setTimeout(() => { try { rendition.resize(stage.clientWidth, stage.clientHeight); } catch {} }, 250);
    }
    root.querySelector('[data-act="fullscreen"]').addEventListener("click", () => toggleImmersive());
    root.querySelector('[data-act="exit-fullscreen"]').addEventListener("click", () => toggleImmersive(false));
    root.querySelector('[data-act="options"]').addEventListener("click", () => openOptionsSheet("epub"));

    // Keyboard
    function onKey(e) {
      if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); rendition.next(); }
      else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); rendition.prev(); }
      else if (e.key === "f" || e.key === "F") { e.preventDefault(); toggleImmersive(); }
      else if (e.key === "Escape" && document.body.classList.contains("is-immersive")) toggleImmersive(false);
    }
    document.addEventListener("keydown", onKey);

    // Selection / Highlight
    const selAction = root.querySelector("#selectionAction");
    let activeSelection = null;
    rendition.on("selected", (cfiRange, contents) => {
      try {
        const range = contents.range(cfiRange);
        if (!range) return;
        const rect = range.getBoundingClientRect();
        const frameRect = stage.getBoundingClientRect();
        // Position the action bar near the selection inside the reader frame
        selAction.classList.remove("hidden");
        const left = Math.max(8, Math.min(stage.clientWidth - 220, rect.left - frameRect.left));
        const top = Math.max(8, rect.top - frameRect.top - 44);
        selAction.style.left = left + "px";
        selAction.style.top = top + "px";
        activeSelection = { cfi: cfiRange };
      } catch (e) { console.warn(e); }
    });
    rendition.on("relocated", () => { selAction.classList.add("hidden"); activeSelection = null; });
    selAction.querySelector('[data-act="cancel-sel"]').addEventListener("click", () => {
      selAction.classList.add("hidden"); activeSelection = null;
    });
    selAction.querySelector('[data-act="highlight"]').addEventListener("click", async () => {
      if (!activeSelection) return;
      const cfi = activeSelection.cfi;
      const id = "hl_" + book.id + "_" + (await hashString(cfi));
      try { rendition.annotations.add("highlight", cfi, { id }, null, "cozy-hl", { fill: "rgba(255,196,0,0.35)" }); } catch {}
      await idb.put("highlights", { id, bookId: book.id, cfi, color: "yellow", createdAt: Date.now() });
      selAction.classList.add("hidden");
      activeSelection = null;
    });
    selAction.querySelector('[data-act="unhighlight"]').addEventListener("click", async () => {
      if (!activeSelection) return;
      const cfi = activeSelection.cfi;
      const id = "hl_" + book.id + "_" + (await hashString(cfi));
      try { rendition.annotations.remove(cfi, "highlight"); } catch {}
      await idb.del("highlights", id);
      selAction.classList.add("hidden");
      activeSelection = null;
    });

    // Resize handling
    const ro = new ResizeObserver(() => {
      try { rendition.resize(stage.clientWidth, stage.clientHeight); } catch {}
    });
    ro.observe(stage);

    const saveTimer = setInterval(() => persistReaderProgress(), 4000);
    const onVis = () => { if (document.visibilityState === "hidden") persistReaderProgress(); };
    document.addEventListener("visibilitychange", onVis);
    const onUnload = () => { try { persistReaderProgress(); } catch {} };
    window.addEventListener("beforeunload", onUnload);

    viewCleanup = async () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("beforeunload", onUnload);
      clearInterval(saveTimer);
      ro.disconnect();
      document.body.classList.remove("is-immersive");
      if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch {} }
      try { rendition.destroy(); } catch {}
      try { epub.destroy(); } catch {}
      await finalizeSession();
    };
  }

  function applyEpubReaderStyles() {
    if (!readerState || !readerState.rendition) return;
    const theme = cachedPrefs.theme;
    const surfaces = {
      light: { bg: "#fbf9f4", fg: "#1b1c19", link: "#8d4b00", selBg: "#ffdcc3" },
      sepia: { bg: "#f3e8d2", fg: "#3b2a18", link: "#8d4b00", selBg: "#ffdcc3" },
      dark:  { bg: "#14130e", fg: "#ece1d2", link: "#ffb77d", selBg: "#6e3900" },
    };
    const s = surfaces[theme] || surfaces.light;
    const ff = (cachedPrefs.fontFamily || "Literata") + ", serif";
    const lh = (cachedPrefs.lineHeight / 10).toFixed(2);
    const rules = {
      "body": {
        "background": s.bg + " !important",
        "color": s.fg + " !important",
        "font-family": ff + " !important",
        "line-height": lh + " !important",
        "padding": cachedPrefs.margin + "px !important",
      },
      "p, div, span, li, blockquote": {
        "color": s.fg + " !important",
        "font-family": ff + " !important",
        "line-height": lh + " !important",
      },
      "a, a *": { "color": s.link + " !important" },
      "::selection": { "background": s.selBg + " !important" },
    };
    try {
      // register+select re-applies cleanly on every call (default() can be sticky)
      readerState.rendition.themes.register("cozy", rules);
      readerState.rendition.themes.select("cozy");
      readerState.rendition.themes.fontSize(cachedPrefs.fontSize + "px");
    } catch (e) { console.warn(e); }
  }

  async function hashString(s) {
    const enc = new TextEncoder().encode(s);
    const buf = await crypto.subtle.digest("SHA-1", enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  }

  async function persistReaderProgress() {
    if (!readerState) return;
    const { book } = readerState;
    const stored = (await idb.get("books", book.id)) || book;
    if (readerState.format === "pdf") {
      stored.lastPage = readerState.currentPage;
      stored.pageCount = readerState.pageCount;
      if (stored.lastPage >= stored.pageCount && stored.pageCount > 0)
        stored.finishedAt = stored.finishedAt || Date.now();
    } else if (readerState.format === "epub") {
      stored.lastCfi = readerState.currentCfi || stored.lastCfi;
      stored.lastPage = readerState.currentPage || stored.lastPage || 0;
      stored.pageCount = readerState.pageCount || stored.pageCount || 0;
      if (stored.pageCount && stored.lastPage >= stored.pageCount)
        stored.finishedAt = stored.finishedAt || Date.now();
      if (readerState.epub && readerState.epub.locations && readerState.epub.locations.total && !stored.epubLocations) {
        try { stored.epubLocations = readerState.epub.locations.save(); } catch {}
      }
    }
    stored.lastReadAt = Date.now();
    stored.bookmarked = book.bookmarked;
    if (stored.fileBlob) delete stored.fileBlob;
    await idb.put("books", stored);
  }

  async function finalizeSession() {
    if (!readerState) return;
    const { book, session } = readerState;
    const endAt = Date.now();
    const durationMs = endAt - session.startAt;
    const pagesRead = Math.max(0, (readerState.session.lastTickLoc || 0) - (readerState.session.startTickLoc || 0));
    if (durationMs > 5000 || pagesRead > 0) {
      await idb.put("sessions", {
        bookId: book.id,
        startAt: session.startAt,
        endAt,
        startPage: session.startTickLoc || 0,
        endPage: session.lastTickLoc || 0,
        pagesRead,
        durationMs,
      });
    }
    await persistReaderProgress();
    readerState = null;
  }

  // ---------- Options sheet ----------
  function openOptionsSheet(format) {
    const sheet = document.getElementById("optionsSheet");
    const backdrop = document.getElementById("optionsBackdrop");
    if (!sheet) return;
    // Toggle epub-only / pdf-only visibility within sheet
    sheet.querySelectorAll("[data-epub-only]").forEach((el) => el.classList.toggle("hidden", format !== "epub"));
    sheet.querySelectorAll("[data-pdf-only]").forEach((el) => el.classList.toggle("hidden", format !== "pdf"));
    // Theme pick state
    sheet.querySelectorAll("[data-theme-pick]").forEach((b) => b.classList.toggle("is-active", b.dataset.themePick === cachedPrefs.theme));
    sheet.querySelectorAll("[data-font-pick]").forEach((b) => b.classList.toggle("is-active", b.dataset.fontPick === cachedPrefs.fontFamily));
    // Sliders
    bindPrefSlider(sheet, "#prefBrightness", "brightness", (v) => v + "%", { onChange: applyBrightness });
    bindPrefSlider(sheet, "#prefFontSize", "fontSize", (v) => v + "px", { onChange: applyEpubReaderStyles });
    bindPrefSlider(sheet, "#prefLineHeight", "lineHeight", (v) => (v / 10).toFixed(1), { onChange: applyEpubReaderStyles });
    bindPrefSlider(sheet, "#prefMargin", "margin", (v) => v + "px", { onChange: applyEpubReaderStyles });
    backdrop.classList.remove("hidden");
    sheet.classList.remove("hidden", "is-closing");
  }
  function closeOptionsSheet() {
    const sheet = document.getElementById("optionsSheet");
    const backdrop = document.getElementById("optionsBackdrop");
    if (!sheet) return;
    sheet.classList.add("is-closing");
    backdrop.classList.add("hidden");
    setTimeout(() => sheet.classList.add("hidden"), 200);
  }
  function bindPrefSlider(root, sel, key, format, opts) {
    const input = root.querySelector(sel);
    if (!input) return;
    const lbl = root.querySelector(`[data-val="${input.id}"]`);
    input.value = cachedPrefs[key];
    const refresh = () => {
      if (lbl) lbl.textContent = format(parseFloat(input.value));
      input.style.setProperty("--p", ((input.value - input.min) / (input.max - input.min) * 100) + "%");
    };
    input.oninput = () => {
      cachedPrefs[key] = parseFloat(input.value);
      refresh();
      if (opts && opts.onChange) opts.onChange(cachedPrefs[key]);
    };
    input.onchange = () => setPref(key, parseFloat(input.value));
    refresh();
  }

  // ---------- Import ----------
  function detectFormat(file) {
    const n = (file.name || "").toLowerCase();
    if (n.endsWith(".epub") || file.type === "application/epub+zip") return "epub";
    if (n.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
    return null;
  }
  async function handleFiles(files) {
    if (!files || !files.length) return;
    let added = 0;
    for (const file of files) {
      const format = detectFormat(file);
      if (!format) continue;
      toast(`Importing ${file.name}…`, 60000);
      try {
        const buf = await file.arrayBuffer();
        if (format === "pdf") {
          await waitFor(() => !!window.pdfjsLib);
          const blob = new Blob([buf], { type: "application/pdf" });
          const pdf = await loadPdfFromBlob(blob);
          const baseName = file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
          const meta = await extractPdfMeta(pdf, baseName);
          const coverBlob = await extractPdfCoverBlob(pdf, 480).catch(() => null);
          const id = "b_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
          await idb.put("files", { id, blob });
          await idb.put("books", {
            id, format: "pdf",
            title: meta.title, author: meta.author,
            fileName: file.name, sizeBytes: file.size,
            pageCount: pdf.numPages, lastPage: 0, lastReadAt: 0,
            addedAt: Date.now(), finishedAt: 0, bookmarked: false,
            coverBlob,
          });
          try { await pdf.destroy(); } catch {}
          added++;
        } else if (format === "epub") {
          await waitFor(() => !!window.ePub);
          const blob = new Blob([buf], { type: "application/epub+zip" });
          const book = await openEpubFromBlob(blob);
          const baseName = file.name.replace(/\.epub$/i, "").replace(/[_-]+/g, " ").trim();
          const meta = getEpubMeta(book, baseName);
          const coverBlob = await extractEpubCoverBlob(book).catch(() => null);
          const id = "b_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
          await idb.put("files", { id, blob });
          await idb.put("books", {
            id, format: "epub",
            title: meta.title, author: meta.author,
            fileName: file.name, sizeBytes: file.size,
            pageCount: 0, lastPage: 0, lastReadAt: 0,
            addedAt: Date.now(), finishedAt: 0, bookmarked: false,
            coverBlob, lastCfi: null, epubLocations: null,
          });
          try { book.destroy(); } catch {}
          added++;
        }
      } catch (e) {
        console.error("import failed", file.name, e);
        toast(`Could not import ${file.name}`, 3000);
      }
    }
    if (added) {
      toast(`Imported ${added} book${added === 1 ? "" : "s"}.`, 2200);
      if ((location.hash || "#/library") === "#/library") handleRoute();
      else navigate("#/library");
    } else {
      toast("No supported files imported.", 2200);
    }
  }

  // ---------- Export / Restore ----------
  function blobToB64(blob) {
    if (!blob) return Promise.resolve(null);
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res({ b64: r.result.split(",")[1], type: blob.type || "application/octet-stream" });
      r.onerror = rej;
      r.readAsDataURL(blob);
    });
  }
  function b64ToBlob(b64, type) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: type || "application/octet-stream" });
  }
  async function exportLibrary() {
    toast("Preparing backup…", 60000);
    const [books, files, sessions, prefs, highlights] = await Promise.all([
      idb.all("books"), idb.all("files"), idb.all("sessions"), idb.all("prefs"), idb.all("highlights"),
    ]);
    // Convert blobs to base64
    const booksOut = [];
    for (const b of books) {
      const cover = b.coverBlob ? await blobToB64(b.coverBlob) : null;
      const copy = { ...b }; delete copy.coverBlob; delete copy.fileBlob;
      booksOut.push({ ...copy, cover });
    }
    const filesOut = [];
    for (const f of files) {
      const b = await blobToB64(f.blob);
      filesOut.push({ id: f.id, type: b ? b.type : "application/octet-stream", b64: b ? b.b64 : null });
    }
    const out = {
      format: "cozy-reader-backup",
      version: 1,
      exportedAt: Date.now(),
      books: booksOut, files: filesOut, sessions, prefs, highlights,
    };
    const json = JSON.stringify(out);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.href = url;
    a.download = `cozy-reader-backup-${stamp}.cozy.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("Backup saved.", 2200);
  }
  async function restoreLibrary(file) {
    if (!file) return;
    if (!confirm("Restore from backup? This MERGES with your current library — duplicate IDs will be overwritten.")) return;
    toast("Restoring…", 60000);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (data.format !== "cozy-reader-backup") { toast("Not a Cozy Reader backup."); return; }
      for (const b of data.books || []) {
        const cover = b.cover && b.cover.b64 ? b64ToBlob(b.cover.b64, b.cover.type) : null;
        const copy = { ...b }; delete copy.cover;
        copy.coverBlob = cover;
        await idb.put("books", copy);
      }
      for (const f of data.files || []) {
        if (!f.b64) continue;
        const blob = b64ToBlob(f.b64, f.type);
        await idb.put("files", { id: f.id, blob });
      }
      for (const s of data.sessions || []) {
        const copy = { ...s }; delete copy.id; // let autoincrement assign fresh id
        await idb.put("sessions", copy);
      }
      for (const p of data.prefs || []) await idb.put("prefs", p);
      for (const h of data.highlights || []) await idb.put("highlights", h);
      cachedPrefs = await loadPrefs();
      applyTheme(cachedPrefs.theme);
      toast("Restored.", 2200);
      navigate("#/library");
    } catch (e) {
      console.error(e);
      toast("Restore failed.", 2500);
    }
  }

  // ---------- Boot ----------
  async function boot() {
    cachedPrefs = await loadPrefs();
    applyTheme(cachedPrefs.theme);
    applyBrightness(cachedPrefs.brightness);

    // Wire controls
    $("#fab").addEventListener("click", () => $("#pdfInput").click());
    $("#topImportBtn").addEventListener("click", () => $("#pdfInput").click());
    $("#pdfInput").addEventListener("change", (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = "";
      handleFiles(files);
    });
    $("#restoreInput").addEventListener("change", (e) => {
      const f = (e.target.files || [])[0];
      e.target.value = "";
      if (f) restoreLibrary(f);
    });

    // Theme quick toggle in header (cycles light → sepia → dark)
    $("#themeQuickToggle").addEventListener("click", () => {
      const order = ["light", "sepia", "dark"];
      const idx = order.indexOf(cachedPrefs.theme);
      const next = order[(idx + 1) % order.length];
      cachedPrefs.theme = next;
      applyTheme(next);
      setPref("theme", next);
      toast("Theme: " + next, 1200);
    });

    // Options sheet — bind theme/font picks here so they apply on the fly
    document.addEventListener("click", (e) => {
      const tp = e.target.closest("[data-theme-pick]");
      if (tp) {
        cachedPrefs.theme = tp.dataset.themePick;
        applyTheme(cachedPrefs.theme);
        setPref("theme", cachedPrefs.theme);
        return;
      }
      const fp = e.target.closest("[data-font-pick]");
      if (fp) {
        cachedPrefs.fontFamily = fp.dataset.fontPick;
        applyEpubReaderStyles();
        setPref("fontFamily", cachedPrefs.fontFamily);
        $$("[data-font-pick]").forEach((b) => b.classList.toggle("is-active", b.dataset.fontPick === cachedPrefs.fontFamily));
        return;
      }
      const rt = e.target.closest("[data-route]");
      if (rt) { e.preventDefault(); navigate(rt.dataset.route); return; }
    });
    $("#optionsClose").addEventListener("click", closeOptionsSheet);
    $("#optionsBackdrop").addEventListener("click", closeOptionsSheet);

    // Drag & drop
    window.addEventListener("dragover", (e) => { e.preventDefault(); });
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) handleFiles(files);
    });

    window.addEventListener("hashchange", handleRoute);
    if (!location.hash) location.hash = "#/library";
    else handleRoute();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
