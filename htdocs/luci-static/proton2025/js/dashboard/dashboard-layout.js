/**
 * Proton2025 Dashboard - Overview Layout Orchestrator v8.0
 * Copyright 2025-2026 ChesterGoodiny
 * Licensed under the Apache License, Version 2.0
 * See LICENSE and NOTICE for details.
 *
 * Модель B' (ТЗ п.13.4):
 *   layout = {
 *     version: 2,
 *     rows: [ [ {id, w}, ... ], ... ],
 *     hidden: [id, ...]
 *   }
 *   w = целое 1..12, строка = CSS Grid с fr по весам.
 *
 * Identity карточек: узлы LuCI-секций и наших виджетов НИКОГДА не
 * отвязываются от DOM. Перемещение — только cell.appendChild(node),
 * если node.parentNode !== cell.
 *
 * Проблема height: 100% у LuCI-секций (ТЗ п.16) решена CSS:
 * строка — display: grid, ячейка — height: 100%, карточка — height: 100%.
 * Никаких flex-basis, которые ломают высоту.
 *
 * Режим редактирования (кнопка-карандаш в header.ut):
 *   Desktop: drag карточек + resize мышью за правый край + 👁 скрыть.
 *   Mobile:  ↑/↓ для порядка (drag отключён) + 👁 скрыть.
 *   Панель «Сбросить к дефолту» — фиксированная плашка внизу.
 */

(function () {
  "use strict";

  const MAINCONTENT_ID = "maincontent";
  const VIEW_ID = "view";
  const GRID_ID = "proton-overview-grid";
  const STORAGE_KEY = "proton-overview-layout";
  const EDIT_BTN_ID = "proton-overview-edit-btn";

  const W_MIN = 1;
  const W_MAX = 12;

  const CARD_IDS = [
    "internet", "hosts", "ports", "system", "apps",
    "temperature", "ram", "storage", "network", "dhcp"
  ];

  const DEFAULT_LAYOUT = {
    version: 2,
    rows: [
      [ { id: "internet", w: 2 }, { id: "hosts", w: 3 } ],
      [ { id: "ports", w: 1 } ],
      [ { id: "system", w: 1 }, { id: "apps", w: 1 } ],
      [ { id: "temperature", w: 1 } ],
      [ { id: "ram", w: 1 }, { id: "storage", w: 1 } ],
      [ { id: "network", w: 1 } ],
      [ { id: "dhcp", w: 1 } ],
    ],
    hidden: [],
  };

  const LUCY_SECTIONS = {
    ram:     ["память", "memory", "оперативная память"],
    storage: ["хранилище", "storage"],
    network: ["сеть", "network"],
    ports:   ["состояние портов", "port status", "ports", "network ports"],
    dhcp:    ["аренды dhcp", "dhcp leases", "dhcp"],
  };

  let gridRoot = null;
  let layoutObserver = null;
  let relayoutScheduled = false;
  let mounted = false;
  let currentLayout = null;
  let editMode = false;
  let isMobile = false;
  let resizeState = null;
  let resetBar = null;
  let editBtn = null;

  function t(value) {
    if (typeof window.protonT === "function") return window.protonT(value);
    if (window.L && typeof L.tr === "function") {
      const tr = L.tr(value);
      if (tr && tr !== value) return tr;
    }
    return value;
  }

  // ---------------------------------------------------------------------------
  // Layout: load / save / normalize
  // ---------------------------------------------------------------------------

  function isBrokenLegacyLayout(obj) {
    // v1/v2/v3 при провале писали раскладку из 10 строк по 1 карточке.
    if (!obj || !Array.isArray(obj.rows)) return false;
    if (obj.version === 2) return false;
    if (obj.rows.length < 10) return false;
    for (const row of obj.rows) {
      if (!Array.isArray(row) || row.length !== 1) return false;
    }
    return true;
  }

  function cloneLayout(layout) {
    return {
      version: 2,
      rows: layout.rows.map(row => row.map(cell => ({ id: cell.id, w: cell.w }))),
      hidden: layout.hidden.slice(),
    };
  }

  function normalizeLayout(raw) {
    const known = new Set(CARD_IDS);
    const seen = new Set();
    const rows = [];

    if (raw && Array.isArray(raw.rows)) {
      for (const row of raw.rows) {
        if (!Array.isArray(row) || row.length === 0) continue;
        const newRow = [];
        for (const cell of row) {
          if (!cell || typeof cell.id !== "string") continue;
          if (!known.has(cell.id)) continue;
          if (seen.has(cell.id)) continue;
          let w = parseInt(cell.w, 10);
          if (!Number.isFinite(w)) w = 1;
          if (w < W_MIN) w = W_MIN;
          if (w > W_MAX) w = W_MAX;
          newRow.push({ id: cell.id, w: w });
          seen.add(cell.id);
        }
        if (newRow.length) rows.push(newRow);
      }
    }

    const hidden = [];
    if (raw && Array.isArray(raw.hidden)) {
      for (const id of raw.hidden) {
        if (typeof id !== "string") continue;
        if (!known.has(id)) continue;
        if (hidden.indexOf(id) !== -1) continue;
        hidden.push(id);
      }
    }

    const missing = CARD_IDS.filter(id => !seen.has(id) && hidden.indexOf(id) === -1);
    if (missing.length) {
      if (!rows.length) rows.push([]);
      const lastRow = rows[rows.length - 1];
      for (const id of missing) {
        lastRow.push({ id: id, w: 1 });
      }
    }

    const cleanRows = rows.filter(r => r.length > 0);

    return {
      version: 2,
      rows: cleanRows,
      hidden: hidden,
    };
  }

  function loadLayout() {
    let raw = null;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) raw = JSON.parse(stored);
    } catch (e) { raw = null; }

    if (isBrokenLegacyLayout(raw)) {
      raw = null;
    }

    if (!raw || raw.version !== 2) {
      return cloneLayout(DEFAULT_LAYOUT);
    }

    return normalizeLayout(raw);
  }

  function saveLayout() {
    if (!currentLayout) return;
    const json = JSON.stringify(currentLayout);
    try {
      localStorage.setItem(STORAGE_KEY, json);
    } catch (e) {}
    if (window.protonSettingsSync && typeof window.protonSettingsSync.saveLocalKeyToUci === "function") {
      window.protonSettingsSync.saveLocalKeyToUci(STORAGE_KEY, json).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Поиск LuCI-секций (только чтение #view, без мутации)
  // ---------------------------------------------------------------------------

  function normalizeHeading(text) {
    return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function getSectionHeading(section) {
    const h3 = section.querySelector(":scope > .cbi-title > h3, :scope > h3");
    if (!h3) return "";
    let heading = "";
    for (const node of h3.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) heading += node.textContent;
      else if (node.nodeType === Node.ELEMENT_NODE && node.tagName !== "SPAN") {
        heading += node.textContent;
      }
    }
    return normalizeHeading(heading);
  }

  function findLucysections() {
    const view = document.getElementById(VIEW_ID);
    const root = gridRoot || document.body;
    const found = {};
    const sections = [];

    // 1. Из #view — те, что ещё не перемещены
    if (view) {
      view.querySelectorAll(".cbi-section").forEach(s => sections.push(s));
    }

    // 2. Из ячеек — уже перемещённые (чтобы не терять identity)
    root.querySelectorAll(".proton-overview-cell > .cbi-section").forEach(s => {
      if (s.parentElement === view) return;
      sections.push(s);
    });

    for (const section of sections) {
      if (section.dataset.protonLayoutTag) {
        const key = section.dataset.protonLayoutTag;
        if (!found[key]) found[key] = section;
        continue;
      }
      const heading = getSectionHeading(section);
      if (!heading) continue;
      for (const [key, aliases] of Object.entries(LUCY_SECTIONS)) {
        if (found[key]) continue;
        if (aliases.some(alias => heading.includes(alias))) {
          found[key] = section;
          section.dataset.protonLayoutTag = key;
          break;
        }
      }
    }

    return found;
  }

  // ---------------------------------------------------------------------------
  // Поиск наших виджетов
  // ---------------------------------------------------------------------------

  function findOurWidgets() {
    return {
      internet: document.getElementById("proton-dashboard-internet"),
      system: document.getElementById("proton-dashboard-system"),
      apps: document.getElementById("proton-dashboard-apps"),
      temperature: document.getElementById("proton-temp-widget"),
      hosts: document.getElementById("proton-dashboard-hosts"),
    };
  }

  function resolveNode(id, widgets, luci) {
    switch (id) {
      case "internet":    return widgets.internet;
      case "hosts":       return widgets.hosts;
      case "system":      return widgets.system;
      case "apps":        return widgets.apps;
      case "temperature": return widgets.temperature;
      case "ports":       return luci.ports;
      case "ram":         return luci.ram;
      case "storage":     return luci.storage;
      case "network":     return luci.network;
      case "dhcp":        return luci.dhcp;
      default:            return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Grid construction
  // ---------------------------------------------------------------------------

  function ensureGridRoot() {
    if (gridRoot && document.body.contains(gridRoot)) return gridRoot;

    const maincontent = document.getElementById(MAINCONTENT_ID);
    if (!maincontent) return null;

    const staleByIds = ["proton-dashboard-grid", "proton-widgets-grid"];
    for (const id of staleByIds) {
      const stale = document.getElementById(id);
      if (stale) {
        const parent = stale.parentNode;
        while (stale.firstChild) parent.insertBefore(stale.firstChild, stale);
        parent.removeChild(stale);
      }
    }

    gridRoot = document.createElement("div");
    gridRoot.id = GRID_ID;
    gridRoot.className = "proton-overview-grid";

    const view = document.getElementById(VIEW_ID);
    if (view && view.parentNode === maincontent) {
      maincontent.insertBefore(gridRoot, view);
    } else {
      maincontent.insertBefore(gridRoot, maincontent.firstElementChild);
    }

    return gridRoot;
  }

  // ---------------------------------------------------------------------------
  // Placement (identity-safe)
  // ---------------------------------------------------------------------------

  function placeInCell(cell, node) {
    if (!cell || !node) return false;
    if (node.parentNode === cell) return false;
    cell.appendChild(node);
    return true;
  }

  function ensureRow(rowIndex) {
    let row = gridRoot.querySelector(':scope > .proton-overview-row[data-row-index="' + rowIndex + '"]');
    if (!row) {
      row = document.createElement("div");
      row.className = "proton-overview-row";
      row.dataset.rowIndex = String(rowIndex);
      gridRoot.appendChild(row);
    }
    return row;
  }

  function ensureCell(row, cardId) {
    let cell = row.querySelector(':scope > .proton-overview-cell[data-cell-id="' + cardId + '"]');
    if (!cell) {
      cell = document.createElement("div");
      cell.className = "proton-overview-cell";
      cell.dataset.cellId = cardId;
      row.appendChild(cell);
    }
    return cell;
  }

  function pruneStaleRowsAndCells() {
    const root = gridRoot;
    if (!root || !currentLayout) return;

    const validRowIndexes = new Set(currentLayout.rows.map((_, i) => String(i)));
    const validCellsByRow = new Map();
    currentLayout.rows.forEach((row, i) => {
      validCellsByRow.set(String(i), new Set(row.map(c => c.id)));
    });

    root.querySelectorAll(":scope > .proton-overview-row").forEach(row => {
      const idx = row.dataset.rowIndex;
      if (!validRowIndexes.has(idx)) {
        const maincontent = document.getElementById(MAINCONTENT_ID);
        if (maincontent) {
          while (row.firstChild) row.removeChild(row.firstChild);
        }
        row.remove();
        return;
      }
      const validCells = validCellsByRow.get(idx);
      row.querySelectorAll(":scope > .proton-overview-cell").forEach(cell => {
        if (!validCells.has(cell.dataset.cellId)) {
          const maincontent = document.getElementById(MAINCONTENT_ID);
          while (cell.firstChild) {
            const child = cell.firstChild;
            cell.removeChild(child);
            if (maincontent) maincontent.appendChild(child);
          }
          cell.remove();
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Edit-controls
  // ---------------------------------------------------------------------------

  function createEditControlsForCell(cell, cardId) {
    if (!isMobile) {
      const drag = document.createElement("div");
      drag.className = "proton-overview-drag-handle";
      drag.title = t("Drag to reorder");
      drag.dataset.role = "drag-handle";
      drag.dataset.cardId = cardId;
      drag.setAttribute("draggable", "true");
      cell.appendChild(drag);
    }

    if (!isMobile) {
      const resize = document.createElement("div");
      resize.className = "proton-overview-resize-handle";
      resize.title = t("Drag to resize");
      resize.dataset.role = "resize-handle";
      resize.dataset.cardId = cardId;
      cell.appendChild(resize);
    }

    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "proton-overview-hide-btn";
    hide.title = t("Hide card");
    hide.setAttribute("aria-label", t("Hide card"));
    hide.dataset.role = "hide-btn";
    hide.dataset.cardId = cardId;
    hide.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
    hide.addEventListener("click", ev => { ev.stopPropagation(); hideCard(cardId); });
    cell.appendChild(hide);

    if (isMobile) {
      const controls = document.createElement("div");
      controls.className = "proton-overview-mobile-controls";
      controls.dataset.role = "mobile-controls";
      controls.dataset.cardId = cardId;

      const up = document.createElement("button");
      up.type = "button";
      up.textContent = "↑";
      up.title = t("Move up");
      up.setAttribute("aria-label", t("Move up"));
      up.addEventListener("click", ev => { ev.stopPropagation(); moveCard(cardId, -1); });

      const down = document.createElement("button");
      down.type = "button";
      down.textContent = "↓";
      down.title = t("Move down");
      down.setAttribute("aria-label", t("Move down"));
      down.addEventListener("click", ev => { ev.stopPropagation(); moveCard(cardId, 1); });

      controls.appendChild(up);
      controls.appendChild(down);
      cell.appendChild(controls);
    }

    if (!isMobile) {
      bindDragAndDrop(cell, cardId);
      bindResize(cell, cardId);
    }
  }

  function removeEditControls() {
    if (!gridRoot) return;
    gridRoot.querySelectorAll('[data-role="drag-handle"], [data-role="resize-handle"], [data-role="hide-btn"], [data-role="mobile-controls"]').forEach(el => el.remove());
    gridRoot.querySelectorAll(".is-dragging, .drop-target-before, .drop-target-after").forEach(el => el.classList.remove("is-dragging", "drop-target-before", "drop-target-after"));
  }

  function hideCard(cardId) {
    if (!currentLayout) return;
    if (currentLayout.hidden.indexOf(cardId) === -1) currentLayout.hidden.push(cardId);
    buildLayout();
    saveLayout();
  }

  function moveCard(cardId, direction) {
    if (!currentLayout) return;
    let found = null;
    for (let r = 0; r < currentLayout.rows.length; r++) {
      const row = currentLayout.rows[r];
      for (let c = 0; c < row.length; c++) {
        if (row[c].id === cardId) { found = { r, c }; break; }
      }
      if (found) break;
    }
    if (!found) return;

    const row = currentLayout.rows[found.r];
    const newC = found.c + direction;

    if (newC >= 0 && newC < row.length) {
      const tmp = row[found.c];
      row[found.c] = row[newC];
      row[newC] = tmp;
    } else if (direction < 0 && found.r > 0) {
      row.splice(found.c, 1);
      const prevRow = currentLayout.rows[found.r - 1];
      prevRow.splice(0, 0, { id: cardId, w: row[found.c] ? row[found.c].w : 1 });
      if (row.length === 0) currentLayout.rows.splice(found.r, 1);
    } else if (direction > 0 && found.r < currentLayout.rows.length - 1) {
      row.splice(found.c, 1);
      const nextRow = currentLayout.rows[found.r + 1];
      nextRow.push({ id: cardId, w: 1 });
      if (row.length === 0) currentLayout.rows.splice(found.r, 1);
    }

    buildLayout();
    saveLayout();
  }

  let dragSourceId = null;

  function bindDragAndDrop(cell, cardId) {
    cell.setAttribute("draggable", "true");
    cell.dataset.dragId = cardId;

    cell.addEventListener("dragstart", ev => {
      dragSourceId = cardId;
      cell.classList.add("is-dragging");
      try {
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", cardId);
      } catch (e) {}
    });

    cell.addEventListener("dragend", () => {
      cell.classList.remove("is-dragging");
      dragSourceId = null;
      gridRoot.querySelectorAll(".drop-target-before, .drop-target-after").forEach(el => {
        el.classList.remove("drop-target-before", "drop-target-after");
      });
    });

    cell.addEventListener("dragover", ev => {
      if (!dragSourceId || dragSourceId === cardId) return;
      ev.preventDefault();
      try { ev.dataTransfer.dropEffect = "move"; } catch (e) {}

      const rect = cell.getBoundingClientRect();
      const isBefore = ev.clientX < rect.left + rect.width / 2;
      cell.classList.toggle("drop-target-before", isBefore);
      cell.classList.toggle("drop-target-after", !isBefore);
    });

    cell.addEventListener("dragleave", ev => {
      if (ev.relatedTarget && cell.contains(ev.relatedTarget)) return;
      cell.classList.remove("drop-target-before", "drop-target-after");
    });

    cell.addEventListener("drop", ev => {
      if (!dragSourceId || dragSourceId === cardId) return;
      ev.preventDefault();
      const rect = cell.getBoundingClientRect();
      const isBefore = ev.clientX < rect.left + rect.width / 2;
      cell.classList.remove("drop-target-before", "drop-target-after");
      dropCard(dragSourceId, cardId, isBefore);
      dragSourceId = null;
    });
  }

  function findCardPosition(cardId) {
    if (!currentLayout) return null;
    for (let r = 0; r < currentLayout.rows.length; r++) {
      const row = currentLayout.rows[r];
      for (let c = 0; c < row.length; c++) {
        if (row[c].id === cardId) return { r, c, card: row[c] };
      }
    }
    return null;
  }

  function dropCard(sourceId, targetId, isBefore) {
    if (!currentLayout || sourceId === targetId) return;
    const src = findCardPosition(sourceId);
    const tgt = findCardPosition(targetId);
    if (!src || !tgt) return;

    const card = currentLayout.rows[src.r].splice(src.c, 1)[0];
    if (!card) return;

    if (currentLayout.rows[src.r].length === 0) currentLayout.rows.splice(src.r, 1);

    const tgt2 = findCardPosition(targetId);
    if (!tgt2) return;

    const insertIdx = isBefore ? tgt2.c : tgt2.c + 1;
    currentLayout.rows[tgt2.r].splice(insertIdx, 0, card);

    buildLayout();
    saveLayout();
  }

  function bindResize(cell, cardId) {
    const handle = cell.querySelector('[data-role="resize-handle"]');
    if (!handle) return;

    handle.addEventListener("mousedown", ev => {
      ev.preventDefault();
      ev.stopPropagation();

      const pos = findCardPosition(cardId);
      if (!pos) return;

      const row = currentLayout.rows[pos.r];
      const totalW = row.reduce((s, c) => s + c.w, 0);

      let neighbor = null;
      if (pos.c + 1 < row.length) neighbor = { idx: pos.c + 1, card: row[pos.c + 1] };
      else if (pos.c > 0) neighbor = { idx: pos.c - 1, card: row[pos.c - 1] };

      if (!neighbor) return;

      resizeState = {
        cardId,
        rowIndex: pos.r,
        cellIndex: pos.c,
        neighborIdx: neighbor.idx,
        startX: ev.clientX,
        startW: row[pos.c].w,
        neighborW: neighbor.card.w,
        totalW,
        rowEl: cell.parentElement,
        rowPixelWidth: cell.parentElement.getBoundingClientRect().width,
      };

      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";

      document.addEventListener("mousemove", onResizeMove);
      document.addEventListener("mouseup", onResizeUp);
    });
  }

  function onResizeMove(ev) {
    if (!resizeState || !currentLayout) return;
    const row = currentLayout.rows[resizeState.rowIndex];
    if (!row) return;
    const cell = row[resizeState.cellIndex];
    const neighbor = row[resizeState.neighborIdx];
    if (!cell || !neighbor) return;

    const pxPerW = resizeState.rowPixelWidth / resizeState.totalW;
    const dx = ev.clientX - resizeState.startX;
    const dw = Math.round(dx / pxPerW);

    let newW = resizeState.startW + dw;
    let newNeighborW = resizeState.neighborW - dw;

    if (newW < W_MIN) { newNeighborW -= (W_MIN - newW); newW = W_MIN; }
    if (newW > W_MAX) { newNeighborW += (newW - W_MAX); newW = W_MAX; }
    if (newNeighborW < W_MIN) { newW -= (W_MIN - newNeighborW); newNeighborW = W_MIN; }
    if (newNeighborW > W_MAX) { newW += (newNeighborW - W_MAX); newNeighborW = W_MAX; }

    if (newW < W_MIN) newW = W_MIN;
    if (newNeighborW < W_MIN) newNeighborW = W_MIN;

    cell.w = newW;
    neighbor.w = newNeighborW;

    applyRowGrid(resizeState.rowEl, row);
  }

  function onResizeUp() {
    document.removeEventListener("mousemove", onResizeMove);
    document.removeEventListener("mouseup", onResizeUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    resizeState = null;
    saveLayout();
  }

  function applyRowGrid(rowEl, row) {
    rowEl.style.gridTemplateColumns = row.map(c => c.w + "fr").join(" ");
  }

  function showResetBar() {
    if (resetBar) return;
    resetBar = document.createElement("div");
    resetBar.className = "proton-overview-reset-bar";

    const label = document.createElement("span");
    label.textContent = t("Edit mode");
    label.style.cssText = "font-size:0.85rem;color:var(--proton-fg-secondary);";

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "cbi-button cbi-button-neutral";
    resetBtn.textContent = t("Reset to default");
    resetBtn.addEventListener("click", () => {
      if (!confirm(t("Reset layout to default?"))) return;
      currentLayout = cloneLayout(DEFAULT_LAYOUT);
      buildLayout();
      saveLayout();
    });

    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "cbi-button cbi-button-positive";
    doneBtn.textContent = t("Done");
    doneBtn.addEventListener("click", exitEditMode);

    resetBar.appendChild(label);
    resetBar.appendChild(resetBtn);
    resetBar.appendChild(doneBtn);
    document.body.appendChild(resetBar);
  }

  function hideResetBar() {
    if (resetBar && resetBar.parentNode) resetBar.parentNode.removeChild(resetBar);
    resetBar = null;
  }

  function enterEditMode() {
    if (editMode || !gridRoot) return;
    editMode = true;
    gridRoot.classList.add("is-editing");
    if (editBtn) editBtn.setAttribute("aria-pressed", "true");

    currentLayout.rows.forEach(row => {
      for (const cellSpec of row) {
        if (currentLayout.hidden.indexOf(cellSpec.id) !== -1) continue;
        const cell = gridRoot.querySelector('[data-cell-id="' + cellSpec.id + '"]');
        if (cell) createEditControlsForCell(cell, cellSpec.id);
      }
    });

    showResetBar();
  }

  function exitEditMode() {
    if (!editMode) return;
    editMode = false;
    if (gridRoot) gridRoot.classList.remove("is-editing");
    if (editBtn) editBtn.setAttribute("aria-pressed", "false");
    removeEditControls();
    hideResetBar();
    saveLayout();
  }

  function toggleEditMode() {
    if (editMode) exitEditMode();
    else enterEditMode();
  }

  function bindEditButton() {
    editBtn = document.getElementById(EDIT_BTN_ID);
    if (!editBtn) return;
    if (editBtn.dataset.protonBound === "1") return;
    editBtn.dataset.protonBound = "1";
    editBtn.addEventListener("click", toggleEditMode);
  }

  // ---------------------------------------------------------------------------
  // buildLayout
  // ---------------------------------------------------------------------------

  function buildLayout() {
    const root = ensureGridRoot();
    if (!root) return false;
    if (!currentLayout) currentLayout = loadLayout();

    const widgets = findOurWidgets();
    const luci = findLucysections();
    isMobile = window.matchMedia("(max-width: 800px)").matches;

    for (let r = 0; r < currentLayout.rows.length; r++) {
      const row = currentLayout.rows[r];
      const rowEl = ensureRow(r);

      // Строка — CSS Grid, fr по весам.
      // Это самый предсказуемый способ задать пропорции.
      rowEl.style.display = "grid";
      rowEl.style.gridTemplateColumns = row.map(c => c.w + "fr").join(" ");
      rowEl.style.gap = "18px";
      rowEl.style.alignItems = "stretch";

      // Удаляем ячейки, которых больше нет в этой строке
      const validIds = new Set(row.map(c => c.id));
      rowEl.querySelectorAll(":scope > .proton-overview-cell").forEach(cell => {
        if (!validIds.has(cell.dataset.cellId)) {
          const maincontent = document.getElementById(MAINCONTENT_ID);
          while (cell.firstChild) {
            const child = cell.firstChild;
            cell.removeChild(child);
            if (maincontent) maincontent.appendChild(child);
          }
          cell.remove();
        }
      });

      let hasVisible = false;

      for (const cellSpec of row) {
        const cell = ensureCell(rowEl, cellSpec.id);

        if (currentLayout.hidden.indexOf(cellSpec.id) !== -1) {
          cell.style.display = "none";
          cell.classList.add("is-hidden");
          continue;
        }
        cell.style.display = "";
        cell.classList.remove("is-hidden");

        const node = resolveNode(cellSpec.id, widgets, luci);
        if (node) {
          const ph = cell.querySelector(".proton-overview-placeholder");
          if (ph) ph.remove();
          placeInCell(cell, node);
          hasVisible = true;
        } else {
          if (!cell.querySelector(".proton-overview-placeholder")) {
            const ph = document.createElement("div");
            ph.className = "proton-overview-placeholder";
            ph.textContent = t("Loading...");
            cell.appendChild(ph);
          }
        }
      }

      if (!hasVisible) {
        rowEl.classList.add("is-hidden");
        rowEl.style.display = "none";
      } else {
        rowEl.classList.remove("is-hidden");
        rowEl.style.display = "";
      }
    }

    pruneStaleRowsAndCells();

    const dashSection = document.getElementById("proton-dashboard-section");
    if (dashSection && !dashSection.querySelector("#proton-dashboard-internet")) {
      dashSection.style.display = "none";
    }
    const widgetsSection = document.querySelector(".proton-widgets-section");
    if (widgetsSection && !widgetsSection.querySelector("#proton-temp-widget")) {
      widgetsSection.style.display = "none";
    }

    if (editMode) {
      removeEditControls();
      currentLayout.rows.forEach(row => {
        for (const cellSpec of row) {
          if (currentLayout.hidden.indexOf(cellSpec.id) !== -1) continue;
          const cell = gridRoot.querySelector('[data-cell-id="' + cellSpec.id + '"]');
          if (cell) createEditControlsForCell(cell, cellSpec.id);
        }
      });
    }

    return true;
  }

  function scheduleRelayout() {
    if (relayoutScheduled) return;
    relayoutScheduled = true;
    requestAnimationFrame(() => {
      relayoutScheduled = false;
      try { buildLayout(); } catch (e) { console.warn("[Proton2025] Layout error:", e); }
    });
  }

  function isOverviewPage() {
    return (
      document.body.dataset.page === "admin-status-overview" ||
      window.location.pathname.includes("/admin/status/overview")
    );
  }

  function startObserver() {
    if (layoutObserver) return;
    const maincontent = document.getElementById(MAINCONTENT_ID);
    if (!maincontent) return;

    layoutObserver = new MutationObserver(mutations => {
      for (const m of mutations) {
        if (m.type === "childList" && (m.addedNodes.length || m.removedNodes.length)) { scheduleRelayout(); return; }
        if (m.type === "attributes" && m.attributeName === "data-page") { scheduleRelayout(); return; }
      }
    });

    layoutObserver.observe(maincontent, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-page"] });

    let intervalTicks = 0;
    const interval = setInterval(() => {
      intervalTicks++;
      if (!document.body.contains(maincontent)) { clearInterval(interval); return; }
      scheduleRelayout();
      if (intervalTicks > 30) { clearInterval(interval); setInterval(scheduleRelayout, 5000); }
    }, 1000);

    let resizeTimer = null;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const wasMobile = isMobile;
        isMobile = window.matchMedia("(max-width: 800px)").matches;
        if (wasMobile !== isMobile && editMode) {
          removeEditControls();
          currentLayout.rows.forEach(row => {
            for (const cellSpec of row) {
              if (currentLayout.hidden.indexOf(cellSpec.id) !== -1) continue;
              const cell = gridRoot.querySelector('[data-cell-id="' + cellSpec.id + '"]');
              if (cell) createEditControlsForCell(cell, cellSpec.id);
            }
          });
        }
        scheduleRelayout();
      }, 150);
    };
    window.addEventListener("resize", onResize);

    window.addEventListener("pagehide", () => {
      clearInterval(interval);
      window.removeEventListener("resize", onResize);
    }, { once: true });
  }

  function start() {
    if (mounted) return;
    mounted = true;
    currentLayout = loadLayout();
    isMobile = window.matchMedia("(max-width: 800px)").matches;
    buildLayout();
    bindEditButton();
    startObserver();
  }

  function stop() {
    mounted = false;
    if (layoutObserver) { layoutObserver.disconnect(); layoutObserver = null; }
    if (gridRoot && gridRoot.parentNode) {
      const parent = gridRoot.parentNode;
      while (gridRoot.firstChild) parent.insertBefore(gridRoot.firstChild, gridRoot);
      parent.removeChild(gridRoot);
      gridRoot = null;
    }
    if (editMode) exitEditMode();
  }

  function init() {
    if (!isOverviewPage()) return;
    if (!document.getElementById(MAINCONTENT_ID)) {
      const bodyObs = new MutationObserver(() => {
        if (document.getElementById(MAINCONTENT_ID)) { bodyObs.disconnect(); start(); }
      });
      bodyObs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => bodyObs.disconnect(), 15000);
      return;
    }
    start();
  }

  window.ProtonDashboardLayout = {
    start,
    stop,
    relayout: scheduleRelayout,
    getLayout: () => cloneLayout(currentLayout || DEFAULT_LAYOUT),
    setLayout: layout => {
      currentLayout = normalizeLayout(layout);
      buildLayout();
      saveLayout();
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
