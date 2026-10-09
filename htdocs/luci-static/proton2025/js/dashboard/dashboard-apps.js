/**
 * Proton2025 Dashboard - Applications widget
 * Copyright 2025-2026 ChesterGoodiny
 * Licensed under the Apache License, Version 2.0
 * See LICENSE and NOTICE for details.
 *
 * KeeneticOS-style applications panel:
 *   - Compact chip grid (was: list of rows)
 *   - Click a chip → expandable detail panel below
 *   - Detail shows: description, uptime, pid, logs
 *   - Actions: Start / Stop / Restart
 *   - Settings modal (unchanged) — add/remove services
 */

(function () {
  "use strict";

  const POLL_INTERVAL = 10000;
  const TOGGLE_TIMEOUT_MS = 3000;
  const TOGGLE_POLL_MS = 500;
  const STORAGE_KEY = "proton-apps-widget";
  const SERVICES_STORAGE_KEY = "proton-services-widget";
  const LOG_LINES_DEFAULT = 20;

  const CRITICAL_SERVICES = new Set([
    "network",
    "firewall",
    "dnsmasq",
    "odhcpd",
    "uhttpd",
    "dropbear",
    "rpcd",
    "ubus",
  ]);

  let modalOpen = false;
  let pollTimer = null;
  let visibilityHandler = null;
  let mounted = false;
  let servicesGridWrapObserver = null;
  let rcInitRpc = null;
  let callGetServiceInfo = null;
  let callGetServiceLog = null;
  let busyServices = new Set();
  let selectedService = null;

  // ---------------------------------------------------------------------------
  // i18n
  // ---------------------------------------------------------------------------

  function t(value) {
    if (typeof window.protonT === "function") return window.protonT(value);
    if (window.L && typeof L.tr === "function") {
      const tr = L.tr(value);
      if (tr && tr !== value) return tr;
    }
    return value;
  }

  // ---------------------------------------------------------------------------
  // RPC
  // ---------------------------------------------------------------------------

  function ensureRpc() {
    if (!window.L || !L.rpc || typeof L.rpc.declare !== "function") return false;

    if (!rcInitRpc) {
      rcInitRpc = L.rpc.declare({
        object: "rc",
        method: "init",
        params: ["name", "action"],
        expect: { "": {} },
      });
    }

    if (!callGetServiceInfo) {
      callGetServiceInfo = L.rpc.declare({
        object: "luci.proton-system",
        method: "getServiceInfo",
        params: ["name"],
        expect: { "": {} },
      });
    }

    if (!callGetServiceLog) {
      callGetServiceLog = L.rpc.declare({
        object: "luci.proton-system",
        method: "getServiceLog",
        params: ["name", "lines"],
        expect: { "": {} },
      });
    }

    return true;
  }

  async function callRcInit(name, action) {
    if (!ensureRpc()) throw new Error("RPC not ready");
    return L.resolveDefault(rcInitRpc(name, action), null);
  }

  async function fetchServiceInfo(name) {
    if (!ensureRpc()) return null;
    return L.resolveDefault(callGetServiceInfo(name), null);
  }

  async function fetchServiceLog(name, lines) {
    if (!ensureRpc()) return null;
    return L.resolveDefault(callGetServiceLog(name, lines || LOG_LINES_DEFAULT), null);
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  function readAppsList() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return readServicesList();
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return readServicesList();
    }
  }

  function writeAppsList(list) {
  try {
    const json = JSON.stringify(list);
    localStorage.setItem(STORAGE_KEY, json);

    // Прямое сохранение в UCI — не полагаемся на перехват setItem
    if (
      window.protonSettingsSync &&
      typeof window.protonSettingsSync.saveLocalKeyToUci === "function"
    ) {
      window.protonSettingsSync.saveLocalKeyToUci(STORAGE_KEY, json);
    }

    return true;
  } catch (e) {
    return false;
  }
}

  function readServicesList() {
    try {
      const raw = localStorage.getItem(SERVICES_STORAGE_KEY);
      if (raw === null || raw === undefined) return ["dnsmasq", "dropbear"];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : ["dnsmasq", "dropbear"];
    } catch (e) {
      return ["dnsmasq", "dropbear"];
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function getStatusKey(status) {
    switch (status) {
      case "running": return "Running";
      case "stopped": return "Stopped";
      case "not-installed": return "Not installed";
      case "error": return "Error";
      default: return "Unknown";
    }
  }

  function getStatusFromApi() {
    return window.ProtonServicesApi || null;
  }

  function formatUptime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "—";
    const total = Math.floor(seconds);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  }
  
  function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, function (c) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
  });
}

function renderLogLine(rawLine) {
  const line = String(rawLine || "");
  if (!line) return "";

  // Паттерн logread (busybox) с опциональной датой в начале:
  // "Wed Oct  7 09:18:31 2026 authpriv.info dropbear[1854]: message"
  // либо "Jan  1 00:00:00 hostname daemon.warn proc[123]: message"
  const m = line.match(
    /^(\S{3}\s+\S{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\s+\d{4})?)\s+([a-z][a-z0-9]+\.(?:emerg|alert|crit|err|warn|warning|notice|info|debug))\s+([^\s:]+(?:\[\d+\])?):\s*(.*)$/i
  );

  if (!m) {
    // Не разобрали — вернём как есть
    return '<span class="proton-log-msg">' + escapeHtml(line) + "</span>\n";
  }

  const ts = m[1];
  const lvl = m[2];
  const proc = m[3];
  const msg = m[4];

  const lvlLower = lvl.split(".")[1].toLowerCase();
  const lvlClass = "proton-log-lvl-" + (
    lvlLower === "warn" || lvlLower === "warning" ? "warning" :
    lvlLower === "err" || lvlLower === "error" ? "error" :
    lvlLower === "crit" || lvlLower === "emerg" || lvlLower === "alert" ? "critical" :
    lvlLower === "notice" ? "notice" :
    lvlLower === "debug" ? "debug" :
    "info"
  );

  return (
    '<span class="proton-log-ts">' + escapeHtml(ts) + "</span> " +
    '<span class="proton-log-lvl ' + lvlClass + '">' + escapeHtml(lvl) + "</span> " +
    '<span class="proton-log-proc">' + escapeHtml(proc) + ":</span> " +
    '<span class="proton-log-msg">' + escapeHtml(msg) + "</span>\n"
  );
}

  // ---------------------------------------------------------------------------
  // Confirm dialog
  // ---------------------------------------------------------------------------

  function showConfirmDialog(title, message, confirmLabel, onConfirm) {
    const overlay = document.createElement("div");
    overlay.className = "proton-confirm-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "proton-confirm-modal";

    const heading = document.createElement("h3");
    heading.textContent = title;

    const body = document.createElement("p");
    body.textContent = message;

    const actions = document.createElement("div");
    actions.className = "proton-confirm-modal-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "cbi-button cbi-button-neutral";
    cancelBtn.textContent = t("Cancel");

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "cbi-button cbi-button-negative";
    confirmBtn.textContent = confirmLabel;

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    modal.appendChild(heading);
    modal.appendChild(body);
    modal.appendChild(actions);
    overlay.appendChild(modal);

    function close() {
      document.removeEventListener("keydown", escHandler);
      overlay.classList.add("is-closing");
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 200);
    }

    function escHandler(e) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", escHandler);

    cancelBtn.addEventListener("click", close);
    confirmBtn.addEventListener("click", function () {
      close();
      setTimeout(onConfirm, 220);
    });
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });

    document.body.appendChild(overlay);
    setTimeout(() => confirmBtn.focus(), 80);
  }

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------

  function showToast(message, type) {
    const alert = document.createElement("div");
    alert.className = "alert-message proton-alert-floating " + (type || "info");
    alert.dataset.protonManaged = "true";
    alert.dataset.protonTimeout = "3000";

    const body = document.createElement("div");
    body.className = "alert-message-content";
    const p = document.createElement("p");
    p.textContent = message;
    body.appendChild(p);
    alert.appendChild(body);

    document.body.appendChild(alert);

    requestAnimationFrame(function () {
      alert.classList.add("is-visible");
    });

    setTimeout(function () {
      alert.classList.remove("is-visible");
      alert.classList.add("is-hidden");
      setTimeout(function () {
        if (alert.parentNode) alert.parentNode.removeChild(alert);
      }, 300);
    }, 3000);
  }

  // ---------------------------------------------------------------------------
  // Card skeleton
  // ---------------------------------------------------------------------------

  function ensureCard() {
    let card = document.getElementById("proton-dashboard-apps");
    if (card) {
      mounted = true;
      return card;
    }

    card = document.createElement("article");
    card.className = "proton-dashboard-card proton-dashboard-apps";
    card.id = "proton-dashboard-apps";

    card.innerHTML = `
      <div class="proton-dashboard-card-header">
        <div>
          <div class="proton-dashboard-card-title-row">
            <span class="proton-dashboard-card-status-dot" data-role="status-dot"></span>
            <h3 class="proton-dashboard-card-title">${t("Applications")}</h3>
          </div>
          <div class="proton-dashboard-card-subtitle" data-role="subtitle">
            ${t("Loading...")}
          </div>
        </div>
        <button type="button" class="proton-dashboard-apps-settings-btn" data-role="settings" title="${t("Applications settings")}" aria-label="${t("Applications settings")}">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="4" y1="6" x2="20" y2="6"></line>
            <circle cx="9" cy="6" r="2"></circle>
            <line x1="4" y1="12" x2="20" y2="12"></line>
            <circle cx="15" cy="12" r="2"></circle>
            <line x1="4" y1="18" x2="20" y2="18"></line>
            <circle cx="7" cy="18" r="2"></circle>
          </svg>
        </button>
      </div>

      <div class="proton-dashboard-card-body">
        <div class="proton-apps-grid" data-role="grid" role="list"></div>
        <div class="proton-apps-detail-slot" data-role="detail-slot"></div>
      </div>

      <div class="proton-dashboard-card-footer">
        <span data-role="footer-left">—</span>
        <span data-role="footer-right"></span>
      </div>
    `;

    const maincontent = document.getElementById("maincontent");
    if (!maincontent) return null;
    maincontent.appendChild(card);

    mounted = true;
    return card;
  }

  // ---------------------------------------------------------------------------
  // Chip rendering
  // ---------------------------------------------------------------------------

  function createChip(name, info, status) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "proton-apps-chip";
    chip.dataset.service = name;
    chip.dataset.status = status;

    if (selectedService === name) chip.classList.add("active");

    const icon = document.createElement("span");
    icon.className = "proton-apps-chip-icon";
    icon.textContent = info.icon || "📦";

    const nameEl = document.createElement("span");
    nameEl.className = "proton-apps-chip-name";
    nameEl.textContent = info.displayName || name;

    const dot = document.createElement("span");
    dot.className = "proton-apps-chip-dot";
    dot.dataset.status = status;

    chip.appendChild(icon);
    chip.appendChild(nameEl);
    chip.appendChild(dot);

    chip.addEventListener("click", function () {
      toggleServiceDetail(name);
    });

    return chip;
  }

  function renderChips(card, services, statuses) {
    const grid = card.querySelector('[data-role="grid"]');
    if (!grid) return;

    const fragment = document.createDocumentFragment();

    if (!services.length) {
        const empty = document.createElement("div");
        empty.className = "proton-dashboard-apps-empty";
        empty.textContent = t("No applications selected");
        fragment.appendChild(empty);
        grid.replaceChildren(fragment);
        return;
    }

    const api = getStatusFromApi();
    const statusOrder = { running: 0, stopped: 1, unknown: 2, error: 2, "not-installed": 3 };

    const sorted = services.slice().sort(function (a, b) {
        const sa = statusOrder[statuses[a]] ?? 9;
        const sb = statusOrder[statuses[b]] ?? 9;
        if (sa !== sb) return sa - sb;
        const ia = api ? api.getServiceInfo(a) : { displayName: a };
        const ib = api ? api.getServiceInfo(b) : { displayName: b };
        return (ia.displayName || a).localeCompare(ib.displayName || b);
    });

    sorted.forEach(function (name) {
        const info = api ? api.getServiceInfo(name) : {
            name: name,
            displayName: name,
            icon: "📦",
            category: "other",
        };
        const status = statuses[name] || "unknown";
        fragment.appendChild(createChip(name, info, status));
    });

    grid.replaceChildren(fragment);
}

  // ---------------------------------------------------------------------------
  // Detail panel
  // ---------------------------------------------------------------------------

  function closeServiceDetail() {
    selectedService = null;
    const card = document.getElementById("proton-dashboard-apps");
    if (!card) return;
    const slot = card.querySelector('[data-role="detail-slot"]');
    if (slot) slot.replaceChildren();
    card.querySelectorAll(".proton-apps-chip.active").forEach(function (chip) {
      chip.classList.remove("active");
    });
  }

  async function toggleServiceDetail(name) {
    if (selectedService === name) {
      closeServiceDetail();
      return;
    }

    selectedService = name;

    const card = document.getElementById("proton-dashboard-apps");
    if (!card) return;

    card.querySelectorAll(".proton-apps-chip").forEach(function (chip) {
      chip.classList.toggle("active", chip.dataset.service === name);
    });

    const slot = card.querySelector('[data-role="detail-slot"]');
    if (!slot) return;

    slot.replaceChildren();
    const detail = await buildServiceDetail(name);
    if (detail) slot.appendChild(detail);
  }

  async function buildServiceDetail(name) {
    const api = getStatusFromApi();
    const info = api ? api.getServiceInfo(name) : {
      name: name,
      displayName: name,
      description: "",
      icon: "📦",
    };

    const status = api ? await api.checkStatus(name) : "unknown";

    // Контейнер
    const box = document.createElement("div");
    box.className = "proton-apps-detail";
    box.dataset.service = name;

    // Header
    const header = document.createElement("div");
    header.className = "proton-apps-detail-header";

    const icon = document.createElement("span");
    icon.className = "proton-apps-detail-icon";
    icon.textContent = info.icon || "📦";

    const text = document.createElement("div");
    text.className = "proton-apps-detail-text";

    const nameRow = document.createElement("div");
    nameRow.className = "proton-apps-detail-name";

    const nameText = document.createElement("span");
    nameText.textContent = info.displayName || name;

    const statusBadge = document.createElement("span");
    statusBadge.className = "proton-apps-detail-status";
    statusBadge.dataset.status = status;
    statusBadge.textContent = t(getStatusKey(status));

    nameRow.appendChild(nameText);
    nameRow.appendChild(statusBadge);

    const desc = document.createElement("div");
    desc.className = "proton-apps-detail-desc";
    desc.textContent = info.description || "";

    text.appendChild(nameRow);
    text.appendChild(desc);

    header.appendChild(icon);
    header.appendChild(text);

    // Meta (uptime, pid) — подгружаем асинхронно
    const meta = document.createElement("div");
    meta.className = "proton-apps-detail-meta";

    const metaUptime = document.createElement("span");
    metaUptime.className = "proton-apps-detail-meta-item";
    metaUptime.innerHTML = `<strong>${t("Uptime")}:</strong><span data-role="uptime">…</span>`;

    const metaPid = document.createElement("span");
    metaPid.className = "proton-apps-detail-meta-item";
    metaPid.innerHTML = `<strong>PID:</strong><span data-role="pid">…</span>`;

    meta.appendChild(metaUptime);
    meta.appendChild(metaPid);

    // Actions
    const actions = document.createElement("div");
    actions.className = "proton-apps-detail-actions";

    const isRunning = status === "running";
    const isInstalled = status !== "not-installed";

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = isRunning ? "cbi-button cbi-button-negative" : "cbi-button cbi-button-positive";
    toggleBtn.textContent = isRunning ? t("Stop") : t("Start");
    toggleBtn.disabled = !isInstalled;

    const restartBtn = document.createElement("button");
    restartBtn.type = "button";
    restartBtn.className = "cbi-button cbi-button-neutral";
    restartBtn.textContent = t("Restart");
    restartBtn.disabled = !isInstalled || !isRunning;

    actions.appendChild(toggleBtn);
    actions.appendChild(restartBtn);

    // Log toggle
    const logToggleWrap = document.createElement("div");
    logToggleWrap.className = "proton-apps-detail-log-toggle";

    const logBtn = document.createElement("button");
    logBtn.type = "button";
    logBtn.textContent = "📄 " + t("Show logs");
    logToggleWrap.appendChild(logBtn);

    const logBox = document.createElement("div");
    logBox.className = "proton-apps-detail-logs";
    logBox.style.display = "none";
    logBox.textContent = t("Loading...");

    let logLoaded = false;
    let logVisible = false;

    logBtn.addEventListener("click", async function () {
      logVisible = !logVisible;
      logBox.style.display = logVisible ? "" : "none";
      logBtn.textContent = (logVisible ? "▲ " + t("Hide logs") : "📄 " + t("Show logs"));

      if (!logLoaded && logVisible) {
        logLoaded = true;
        logBox.textContent = t("Loading...");
        try {
          const res = await fetchServiceLog(name, LOG_LINES_DEFAULT);
          const lines = (res && Array.isArray(res.lines)) ? res.lines : [];
          if (!lines.length) {
            logBox.innerHTML = `<div class="proton-apps-detail-logs-empty">${t("Logs unavailable")}</div>`;
          } else {
            logBox.innerHTML = lines.map(function (line) {
				return renderLogLine(line);
			}).join("");
          }
        } catch (e) {
          logBox.innerHTML = `<div class="proton-apps-detail-logs-empty">${t("Logs unavailable")}</div>`;
        }
      }
    });

    // Собираем
    box.appendChild(header);
    box.appendChild(meta);
    box.appendChild(actions);
    box.appendChild(logToggleWrap);
    box.appendChild(logBox);

    // Подгружаем uptime/pid асинхронно
    fetchServiceInfo(name).then(function (res) {
      const uptimeEl = box.querySelector('[data-role="uptime"]');
      const pidEl = box.querySelector('[data-role="pid"]');
      if (res && res.success) {
        if (uptimeEl) uptimeEl.textContent = res.uptime != null ? formatUptime(res.uptime) : "—";
        if (pidEl) pidEl.textContent = res.pid != null ? String(res.pid) : "—";
      } else {
        if (uptimeEl) uptimeEl.textContent = "—";
        if (pidEl) pidEl.textContent = "—";
      }
    }).catch(function () {
      const uptimeEl = box.querySelector('[data-role="uptime"]');
      const pidEl = box.querySelector('[data-role="pid"]');
      if (uptimeEl) uptimeEl.textContent = "—";
      if (pidEl) pidEl.textContent = "—";
    });

    // Toggle start/stop
    toggleBtn.addEventListener("click", function () {
      const act = isRunning ? "stop" : "start";
      const doAction = function () {
        runServiceAction(name, act, toggleBtn, restartBtn, box);
      };
      if (act === "stop" && CRITICAL_SERVICES.has(name)) {
        showConfirmDialog(
          t("Stop service?"),
          t('Are you sure you want to stop the "{name}" service? This may disrupt network connectivity.').replace("{name}", info.displayName || name),
          t("Stop"),
          doAction
        );
      } else {
        doAction();
      }
    });

    // Restart
    restartBtn.addEventListener("click", function () {
      runServiceAction(name, "restart", toggleBtn, restartBtn, box);
    });

    return box;
  }

  async function runServiceAction(name, action, toggleBtn, restartBtn, box) {
    if (busyServices.has(name)) return;
    busyServices.add(name);

    const origToggle = toggleBtn.textContent;
    const origRestart = restartBtn.textContent;
    toggleBtn.disabled = true;
    restartBtn.disabled = true;
    toggleBtn.textContent = t("Please wait...");
    restartBtn.textContent = t("Please wait...");

    try {
      await callRcInit(name, action);
      const ok = await waitForStatus(name, action === "stop" ? "stopped" : "running", TOGGLE_TIMEOUT_MS);

      if (ok) {
        showToast(t("Action applied"), "success");
        // Перерисуем панель
        if (selectedService === name) {
          const slot = box.parentElement;
          if (slot) {
            slot.replaceChildren();
            const detail = await buildServiceDetail(name);
            if (detail) slot.appendChild(detail);
          }
        }
      } else {
        showToast(t("Action failed"), "error");
        toggleBtn.disabled = false;
        restartBtn.disabled = false;
        toggleBtn.textContent = origToggle;
        restartBtn.textContent = origRestart;
      }
    } catch (e) {
      console.warn("[Proton2025] service action failed:", name, action, e);
      showToast(t("Action failed"), "error");
      toggleBtn.disabled = false;
      restartBtn.disabled = false;
      toggleBtn.textContent = origToggle;
      restartBtn.textContent = origRestart;
    } finally {
      busyServices.delete(name);
    }
  }

  async function waitForStatus(name, expected, timeoutMs) {
    const api = getStatusFromApi();
    if (!api) return false;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await api.checkStatus(name);
      if (current === expected) return true;
      await new Promise((r) => setTimeout(r, TOGGLE_POLL_MS));
    }
    const finalStatus = await api.checkStatus(name);
    return finalStatus === expected;
  }

  // ---------------------------------------------------------------------------
  // Subtitle / footer
  // ---------------------------------------------------------------------------

  function updateSubtitle(card, services, statuses) {
    const el = card.querySelector('[data-role="subtitle"]');
    if (!el) return;
    const total = services.length;
    let running = 0;
    for (const name of services) {
      if (statuses[name] === "running") running++;
    }
    if (!total) {
      el.textContent = t("No applications selected");
      return;
    }
    el.textContent = `${running} / ${total} ${t("running")}`;
  }

  function updateFooter(card, services) {
    const left = card.querySelector('[data-role="footer-left"]');
    if (left) left.textContent = `${services.length} ${t("services")}`;
  }

  function setStatusDot(card, state) {
    const dot = card.querySelector('[data-role="status-dot"]');
    if (dot) dot.dataset.state = state;
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  async function pollStatuses() {
    if (!mounted || document.hidden) return;
    if (document.body.classList.contains("proton-modal-open")) return;

    const card = document.getElementById("proton-dashboard-apps");
    if (!card) return;

    const api = getStatusFromApi();
    if (!api) return;

    const services = readAppsList();
    const statuses = {};

    await Promise.all(
        services.map(async function (name) {
            if (busyServices.has(name)) {
                statuses[name] = "running";
                return;
            }
            try {
                statuses[name] = await api.checkStatus(name);
            } catch (e) {
                statuses[name] = "unknown";
            }
        })
    );

    // Инкрементальное обновление: не пересоздаём чипы, если их состав
    // совпадает. Меняем только точку статуса (dataset.status) и цвет.
    const grid = card.querySelector('[data-role="grid"]');
    const existingChips = grid
        ? Array.from(grid.querySelectorAll(".proton-apps-chip"))
        : [];
    const existingOrder = existingChips.map((c) => c.dataset.service);
    const desiredOrder = services.slice();

    const sameSet =
        existingOrder.length === desiredOrder.length &&
        existingOrder.every((name, i) => name === desiredOrder[i]);

    if (sameSet) {
        // Состав не изменился — обновляем только точки статуса
        existingChips.forEach((chip) => {
            const name = chip.dataset.service;
            const newStatus = statuses[name] || "unknown";
            if (chip.dataset.status !== newStatus) {
                chip.dataset.status = newStatus;
                const dot = chip.querySelector(".proton-apps-chip-dot");
                if (dot) dot.dataset.status = newStatus;
            }
        });
    } else {
        // Состав изменился (пользователь добавил/удалил сервис) — пересоздаём
        renderChips(card, services, statuses);
    }

    updateSubtitle(card, services, statuses);
    updateFooter(card, services);
}

  // ---------------------------------------------------------------------------
  // Settings modal (unchanged from previous version)
  // ---------------------------------------------------------------------------

  async function openSettingsModal() {
    if (modalOpen) return;
    modalOpen = true;

    const api = getStatusFromApi();
    if (!api) {
      modalOpen = false;
      showToast(t("Services API not ready"), "warning");
      return;
    }

    const available = await api.listAvailableServices();
    const current = new Set(readAppsList());

    const overlay = document.createElement("div");
    overlay.className = "proton-confirm-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "proton-confirm-modal proton-apps-settings-modal";
    modal.style.maxWidth = "560px";
    modal.style.width = "calc(100% - 40px)";

    const heading = document.createElement("h3");
    heading.textContent = t("Applications settings");

    const body = document.createElement("div");
    body.className = "proton-apps-settings-body";

    const searchWrap = document.createElement("div");
    searchWrap.className = "proton-apps-settings-search";
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = t("Search services...");
    searchInput.autocomplete = "off";
    searchWrap.appendChild(searchInput);

    const listContainer = document.createElement("div");
    listContainer.className = "proton-apps-settings-list";

    const actions = document.createElement("div");
    actions.className = "proton-confirm-modal-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "cbi-button cbi-button-neutral";
    cancelBtn.textContent = t("Cancel");

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "cbi-button cbi-button-positive";
    saveBtn.textContent = t("Save");

    function isDaemon(entry) {
      const known = window.protonServicesWidget?.knownServices?.[entry.name];
      if (known && known.daemon === false) return false;
      return true;
    }

    function render(filter) {
      listContainer.replaceChildren();

      const filterLower = String(filter || "").toLowerCase().trim();

      const filtered = available
        .filter((entry) => isDaemon(entry))
        .filter((entry) => {
          if (!filterLower) return true;
          const info = api.getServiceInfo(entry.name);
          const haystack =
            `${entry.name} ${info.displayName || ""} ${info.description || ""}`.toLowerCase();
          return haystack.indexOf(filterLower) !== -1;
        });

      const grouped = new Map();
      filtered.forEach((entry) => {
        const info = api.getServiceInfo(entry.name);
        const cat = info.category || "other";
        if (!grouped.has(cat)) grouped.set(cat, []);
        grouped.get(cat).push({ entry, info });
      });

      const order = ["network", "security", "vpn", "adblock", "system", "other"];
      const categories = Array.from(grouped.keys()).sort(
        (a, b) => order.indexOf(a) - order.indexOf(b)
      );

      if (!categories.length) {
        const empty = document.createElement("div");
        empty.className = "proton-apps-settings-empty";
        empty.textContent = t("No services found");
        listContainer.appendChild(empty);
        return;
      }

      const catMeta = window.protonServicesWidget?.categories || {};
      const catLabels = {
        network: t("Network"),
        security: t("Security"),
        vpn: t("VPN"),
        adblock: t("Ad Blocking"),
        system: t("System"),
        other: t("Other"),
      };

      categories.forEach((cat) => {
        const header = document.createElement("div");
        header.className = "proton-apps-settings-category";
        const icon = catMeta[cat]?.icon || "📦";
        header.textContent = `${icon} ${catLabels[cat] || cat}`.toUpperCase();
        listContainer.appendChild(header);

        grouped.get(cat).forEach(({ entry, info }) => {
          const row = document.createElement("div");
          row.className = "proton-apps-settings-row";

          const ic = document.createElement("span");
          ic.className = "proton-apps-settings-icon";
          ic.textContent = info.icon || "📦";

          const textWrap = document.createElement("div");
          textWrap.className = "proton-apps-settings-text";

          const nm = document.createElement("div");
          nm.className = "proton-apps-settings-name";
          nm.textContent = info.displayName || entry.name;

          const desc = document.createElement("div");
          desc.className = "proton-apps-settings-desc";
          desc.textContent = info.description || "";

          textWrap.appendChild(nm);
          textWrap.appendChild(desc);

          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "proton-apps-settings-btn";

          const isInstalled = entry.fromInitd === true;
          const isAdded = current.has(entry.name);

          if (!isInstalled) {
            btn.textContent = t("Not installed");
            btn.classList.add("is-unavailable");
            btn.disabled = true;
          } else if (isAdded) {
            btn.textContent = t("Remove");
            btn.classList.add("is-remove");
          } else {
            btn.textContent = "+ " + t("Add");
            btn.classList.add("is-add");
          }

          btn.addEventListener("click", function () {
            if (!isInstalled) return;
            if (current.has(entry.name)) {
              current.delete(entry.name);
              btn.textContent = "+ " + t("Add");
              btn.classList.remove("is-remove");
              btn.classList.add("is-add");
            } else {
              current.add(entry.name);
              btn.textContent = t("Remove");
              btn.classList.remove("is-add");
              btn.classList.add("is-remove");
            }
          });

          row.appendChild(ic);
          row.appendChild(textWrap);
          row.appendChild(btn);
          listContainer.appendChild(row);
        });
      });
    }

    render("");

    let searchTimeout;
    searchInput.addEventListener("input", function () {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => render(searchInput.value), 120);
    });

    function close() {
      modalOpen = false;
      document.removeEventListener("keydown", escHandler);
      overlay.classList.add("is-closing");
      setTimeout(function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 200);
    }

    function escHandler(e) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", escHandler);

    cancelBtn.addEventListener("click", close);
    saveBtn.addEventListener("click", function () {
      const newList = Array.from(current).filter((n) => api.isValidServiceName(n));
      writeAppsList(newList);
      close();
      const card = document.getElementById("proton-dashboard-apps");
      if (card) {
        closeServiceDetail();
        renderChips(card, newList, {});
        pollStatuses();
      }
    });

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    modal.appendChild(heading);
    modal.appendChild(body);
    body.appendChild(searchWrap);
    body.appendChild(listContainer);
    modal.appendChild(actions);
    overlay.appendChild(modal);

    document.body.appendChild(overlay);
    setTimeout(() => searchInput.focus(), 80);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function start() {
    if (window.__protonAppsStarted) return true;
    window.__protonAppsStarted = true;

    const card = ensureCard();
    if (!card) return false;

    if (card.dataset.protonInit === "true") {
        return true;
    }
    card.dataset.protonInit = "true";

    const services = readAppsList();
    renderChips(card, services, {});
    setStatusDot(card, "ok");

    const settingsBtn = card.querySelector('[data-role="settings"]');
    if (settingsBtn) {
        settingsBtn.addEventListener("click", openSettingsModal);
    }

    if (pollTimer) return true;
    pollStatuses();
    pollTimer = setInterval(pollStatuses, POLL_INTERVAL);

    visibilityHandler = function () {
        if (!document.hidden) pollStatuses();
    };
    document.addEventListener("visibilitychange", visibilityHandler);

    return true;
}

  function stop() {
    mounted = false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (visibilityHandler) {
      document.removeEventListener("visibilitychange", visibilityHandler);
      visibilityHandler = null;
    }
    if (servicesGridWrapObserver) {
      servicesGridWrapObserver.disconnect();
      servicesGridWrapObserver = null;
    }
  }

  function isOverviewPage() {
    return (
      document.body.dataset.page === "admin-status-overview" ||
      window.location.pathname.includes("/admin/status/overview")
    );
  }

  function init() {
    if (!isOverviewPage()) return;
    start();
  }

  window.ProtonDashboardApps = {
    start,
    stop,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
