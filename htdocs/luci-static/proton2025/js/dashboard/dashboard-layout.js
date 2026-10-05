/**
 * Proton2025 Dashboard - Overview Layout Orchestrator
 * Copyright 2025-2026 ChesterGoodiny
 * Licensed under the Apache License, Version 2.0
 * See LICENSE and NOTICE for details.
 *
 * Собирает все блоки Overview в единый grid по заданному порядку:
 *   1. Internet       | 2. Хосты
 *   3. Система        | 4. Приложения
 *   5. Температура (full-width)
 *   6. RAM            | 7. Storage
 *   8. Сеть           | 9. Состояние портов
 *  10. Аренды DHCP (full-width)
 *
 * Источники блоков:
 *   - dashboard.js          → #proton-dashboard-internet
 *   - dashboard-system.js   → #proton-dashboard-system
 *   - dashboard-apps.js     → #proton-dashboard-apps
 *   - services-widget.js    → #proton-temp-widget
 *   - LuCI cbi-section      → RAM, Storage, Network, Ports, DHCP (в #view)
 *   - dashboard-hosts.js    → #proton-dashboard-hosts (этап 4.5.B; пока заглушка)
 */

(function () {
  "use strict";

  const MAINCONTENT_ID = "maincontent";
  const VIEW_ID = "view";
  const GRID_ID = "proton-overview-grid";

  // Секции LuCI, которые нужно переместить, ищем по тексту заголовка.
  // Ключ — наша метка для логирования и CSS-класса; значение — массив
  // допустимых текстов заголовка (ru + en), регистр нормализуется.
  const LUCY_SECTIONS = {
    ram:     ["оперативная память", "memory"],
    storage: ["хранилище", "storage"],
    network: ["сеть", "network"],
    ports:   ["состояние портов", "port status", "ports", "network ports"],
    dhcp:    ["аренды dhcp", "dhcp leases", "dhcp"],
  };

  let gridRoot = null;
  let layoutObserver = null;
  let relayoutScheduled = false;
  let mounted = false;

  function t(value) {
    if (typeof window.protonT === "function") return window.protonT(value);
    if (window.L && typeof L.tr === "function") {
      const tr = L.tr(value);
      if (tr && tr !== value) return tr;
    }
    return value;
  }

  // ---------------------------------------------------------------------------
  // Поиск LuCI-секций по заголовку
  // ---------------------------------------------------------------------------

  function normalizeHeading(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
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
        view.querySelectorAll(".cbi-section").forEach((s) => sections.push(s));
    }

    // 2. Из ячеек — уже перемещённые
    root.querySelectorAll(".proton-overview-cell > .cbi-section").forEach((s) => {
        if (s.parentElement === view) return;  // избегаем дублирования
        sections.push(s);
    });

    for (const section of sections) {
        // Если секция уже помечена — используем её метку
        if (section.dataset.protonLayoutTag) {
            const key = section.dataset.protonLayoutTag;
            if (!found[key]) found[key] = section;
            continue;
        }
        // Если не помечена — ищем по заголовку, как раньше
        const heading = getSectionHeading(section);
        if (!heading) continue;
        for (const [key, aliases] of Object.entries(LUCY_SECTIONS)) {
            if (found[key]) continue;
            if (aliases.some((alias) => heading.includes(alias))) {
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
      hosts: document.getElementById("proton-dashboard-hosts"), // этап B
    };
  }

  // ---------------------------------------------------------------------------
  // Grid construction
  // ---------------------------------------------------------------------------

  function ensureGridRoot() {
    if (gridRoot && document.body.contains(gridRoot)) return gridRoot;

    const maincontent = document.getElementById(MAINCONTENT_ID);
    if (!maincontent) return null;

    // Убираем старые наши grid-обёртки, если остались от предыдущих версий
    const staleByIds = [
      "proton-dashboard-grid",
      "proton-widgets-grid",
    ];
    for (const id of staleByIds) {
      const stale = document.getElementById(id);
      if (stale) {
        // разворачиваем детей обратно, чтобы не потерять узлы
        const parent = stale.parentNode;
        while (stale.firstChild) parent.insertBefore(stale.firstChild, stale);
        parent.removeChild(stale);
      }
    }

    gridRoot = document.createElement("div");
    gridRoot.id = GRID_ID;
    gridRoot.className = "proton-overview-grid";

    // Ставим grid в начало #maincontent, перед #view
    const view = document.getElementById(VIEW_ID);
    if (view && view.parentNode === maincontent) {
      maincontent.insertBefore(gridRoot, view);
    } else {
      maincontent.insertBefore(gridRoot, maincontent.firstElementChild);
    }

    return gridRoot;
  }

  function makeRow(className) {
    const row = document.createElement("div");
    row.className = "proton-overview-row" + (className ? " " + className : "");
    return row;
  }

  function makeCell(id, className) {
    const cell = document.createElement("div");
    cell.className = "proton-overview-cell" + (className ? " " + className : "");
    if (id) cell.id = id;
    return cell;
  }

  // Перемещает узел в ячейку, если он ещё не там.
  // Возвращает true, если что-то изменилось.
  function placeInCell(cell, node) {
    if (!cell || !node) return false;
    if (node.parentNode === cell) return false;
    cell.appendChild(node);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

  function buildLayout() {
    const root = ensureGridRoot();
    if (!root) return false;

    const widgets = findOurWidgets();
    const luci = findLucysections();

    let changed = false;

    // Проходим по всем рядам. Для каждого ряда — либо уже есть ячейки
    // (значит, всё стабильно), либо создаём заново.
    const rowsSpec = [
      {
        key: "row-1",
        className: "r-40-60",
        cells: [
          { id: "cell-internet", node: widgets.internet },
          { id: "cell-hosts",    node: widgets.hosts },
        ],
      },
      {
        key: "row-2",
        className: "r-50-50",
        cells: [
          { id: "cell-system", node: widgets.system },
          { id: "cell-apps",   node: widgets.apps },
        ],
      },
      {
        key: "row-3",
        className: "r-full",
        cells: [
          { id: "cell-temperature", node: widgets.temperature },
        ],
      },
      {
        key: "row-4",
        className: "r-50-50",
        cells: [
          { id: "cell-ram",     node: luci.ram },
          { id: "cell-storage", node: luci.storage },
        ],
      },
      {
        key: "row-5",
        className: "r-50-50",
        cells: [
          { id: "cell-network", node: luci.network },
          { id: "cell-ports",   node: luci.ports },
        ],
      },
      {
        key: "row-6",
        className: "r-full",
        cells: [
          { id: "cell-dhcp", node: luci.dhcp },
        ],
      },
    ];

    for (const spec of rowsSpec) {
    let row = root.querySelector(':scope > .proton-overview-row[data-row="' + spec.key + '"]');
    if (!row) {
        row = makeRow(spec.className);
        row.dataset.row = spec.key;
        root.appendChild(row);
        changed = true;
    }

    // row-1: если Хосты ещё не готовы — Internet займёт всю ширину
    if (spec.key === "row-1") {
        const hasHosts = !!widgets.hosts;
        const wantClass = hasHosts ? "r-40-60" : "r-full";
        if (row.classList.contains("r-40-60") && !hasHosts) {
            row.classList.remove("r-40-60");
            row.classList.add("r-full");
            changed = true;
        } else if (row.classList.contains("r-full") && hasHosts) {
            row.classList.remove("r-full");
            row.classList.add("r-40-60");
            changed = true;
        }
    }

    for (const cellSpec of spec.cells) {
        let cell = row.querySelector(':scope > [data-cell="' + cellSpec.id + '"]');
        if (!cell) {
            cell = makeCell(cellSpec.id, "cell-" + cellSpec.id);
            cell.dataset.cell = cellSpec.id;
            row.appendChild(cell);
            changed = true;
        }

        if (cellSpec.node) {
            const placeholder = cell.querySelector(".proton-overview-placeholder");
            if (placeholder) placeholder.remove();
            cell.style.display = "";
            if (placeInCell(cell, cellSpec.node)) changed = true;
        } else if (cellSpec.optional) {
            // Опциональная ячейка (hosts до этапа B) — скрываем, пока нет узла
            if (cell.style.display !== "none") {
                cell.style.display = "none";
                // Убираем placeholder, если был
                const placeholder = cell.querySelector(".proton-overview-placeholder");
                if (placeholder) placeholder.remove();
                changed = true;
            }
        } else {
            // LuCI-секция, ждём появления
            cell.style.display = "";
            if (!cell.querySelector(".proton-overview-placeholder")) {
                const ph = document.createElement("div");
                ph.className = "proton-overview-placeholder";
                ph.textContent = t("Loading...");
                cell.appendChild(ph);
                changed = true;
            }
        }
    }
}

    cleanupEmptySections();
	return changed;
  }
  
    function cleanupEmptySections() {
    const dashSection = document.getElementById("proton-dashboard-section");
    if (dashSection && !dashSection.querySelector("#proton-dashboard-internet")) {
      // Internet забрали в grid, пустая обёртка с заголовком больше не нужна
      dashSection.style.display = "none";
    }

    const widgetsSection = document.querySelector(".proton-widgets-section");
    if (widgetsSection && !widgetsSection.querySelector("#proton-temp-widget")) {
      widgetsSection.style.display = "none";
    }
  }

  // ---------------------------------------------------------------------------
  // Scheduler
  // ---------------------------------------------------------------------------

  function scheduleRelayout() {
    if (relayoutScheduled) return;
    relayoutScheduled = true;
    requestAnimationFrame(function () {
      relayoutScheduled = false;
      try {
        buildLayout();
      } catch (e) {
        console.warn("[Proton2025] Layout error:", e);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Watch
  // ---------------------------------------------------------------------------

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

    layoutObserver = new MutationObserver(function (mutations) {
      // Реагируем только на добавление/удаление узлов и смену data-page
      for (const m of mutations) {
        if (m.type === "childList" && (m.addedNodes.length || m.removedNodes.length)) {
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
      subtree: true,
      attributes: true,
      attributeFilter: ["data-page"],
    });

    // Плюс страховочный интервал: LuCI может перерисовывать секции
    // без childList-мутаций в #maincontent (например, replaceChildren внутри #view).
    let intervalTicks = 0;
    const interval = setInterval(function () {
      intervalTicks++;
      if (!document.body.contains(maincontent)) {
        clearInterval(interval);
        return;
      }
      scheduleRelayout();
      // Через 30 сек прекращаем частые проверки, дальше — раз в 5 сек
      if (intervalTicks > 30) {
        clearInterval(interval);
        setInterval(scheduleRelayout, 5000);
      }
    }, 1000);

    window.addEventListener("pagehide", function () {
      clearInterval(interval);
    }, { once: true });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function start() {
    if (mounted) return;
    mounted = true;
    buildLayout();
    startObserver();
  }

  function stop() {
    mounted = false;
    if (layoutObserver) {
      layoutObserver.disconnect();
      layoutObserver = null;
    }
    if (gridRoot && gridRoot.parentNode) {
      // НЕ удаляем grid — просто разворачиваем на месте
      const parent = gridRoot.parentNode;
      while (gridRoot.firstChild) parent.insertBefore(gridRoot.firstChild, gridRoot);
      parent.removeChild(gridRoot);
      gridRoot = null;
    }
  }

  function init() {
    if (!isOverviewPage()) return;

    // Ждём #maincontent (LuCI создаёт его до DOMContentLoaded).
    // Если его нет — ждём через MutationObserver.
    if (!document.getElementById(MAINCONTENT_ID)) {
      const bodyObs = new MutationObserver(function () {
        if (document.getElementById(MAINCONTENT_ID)) {
          bodyObs.disconnect();
          start();
        }
      });
      bodyObs.observe(document.body, { childList: true, subtree: true });
      setTimeout(function () { bodyObs.disconnect(); }, 15000);
      return;
    }

    start();
  }

  window.ProtonDashboardLayout = {
    start: start,
    stop: stop,
    relayout: scheduleRelayout,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
