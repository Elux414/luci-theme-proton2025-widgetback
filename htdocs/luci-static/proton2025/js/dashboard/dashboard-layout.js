/**
 * Proton2025 Dashboard - Overview Layout Orchestrator v9.0 (Masonry Grid)
 */

(function () {
  "use strict";

  const MAINCONTENT_ID = "maincontent";
  const VIEW_ID = "view";
  const GRID_ID = "proton-overview-grid";
  const STORAGE_KEY = "proton-overview-layout";
  const EDIT_BTN_ID = "proton-overview-edit-btn";

  const CARD_IDS = [
    "internet", "hosts", "ports", "system", "apps",
    "temperature", "ram", "storage", "network", "dhcp",
    "wireless"
  ];

  const DEFAULT_LAYOUT = {
    version: 3,
    cards: [
      { id: "internet", w: 5, h: 2 },
      { id: "hosts", w: 7, h: 2 },
      { id: "ports", w: 12, h: 1 },
      { id: "system", w: 6, h: 3 },
      { id: "apps", w: 6, h: 3 },
      { id: "temperature", w: 12, h: 1 },
      { id: "ram", w: 6, h: 2 },
      { id: "storage", w: 6, h: 2 },
      { id: "network", w: 12, h: 2 },
      { id: "dhcp", w: 12, h: 1 }
    ],
    hidden: [],
  };

  const LUCY_SECTIONS = {
    ram:     ["память", "memory", "оперативная память"],
    storage: ["хранилище", "storage"],
    network: ["сеть", "network"],
    wireless: ["беспроводная сеть", "wireless", "wi-fi", "wifi"],
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
  let lastRenderedSignature = "";

  function computeLayoutSignature(widgets, luci) {
    const root = gridRoot;
    const parts = [];
    for (const cellSpec of currentLayout.cards) {
      const node = resolveNode(cellSpec.id, widgets, luci);
      const cell = root
        ? root.querySelector(`:scope > .proton-overview-cell[data-cell-id="${cellSpec.id}"]`)
        : null;
      const isHidden = currentLayout.hidden.includes(cellSpec.id);

      // «В ячейке» — критично: если LuCI пересоздал секцию, node сменился,
      // но id/tagName те же. Без этой проверки buildLayout решит, что
      // ничего не изменилось, и оставит в ячейке отсоединённый старый узел.
      const inCell = node && cell ? (node.parentNode === cell) : !node;

      parts.push(
        cellSpec.id + "|" + cellSpec.w + "|" + cellSpec.h + "|" +
        (isHidden ? "h" : "v") + "|" +
        (node ? (node.id || node.tagName) : "null") + "|" +
        (inCell ? "1" : "0")
      );
    }
    return parts.join(";");
  }

  function t(value) {
    if (typeof window.protonT === "function") return window.protonT(value);
    if (window.L && typeof L.tr === "function") {
      const tr = L.tr(value);
      if (tr && tr !== value) return tr;
    }
    return value;
  }

  // ---------------------------------------------------------------------------
  // Layout Model
  // ---------------------------------------------------------------------------

  function cloneLayout(layout) {
    return {
      version: 3,
      cards: layout.cards.map(c => ({ id: c.id, w: c.w, h: c.h })),
      hidden: layout.hidden.slice(),
    };
  }

  function normalizeLayout(raw) {
    const known = new Set(CARD_IDS);
    const seen = new Set();
    const cards = [];

    if (raw && raw.version === 2 && Array.isArray(raw.rows)) {
      raw.cards = [];
      raw.rows.forEach(row => {
        row.forEach(cell => {
          raw.cards.push({ id: cell.id, w: cell.w || 1, h: 1 });
        });
      });
    }

    if (raw && Array.isArray(raw.cards)) {
      for (const cell of raw.cards) {
        if (!cell || typeof cell.id !== "string") continue;
        if (!known.has(cell.id) || seen.has(cell.id)) continue;
        
        let w = parseInt(cell.w, 10);
        if (!Number.isFinite(w) || w < 1) w = 1;
        if (w > 12) w = 12;
        
        let h = parseInt(cell.h, 10);
        if (!Number.isFinite(h) || h < 1) h = 1;
        if (h > 6) h = 6;

        cards.push({ id: cell.id, w: w, h: h });
        seen.add(cell.id);
      }
    }

    const hidden = [];
    if (raw && Array.isArray(raw.hidden)) {
      for (const id of raw.hidden) {
        if (typeof id !== "string" || !known.has(id) || hidden.includes(id)) continue;
        hidden.push(id);
      }
    }

    CARD_IDS.forEach(id => {
      if (!seen.has(id) && !hidden.includes(id)) {
        cards.push({ id: id, w: 6, h: 2 });
      }
    });

    return { version: 3, cards: cards, hidden: hidden };
  }

  function loadLayout() {
    let raw = null;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) raw = JSON.parse(stored);
    } catch (e) { raw = null; }

    if (!raw || (raw.version !== 2 && raw.version !== 3)) {
      return cloneLayout(DEFAULT_LAYOUT);
    }

    return normalizeLayout(raw);
  }

  function saveLayout() {
    if (!currentLayout) return;
    const json = JSON.stringify(currentLayout);
    try { localStorage.setItem(STORAGE_KEY, json); } catch (e) {}
    if (window.protonSettingsSync && typeof window.protonSettingsSync.saveLocalKeyToUci === "function") {
      window.protonSettingsSync.saveLocalKeyToUci(STORAGE_KEY, json).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------------
  // Поиск узлов
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
    const hiddenIds = (currentLayout || loadLayout()).hidden;

    if (view) {
      view.querySelectorAll(".cbi-section").forEach(s => sections.push(s));
    }
    root.querySelectorAll(".proton-overview-cell > .cbi-section").forEach(s => {
      if (s.parentElement === view) return;
      sections.push(s);
    });

    for (const section of sections) {
      const applyHiddenState = (key, el) => {
        if (hiddenIds.includes(key)) el.style.display = "none";
        else el.style.display = "";
      };

      if (section.dataset.protonLayoutTag) {
        const key = section.dataset.protonLayoutTag;
        if (!found[key]) {
          found[key] = section;
          applyHiddenState(key, section);
        }
        continue;
      }
      
      const heading = getSectionHeading(section);
      if (!heading) continue;
      
      for (const [key, aliases] of Object.entries(LUCY_SECTIONS)) {
        if (found[key]) continue;
        if (aliases.some(alias => heading.includes(alias))) {
          found[key] = section;
          section.dataset.protonLayoutTag = key;
          applyHiddenState(key, section);
          break;
        }
      }
    }
    return found;
  }

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
      case "wireless":    return luci.wireless;
      default:            return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Grid Construction
  // ---------------------------------------------------------------------------

  function ensureGridRoot() {
    if (gridRoot && document.body.contains(gridRoot)) return gridRoot;

    const maincontent = document.getElementById(MAINCONTENT_ID);
    if (!maincontent) return null;

    ["proton-dashboard-grid", "proton-widgets-grid"].forEach(id => {
      const stale = document.getElementById(id);
      if (stale) {
        const parent = stale.parentNode;
        while (stale.firstChild) parent.insertBefore(stale.firstChild, stale);
        parent.removeChild(stale);
      }
    });

    gridRoot = document.createElement("div");
    gridRoot.id = GRID_ID;
    gridRoot.className = "proton-overview-grid";

    // Вставляем сетку
    const view = document.getElementById(VIEW_ID);
    if (view && view.parentNode === maincontent) {
      maincontent.insertBefore(gridRoot, view);
    } else {
      maincontent.insertBefore(gridRoot, maincontent.firstElementChild);
    }

    return gridRoot;
  }

  function placeInCell(cell, node) {
    if (!cell || !node) return false;
    if (node.parentNode === cell) return false;
    cell.appendChild(node);
    return true;
  }

  function buildLayout() {
    const root = ensureGridRoot();
    if (!root) return false;
    if (!currentLayout) currentLayout = loadLayout();

    const widgets = findOurWidgets();
    const luci = findLucysections();
    isMobile = window.matchMedia("(max-width: 800px)").matches;
	
	const signature = computeLayoutSignature(widgets, luci);
	if (signature === lastRenderedSignature && !editMode) {
		return true;
	}
	lastRenderedSignature = signature;

    // Очистка сетки: удаляем ячейки, которых больше нет в раскладке.
    const existingCells = Array.from(root.children);
    const activeIds = currentLayout.cards.map(c => c.id);

    existingCells.forEach(cell => {
      if (!activeIds.includes(cell.dataset.cellId)) {
        while (cell.firstChild) {
          const child = cell.firstChild;
          cell.removeChild(child);
          const maincontent = document.getElementById(MAINCONTENT_ID);
          if (maincontent) maincontent.appendChild(child);
        }
        cell.remove();
      }
    });

    // Проходим по карточкам. Каждое DOM-действие — только если оно
    // реально меняет состояние (appendChild для уже вложенного узла,
    // повторная установка того же gridColumn и т.п. — no-op, но браузер
    // всё равно перерисовывает узел, поэтому избегаем их).
    currentLayout.cards.forEach((cellSpec) => {
      let cell = root.querySelector(`:scope > .proton-overview-cell[data-cell-id="${cellSpec.id}"]`);

      if (!cell) {
        cell = document.createElement("div");
        cell.className = "proton-overview-cell";
        cell.dataset.cellId = cellSpec.id;
        root.appendChild(cell);
      }

      // gridColumn/gridRow — пишем только если значение изменилось.
      const nextCol = `span ${cellSpec.w}`;
      const nextRow = `span ${cellSpec.h}`;
      if (cell.style.gridColumn !== nextCol) cell.style.gridColumn = nextCol;
      if (cell.style.gridRow !== nextRow) cell.style.gridRow = nextRow;

      // Классы ширины — тоже только при изменении.
      const nextWidthClass =
        cellSpec.w <= 4 ? "is-narrow" : cellSpec.w <= 7 ? "is-medium" : "is-wide";
      if (!cell.classList.contains(nextWidthClass)) {
        cell.classList.remove("is-narrow", "is-medium", "is-wide");
        cell.classList.add(nextWidthClass);
      }

      const isHidden = currentLayout.hidden.includes(cellSpec.id);
      const node = resolveNode(cellSpec.id, widgets, luci);

      if (isHidden) {
        if (cell.style.display !== "none") cell.style.display = "none";
        if (!cell.classList.contains("is-hidden")) cell.classList.add("is-hidden");
        if (node && node.style.display !== "none") node.style.display = "none";
        return;
      }

      if (cell.style.display === "none") cell.style.display = "";
      if (cell.classList.contains("is-hidden")) cell.classList.remove("is-hidden");
      if (node && node.style.display === "none") node.style.display = "";

      if (node) {
        const ph = cell.querySelector(".proton-overview-placeholder");
        if (ph) ph.remove();
        placeInCell(cell, node);   // уже no-op, если node.parentNode === cell
      } else if (!cell.querySelector(".proton-overview-placeholder")) {
        const ph = document.createElement("div");
        ph.className = "proton-overview-placeholder";
        ph.textContent = t("Loading...");
        cell.appendChild(ph);
      }
    });

    // Сортировка: переставляем ячейку в конец только если она ещё не
    // последний ребёнок root. appendChild для последнего ребёнка — no-op
    // в спеке, но Chromium всё равно снимает/вставляет слой, поэтому
    // проверяем явно.
    for (let i = 0; i < currentLayout.cards.length; i++) {
      const cellSpec = currentLayout.cards[i];
      const cell = root.querySelector(`:scope > .proton-overview-cell[data-cell-id="${cellSpec.id}"]`);
      if (!cell) continue;
      const expectedPrev = root.children[i];
      if (expectedPrev !== cell) {
        root.insertBefore(cell, expectedPrev || null);
      }
    }

    // --- Скрытие старых контейнеров ---
    const view = document.getElementById(VIEW_ID);
    if (view && view.style.display !== "none") view.style.display = "none";

    const widgetsSection = document.querySelector(".proton-widgets-section");
    if (widgetsSection && widgetsSection.style.display !== "none") {
      widgetsSection.style.display = "none";
    }

    if (editMode) {
      removeEditControls();
      currentLayout.cards.forEach(cellSpec => {
        if (currentLayout.hidden.includes(cellSpec.id)) return;
        const cell = root.querySelector(`[data-cell-id="${cellSpec.id}"]`);
        if (cell) createEditControlsForCell(cell, cellSpec.id);
      });
    }

    return true;
}

  // ---------------------------------------------------------------------------
  // Edit Controls
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
      resize.title = t("Drag to resize width");
      resize.dataset.role = "resize-handle";
      resize.dataset.cardId = cardId;
      cell.appendChild(resize);

      const resizeBottom = document.createElement("div");
      resizeBottom.className = "proton-overview-resize-handle-bottom";
      resizeBottom.title = t("Drag to resize height");
      resizeBottom.dataset.role = "resize-handle-bottom";
      resizeBottom.dataset.cardId = cardId;
      cell.appendChild(resizeBottom);
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
      bindResizeBottom(cell, cardId);
    }
  }

  function removeEditControls() {
    if (!gridRoot) return;
    gridRoot.querySelectorAll('[data-role="drag-handle"], [data-role="resize-handle"], [data-role="resize-handle-bottom"], [data-role="hide-btn"], [data-role="mobile-controls"]').forEach(el => el.remove());
    gridRoot.querySelectorAll(".is-dragging, .drop-target").forEach(el => el.classList.remove("is-dragging", "drop-target"));
  }

  // ---------------------------------------------------------------------------
  // Логика изменения
  // ---------------------------------------------------------------------------

  function hideCard(cardId) {
    if (!currentLayout) return;
    if (!currentLayout.hidden.includes(cardId)) currentLayout.hidden.push(cardId);
    buildLayout();
    saveLayout();
    if (editMode) updateResetBarVisibility();
  }

  function moveCard(cardId, direction) {
    if (!currentLayout) return;
    const index = currentLayout.cards.findIndex(c => c.id === cardId);
    if (index === -1) return;

    const newIndex = index + direction;
    if (newIndex >= 0 && newIndex < currentLayout.cards.length) {
      const temp = currentLayout.cards[index];
      currentLayout.cards[index] = currentLayout.cards[newIndex];
      currentLayout.cards[newIndex] = temp;
      buildLayout();
      saveLayout();
    }
  }

  let dragSourceId = null;

  function bindDragAndDrop(cell, cardId) {
    const dragHandle = cell.querySelector('[data-role="drag-handle"]');
    if (!dragHandle) return;

    dragHandle.setAttribute("draggable", "true");

    dragHandle.addEventListener("dragstart", ev => {
      dragSourceId = cardId;
      cell.classList.add("is-dragging");
      try {
        ev.dataTransfer.effectAllowed = "move";
        ev.dataTransfer.setData("text/plain", cardId);
      } catch (e) {}
    });

    dragHandle.addEventListener("dragend", () => {
      cell.classList.remove("is-dragging");
      dragSourceId = null;
      gridRoot.querySelectorAll(".drop-target").forEach(el => el.classList.remove("drop-target"));
    });

    cell.addEventListener("dragover", ev => {
      if (!dragSourceId || dragSourceId === cardId) return;
      ev.preventDefault();
      try { ev.dataTransfer.dropEffect = "move"; } catch (e) {}
      cell.classList.add("drop-target");
    });

    cell.addEventListener("dragleave", ev => {
      if (ev.relatedTarget && cell.contains(ev.relatedTarget)) return;
      cell.classList.remove("drop-target");
    });

    cell.addEventListener("drop", ev => {
      if (!dragSourceId || dragSourceId === cardId) return;
      ev.preventDefault();
      cell.classList.remove("drop-target");
      dropCard(dragSourceId, cardId);
      dragSourceId = null;
    });
  }

  function dropCard(sourceId, targetId) {
    if (!currentLayout || sourceId === targetId) return;
    
    const srcIndex = currentLayout.cards.findIndex(c => c.id === sourceId);
    const tgtIndex = currentLayout.cards.findIndex(c => c.id === targetId);
    if (srcIndex === -1 || tgtIndex === -1) return;

    const card = currentLayout.cards.splice(srcIndex, 1)[0];
    const newTgtIndex = currentLayout.cards.findIndex(c => c.id === targetId);
    
    if (srcIndex < tgtIndex) {
      currentLayout.cards.splice(newTgtIndex + 1, 0, card);
    } else {
      currentLayout.cards.splice(newTgtIndex, 0, card);
    }

    buildLayout();
    saveLayout();
  }

  function bindResize(cell, cardId) {
    const handle = cell.querySelector('[data-role="resize-handle"]');
    if (!handle) return;

    handle.addEventListener("mousedown", ev => {
      ev.preventDefault();
      ev.stopPropagation();

      const spec = currentLayout.cards.find(c => c.id === cardId);
      if (!spec) return;

      const startX = ev.clientX;
      const startW = spec.w;
      
      const gridWidth = gridRoot.getBoundingClientRect().width;
      const colWidth = (gridWidth - 11 * 18) / 12;

      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";

      const onMouseMove = (moveEv) => {
        const dx = moveEv.clientX - startX;
        const dw = Math.round(dx / colWidth);
        let newW = startW + dw;
        if (newW < 1) newW = 1;
        if (newW > 12) newW = 12;
        
        if (newW !== spec.w) {
          spec.w = newW;
          cell.style.gridColumn = `span ${newW}`;
        }
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        saveLayout();
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  }

  function bindResizeBottom(cell, cardId) {
    const handle = cell.querySelector('[data-role="resize-handle-bottom"]');
    if (!handle) return;

    handle.addEventListener("mousedown", ev => {
      ev.preventDefault();
      ev.stopPropagation();

      const spec = currentLayout.cards.find(c => c.id === cardId);
      if (!spec) return;

      const startY = ev.clientY;
      const startH = spec.h;
      
      const rowHeight = 140 + 18; 

      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";

      const onMouseMove = (moveEv) => {
        const dy = moveEv.clientY - startY;
        const dh = Math.round(dy / rowHeight);
        let newH = startH + dh;
        if (newH < 1) newH = 1;
        if (newH > 6) newH = 6;
        
        if (newH !== spec.h) {
          spec.h = newH;
          cell.style.gridRow = `span ${newH}`;
        }
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        saveLayout();
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  }

  // ---------------------------------------------------------------------------
  // Reset Bar & Unhide
  // ---------------------------------------------------------------------------

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
      updateResetBarVisibility();
    });

    const unhideBtn = document.createElement("button");
    unhideBtn.type = "button";
    unhideBtn.className = "cbi-button cbi-button-neutral";
    unhideBtn.id = "proton-unhide-btn";
    unhideBtn.style.display = currentLayout.hidden.length > 0 ? "inline-flex" : "none";
    unhideBtn.addEventListener("click", showUnhideModal);

    const doneBtn = document.createElement("button");
    doneBtn.type = "button";
    doneBtn.className = "cbi-button cbi-button-positive";
    doneBtn.textContent = t("Done");
    doneBtn.addEventListener("click", exitEditMode);

    resetBar.appendChild(label);
    resetBar.appendChild(resetBtn);
    resetBar.appendChild(unhideBtn);
    resetBar.appendChild(doneBtn);
    document.body.appendChild(resetBar);
    updateResetBarVisibility();
  }

  function updateResetBarVisibility() {
    const unhideBtn = document.getElementById("proton-unhide-btn");
    if (unhideBtn) {
      unhideBtn.style.display = currentLayout.hidden.length > 0 ? "inline-flex" : "none";
      unhideBtn.textContent = t("Hidden cards") + " (" + currentLayout.hidden.length + ")";
    }
  }

  function showUnhideModal() {
    if (!currentLayout || currentLayout.hidden.length === 0) return;

    const overlay = document.createElement("div");
    overlay.className = "proton-confirm-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "proton-confirm-modal";
    modal.style.maxWidth = "400px";

    const heading = document.createElement("h3");
    heading.textContent = t("Hidden cards");

    const list = document.createElement("div");
    list.style.cssText = "display:flex; flex-direction:column; gap:8px; margin:16px 0; max-height:300px; overflow-y:auto;";
    
    currentLayout.hidden.forEach(id => {
      const label = document.createElement("label");
      label.style.cssText = "display:flex; align-items:center; gap:8px; cursor:pointer; padding:8px; border:1px solid var(--proton-border); border-radius:6px;";
      
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = id;
      cb.dataset.id = id;

      const name = getCardTitle(id);

      const span = document.createElement("span");
      span.textContent = name;
      span.style.flex = "1";

      label.appendChild(cb);
      label.appendChild(span);
      list.appendChild(label);
    });

    const actions = document.createElement("div");
    actions.className = "proton-confirm-modal-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "cbi-button cbi-button-neutral";
    cancelBtn.textContent = t("Cancel");
    cancelBtn.addEventListener("click", () => {
      overlay.remove();
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "cbi-button cbi-button-positive";
    saveBtn.textContent = t("Restore selected");
    saveBtn.addEventListener("click", () => {
      const selected = Array.from(list.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.dataset.id);
      if (selected.length === 0) {
        overlay.remove();
        return;
      }
      
      selected.forEach(id => {
        currentLayout.hidden = currentLayout.hidden.filter(h => h !== id);
        if (!currentLayout.cards.find(c => c.id === id)) {
          currentLayout.cards.push({ id: id, w: 6, h: 2 });
        }
      });
      
      buildLayout();
      saveLayout();
      updateResetBarVisibility();
      overlay.remove();
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    modal.appendChild(heading);
    modal.appendChild(list);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  function getCardTitle(id) {
    const map = {
      internet: "Интернет", hosts: "Устройства", ports: "Состояние портов",
      system: "Система", apps: "Приложения", temperature: "Температура",
      ram: "Память", storage: "Хранилище", network: "Сеть", dhcp: "DHCP",
      wireless: "Беспроводная сеть"
    };
    return map[id] || id;
  }

  function hideResetBar() {
    if (resetBar && resetBar.parentNode) resetBar.parentNode.removeChild(resetBar);
    resetBar = null;
  }

  // ---------------------------------------------------------------------------
  // Edit Mode Lifecycle
  // ---------------------------------------------------------------------------

  function enterEditMode() {
    if (editMode || !gridRoot) return;
    editMode = true;
    gridRoot.classList.add("is-editing");
    if (editBtn) editBtn.setAttribute("aria-pressed", "true");

    currentLayout.cards.forEach(cellSpec => {
      if (currentLayout.hidden.includes(cellSpec.id)) return;
      const cell = gridRoot.querySelector(`[data-cell-id="${cellSpec.id}"]`);
      if (cell) createEditControlsForCell(cell, cellSpec.id);
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
  // Observer / Lifecycle
  // ---------------------------------------------------------------------------

  function scheduleRelayout() {
    if (relayoutScheduled) return;
    relayoutScheduled = true;
    requestAnimationFrame(() => {
        relayoutScheduled = false;
        try {
            if (dragSourceId || resizeState) return;
            buildLayout();
        } catch (e) {
            console.warn("[Proton2025] Layout error:", e);
        }
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
            // Мутации внутри уже размещённых ячеек — это работа карточек
            // (графики, числа, чипы). Их пересборка сетки не касается.
            if (m.target && m.target.closest &&
                m.target.closest(".proton-overview-cell")) {
                continue;
            }

            // Добавление/удаление узлов на уровне #maincontent или #view —
            // это либо наши виджеты, либо LuCI-секции. Пересобираем.
            if (m.type === "childList" &&
                (m.addedNodes.length || m.removedNodes.length)) {
                scheduleRelayout();
                return;
            }

            if (m.type === "attributes" && m.attributeName === "data-page") {
                scheduleRelayout();
                return;
            }
        }
    });

    layoutObserver.observe(maincontent, {
        childList: true,
        attributes: true,
        attributeFilter: ["data-page"],
        subtree: true,
    });

    let resizeTimer = null;
    const onResize = () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            isMobile = window.matchMedia("(max-width: 800px)").matches;
            if (editMode) {
                removeEditControls();
                currentLayout.cards.forEach(cellSpec => {
                    if (currentLayout.hidden.includes(cellSpec.id)) return;
                    const cell = gridRoot.querySelector(`[data-cell-id="${cellSpec.id}"]`);
                    if (cell) createEditControlsForCell(cell, cellSpec.id);
                });
            }
            scheduleRelayout();
        }, 150);
    };
    window.addEventListener("resize", onResize);

    window.addEventListener("pagehide", () => {
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
