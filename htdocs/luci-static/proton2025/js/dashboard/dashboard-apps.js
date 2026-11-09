/**
 * Proton2025 Dashboard - Applications widget
 * Copyright 2025-2026 ChesterGoodiny
 * Licensed under the Apache License, Version 2.0
 * See LICENSE and NOTICE for details.
 */

(function () {
  "use strict";

  const POLL_INTERVAL = 10000;
  const TOGGLE_TIMEOUT_MS = 3000;
  const TOGGLE_POLL_MS = 500;
  const STORAGE_KEY = "proton-apps-widget";
  const SERVICES_STORAGE_KEY = "proton-services-widget";
  const LOG_LINES_DEFAULT = 20;

  // History: sample interval и retention.
  const HISTORY_SAMPLE_INTERVALS = [5, 10, 30, 60];
  const HISTORY_MAX_AGE_HOURS = [1, 6, 24];

  // Per-service L7 presets. Значение "custom" → числовой input.
  const INTERVAL_PRESETS = [30, 60, 120, 300, 600, 1800, 3600];
  const TIMEOUT_PRESETS = [2, 5, 10, 30, 60];
  const FAILURE_PRESETS = [1, 2, 3, 5, 10];

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
  let callProtonGetSettings = null;
  let callHealthGetConfig = null;
  let callHealthGetMethods = null;
  let callHealthGetSchema = null;
  let callProtonSetSettings = null;
  let callHealthSetService = null;
  let callHealthClearService = null;
  let busyServices = new Set();
  let selectedService = null;
  let summaryEventsTimer = null;
  let summarySelectedEventGroup = null;
  let callWriteUserAction = null;
  let callTestTelegram = null;

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
        params: ["name", "lines", "include_health_check"],
        expect: { "": {} },
      });
    }

    if (!callProtonGetSettings) {
      callProtonGetSettings = L.rpc.declare({
        object: "luci.proton-settings",
        method: "getSettings",
        expect: { "": {} },
      });
    }

    if (!callHealthGetConfig) {
      callHealthGetConfig = L.rpc.declare({
        object: "luci.proton-healthcheck",
        method: "getConfig",
        expect: { "": {} },
      });
    }

    if (!callHealthGetMethods) {
      callHealthGetMethods = L.rpc.declare({
        object: "luci.proton-healthcheck",
        method: "getMethods",
        expect: { "": {} },
      });
    }

    if (!callHealthGetSchema) {
      callHealthGetSchema = L.rpc.declare({
        object: "luci.proton-healthcheck",
        method: "getSchema",
        expect: { "": {} },
      });
    }

    if (!callProtonSetSettings) {
      callProtonSetSettings = L.rpc.declare({
        object: "luci.proton-settings",
        method: "setSettings",
        params: ["settings"],
        expect: { "": {} },
      });
    }

    if (!callHealthSetService) {
      callHealthSetService = L.rpc.declare({
        object: "luci.proton-healthcheck",
        method: "setService",
        params: ["name", "enabled", "config"],
        expect: { "": {} },
      });
    }

    if (!callHealthClearService) {
      callHealthClearService = L.rpc.declare({
        object: "luci.proton-healthcheck",
        method: "clearService",
        params: ["name"],
        expect: { "": {} },
      });
    }

    if (!callWriteUserAction) {
      callWriteUserAction = L.rpc.declare({
        object: "luci.proton-services-history",
        method: "writeUserAction",
        params: ["service", "action"],
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

  async function fetchServiceLog(name, lines, includeHealthCheck) {
    if (!ensureRpc()) return null;
    return L.resolveDefault(
      callGetServiceLog(
        name,
        lines || LOG_LINES_DEFAULT,
        includeHealthCheck ? "1" : "0",
      ),
      null,
    );
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
  // Telegram section
  // ---------------------------------------------------------------------------

  function renderTelegramSection(container, settings, rootContainer) {
    const state = rootContainer._monitoringState;
    if (!state.telegram) {
      state.telegram = {
        enabled: false,
        token: "",
        chat_id: "",
        events: ["health-fail", "health-recovery", "crash", "restart", "user-stop", "silent-death"],
        services: []
      };
      if (settings.telegram) {
        Object.assign(state.telegram, settings.telegram);
      }
    }

    const tg = state.telegram;

    const section = document.createElement("section");
    section.className = "proton-monitoring-section";
    section.style.marginTop = "24px";

    const title = document.createElement("h4");
    title.className = "proton-monitoring-section-title";
    title.textContent = t("Telegram Notifications");
    section.appendChild(title);

    const enabledRow = document.createElement("label");
    enabledRow.className = "proton-monitoring-toggle";
    enabledRow.style.marginBottom = "16px";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = tg.enabled;

    const slider = document.createElement("span");
    slider.className = "proton-monitoring-toggle-slider";

    const text = document.createElement("span");
    text.className = "proton-monitoring-toggle-text";
    text.textContent = t("Enable Telegram notifications");

    enabledRow.appendChild(check);
    enabledRow.appendChild(slider);
    enabledRow.appendChild(text);
    section.appendChild(enabledRow);

    const fieldsBox = document.createElement("div");
    fieldsBox.className = "proton-telegram-settings";
    fieldsBox.style.display = tg.enabled ? "flex" : "none";

    // Bot Token
    const tokenRow = document.createElement("div");
    tokenRow.className = "proton-telegram-row";
    const tokenLabel = document.createElement("label");
    tokenLabel.textContent = "Bot Token";
    const tokenInput = document.createElement("input");
    tokenInput.type = "text";
    tokenInput.className = "cbi-input-text";
    tokenInput.value = tg.token;
    tokenInput.placeholder = "123456:ABC-DEF...";
    tokenInput.addEventListener("input", () => { tg.token = tokenInput.value.trim(); });
    tokenRow.appendChild(tokenLabel);
    tokenRow.appendChild(tokenInput);
    fieldsBox.appendChild(tokenRow);

    // Chat ID
    const chatRow = document.createElement("div");
    chatRow.className = "proton-telegram-row";
    const chatLabel = document.createElement("label");
    chatLabel.textContent = "Chat ID";
    const chatInput = document.createElement("input");
    chatInput.type = "text";
    chatInput.className = "cbi-input-text";
    chatInput.value = tg.chat_id;
    chatInput.placeholder = "-1001234567890";
    chatInput.addEventListener("input", () => { tg.chat_id = chatInput.value.trim(); });
    chatRow.appendChild(chatLabel);
    chatRow.appendChild(chatInput);
    fieldsBox.appendChild(chatRow);

    // Test
    const testRow = document.createElement("div");
    testRow.style.display = "flex";
    testRow.style.justifyContent = "flex-end";

    const testBtn = document.createElement("button");
    testBtn.type = "button";
    testBtn.className = "cbi-button cbi-button-action";
    testBtn.textContent = "Test Connection";

    testBtn.addEventListener("click", async () => {
      if (!tg.token || !tg.chat_id) {
        showToast(t("Token and Chat ID are required"), "warning");
        return;
      }
      testBtn.disabled = true;
      testBtn.textContent = t("Sending...");

      if (!ensureRpc()) {
        showToast(t("RPC not ready"), "error");
        testBtn.disabled = false;
        testBtn.textContent = "Test Connection";
        return;
      }

      if (!callTestTelegram) {
        callTestTelegram = L.rpc.declare({
          object: "luci.proton-healthcheck",
          method: "testTelegram",
          params: ["token", "chat_id"],
          expect: { "": {} }
        });
      }

      try {
        const res = await L.resolveDefault(callTestTelegram(tg.token, tg.chat_id), null);
        if (res && res.success) {
          showToast(t("Test message sent!"), "success");
        } else {
          showToast(t("Failed: ") + (res?.error || "RPC failed"), "error");
        }
      } catch (e) {
        showToast(t("Request failed: ") + e.message, "error");
      }

      testBtn.disabled = false;
      testBtn.textContent = "Test Connection";
    });

    testRow.appendChild(testBtn);
    fieldsBox.appendChild(testRow);

    // Services
    const allServices = readAppsList();
    const isAllServices = tg.services.length === 0;

    const svcRow = document.createElement("div");
    svcRow.className = "proton-telegram-row";

    const svcLabel = document.createElement("label");
    svcLabel.textContent = "Services to notify";
    svcRow.appendChild(svcLabel);

    const allCbLabel = document.createElement("label");
    allCbLabel.className = "proton-telegram-checkbox-row";
    allCbLabel.style.fontWeight = "600";
    allCbLabel.style.marginBottom = "8px";

    const allCb = document.createElement("input");
    allCb.type = "checkbox";
    allCb.checked = isAllServices;

    allCbLabel.appendChild(allCb);
    allCbLabel.appendChild(document.createTextNode("Notify all selected services"));
    svcRow.appendChild(allCbLabel);

    const svcList = document.createElement("div");
    svcList.className = "proton-telegram-checkbox-list";
    svcList.style.display = isAllServices ? "none" : "flex";

    allServices.forEach(sName => {
      const lbl = document.createElement("label");
      lbl.className = "proton-telegram-checkbox-row";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = tg.services.includes(sName);

      cb.addEventListener("change", () => {
        if (cb.checked) {
          if (!tg.services.includes(sName)) tg.services.push(sName);
        } else {
          tg.services = tg.services.filter(s => s !== sName);
        }
        if (tg.services.length === allServices.length) {
          tg.services = [];
          allCb.checked = true;
          svcList.style.display = "none";
        }
      });

      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(sName));
      svcList.appendChild(lbl);
    });

    allCb.addEventListener("change", () => {
      if (allCb.checked) {
        tg.services = [];
        svcList.style.display = "none";
      } else {
        tg.services = allServices.slice();
        svcList.style.display = "flex";
        svcList.querySelectorAll("input[type='checkbox']").forEach(c => c.checked = true);
      }
    });

    svcRow.appendChild(svcList);
    fieldsBox.appendChild(svcRow);

    // Events
    const evRow = document.createElement("div");
    evRow.className = "proton-telegram-row";

    const evLabel = document.createElement("label");
    evLabel.textContent = "Events to notify";
    evRow.appendChild(evLabel);

    const evList = document.createElement("div");
    evList.style.cssText = "display:flex; flex-wrap:wrap; gap:12px;";

    const allEvents = [
      { id: "health-fail", label: "Health Fail" },
      { id: "health-recovery", label: "Health Recover" },
      { id: "crash", label: "Crash" },
      { id: "restart", label: "Restart" },
      { id: "user-stop", label: "User Stop" },
      { id: "silent-death", label: "Silent Death" }
    ];

    allEvents.forEach(ev => {
      const lbl = document.createElement("label");
      lbl.className = "proton-telegram-checkbox-row";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = tg.events.includes(ev.id);

      cb.addEventListener("change", () => {
        if (cb.checked) {
          if (!tg.events.includes(ev.id)) tg.events.push(ev.id);
        } else {
          tg.events = tg.events.filter(e => e !== ev.id);
        }
      });

      lbl.appendChild(cb);
      lbl.appendChild(document.createTextNode(ev.label));
      evList.appendChild(lbl);
    });

    evRow.appendChild(evList);
    fieldsBox.appendChild(evRow);

    check.addEventListener("change", () => {
      tg.enabled = check.checked;
      fieldsBox.style.display = tg.enabled ? "flex" : "none";
    });

    section.appendChild(fieldsBox);
    container.appendChild(section);
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

    const isHealthCheck = line.startsWith("[HC] ");
    const body = isHealthCheck ? line.slice(5) : line;
    const hcClass = isHealthCheck ? " proton-log-hc" : "";

    const m = body.match(
      /^(\S{3}\s+\S{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}(?:\s+\d{4})?)\s+([a-z][a-z0-9]+\.(?:emerg|alert|crit|err|warn|warning|notice|info|debug))\s+([^\s:]+(?:\[\d+\])?):\s*(.*)$/i
    );

    if (!m) {
      return (
        '<span class="proton-log-msg' + hcClass + '">' +
        escapeHtml(body) +
        "</span>\n"
      );
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
      '<span class="proton-log-ts' + hcClass + '">' + escapeHtml(ts) + "</span> " +
      '<span class="proton-log-lvl ' + lvlClass + hcClass + '">' + escapeHtml(lvl) + "</span> " +
      '<span class="proton-log-proc' + hcClass + '">' + escapeHtml(proc) + ":</span> " +
      '<span class="proton-log-msg' + hcClass + '">' + escapeHtml(msg) + "</span>\n"
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

      <div class="proton-apps-summary" data-role="summary">
        <div class="proton-apps-summary-header">
        <span class="proton-apps-summary-title" data-i18n="Services Health">${t("Services Health")}</span>
        <div class="proton-apps-graph-toolbar" data-role="summary-graph-toolbar">
        <button type="button" class="proton-apps-graph-period" data-period="300">${t("5m")}</button>
        <button type="button" class="proton-apps-graph-period" data-period="3600">${t("1h")}</button>
        <button type="button" class="proton-apps-graph-period" data-period="21600">${t("6h")}</button>
        <button type="button" class="proton-apps-graph-period" data-period="86400">${t("24h")}</button>
        </div>
      </div>
      <div class="proton-apps-graph-container" data-role="summary-graph"></div>
      <div class="proton-apps-events-timeline" data-role="summary-events"></div>
      <div class="proton-apps-summary-footer" data-role="summary-footer"></div>
      </div>

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

  function initDetailGraph(box, serviceName, toolbar, container) {
    if (!box || !container || !toolbar) return;

    renderDetailGraph(box, serviceName, container);

    toolbar.addEventListener("click", function (e) {
      const btn = e.target.closest(".proton-apps-graph-period");
      if (!btn) return;
      const period = parseInt(btn.dataset.period, 10);
      if (!period || period === detailGraphPeriodSec) return;

      detailGraphPeriodSec = period;
      toolbar.querySelectorAll(".proton-apps-graph-period").forEach(function (b) {
        b.classList.toggle("active", parseInt(b.dataset.period, 10) === period);
      });
      renderDetailGraph(box, serviceName, container);
    });
  }

  function renderDetailGraph(box, serviceName, container) {
    if (!container) return;

    if (!window.ProtonServicesHistory || !window.ProtonServicesGraph) {
      container.innerHTML = '<div class="proton-apps-graph-empty">' + t("Loading...") + '</div>';
      return;
    }

    const windowMs = detailGraphPeriodSec * 1000;
    let points = [];
    try {
      points = window.ProtonServicesHistory.getServiceHistoryForRender(serviceName, windowMs, {
        targetCount: 200,
      });
    } catch (e) {
      console.warn("[Proton2025] Failed to get service history:", e);
      points = [];
    }

    const width = container.clientWidth || 400;
    const height = container.clientHeight || 120;

    if (!points.length) {
      container.innerHTML = '<div class="proton-apps-graph-empty">' + t("No data") + '</div>';
      return;
    }

    window.ProtonServicesGraph.renderServiceGraph(container, points, {
      width: width,
      height: height,
      windowMs: windowMs,
    });
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

    const summaryEl = card.querySelector('[data-role="summary"]');
    if (summaryEl) summaryEl.style.display = "";

    renderSummaryGraph(card);
  }

  async function toggleServiceDetail(name) {
    if (selectedService === name) {
      closeServiceDetail();
      return;
    }

    selectedService = name;

    const card = document.getElementById("proton-dashboard-apps");
    if (!card) return;

    const summaryEl = card.querySelector('[data-role="summary"]');
    if (summaryEl) summaryEl.style.display = "none";

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

    const box = document.createElement("div");
    box.className = "proton-apps-detail";
    box.dataset.service = name;

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

    const graphWrap = document.createElement("div");
    graphWrap.className = "proton-apps-detail-graph";
    graphWrap.dataset.role = "service-graph";

    const graphHeader = document.createElement("div");
    graphHeader.className = "proton-apps-detail-graph-header";

    const graphTitle = document.createElement("span");
    graphTitle.className = "proton-apps-detail-graph-title";
    graphTitle.textContent = t("Service History");

    const graphToolbar = document.createElement("div");
    graphToolbar.className = "proton-apps-graph-toolbar";
    graphToolbar.dataset.role = "service-graph-toolbar";

    const periods = [
      { sec: 300, label: t("5m") },
      { sec: 3600, label: t("1h") },
      { sec: 21600, label: t("6h") },
      { sec: 86400, label: t("24h") },
    ];

    periods.forEach(function (p) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "proton-apps-graph-period";
      btn.dataset.period = String(p.sec);
      btn.textContent = p.label;
      if (p.sec === detailGraphPeriodSec) btn.classList.add("active");
      graphToolbar.appendChild(btn);
    });

    graphHeader.appendChild(graphTitle);
    graphHeader.appendChild(graphToolbar);

    const graphContainer = document.createElement("div");
    graphContainer.className = "proton-apps-detail-graph-container";
    graphContainer.dataset.role = "service-graph-container";

    graphWrap.appendChild(graphHeader);
    graphWrap.appendChild(graphContainer);

    const actions = document.createElement("div");
    actions.className = "proton-apps-detail-actions";

    const isRunning = status === "running";
    const isInstalled = status !== "not-installed";
    const isWireguard = name === "wireguard";

    if (!isWireguard) {
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = isRunning ? "cbi-button cbi-button-negative" : "cbi-button cbi-button-positive";
      toggleBtn.textContent = isRunning ? t("Stop") : t("Start");
      toggleBtn.disabled = !isInstalled;

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

      const restartBtn = document.createElement("button");
      restartBtn.type = "button";
      restartBtn.className = "cbi-button cbi-button-neutral";
      restartBtn.textContent = t("Restart");
      restartBtn.disabled = !isInstalled || !isRunning;

      restartBtn.addEventListener("click", function () {
        runServiceAction(name, "restart", toggleBtn, restartBtn, box);
      });

      actions.appendChild(toggleBtn);
      actions.appendChild(restartBtn);
    }

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
          const res = await fetchServiceLog(name, LOG_LINES_DEFAULT, true);
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

    box.appendChild(header);
    box.appendChild(meta);
    box.appendChild(graphWrap);
    box.appendChild(actions);
    box.appendChild(logToggleWrap);
    box.appendChild(logBox);

    initDetailGraph(box, name, graphToolbar, graphContainer);

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

    return box;
  }

  async function runServiceAction(name, action, toggleBtn, restartBtn, box) {
    if (busyServices.has(name)) return;
    busyServices.add(name);

    try {
      if (ensureRpc()) {
        if (action === "stop") {
          await L.resolveDefault(callWriteUserAction(name, "stop"), null);
        } else if (action === "start") {
          await L.resolveDefault(callWriteUserAction(name, ""), null);
        }
      }
    } catch (e) {
      console.warn("[Proton2025] writeUserAction failed:", name, action, e);
    }

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
      renderChips(card, services, statuses);
    }

    updateSubtitle(card, services, statuses);
    updateFooter(card, services);
  }

  // ---------------------------------------------------------------------------
  // Settings modal
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

    const monitoringPromise = loadMonitoringSettings();

    const overlay = document.createElement("div");
    overlay.className = "proton-confirm-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "proton-confirm-modal proton-apps-settings-modal";
    modal.style.maxWidth = "560px";
    modal.style.width = "calc(100% - 40px)";

    const heading = document.createElement("h3");
    heading.textContent = t("Applications settings");

    const tabsNav = document.createElement("ul");
    tabsNav.className = "proton-tabs-navigation";

    const tabServicesBtn = document.createElement("button");
    tabServicesBtn.type = "button";
    tabServicesBtn.className = "proton-tab-button active";
    tabServicesBtn.dataset.tab = "services";
    tabServicesBtn.textContent = t("Services");

    const tabMonitoringBtn = document.createElement("button");
    tabMonitoringBtn.type = "button";
    tabMonitoringBtn.className = "proton-tab-button";
    tabMonitoringBtn.dataset.tab = "monitoring";
    tabMonitoringBtn.textContent = t("Monitoring");

    const tabServicesLi = document.createElement("li");
    tabServicesLi.appendChild(tabServicesBtn);
    const tabMonitoringLi = document.createElement("li");
    tabMonitoringLi.appendChild(tabMonitoringBtn);
    tabsNav.appendChild(tabServicesLi);
    tabsNav.appendChild(tabMonitoringLi);

    const contentServices = document.createElement("div");
    contentServices.className = "proton-tab-content active";
    contentServices.dataset.tabContent = "services";

    const searchWrap = document.createElement("div");
    searchWrap.className = "proton-apps-settings-search";
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.placeholder = t("Search services...");
    searchInput.autocomplete = "off";
    searchWrap.appendChild(searchInput);

    const listContainer = document.createElement("div");
    listContainer.className = "proton-apps-settings-list";

    const servicesHint = document.createElement("div");
    servicesHint.className = "proton-apps-settings-hint";
    servicesHint.textContent = t("These services are tracked in history and health checks");
    servicesHint.style.cssText = "font-size:0.8rem;color:var(--proton-muted);margin-bottom:8px;";
    contentServices.appendChild(servicesHint);

    contentServices.appendChild(searchWrap);
    contentServices.appendChild(listContainer);

    const contentMonitoring = document.createElement("div");
    contentMonitoring.className = "proton-tab-content";
    contentMonitoring.dataset.tabContent = "monitoring";
    contentMonitoring.innerHTML = `<div class="proton-apps-settings-loading">${t("Loading...")}</div>`;

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
        .filter((entry) => isDaemon(entry) || entry.name === "wireguard")
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

          const isInstalled = entry.fromInitd === true || entry.name === "wireguard";
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

    function activateTab(tabName) {
      const tabs = [tabServicesBtn, tabMonitoringBtn];
      const contents = [contentServices, contentMonitoring];

      tabs.forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.tab === tabName);
      });

      contents.forEach((el) => {
        el.classList.toggle("active", el.dataset.tabContent === tabName);
      });
    }

    tabServicesBtn.addEventListener("click", () => activateTab("services"));
    tabMonitoringBtn.addEventListener("click", () => activateTab("monitoring"));

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

    saveBtn.addEventListener("click", async function () {
      const newList = Array.from(current).filter((n) => api.isValidServiceName(n));

      showConfirmDialog(
        t("Apply changes?"),
        t("Save monitoring and services settings?"),
        t("Apply"),
        async function () {
          await applySettings(newList);
          close();
          const card = document.getElementById("proton-dashboard-apps");
          if (card) {
            closeServiceDetail();
            renderChips(card, newList, {});
            pollStatuses();
          }
        },
      );
    });

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    modal.appendChild(heading);
    modal.appendChild(tabsNav);
    modal.appendChild(contentServices);
    modal.appendChild(contentMonitoring);
    modal.appendChild(actions);
    overlay.appendChild(modal);

    document.body.appendChild(overlay);
    setTimeout(() => searchInput.focus(), 80);

    monitoringPromise.then(function (settings) {
      renderMonitoringTab(contentMonitoring, settings);
    }).catch(function (err) {
      console.warn("[Proton2025] Failed to load monitoring settings:", err);
      contentMonitoring.innerHTML = `<div class="proton-apps-settings-empty">${t("Unable to load settings")}</div>`;
    });
  }

  // =========================================================================
  //  Батч-сохранение
  // =========================================================================

  async function applySettings(newServicesList) {
    if (!ensureRpc()) {
      showToast(t("Services API not ready"), "warning");
      return;
    }

    writeAppsList(newServicesList);

    const modalOverlay = document.querySelector(".proton-apps-settings-modal");
    const monitoringContent = modalOverlay
      ? modalOverlay.querySelector('[data-tab-content="monitoring"]')
      : null;
    const mState = monitoringContent ? monitoringContent._monitoringState : null;

    if (!mState) {
      showToast(t("Settings saved"), "success");
      return;
    }

    const errors = [];

    // 1. History
    try {
      const res = await L.resolveDefault(
        callProtonSetSettings({
          history_sample_interval: String(mState.history.sampleInterval),
          history_max_age_hours: String(mState.history.maxAgeHours),
        }),
        null,
      );
      if (!res || !res.success) {
        errors.push("history: " + (res && res.error ? res.error : "unknown"));
      }
    } catch (e) {
      errors.push("history: " + (e && e.message ? e.message : e));
    }

    // 2. Telegram
    const tg = mState.telegram;
    if (tg) {
      try {
        const res = await L.resolveDefault(
          callProtonSetSettings({
            telegram_enabled: tg.enabled ? "1" : "0",
            telegram_bot_token: tg.token || "",
            telegram_chat_id: tg.chat_id || "",
            telegram_events: JSON.stringify(tg.events || []),
            telegram_services: JSON.stringify(tg.services || []),
          }),
          null
        );
        if (!res || !res.success) {
          errors.push("telegram: " + (res?.error || "unknown"));
        }
      } catch (e) {
        errors.push("telegram: " + (e.message || e));
      }
    }

    // 3. L7 per-service
    const configByName = new Map();
    (mState.health.services || []).forEach(function (s) {
      if (s && s.name) configByName.set(s.name, s);
    });

    const toSave = [];
    const toClear = [];

    newServicesList.forEach(function (name) {
      const cfg = configByName.get(name);
      if (cfg && cfg.method) {
        // Собираем config: method + common per-service + method-specific.
        const configObj = Object.assign({}, cfg.fields || {});
        configObj.method = cfg.method;
        configObj.interval = cfg.interval;
        configObj.timeout = cfg.timeout;
        configObj.failures_threshold = cfg.failures_threshold;
        configObj.log_to_syslog = cfg.log_to_syslog ? "1" : "0";

        toSave.push({
          name: name,
          enabled: cfg.enabled === true,
          config: configObj,
        });
      } else if (cfg) {
        toClear.push(name);
      }
    });

    configByName.forEach(function (cfg, name) {
      if (newServicesList.indexOf(name) === -1) {
        toClear.push(name);
      }
    });

    for (const item of toSave) {
      try {
        const configJson = JSON.stringify(item.config);
        const res = await L.resolveDefault(
          callHealthSetService(item.name, item.enabled ? "1" : "0", configJson),
          null,
        );
        if (!res || !res.success) {
          errors.push(item.name + ": " + (res && res.error ? res.error : "unknown"));
        }
      } catch (e) {
        errors.push(item.name + ": " + (e && e.message ? e.message : e));
      }
    }

    for (const name of toClear) {
      try {
        const res = await L.resolveDefault(callHealthClearService(name), null);
        if (!res || !res.success) {
          errors.push(name + " (clear): " + (res && res.error ? res.error : "unknown"));
        }
      } catch (e) {
        errors.push(name + " (clear): " + (e && e.message ? e.message : e));
      }
    }

    // 4. Обновляем кэш services-history.js
    if (window.ProtonServicesHistory
      && typeof window.ProtonServicesHistory.loadSettingsFromUci === "function") {
      try {
        await window.ProtonServicesHistory.loadSettingsFromUci();
      } catch (e) {}
    }

    // 5. Результат
    if (errors.length === 0) {
      showToast(t("Settings saved"), "success");
    } else {
      console.warn("[Proton2025] Apply settings errors:", errors);
      showToast(
        t("Some settings were not saved") + ": " + errors.length,
        "warning",
      );
    }
  }

  // =========================================================================
  //  Таб «Мониторинг»
  // =========================================================================

  async function loadMonitoringSettings() {
    if (!ensureRpc()) {
      return null;
    }

    const [settingsRes, healthRes, methodsRes, schemaRes] = await Promise.all([
      L.resolveDefault(callProtonGetSettings(), null),
      L.resolveDefault(callHealthGetConfig(), null),
      L.resolveDefault(callHealthGetMethods(), null),
      L.resolveDefault(callHealthGetSchema(), null),
    ]);

    // History
    const rawSettings = (settingsRes && settingsRes.settings) ? settingsRes.settings : {};
    const sampleInterval = clampInt(rawSettings.history_sample_interval, HISTORY_SAMPLE_INTERVALS, 10);
    const maxAgeHours = clampInt(rawSettings.history_max_age_hours, HISTORY_MAX_AGE_HOURS, 24);

    // L7 per-service (без global)
    const healthServices = (healthRes && Array.isArray(healthRes.services))
      ? healthRes.services.map((s) => {
          const fields = (s.fields && typeof s.fields === "object") ? s.fields : {};
          return {
            name: String(s.name || ""),
            enabled: s.enabled === true,
            method: String(s.method || ""),
            interval: Number.isFinite(+fields.interval) ? +fields.interval : 60,
            timeout: Number.isFinite(+fields.timeout) ? +fields.timeout : 5,
            failures_threshold: Number.isFinite(+fields.failures_threshold) ? +fields.failures_threshold : 2,
            log_to_syslog: String(fields.log_to_syslog) !== "0",
            fields: fields,
          };
        })
      : [];

    // Methods availability
    const methods = (methodsRes && Array.isArray(methodsRes.methods))
      ? methodsRes.methods.map((m) => ({
          id: String(m.id || ""),
          available: m.available === true,
        }))
      : [];

    // Schema
    const schema = (schemaRes && schemaRes.success)
      ? {
          methods: Array.isArray(schemaRes.methods) ? schemaRes.methods.slice() : [],
          fields: (schemaRes.fields && typeof schemaRes.fields === "object") ? schemaRes.fields : {},
          defaults: (schemaRes.defaults && typeof schemaRes.defaults === "object") ? schemaRes.defaults : {},
          common_fields: Array.isArray(schemaRes.common_fields) ? schemaRes.common_fields.slice() : [],
          limits: (schemaRes.limits && typeof schemaRes.limits === "object") ? schemaRes.limits : {},
        }
      : null;

    // Telegram
    const tgEnabled = rawSettings.telegram_enabled === "1";
    let tgEvents = ["health-fail", "health-recovery", "crash", "restart", "user-stop", "silent-death"];
    try { tgEvents = JSON.parse(rawSettings.telegram_events || '[]'); } catch(e){}
    let tgServices = [];
    try { tgServices = JSON.parse(rawSettings.telegram_services || '[]'); } catch(e){}

    const telegram = {
      enabled: tgEnabled,
      token: rawSettings.telegram_bot_token || "",
      chat_id: rawSettings.telegram_chat_id || "",
      events: Array.isArray(tgEvents) ? tgEvents : [],
      services: Array.isArray(tgServices) ? tgServices : []
    };

    return {
      history: { sampleInterval, maxAgeHours },
      health: { services: healthServices },
      methods,
      schema,
      telegram: telegram,
    };
  }

  function clampInt(value, allowed, fallback) {
    const n = +value;
    if (n != n) return fallback;
    return allowed.indexOf(n) >= 0 ? n : fallback;
  }

  function renderMonitoringTab(container, settings) {
    container.innerHTML = "";

    if (!settings) {
      const err = document.createElement("div");
      err.className = "proton-apps-settings-empty";
      err.textContent = t("Unable to load settings");
      container.appendChild(err);
      return;
    }

    // === Секция «История» ===
    const historySection = document.createElement("section");
    historySection.className = "proton-monitoring-section";

    const historyTitle = document.createElement("h4");
    historyTitle.className = "proton-monitoring-section-title";
    historyTitle.textContent = t("History");
    historySection.appendChild(historyTitle);

    const intervalRow = document.createElement("div");
    intervalRow.className = "proton-monitoring-row";

    const intervalLabel = document.createElement("label");
    intervalLabel.className = "proton-monitoring-label";
    intervalLabel.textContent = t("Polling interval");
    intervalLabel.setAttribute("for", "proton-monitoring-interval");

    const intervalSelect = document.createElement("select");
    intervalSelect.id = "proton-monitoring-interval";
    intervalSelect.className = "cbi-input-select proton-monitoring-select";

    HISTORY_SAMPLE_INTERVALS.forEach((sec) => {
      const opt = document.createElement("option");
      opt.value = String(sec);
      opt.textContent = sec + " " + t("seconds");
      if (sec === settings.history.sampleInterval) opt.selected = true;
      intervalSelect.appendChild(opt);
    });

    intervalRow.appendChild(intervalLabel);
    intervalRow.appendChild(intervalSelect);
    historySection.appendChild(intervalRow);

    const retentionRow = document.createElement("div");
    retentionRow.className = "proton-monitoring-row";

    const retentionLabel = document.createElement("label");
    retentionLabel.className = "proton-monitoring-label";
    retentionLabel.textContent = t("Retention period");
    retentionLabel.setAttribute("for", "proton-monitoring-retention");

    const retentionSelect = document.createElement("select");
    retentionSelect.id = "proton-monitoring-retention";
    retentionSelect.className = "cbi-input-select proton-monitoring-select";

    HISTORY_MAX_AGE_HOURS.forEach((hours) => {
      const opt = document.createElement("option");
      opt.value = String(hours);
      opt.textContent = hours + " " + (hours === 1 ? t("hour") : t("hours"));
      if (hours === settings.history.maxAgeHours) opt.selected = true;
      retentionSelect.appendChild(opt);
    });

    retentionRow.appendChild(retentionLabel);
    retentionRow.appendChild(retentionSelect);
    historySection.appendChild(retentionRow);

    const infoLine = document.createElement("div");
    infoLine.className = "proton-monitoring-info";

    const servicesCount = readAppsList().length;
    infoLine.textContent = t("Services monitored") + ": " + servicesCount;
    historySection.appendChild(infoLine);

    container.appendChild(historySection);

    // === Секция «Health check» (per-service) ===
    const l7Section = document.createElement("section");
    l7Section.className = "proton-monitoring-section";
    l7Section.dataset.role = "l7-section";

    const l7Title = document.createElement("h4");
    l7Title.className = "proton-monitoring-section-title";
    l7Title.textContent = t("Health check");
    l7Section.appendChild(l7Title);

    const l7Hint = document.createElement("div");
    l7Hint.className = "proton-monitoring-info";
    l7Hint.style.marginTop = "0";
    l7Hint.style.marginBottom = "10px";
    l7Hint.textContent = t("Configure interval, timeout and failure threshold individually for each service.");
    l7Section.appendChild(l7Hint);

    container.dataset.role = "monitoring-content";
    container._monitoringState = {
      history: {
        sampleInterval: settings.history.sampleInterval,
        maxAgeHours: settings.history.maxAgeHours,
      },
      health: {
        services: JSON.parse(JSON.stringify(settings.health.services || [])),
      },
      methods: settings.methods.slice(),
      schema: settings.schema,
      telegram: settings.telegram
        ? JSON.parse(JSON.stringify(settings.telegram))
        : {
            enabled: false,
            token: "",
            chat_id: "",
            events: ["health-fail", "health-recovery", "crash", "restart", "user-stop", "silent-death"],
            services: [],
          },
    };

    intervalSelect.addEventListener("change", function () {
      const v = parseInt(intervalSelect.value, 10);
      if (v == v) container._monitoringState.history.sampleInterval = v;
    });

    retentionSelect.addEventListener("change", function () {
      const v = parseInt(retentionSelect.value, 10);
      if (v == v) container._monitoringState.history.maxAgeHours = v;
    });

    renderL7ServiceListContainer(l7Section, container);

    container.appendChild(l7Section);

    // === Секция «Telegram» ===
    renderTelegramSection(container, settings, container);
  }

  function renderL7ServiceListContainer(section, rootContainer) {
    const state = rootContainer._monitoringState;
    if (!state || !state.health) return;

    const list = document.createElement("div");
    list.className = "proton-l7-services";
    list.dataset.role = "l7-services";

    renderL7ServiceList(list, state, rootContainer);
    section.appendChild(list);
  }

  function renderL7ServiceList(listEl, state, rootContainer) {
    listEl.replaceChildren();

    const selected = readAppsList();
    if (!selected.length) {
      const empty = document.createElement("div");
      empty.className = "proton-apps-settings-empty";
      empty.textContent = t("No services selected");
      listEl.appendChild(empty);
      return;
    }

    const configByName = new Map();
    (state.health.services || []).forEach(function (s) {
      if (s && s.name) configByName.set(s.name, s);
    });

    const methodAvailability = new Map();
    (state.methods || []).forEach(function (m) {
      if (m && m.id) methodAvailability.set(m.id, m.available === true);
    });

    selected.forEach(function (serviceName) {
      const row = createL7ServiceRow(
        serviceName,
        configByName.get(serviceName) || null,
        state,
        methodAvailability,
        rootContainer,
      );
      listEl.appendChild(row);
    });
  }

  function createL7ServiceRow(serviceName, config, state, methodAvailability, rootContainer) {
    const api = getStatusFromApi();
    const info = api ? api.getServiceInfo(serviceName) : {
      name: serviceName,
      displayName: serviceName,
      icon: "📦",
    };

    const row = document.createElement("div");
    row.className = "proton-l7-service-row";
    row.dataset.service = serviceName;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "proton-l7-service-check";
    check.checked = !!(config && config.enabled === true);

    const icon = document.createElement("span");
    icon.className = "proton-l7-service-icon";
    icon.textContent = info.icon || "📦";

    const text = document.createElement("div");
    text.className = "proton-l7-service-text";

    const nameEl = document.createElement("div");
    nameEl.className = "proton-l7-service-name";
    nameEl.textContent = info.displayName || serviceName;

    const metaEl = document.createElement("div");
    metaEl.className = "proton-l7-service-meta";
    metaEl.textContent = buildL7ServicePreview(config, state, methodAvailability);

    text.appendChild(nameEl);
    text.appendChild(metaEl);

    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "proton-l7-service-expand";
    expand.setAttribute("aria-label", t("Edit"));
    expand.setAttribute("aria-expanded", "false");
    expand.textContent = "▾";

    row.appendChild(check);
    row.appendChild(icon);
    row.appendChild(text);
    row.appendChild(expand);

    check.addEventListener("change", function () {
      const cfg = ensureServiceConfig(state, serviceName);
      cfg.enabled = check.checked;
    });

    row.addEventListener("click", function (ev) {
      if (ev.target === check) return;
      if (ev.target.closest(".proton-l7-editor")) return;
      toggleL7ServiceEditor(row, serviceName, state, methodAvailability, rootContainer);
    });

    return row;
  }

  function ensureServiceConfig(state, serviceName) {
    if (!state.health.services) state.health.services = [];
    let cfg = state.health.services.find(function (s) { return s.name === serviceName; });
    if (!cfg) {
      cfg = {
        name: serviceName,
        enabled: false,
        method: "",
        interval: 60,
        timeout: 5,
        failures_threshold: 2,
        log_to_syslog: true,
        fields: {},
      };
      state.health.services.push(cfg);
    } else {
      if (!Number.isFinite(cfg.interval)) cfg.interval = 60;
      if (!Number.isFinite(cfg.timeout)) cfg.timeout = 5;
      if (!Number.isFinite(cfg.failures_threshold)) cfg.failures_threshold = 2;
      if (cfg.log_to_syslog == null) cfg.log_to_syslog = true;
      if (!cfg.fields || typeof cfg.fields !== "object") cfg.fields = {};
    }
    return cfg;
  }

  function buildL7ServicePreview(config, state, methodAvailability) {
    if (!config || !config.method) {
      return t("Not configured");
    }

    const avail = methodAvailability.get(config.method);
    const label = config.method + (avail === false ? " (" + t("Unavailable") + ")" : "");
    const intervalStr = Number.isFinite(config.interval) ? (" · " + config.interval + "s") : "";

    const fields = config.fields || {};

    let target = "";
    if (config.method === "dns") {
      target = [fields.host, fields.server].filter(Boolean).join(" @ ");
    } else if (config.method === "http" || config.method === "proxy_socks5" || config.method === "proxy_http") {
      target = fields.url || "";
    } else if (config.method === "local_port") {
      target = [fields.proto, fields.port].filter(Boolean).join(":");
    } else if (config.method === "wireguard") {
      target = fields.iface || "";
    } else if (config.method === "tunnel_ping") {
      target = [fields.iface, fields.host].filter(Boolean).join(" → ");
    } else if (config.method === "custom") {
      target = (fields.command || "").slice(0, 40);
    }

    const targetStr = target ? " · " + target : "";
    return label + targetStr + intervalStr;
  }

  function toggleL7ServiceEditor(row, serviceName, state, methodAvailability, rootContainer) {
    const next = row.nextElementSibling;
    const isEditorOpen = next && next.classList && next.classList.contains("proton-l7-editor");

    if (isEditorOpen) {
      next.remove();
      row.querySelector(".proton-l7-service-expand").setAttribute("aria-expanded", "false");
      row.querySelector(".proton-l7-service-expand").textContent = "▾";
      return;
    }

    const editor = document.createElement("div");
    editor.className = "proton-l7-editor";
    editor.dataset.service = serviceName;

    renderL7Editor(editor, serviceName, state, methodAvailability, rootContainer, function onClose() {
      editor.remove();
      row.querySelector(".proton-l7-service-expand").setAttribute("aria-expanded", "false");
      row.querySelector(".proton-l7-service-expand").textContent = "▾";
    });

    row.parentNode.insertBefore(editor, row.nextSibling);
    row.querySelector(".proton-l7-service-expand").setAttribute("aria-expanded", "true");
    row.querySelector(".proton-l7-service-expand").textContent = "▴";
  }

  /**
   * Строит строку "label + select(preset | custom) + [input]".
   */
  function buildSelectOrCustomRow(opts) {
    const row = document.createElement("div");
    row.className = "proton-l7-editor-row";

    const label = document.createElement("label");
    label.className = "proton-l7-editor-label";
    label.textContent = opts.label;
    label.setAttribute("for", opts.id);

    const selectWrap = document.createElement("div");
    selectWrap.style.cssText = "display:flex;flex:1 1 auto;min-width:0;gap:6px;align-items:center;";

    const select = document.createElement("select");
    select.id = opts.id;
    select.className = "cbi-input-select proton-l7-editor-select";
    select.style.flex = "0 0 auto";
    select.style.minWidth = "140px";

    const isPreset = opts.presets.indexOf(opts.value) !== -1;

    opts.presets.forEach(function (v) {
      const opt = document.createElement("option");
      opt.value = String(v);
      opt.textContent = opts.unit ? (v + " " + opts.unit) : String(v);
      if (v === opts.value) opt.selected = true;
      select.appendChild(opt);
    });

    const customOpt = document.createElement("option");
    customOpt.value = "custom";
    customOpt.textContent = "— " + t("Custom") + " —";
    if (!isPreset) customOpt.selected = true;
    select.appendChild(customOpt);

    const customInput = document.createElement("input");
    customInput.type = "number";
    customInput.min = String(opts.min);
    customInput.max = String(opts.max);
    customInput.step = "1";
    customInput.className = "cbi-input-text proton-l7-editor-input";
    customInput.style.flex = "1 1 auto";
    customInput.style.minWidth = "80px";
    customInput.style.display = isPreset ? "none" : "";
    customInput.value = String(opts.value);

    function clampValue(raw) {
      let v = parseInt(raw, 10);
      if (v != v) v = opts.presets[0] || opts.min;
      if (v < opts.min) v = opts.min;
      if (v > opts.max) v = opts.max;
      return v;
    }

    select.addEventListener("change", function () {
      if (select.value === "custom") {
        customInput.style.display = "";
        customInput.focus();
        customInput.select();
        opts.onChange(clampValue(customInput.value));
      } else {
        customInput.style.display = "none";
        opts.onChange(parseInt(select.value, 10));
      }
    });

    customInput.addEventListener("input", function () {
      const v = clampValue(customInput.value);
      opts.onChange(v);
    });

    customInput.addEventListener("blur", function () {
      const v = clampValue(customInput.value);
      customInput.value = String(v);
      opts.onChange(v);
    });

    selectWrap.appendChild(select);
    selectWrap.appendChild(customInput);

    row.appendChild(label);
    row.appendChild(selectWrap);
    return row;
  }

  // =========================================================================
  //  Inline-редактор L7 для одного сервиса
  // =========================================================================

  function renderL7Editor(editor, serviceName, state, methodAvailability, rootContainer, onClose) {
    const schema = state.schema;
    if (!schema || !schema.methods || !schema.fields || !schema.defaults) {
      editor.innerHTML = `<div class="proton-apps-settings-empty">${t("Unable to load schema")}</div>`;
      return;
    }

    const cfg = ensureServiceConfig(state, serviceName);

    const draft = {
      method: cfg.method || "",
      interval: Number.isFinite(cfg.interval) ? cfg.interval : 60,
      timeout: Number.isFinite(cfg.timeout) ? cfg.timeout : 5,
      failures_threshold: Number.isFinite(cfg.failures_threshold) ? cfg.failures_threshold : 2,
      log_to_syslog: cfg.log_to_syslog !== false,
      fields: Object.assign({}, cfg.fields || {}),
    };

    const limits = (schema.limits && typeof schema.limits === "object") ? schema.limits : {
      min_interval: 10, max_interval: 3600,
      min_timeout: 1, max_timeout: 60,
      min_failures: 1, max_failures: 10,
    };

    editor.innerHTML = "";

    // ===== Common settings =====
    const commonTitle = document.createElement("div");
    commonTitle.className = "proton-l7-editor-section-title";
    commonTitle.textContent = t("Common settings");
    editor.appendChild(commonTitle);

    const intervalRow = buildSelectOrCustomRow({
      id: "proton-l7-editor-interval-" + slug(serviceName),
      label: t("Interval"),
      unit: t("seconds"),
      presets: INTERVAL_PRESETS,
      value: draft.interval,
      min: limits.min_interval,
      max: limits.max_interval,
      onChange: function (v) { draft.interval = v; },
    });
    editor.appendChild(intervalRow);

    const timeoutRow = buildSelectOrCustomRow({
      id: "proton-l7-editor-timeout-" + slug(serviceName),
      label: t("Timeout"),
      unit: t("seconds"),
      presets: TIMEOUT_PRESETS,
      value: draft.timeout,
      min: limits.min_timeout,
      max: limits.max_timeout,
      onChange: function (v) { draft.timeout = v; },
    });
    editor.appendChild(timeoutRow);

    const thresholdRow = buildSelectOrCustomRow({
      id: "proton-l7-editor-threshold-" + slug(serviceName),
      label: t("Failures until failed"),
      unit: "",
      presets: FAILURE_PRESETS,
      value: draft.failures_threshold,
      min: limits.min_failures,
      max: limits.max_failures,
      onChange: function (v) { draft.failures_threshold = v; },
    });
    editor.appendChild(thresholdRow);

    const logRow = document.createElement("label");
    logRow.className = "proton-monitoring-check-row";
    logRow.style.marginTop = "4px";

    const logCheck = document.createElement("input");
    logCheck.type = "checkbox";
    logCheck.id = "proton-l7-editor-log-" + slug(serviceName);
    logCheck.checked = draft.log_to_syslog;
    logCheck.addEventListener("change", function () {
      draft.log_to_syslog = logCheck.checked;
    });

    const logText = document.createElement("span");
    logText.textContent = t("Log health check to syslog");

    logRow.appendChild(logCheck);
    logRow.appendChild(logText);
    editor.appendChild(logRow);

    // ===== Method-specific =====
    const methodTitle = document.createElement("div");
    methodTitle.className = "proton-l7-editor-section-title";
    methodTitle.style.marginTop = "14px";
    methodTitle.textContent = t("Check method");
    editor.appendChild(methodTitle);

    const methodRow = document.createElement("div");
    methodRow.className = "proton-l7-editor-row";

    const methodLabel = document.createElement("label");
    methodLabel.className = "proton-l7-editor-label";
    methodLabel.textContent = t("Method");
    methodLabel.setAttribute("for", "proton-l7-editor-method-" + slug(serviceName));

    const methodSelect = document.createElement("select");
    methodSelect.id = "proton-l7-editor-method-" + slug(serviceName);
    methodSelect.className = "cbi-input-select proton-l7-editor-select";

    const emptyOpt = document.createElement("option");
    emptyOpt.value = "";
    emptyOpt.textContent = "— " + t("Not configured") + " —";
    if (!draft.method) emptyOpt.selected = true;
    methodSelect.appendChild(emptyOpt);

    schema.methods.forEach(function (mid) {
      const opt = document.createElement("option");
      opt.value = mid;
      const available = methodAvailability.get(mid) !== false;
      opt.textContent = mid + (available ? "" : " (" + t("Unavailable") + ")");
      if (mid === draft.method) opt.selected = true;
      methodSelect.appendChild(opt);
    });

    methodRow.appendChild(methodLabel);
    methodRow.appendChild(methodSelect);
    editor.appendChild(methodRow);

    const fieldsBox = document.createElement("div");
    fieldsBox.className = "proton-l7-editor-fields";
    editor.appendChild(fieldsBox);

    const commonSet = { interval: true, timeout: true, failures_threshold: true, log_to_syslog: true };

    function renderFields() {
      fieldsBox.replaceChildren();

      if (!draft.method) {
        const hint = document.createElement("div");
        hint.className = "proton-l7-editor-hint";
        hint.textContent = t("Select a method to configure");
        fieldsBox.appendChild(hint);
        return;
      }

      const allFieldNames = schema.fields[draft.method] || [];
      const methodFieldNames = allFieldNames.filter(function (f) { return !commonSet[f]; });
      const defaults = schema.defaults[draft.method] || {};

      methodFieldNames.forEach(function (fieldName) {
        const row = document.createElement("div");
        row.className = "proton-l7-editor-row";

        const label = document.createElement("label");
        label.className = "proton-l7-editor-label";
        const fieldId = "proton-l7-field-" + slug(serviceName) + "-" + fieldName;
        label.textContent = humanizeField(fieldName);
        label.setAttribute("for", fieldId);

        const input = document.createElement("input");
        input.type = "text";
        input.id = fieldId;
        input.className = "cbi-input-text proton-l7-editor-input";

        let value = draft.fields[fieldName];
        if (value == null || value === "") {
          value = defaults[fieldName] != null ? String(defaults[fieldName]) : "";
        }
        input.value = String(value);

        input.addEventListener("input", function () {
          draft.fields[fieldName] = input.value;
        });

        row.appendChild(label);
        row.appendChild(input);
        fieldsBox.appendChild(row);
      });
    }

    renderFields();

    methodSelect.addEventListener("change", function () {
      const newMethod = methodSelect.value;
      if (newMethod === draft.method) return;

      draft.method = newMethod;
      draft.fields = {};
      renderFields();
    });

    // ===== Actions =====
    const actionsRow = document.createElement("div");
    actionsRow.className = "proton-l7-editor-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "cbi-button cbi-button-neutral";
    cancelBtn.textContent = t("Cancel");
    cancelBtn.addEventListener("click", function () {
      if (typeof onClose === "function") onClose();
    });

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "cbi-button cbi-button-positive";
    saveBtn.textContent = t("Save");
    saveBtn.addEventListener("click", function () {
      if (!draft.method) {
        showToast(t("Select a method first"), "warning");
        return;
      }

      if (draft.timeout > draft.interval) {
        showToast(t("Timeout must be ≤ interval"), "warning");
        return;
      }

      const methodFieldNames = (schema.fields[draft.method] || []).filter(function (f) {
        return !commonSet[f];
      });
      const hasAny = methodFieldNames.some(function (f) {
        return String(draft.fields[f] || "").trim() !== "";
      });

      if (methodFieldNames.length > 0 && !hasAny) {
        showToast(t("Fill in at least one target field"), "warning");
        return;
      }

      cfg.method = draft.method;
      cfg.interval = draft.interval;
      cfg.timeout = draft.timeout;
      cfg.failures_threshold = draft.failures_threshold;
      cfg.log_to_syslog = draft.log_to_syslog;
      cfg.fields = Object.assign({}, draft.fields);

      if (!cfg.enabled) {
        cfg.enabled = true;
        const row = editor.previousElementSibling;
        if (row) {
          const check = row.querySelector(".proton-l7-service-check");
          if (check) check.checked = true;
        }
      }

      const row = editor.previousElementSibling;
      if (row) {
        const meta = row.querySelector(".proton-l7-service-meta");
        if (meta) {
          meta.textContent = buildL7ServicePreview(cfg, state, methodAvailability);
        }
      }

      showToast(t("Service configuration saved"), "success");
      if (typeof onClose === "function") onClose();
    });

    actionsRow.appendChild(cancelBtn);
    actionsRow.appendChild(saveBtn);
    editor.appendChild(actionsRow);
  }

  function slug(s) {
    return String(s || "").replace(/[^a-zA-Z0-9_-]+/g, "-");
  }

  function humanizeField(name) {
    const map = {
      "host":         "Host",
      "server":       "Server",
      "url":          "URL",
      "expected_code": "Expected code",
      "port":         "Port",
      "proto":        "Protocol",
      "addr":         "Address",
      "proxy_port":   "Proxy port",
      "iface":        "Interface",
      "max_age_sec":  "Max age (sec)",
      "command":      "Command",
    };
    return t(map[name] || name);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  let summaryGraphPeriodSec = 3600;
  let detailGraphPeriodSec = 3600;

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

    initSummaryGraph(card);

    if (pollTimer) return true;
    pollStatuses();
    pollTimer = setInterval(pollStatuses, POLL_INTERVAL);

    window.addEventListener("proton-services-history-updated", function () {
      const c = document.getElementById("proton-dashboard-apps");
      if (!c) return;
      if (selectedService) return;
      renderSummaryGraph(c);
    });

    if (window.__protonAppsHistoryRefreshTimer) {
      clearInterval(window.__protonAppsHistoryRefreshTimer);
      window.__protonAppsHistoryRefreshTimer = null;
    }

    function startHistoryRefreshTimer() {
      if (window.__protonAppsHistoryRefreshTimer) {
        clearInterval(window.__protonAppsHistoryRefreshTimer);
        window.__protonAppsHistoryRefreshTimer = null;
      }

      const h = window.ProtonServicesHistory;
      const si = (h && typeof h.getSampleInterval === "function")
        ? h.getSampleInterval()
        : 10;
      const intervalMs = Math.max(si, 5) * 1000;

      window.__protonAppsHistoryRefreshTimer = setInterval(async function () {
        const c = document.getElementById("proton-dashboard-apps");
        if (!c || document.hidden) return;

        const hist = window.ProtonServicesHistory;
        if (!hist || typeof hist.loadService !== "function") return;

        const services = readAppsList();
        if (!services.length) return;

        try {
          await Promise.all(
            services.map(function (name) {
              return hist.loadService(name, { force: true }).catch(function () {
                return null;
              });
            })
          );
          if (selectedService) {
            const slot = c.querySelector('[data-role="detail-slot"]');
            const graphContainer = slot
              ? slot.querySelector('[data-role="service-graph-container"]')
              : null;
            if (graphContainer) {
              renderDetailGraph(
                slot.querySelector(".proton-apps-detail"),
                selectedService,
                graphContainer
              );
            }
          } else {
            renderSummaryGraph(c);
          }
        } catch (e) {
          // следующая попытка через intervalMs
        }
      }, intervalMs);
    }

    startHistoryRefreshTimer();
    window.__protonAppsStartHistoryRefreshTimer = startHistoryRefreshTimer;

    window.addEventListener("proton-settings-synced", function () {
      if (typeof window.__protonAppsStartHistoryRefreshTimer === "function") {
        window.__protonAppsStartHistoryRefreshTimer();
      }
    });

    visibilityHandler = function () {
      if (!document.hidden) pollStatuses();
    };
    document.addEventListener("visibilitychange", visibilityHandler);
    window.addEventListener("resize", function () {
      const c = document.getElementById("proton-dashboard-apps");
      if (!c) return;
      if (selectedService) return;
      renderSummaryGraph(c);
    });

    return true;
  }

  function initSummaryGraph(card) {
    const toolbar = card.querySelector('[data-role="summary-graph-toolbar"]');
    if (!toolbar) return;

    updateGraphPeriodButtons(toolbar, summaryGraphPeriodSec);

    toolbar.addEventListener("click", function (e) {
      const btn = e.target.closest(".proton-apps-graph-period");
      if (!btn) return;
      const period = parseInt(btn.dataset.period, 10);
      if (!period || period === summaryGraphPeriodSec) return;
      summaryGraphPeriodSec = period;
      updateGraphPeriodButtons(toolbar, period);

      if (window.ProtonServicesHistory
        && typeof window.ProtonServicesHistory.loadEvents === "function") {
        window.ProtonServicesHistory.loadEvents(period * 1000)
          .then(function () { renderSummaryGraph(card); })
          .catch(function () { renderSummaryGraph(card); });
      } else {
        renderSummaryGraph(card);
      }
    });

    if (window.ProtonServicesHistory
      && typeof window.ProtonServicesHistory.loadEvents === "function") {
      window.ProtonServicesHistory.loadEvents(summaryGraphPeriodSec * 1000)
        .then(function () { renderSummaryGraph(card); })
        .catch(function () { renderSummaryGraph(card); });
    } else {
      renderSummaryGraph(card);
    }

    if (!summaryEventsTimer) {
      summaryEventsTimer = setInterval(function () {
        if (!document.body.contains(card)) {
          clearInterval(summaryEventsTimer);
          summaryEventsTimer = null;
          return;
        }
        if (document.hidden) return;
        if (selectedService) return;
        if (!window.ProtonServicesHistory
          || typeof window.ProtonServicesHistory.loadEvents !== "function") {
          return;
        }
        window.ProtonServicesHistory.loadEvents(summaryGraphPeriodSec * 1000)
          .then(function () { renderSummaryGraph(card); })
          .catch(function () {});
      }, 30000);
    }
  }

  function updateGraphPeriodButtons(toolbar, activePeriodSec) {
    toolbar.querySelectorAll(".proton-apps-graph-period").forEach(function (btn) {
      const period = parseInt(btn.dataset.period, 10);
      btn.classList.toggle("active", period === activePeriodSec);
    });
  }

  function handleSummaryEventClick(columnIndex, events) {
    const card = document.getElementById("proton-dashboard-apps");
    if (!card) return;

    if (
      summarySelectedEventGroup &&
      summarySelectedEventGroup.columnIndex === columnIndex
    ) {
      summarySelectedEventGroup = null;
    } else {
      summarySelectedEventGroup = { columnIndex, events };
    }

    renderSummaryGraph(card);
  }

  function getEventTypeLabel(type) {
    if (
      window.ProtonServicesGraph &&
      window.ProtonServicesGraph.EVENT_TYPE_LABEL
    ) {
      return window.ProtonServicesGraph.EVENT_TYPE_LABEL[type] || type;
    }
    return type;
  }

  function renderSummaryEventDetails(card) {
    if (!card) return;

    let details = card.querySelector('[data-role="summary-event-details"]');

    if (!details) {
      details = document.createElement("div");
      details.className = "proton-apps-event-details";
      details.dataset.role = "summary-event-details";

      const eventsContainer = card.querySelector('[data-role="summary-events"]');
      const footer = card.querySelector('[data-role="summary-footer"]');

      if (eventsContainer && eventsContainer.parentNode) {
        eventsContainer.parentNode.insertBefore(
          details,
          eventsContainer.nextSibling,
        );
      } else if (footer && footer.parentNode) {
        footer.parentNode.insertBefore(details, footer);
      } else {
        return;
      }
    }

    if (!summarySelectedEventGroup) {
      details.innerHTML = "";
      return;
    }

    const events = summarySelectedEventGroup.events;
    if (!Array.isArray(events) || events.length === 0) {
      details.innerHTML = "";
      return;
    }

    const firstTs = Number(events[0][0]) || 0;
    const timeStr = formatEventTime(firstTs);
    const headerText = timeStr + " · ℹ️ " + events.length;

    let html = '<div class="proton-apps-event-details-header">' +
      escapeHtml(headerText) +
      "</div>";

    for (const e of events) {
      if (!Array.isArray(e) || e.length < 5) continue;
      const type = String(e[2] || "unknown");
      const service = String(e[1] || "");
      const details = String(e[4] || "");

      html +=
        '<div class="proton-apps-event-row">' +
        '<span class="proton-apps-event-type" data-type="' +
        escapeHtml(type) +
        '">' +
        escapeHtml(getEventTypeLabel(type)) +
        "</span>" +
        '<span class="proton-apps-event-service">' +
        escapeHtml(service) +
        "</span>" +
        '<span class="proton-apps-event-msg" title="' +
        escapeHtml(details) +
        '">' +
        escapeHtml(details) +
        "</span>" +
        "</div>";
    }

    details.innerHTML = html;
  }

  function formatEventTime(ts) {
    if (!Number.isFinite(ts) || ts <= 0) return "—";
    const d = new Date(ts * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return (
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes()) +
      ":" +
      pad(d.getSeconds())
    );
  }

  function renderSummaryGraph(card) {
    const container = card.querySelector('[data-role="summary-graph"]');
    const eventsContainer = card.querySelector('[data-role="summary-events"]');
    const footer = card.querySelector('[data-role="summary-footer"]');
    if (!container) return;
    if (selectedService) return;

    if (!window.ProtonServicesHistory || !window.ProtonServicesGraph) {
      container.innerHTML = '<div class="proton-apps-graph-empty">' + t("Loading...") + '</div>';
      if (eventsContainer) eventsContainer.innerHTML = "";
      return;
    }

    const windowMs = summaryGraphPeriodSec * 1000;
    let points = [];
    try {
      points = window.ProtonServicesHistory.getWorstStatusTimeline(windowMs, {
        targetCount: 200,
      });
    } catch (e) {
      console.warn("[Proton2025] Failed to get worst status timeline:", e);
      points = [];
    }

    const width = container.clientWidth || 400;
    const height = container.clientHeight || 120;

    if (!points.length) {
      container.innerHTML = '<div class="proton-apps-graph-empty">' + t("No data") + '</div>';
    } else {
      window.ProtonServicesGraph.renderWorstStatusGraph(container, points, {
        width: width,
        height: height,
        windowMs: windowMs,
      });
    }

    let visibleEvents = [];
    try {
      if (window.ProtonServicesHistory
        && typeof window.ProtonServicesHistory.getCachedEvents === "function") {
        const allEvents = window.ProtonServicesHistory.getCachedEvents();
        const nowSec = Math.floor(Date.now() / 1000);
        const startSec = nowSec - Math.floor(windowMs / 1000);
        visibleEvents = allEvents.filter((e) => {
          if (!Array.isArray(e) || e.length < 3) return false;
          const ts = Number(e[0]);
          return Number.isFinite(ts) && ts >= startSec && ts <= nowSec;
        });
      }
    } catch (e) {
      visibleEvents = [];
    }

    if (eventsContainer) {
      const eventsWidth = eventsContainer.clientWidth || width;
      window.ProtonServicesGraph.renderEventTimeline(
        eventsContainer,
        visibleEvents,
        {
          width: eventsWidth,
          height: summarySelectedEventGroup ? 32 : 100,
          windowMs: windowMs,
          selectedGroupKey: summarySelectedEventGroup
            ? String(summarySelectedEventGroup.columnIndex)
            : null,
          onEventClick: handleSummaryEventClick,
        },
      );

      eventsContainer.classList.toggle(
        "is-compact",
        !!summarySelectedEventGroup,
      );

      renderSummaryEventDetails(card);
    }

    if (footer) {
      updateSummaryGraphFooter(footer, visibleEvents);
    }
  }

  function updateSummaryGraphFooter(footer, events) {
    if (!footer) return;

    let running = 0;
    let total = 0;
    const widget = window.protonServicesWidget;
    if (widget && widget._statusCache) {
      for (const [, status] of widget._statusCache) {
        total++;
        if (status === "running") running++;
      }
    }

    if (total === 0) {
      const services = readAppsList();
      total = services.length;
      const card = document.getElementById("proton-dashboard-apps");
      if (card) {
        const chips = card.querySelectorAll(".proton-apps-chip");
        chips.forEach(function (chip) {
          if (chip.dataset.status === "running") running++;
        });
      }
    }

    let incidents = 0;
    let worstIncident = null;
    let userStops = 0;
    let cleanExits = 0;
    let restarts = 0;
    let recoveries = 0;

    const INCIDENT_PRIORITY = {
      crash: 1,
      "health-fail": 2,
      "silent-death": 3,
      unknown: 4,
    };

    if (Array.isArray(events)) {
      for (const e of events) {
        if (!Array.isArray(e) || e.length < 3) continue;
        const type = String(e[2] || "");
        if (INCIDENT_PRIORITY[type] != null) {
          incidents++;
          if (
            worstIncident === null ||
            INCIDENT_PRIORITY[type] < INCIDENT_PRIORITY[worstIncident]
          ) {
            worstIncident = type;
          }
        } else if (type === "user-stop") {
          userStops++;
        } else if (type === "clean-exit") {
          cleanExits++;
        } else if (type === "restart") {
          restarts++;
        } else if (type === "health-recovery") {
          recoveries++;
        }
      }
    }

    let dotColor = "#34d399";
    if (worstIncident === "crash") {
      dotColor = "#ef4444";
    } else if (worstIncident === "health-fail") {
      dotColor = "#f97316";
    } else if (worstIncident === "silent-death" || worstIncident === "unknown") {
      dotColor = "#fbbf24";
    } else if (total > 0 && running < total) {
      dotColor = "#fbbf24";
    }

    const parts = [];

    if (total > 0) {
      parts.push(
        '<span class="proton-apps-summary-part">' +
        '<span class="proton-apps-summary-symbol" style="color:' +
        dotColor + '">●</span> ' +
        '<span class="proton-apps-summary-num">' +
        running + "/" + total +
        "</span>" +
        "</span>"
      );
    }

    const zeroClass = (n) => n === 0 ? " is-zero" : "";

    parts.push(
      '<span class="proton-apps-summary-part' + zeroClass(incidents) + '">' +
      '<span class="proton-apps-summary-symbol proton-apps-summary-warn">⚠</span> ' +
      '<span class="proton-apps-summary-num">' +
      incidents +
      "</span>" +
      "</span>"
    );

    parts.push(
      '<span class="proton-apps-summary-part' + zeroClass(userStops) + '">' +
      '<span class="proton-apps-summary-symbol proton-apps-summary-userstop">⏸</span> ' +
      '<span class="proton-apps-summary-num">' +
      userStops +
      "</span>" +
      "</span>"
    );

    parts.push(
      '<span class="proton-apps-summary-part' + zeroClass(cleanExits) + '">' +
      '<span class="proton-apps-summary-symbol proton-apps-summary-cleanexit">⏹</span> ' +
      '<span class="proton-apps-summary-num">' +
      cleanExits +
      "</span>" +
      "</span>"
    );

    parts.push(
      '<span class="proton-apps-summary-part' + zeroClass(restarts) + '">' +
      '<span class="proton-apps-summary-symbol proton-apps-summary-restart">⟳</span> ' +
      '<span class="proton-apps-summary-num">' +
      restarts +
      "</span>" +
      "</span>"
    );

    parts.push(
      '<span class="proton-apps-summary-part' + zeroClass(recoveries) + '">' +
      '<span class="proton-apps-summary-symbol proton-apps-summary-recovery">✓</span> ' +
      '<span class="proton-apps-summary-num">' +
      recoveries +
      "</span>" +
      "</span>"
    );

    footer.innerHTML = parts.join(
      '<span class="proton-apps-summary-sep"> · </span>'
    );
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
