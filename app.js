// Cozy Reader — single-file app
// Vanilla JS + IndexedDB + PDF.js (loaded into window.pdfjsLib by the module shim in index.html)

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
  const waitFor = (cond, timeoutMs = 10000) =>
    new Promise((res, rej) => {
      const t0 = Date.now();
      (function poll() {
        if (cond()) return res();
        if (Date.now() - t0 > timeoutMs) return rej(new Error("timeout"));
        setTimeout(poll, 50);
      })();
    });

  // ---------- IndexedDB ----------
  const DB_NAME = "cozy-reader";
  const DB_VERSION = 1;
  let dbp = null;
  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("books")) {
          const s = db.createObjectStore("books", { keyPath: "id" });
          s.createIndex("addedAt", "addedAt");
          s.createIndex("lastReadAt", "lastReadAt");
        }
        if (!db.objectStoreNames.contains("sessions")) {
          const s = db.createObjectStore("sessions", { keyPath: "id", autoIncrement: true });
          s.createIndex("bookId", "bookId");
          s.createIndex("endAt", "endAt");
        }
        if (!db.objectStoreNames.contains("prefs")) {
          db.createObjectStore("prefs", { keyPath: "key" });
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
    async clear(store) { const s = await tx(store, "readwrite"); return new Promise((res, rej) => { const r = s.clear(); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); },
  };

  // ---------- Prefs ----------
  const PREF_DEFAULTS = { fontSize: 18, lineHeight: 17, pageWidth: 720 };
  async function loadPrefs() {
    const all = await idb.all("prefs");
    const out = { ...PREF_DEFAULTS };
    for (const p of all) out[p.key] = p.value;
    return out;
  }
  async function setPref(key, value) { await idb.put("prefs", { key, value }); applyPrefsToCSS(); }
  let cachedPrefs = { ...PREF_DEFAULTS };
  function applyPrefsToCSS() {
    const r = document.documentElement.style;
    r.setProperty("--reader-font-size", cachedPrefs.fontSize + "px");
    r.setProperty("--reader-line-height", (cachedPrefs.lineHeight / 10).toFixed(1));
    r.setProperty("--reader-page-width", cachedPrefs.pageWidth + "px");
  }

  // ---------- PDF helpers ----------
  async function loadPdfFromBlob(blob) {
    await waitFor(() => !!window.pdfjsLib);
    const buf = await blob.arrayBuffer();
    return await window.pdfjsLib.getDocument({ data: buf }).promise;
  }
  async function renderPageToCanvas(pdf, pageNum, canvas, maxWidth) {
    const page = await pdf.getPage(pageNum);
    const baseViewport = page.getViewport({ scale: 1 });
    const targetWidth = Math.min(maxWidth, baseViewport.width * 2);
    const scale = targetWidth / baseViewport.width;
    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = viewport.width + "px";
    canvas.style.height = viewport.height + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return { width: viewport.width, height: viewport.height };
  }
  async function extractCoverBlob(pdf, maxWidth = 480) {
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
  async function extractTitleFromMetadata(pdf, fallbackFromName) {
    try {
      const md = await pdf.getMetadata();
      const info = md && md.info ? md.info : {};
      const title = (info.Title || "").trim();
      const author = (info.Author || "").trim();
      return {
        title: title || fallbackFromName,
        author: author || "Unknown author",
      };
    } catch {
      return { title: fallbackFromName, author: "Unknown author" };
    }
  }

  // ---------- Book model helpers ----------
  function bookProgress(b) {
    if (!b.pageCount || b.pageCount < 1) return 0;
    return Math.min(1, (b.lastPage || 0) / b.pageCount);
  }
  function isFinished(b) {
    return b.finishedAt || (b.pageCount > 0 && (b.lastPage || 0) >= b.pageCount);
  }
  function isStarted(b) {
    return (b.lastPage || 0) > 0 && !isFinished(b);
  }

  // ---------- Cover URL cache (revoke on view swap) ----------
  let coverUrls = new Map(); // bookId -> objectURL
  function coverURL(book) {
    if (!book.coverBlob) return null;
    if (!coverUrls.has(book.id)) coverUrls.set(book.id, URL.createObjectURL(book.coverBlob));
    return coverUrls.get(book.id);
  }
  function revokeCovers() {
    for (const url of coverUrls.values()) URL.revokeObjectURL(url);
    coverUrls.clear();
  }

  // ---------- Slider behavior (touch + arrows + scrubber) ----------
  function bindSlider(host) {
    const track = host.querySelector("[data-slider-track]");
    const left = host.querySelector('.slider-arrow[data-dir="-1"]');
    const right = host.querySelector('.slider-arrow[data-dir="1"]');
    const scrub = host.querySelector(".slider-scrub");

    function maxScroll() { return Math.max(0, track.scrollWidth - track.clientWidth); }
    function pct() {
      const max = maxScroll();
      return max ? (track.scrollLeft / max) * 100 : 0;
    }
    function updateScrub() {
      const p = pct();
      scrub.value = p;
      scrub.style.setProperty("--p", p + "%");
    }
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
      const target = (parseFloat(scrub.value) / 100) * max;
      track.scrollLeft = target;
      scrub.style.setProperty("--p", scrub.value + "%");
    });
    // Initial
    requestAnimationFrame(updateScrub);
    // Hide controls if not scrollable
    function evalScrollable() {
      const scrollable = maxScroll() > 4;
      host.querySelector(".slider-controls").style.display = scrollable ? "" : "none";
    }
    evalScrollable();
    new ResizeObserver(evalScrollable).observe(track);
  }

  // ---------- Range input progress fill ----------
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

  // ---------- VIEWS ----------
  function mountTemplate(id) {
    const root = $("#viewRoot");
    root.innerHTML = "";
    const tpl = $("#" + id);
    const node = tpl.content.cloneNode(true);
    root.appendChild(node);
    return root;
  }

  // Build a book card DOM
  function makeCard(book, opts = {}) {
    const wide = !!opts.wide;
    const wrap = document.createElement("article");
    wrap.className = "book-card" + (wide ? " wide" : "");
    wrap.dataset.id = book.id;
    const cur = book.lastPage || 0;
    const tot = book.pageCount || 0;
    const pct = tot ? Math.round((cur / tot) * 100) : 0;
    const url = coverURL(book);
    const coverInner = url
      ? `<img alt="${escapeHtml(book.title)} cover" src="${url}" loading="lazy" decoding="async" />`
      : `<div class="placeholder">${escapeHtml(book.title.slice(0, 60))}</div>`;
    if (wide) {
      wrap.innerHTML = `
        <div class="row">
          <div class="cover">${coverInner}</div>
          <div class="meta">
            <span class="kicker">${book.lastReadAt ? "Reading · " + fmt.relTime(book.lastReadAt) : "Not started"}</span>
            <h4>${escapeHtml(book.title)}</h4>
            <p>${escapeHtml(book.author || "Unknown author")}</p>
            <div class="row-bottom">
              <div class="stats"><span>${pct}%</span><span>${tot ? `${Math.max(0, tot - cur)} pages left` : "—"}</span></div>
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
  function escapeHtml(s = "") {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
  }

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
      root.querySelector("[data-subgreet]").textContent = "Add your first PDF to get started.";
      return;
    }
    empty.classList.add("hidden");
    root.querySelector("[data-subgreet]").textContent =
      `${books.length} book${books.length === 1 ? "" : "s"} on your shelf.`;

    const readingNow = books.filter(isStarted);
    const finished = books.filter(isFinished);
    const all = books;

    fillSection(root.querySelector('[data-section="reading-now"]'), readingNow, { wide: true });
    fillSection(root.querySelector('[data-section="all-books"]'), all, { wide: false });
    fillSection(root.querySelector('[data-section="finished"]'), finished, { wide: false });
  }

  function fillSection(section, list, opts) {
    if (!list.length) { section.classList.add("hidden"); return; }
    section.classList.remove("hidden");
    const track = section.querySelector("[data-slider-track]");
    track.innerHTML = "";
    for (const b of list) track.appendChild(makeCard(b, opts));
    section.querySelector("[data-count]").textContent = `${list.length} book${list.length === 1 ? "" : "s"}`;
    const scrub = section.querySelector(".slider-scrub");
    bindRangeFill(scrub);
    bindSlider(section.querySelector("[data-slider-host]"));
  }

  // ---------- Progress ----------
  function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
  function daysAgo(n) { const d = startOfDay(); d.setDate(d.getDate() - n); return d; }

  async function renderProgress() {
    mountTemplate("tpl-progress");
    const root = $("#viewRoot");

    const [books, sessions] = await Promise.all([idb.all("books"), idb.all("sessions")]);
    const now = Date.now();
    const todayStart = startOfDay().getTime();
    const weekStart = daysAgo(6).getTime();

    const pagesToday = sessions.filter(s => s.endAt >= todayStart).reduce((a, s) => a + (s.pagesRead || 0), 0);
    const pagesWeek = sessions.filter(s => s.endAt >= weekStart).reduce((a, s) => a + (s.pagesRead || 0), 0);
    const pagesTotal = sessions.reduce((a, s) => a + (s.pagesRead || 0), 0);
    const msToday = sessions.filter(s => s.endAt >= todayStart).reduce((a, s) => a + (s.durationMs || 0), 0);
    const msWeek = sessions.filter(s => s.endAt >= weekStart).reduce((a, s) => a + (s.durationMs || 0), 0);
    const inprogress = books.filter(isStarted);

    // Streak: consecutive days back from today (or yesterday if nothing today yet) with at least 1 page read
    const dayKeysWithReading = new Set(
      sessions.filter(s => (s.pagesRead || 0) > 0).map(s => fmt.dateKey(s.endAt))
    );
    let streak = 0;
    let cursor = dayKeysWithReading.has(fmt.dateKey(daysAgo(0).getTime())) ? 0 : 1;
    while (cursor < 365) {
      if (dayKeysWithReading.has(fmt.dateKey(daysAgo(cursor).getTime()))) { streak++; cursor++; }
      else break;
    }

    // Metrics
    setMetric(root, "books", books.length, books.length ? `on your shelf` : "import your first PDF");
    setMetric(root, "inprogress", inprogress.length, inprogress.length ? "actively reading" : "none in progress");
    setMetric(root, "pagesToday", pagesToday, pagesToday ? "keep going" : "no pages yet today");
    setMetric(root, "streak", streak, streak === 1 ? "day" : "days");
    setMetric(root, "pagesWeek", pagesWeek, `last 7 days`);
    setMetric(root, "timeToday", fmt.mins(msToday), msToday ? "active today" : "no time logged");
    setMetric(root, "timeWeek", fmt.mins(msWeek), "last 7 days");
    setMetric(root, "pagesTotal", pagesTotal, "all-time pages read");

    // Week chart
    renderWeekChart(root, sessions);

    // Per-book progress slider
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
    const prefs = await loadPrefs();
    cachedPrefs = prefs;

    const setUp = (id, key, format) => {
      const input = root.querySelector("#" + id);
      const lbl = root.querySelector(`[data-val="${id}"]`);
      input.value = prefs[key];
      const refresh = () => {
        lbl.textContent = format(parseFloat(input.value));
        input.style.setProperty("--p", ((input.value - input.min) / (input.max - input.min) * 100) + "%");
      };
      input.addEventListener("input", () => {
        cachedPrefs[key] = parseFloat(input.value);
        applyPrefsToCSS();
        refresh();
      });
      input.addEventListener("change", () => setPref(key, parseFloat(input.value)));
      refresh();
    };
    setUp("prefPageWidth", "pageWidth", (v) => v + "px");

    root.querySelector("#resetSessions").addEventListener("click", async () => {
      if (!confirm("Reset all reading metrics? Books stay; sessions get cleared.")) return;
      await idb.clear("sessions");
      // Also reset lastPage so progress goes to zero? No — keep lastPage so user can resume.
      toast("Metrics reset.");
    });
    root.querySelector("#wipeAll").addEventListener("click", async () => {
      if (!confirm("Delete ALL books and reading data? This cannot be undone.")) return;
      await Promise.all(["books", "sessions", "prefs"].map((s) => idb.clear(s)));
      cachedPrefs = { ...PREF_DEFAULTS };
      applyPrefsToCSS();
      toast("All data deleted.");
      navigate("#/library");
    });

    // Storage info
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

    const canvas = root.querySelector("#pdfCanvas");
    const stage = root.querySelector("#pdfStage");
    const pageSlider = root.querySelector("#pageSlider");
    const pageCur = root.querySelector("[data-page-cur]");
    const pageTot = root.querySelector("[data-page-tot]");

    let pdf;
    try {
      pdf = await loadPdfFromBlob(book.fileBlob);
    } catch (e) {
      toast("Could not open this PDF.");
      console.error(e);
      navigate("#/library");
      return;
    }

    // Initialize per-book state
    const initialPage = Math.min(Math.max(1, book.lastPage || 1), pdf.numPages);
    readerState = {
      book, pdf,
      currentPage: initialPage,
      pageCount: pdf.numPages,
      session: { startAt: Date.now(), startPage: initialPage, lastTickPage: initialPage },
      rendering: false,
      pendingPage: null,
    };

    pageSlider.min = 1;
    pageSlider.max = pdf.numPages;
    pageSlider.value = initialPage;
    bindRangeFill(pageSlider);
    pageTot.textContent = pdf.numPages;

    async function showPage(n) {
      n = Math.min(Math.max(1, n | 0), readerState.pageCount);
      if (readerState.rendering) { readerState.pendingPage = n; return; }
      readerState.rendering = true;
      try {
        const w = Math.min(stage.clientWidth - 8, cachedPrefs.pageWidth);
        await renderPageToCanvas(readerState.pdf, n, canvas, w);
        readerState.currentPage = n;
        pageCur.textContent = n;
        pageSlider.value = n;
        pageSlider.style.setProperty("--p", ((n - 1) / Math.max(1, readerState.pageCount - 1) * 100) + "%");
      } finally {
        readerState.rendering = false;
        if (readerState.pendingPage != null) {
          const p = readerState.pendingPage; readerState.pendingPage = null;
          showPage(p);
        }
      }
    }
    await showPage(initialPage);

    // Bookmark icon reflects "started"
    const bmIcon = root.querySelector("[data-bookmark-icon]");
    function refreshBookmark() {
      const fav = !!book.bookmarked;
      bmIcon.textContent = fav ? "bookmark" : "bookmark_border";
      bmIcon.style.fontVariationSettings = `'FILL' ${fav ? 1 : 0}`;
    }
    refreshBookmark();
    root.querySelector('[data-act="bookmark"]').addEventListener("click", async () => {
      book.bookmarked = !book.bookmarked;
      await idb.put("books", book);
      refreshBookmark();
    });

    // Page nav
    root.querySelector('[data-act="prev"]').addEventListener("click", () => showPage(readerState.currentPage - 1));
    root.querySelector('[data-act="next"]').addEventListener("click", () => showPage(readerState.currentPage + 1));
    pageSlider.addEventListener("input", () => {
      pageCur.textContent = pageSlider.value;
      pageSlider.style.setProperty("--p", ((pageSlider.value - 1) / Math.max(1, readerState.pageCount - 1) * 100) + "%");
    });
    pageSlider.addEventListener("change", () => showPage(parseInt(pageSlider.value, 10)));

    // Keyboard
    function onKey(e) {
      if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); showPage(readerState.currentPage + 1); }
      else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); showPage(readerState.currentPage - 1); }
    }
    document.addEventListener("keydown", onKey);

    // Swipe (touch) to flip pages
    let tStart = null;
    stage.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) return;
      tStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
    }, { passive: true });
    stage.addEventListener("touchend", (e) => {
      if (!tStart) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - tStart.x, dy = t.clientY - tStart.y, dt = Date.now() - tStart.t;
      tStart = null;
      if (dt > 600) return;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx < 0) showPage(readerState.currentPage + 1);
      else showPage(readerState.currentPage - 1);
    }, { passive: true });

    // Re-render on resize
    const ro = new ResizeObserver(() => showPage(readerState.currentPage));
    ro.observe(stage);

    // Persist current page periodically + record session on leave
    const saveTimer = setInterval(() => persistReaderProgress(), 4000);
    const onVis = () => { if (document.visibilityState === "hidden") persistReaderProgress(); };
    document.addEventListener("visibilitychange", onVis);
    const onUnload = () => { try { persistReaderProgress(); } catch {} };
    window.addEventListener("beforeunload", onUnload);

    // Hand cleanup to the router
    viewCleanup = async () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("beforeunload", onUnload);
      clearInterval(saveTimer);
      ro.disconnect();
      await finalizeSession();
    };
  }

  async function persistReaderProgress() {
    if (!readerState) return;
    const { book, currentPage, pageCount } = readerState;
    book.lastPage = currentPage;
    book.pageCount = pageCount;
    book.lastReadAt = Date.now();
    if (currentPage >= pageCount) book.finishedAt = book.finishedAt || Date.now();
    await idb.put("books", book);
  }

  async function finalizeSession() {
    if (!readerState) return;
    const { book, session, currentPage } = readerState;
    const endAt = Date.now();
    const durationMs = endAt - session.startAt;
    const pagesRead = Math.max(0, currentPage - session.startPage);
    if (durationMs > 5000 || pagesRead > 0) {
      await idb.put("sessions", {
        bookId: book.id,
        startAt: session.startAt,
        endAt,
        startPage: session.startPage,
        endPage: currentPage,
        pagesRead,
        durationMs,
      });
    }
    await persistReaderProgress();
    readerState = null;
  }

  // ---------- Import ----------
  async function handleFiles(files) {
    if (!files || !files.length) return;
    await waitFor(() => !!window.pdfjsLib);
    let added = 0;
    for (const file of files) {
      if (file.type && file.type !== "application/pdf") continue;
      toast(`Importing ${file.name}…`, 60000);
      try {
        const blob = file.slice(0, file.size, "application/pdf");
        const pdf = await loadPdfFromBlob(blob);
        const baseName = file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
        const meta = await extractTitleFromMetadata(pdf, baseName);
        const coverBlob = await extractCoverBlob(pdf, 480).catch(() => null);
        const id = "b_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
        const book = {
          id,
          title: meta.title,
          author: meta.author,
          fileName: file.name,
          sizeBytes: file.size,
          pageCount: pdf.numPages,
          lastPage: 0,
          lastReadAt: 0,
          addedAt: Date.now(),
          finishedAt: 0,
          bookmarked: false,
          coverBlob,
          fileBlob: blob,
        };
        await idb.put("books", book);
        added++;
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
      toast("No PDFs imported.", 2200);
    }
  }

  // ---------- Boot ----------
  async function boot() {
    cachedPrefs = await loadPrefs();
    applyPrefsToCSS();

    // Wire global controls
    $("#fab").addEventListener("click", () => $("#pdfInput").click());
    $("#topImportBtn").addEventListener("click", () => $("#pdfInput").click());
    $("#pdfInput").addEventListener("change", (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = ""; // reset
      handleFiles(files);
    });

    // Route buttons
    document.addEventListener("click", (e) => {
      const t = e.target.closest("[data-route]");
      if (!t) return;
      e.preventDefault();
      navigate(t.dataset.route);
    });

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
