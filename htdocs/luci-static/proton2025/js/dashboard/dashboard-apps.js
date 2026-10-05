/**
 * Proton2025 Dashboard - Applications widget
 * Copyright 2025-2026 ChesterGoodiny
 * Licensed under the Apache License, Version 2.0
 * See LICENSE and NOTICE for details.
 *
 * KeeneticOS-style applications panel:
 *   - Toggle start/stop for init.d services
 *   - Optimistic UI + status poll with timeout
 *   - Critical-service confirmation before stop
 *   - Sync with Services Monitor widget or custom selection
 *
 * Data sources:
 *   - window.ProtonServicesApi (exposed by services-widget.js)
 *   - rc.init (ubus, via luci.rpc)
 */

(function () {
  "use strict";

  const POLL_INTERVAL = 10000;
  const TOGGLE_TIMEOUT_MS = 3000;
  const TOGGLE_POLL_MS = 500;
  const STORAGE_KEY = "proton-apps-widget";
  const SERVICES_STORAGE_KEY = "proton-services-widget";

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

  let pollTimer = null;
  let visibilityHandler = null;
  let mounted = false;
  let servicesGridWrapObserver = null;
  let rcInitRpc = null;
  let busyServices = new Set();

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

    return true;
  }

  async function callRcInit(name, action) {
    if (!ensureRpc()) throw new Error("RPC not ready");
    return L.resolveDefault(rcInitRpc(name, action), null);
  }

  // ---------------------------------------------------------------------------
  // Storage helpers
  // ---------------------------------------------------------------------------

  function readAppsList() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) {
        // Первый запуск — наследуем список из services-widget
        return readServicesList();
      }
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return readServicesList();
    }
  }

  function writeAppsList(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
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
  // Status helpers
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
    const api = window.ProtonServicesApi;
    if (!api) return null;
    return api;
  }

  // ---------------------------------------------------------------------------
  // Confirm modal for critical services
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
  // Toast for actions
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
        <ul class="proton-dashboard-apps-list" data-role="list" role="list"></ul>
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
  // Row rendering
  // ---------------------------------------------------------------------------

  function createRow(name, info, status) {
    const row = document.createElement("li");
    row.className = "proton-dashboard-apps-row";
    row.dataset.service = name;
    row.dataset.state = status;

    const icon = document.createElement("span");
    icon.className = "proton-dashboard-apps-icon";
    icon.textContent = info.icon || "📦";

    const infoBlock = document.createElement("div");
    infoBlock.className = "proton-dashboard-apps-info";

    const nameEl = document.createElement("span");
    nameEl.className = "proton-dashboard-apps-name";
    nameEl.textContent = info.displayName || name;

    const metaEl = document.createElement("span");
    metaEl.className = "proton-dashboard-apps-meta";

    const dot = document.createElement("span");
    dot.className = "proton-dashboard-apps-status-dot";
    dot.dataset.state = status;

    const statusText = document.createElement("span");
    statusText.className = "proton-dashboard-apps-status-text";
    statusText.textContent = t(getStatusKey(status));

    metaEl.appendChild(dot);
    metaEl.appendChild(statusText);

    infoBlock.appendChild(nameEl);
    infoBlock.appendChild(metaEl);

    const toggleWrap = document.createElement("label");
    toggleWrap.className = "proton-dashboard-apps-toggle";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = status === "running";
    input.disabled = status === "not-installed" || status === "unknown";

    const slider = document.createElement("span");
    slider.className = "proton-dashboard-apps-toggle-slider";

    toggleWrap.appendChild(input);
    toggleWrap.appendChild(slider);

    input.addEventListener("change", function () {
      if (busyServices.has(name)) {
        input.checked = !input.checked;
        return;
      }
      if (input.checked) {
        doStart(name, input, row);
      } else {
        // Хотим stop — если критический, спросить подтверждение
        if (CRITICAL_SERVICES.has(name)) {
          showConfirmDialog(
            t("Stop service?"),
            t(
              'Are you sure you want to stop the "{name}" service? This may disrupt network connectivity.',
            ).replace("{name}", info.displayName || name),
            t("Stop"),
            function () {
              doStop(name, input, row);
            },
          );
          // откатываем UI до подтверждения
          input.checked = true;
        } else {
          doStop(name, input, row);
        }
      }
    });

    row.appendChild(icon);
    row.appendChild(infoBlock);
    row.appendChild(toggleWrap);

    return row;
  }

  async function doStart(name, input, row) {
    busyServices.add(name);
    input.disabled = true;
    row.dataset.state = "busy";
    const toggle = row.querySelector(".proton-dashboard-apps-toggle");
    if (toggle) toggle.classList.add("is-busy");

    try {
      await callRcInit(name, "start");
      const ok = await waitForStatus(name, "running", TOGGLE_TIMEOUT_MS);
      if (ok) {
        input.checked = true;
        input.disabled = false;
        setRowStatus(row, "running");
        showToast(t("Service started"), "success");
      } else {
        input.checked = false;
        input.disabled = false;
        setRowStatus(row, "stopped");
        showToast(t("Failed to start service"), "error");
      }
    } catch (e) {
      console.warn("[Proton2025] start failed:", name, e);
      input.checked = false;
      input.disabled = false;
      setRowStatus(row, "stopped");
      showToast(t("Failed to start service"), "error");
    } finally {
      busyServices.delete(name);
      if (toggle) toggle.classList.remove("is-busy");
    }
  }

  async function doStop(name, input, row) {
    busyServices.add(name);
    input.disabled = true;
    row.dataset.state = "busy";
    const toggle = row.querySelector(".proton-dashboard-apps-toggle");
    if (toggle) toggle.classList.add("is-busy");

    try {
      await callRcInit(name, "stop");
      const ok = await waitForStatus(name, "stopped", TOGGLE_TIMEOUT_MS);
      if (ok) {
        input.checked = false;
        input.disabled = false;
        setRowStatus(row, "stopped");
        showToast(t("Service stopped"), "success");
      } else {
        input.checked = true;
        input.disabled = false;
        setRowStatus(row, "running");
        showToast(t("Failed to stop service"), "error");
      }
    } catch (e) {
      console.warn("[Proton2025] stop failed:", name, e);
      input.checked = true;
      input.disabled = false;
      setRowStatus(row, "running");
      showToast(t("Failed to stop service"), "error");
    } finally {
      busyServices.delete(name);
      if (toggle) toggle.classList.remove("is-busy");
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

  function setRowStatus(row, status) {
    row.dataset.state = status;
    const dot = row.querySelector(".proton-dashboard-apps-status-dot");
    const text = row.querySelector(".proton-dashboard-apps-status-text");
    const input = row.querySelector('input[type="checkbox"]');

    if (dot) dot.dataset.state = status;
    if (text) text.textContent = t(getStatusKey(status));
    if (input) {
      input.checked = status === "running";
      input.disabled = status === "not-installed" || status === "unknown";
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  function renderList(card, services, statuses) {
    const list = card.querySelector('[data-role="list"]');
    if (!list) return;

    list.replaceChildren();

    if (!services.length) {
      const empty = document.createElement("li");
      empty.className = "proton-dashboard-apps-empty";
      empty.textContent = t("No applications selected");
      list.appendChild(empty);
      return;
    }

    const api = getStatusFromApi();

    services.forEach((name) => {
      const info = api ? api.getServiceInfo(name) : {
        name: name,
        displayName: name,
        icon: "📦",
        category: "other",
      };
      const status = statuses[name] || "unknown";
      const row = createRow(name, info, status);
      list.appendChild(row);
    });
  }

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

  function updateFooter(card, services, statuses) {
    const left = card.querySelector('[data-role="footer-left"]');
    if (left) {
      left.textContent = `${services.length} ${t("services")}`;
    }
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

    const card = document.getElementById("proton-dashboard-apps");
    if (!card) return;

    const api = getStatusFromApi();
    if (!api) return;

    const services = readAppsList();
    const statuses = {};

    await Promise.all(
      services.map(async (name) => {
        if (busyServices.has(name)) {
          // не перезаписываем UI, пока идёт действие
          const row = card.querySelector(`[data-service="${CSS.escape(name)}"]`);
          statuses[name] = row ? row.dataset.state : "unknown";
          return;
        }
        try {
          statuses[name] = await api.checkStatus(name);
        } catch (e) {
          statuses[name] = "unknown";
        }
      }),
    );

    // Обновляем только строки, не пересоздавая DOM
    services.forEach((name) => {
      const row = card.querySelector(`[data-service="${CSS.escape(name)}"]`);
      if (!row) return;
      const status = statuses[name] || "unknown";
      if (row.dataset.state !== status && row.dataset.state !== "busy") {
        setRowStatus(row, status);
      }
    });

    updateSubtitle(card, services, statuses);
    updateFooter(card, services, statuses);
  }

  // ---------------------------------------------------------------------------
  // Settings modal: sync with services-widget OR custom selection
  // ---------------------------------------------------------------------------

  async function openSettingsModal() {
    const api = getStatusFromApi();
    if (!api) {
      showToast(t("Services API not ready"), "warning");
      return;
    }

    const available = await api.listAvailableServices();
    const current = readAppsList();

    const overlay = document.createElement("div");
    overlay.className = "proton-confirm-modal-overlay";

    const modal = document.createElement("div");
    modal.className = "proton-confirm-modal";
    modal.style.maxWidth = "560px";
    modal.style.width = "calc(100% - 40px)";

    const heading = document.createElement("h3");
    heading.textContent = t("Applications settings");

    const body = document.createElement("div");
    body.style.cssText = "margin: 14px 0 20px; max-height: 60vh; overflow-y: auto;";

    // Кнопка синхронизации
    const syncRow = document.createElement("div");
    syncRow.style.cssText = "display:flex; gap:10px; align-items:center; margin-bottom:14px; padding-bottom:14px; border-bottom:1px solid var(--proton-border);";

    const syncBtn = document.createElement("button");
    syncBtn.type = "button";
    syncBtn.className = "cbi-button cbi-button-action";
    syncBtn.textContent = t("Sync with Services Monitor");
    syncBtn.addEventListener("click", function () {
      const servicesList = readServicesList();
      showConfirmDialog(
        t("Overwrite service list?"),
        t(
          "This will replace your current selection with the list from the Services Monitor widget. Continue?",
        ),
        t("Overwrite"),
        function () {
          writeAppsList(servicesList.slice());
          close();
          renderList(document.getElementById("proton-dashboard-apps"), servicesList, {});
          pollStatuses();
          showToast(t("Services synced"), "success");
        },
      );
    });

    const syncInfo = document.createElement("span");
    syncInfo.style.cssText = "font-size:0.85rem; color:var(--proton-text-secondary);";
    syncInfo.textContent = t("Overwrite current list with Services Monitor selection.");

    syncRow.appendChild(syncBtn);
    syncRow.appendChild(syncInfo);

    // Список чекбоксов
    const listTitle = document.createElement("div");
    listTitle.style.cssText = "font-size:0.85rem; font-weight:600; color:var(--proton-text-secondary); margin-bottom:8px;";
    listTitle.textContent = t("Custom selection");

    const list = document.createElement("div");
    list.style.cssText = "display:flex; flex-direction:column; gap:4px;";

    const selected = new Set(current);

    available
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(function (entry) {
        const info = api.getServiceInfo(entry.name);
        const item = document.createElement("label");
        item.style.cssText =
          "display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid var(--proton-border); border-radius:8px; cursor:pointer;";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = selected.has(entry.name);
        cb.dataset.service = entry.name;

        const ic = document.createElement("span");
        ic.textContent = info.icon || "📦";

        const nm = document.createElement("span");
        nm.style.cssText = "flex:1; font-size:0.9rem;";
        nm.textContent = info.displayName || entry.name;

        const installed = document.createElement("span");
        installed.style.cssText = "font-size:0.75rem; color:var(--proton-muted);";
        installed.textContent = entry.fromInitd ? "" : t("Not installed");

        item.appendChild(cb);
        item.appendChild(ic);
        item.appendChild(nm);
        item.appendChild(installed);

        cb.addEventListener("change", function () {
          if (cb.checked) selected.add(entry.name);
          else selected.delete(entry.name);
        });

        list.appendChild(item);
      });

    body.appendChild(syncRow);
    body.appendChild(listTitle);
    body.appendChild(list);

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

    function close() {
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
      const newList = Array.from(selected).filter((n) => api.isValidServiceName(n));
      writeAppsList(newList);
      close();
      const card = document.getElementById("proton-dashboard-apps");
      if (card) {
        renderList(card, newList, {});
        pollStatuses();
      }
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    modal.appendChild(heading);
    modal.appendChild(body);
    modal.appendChild(actions);
    overlay.appendChild(modal);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });

    document.body.appendChild(overlay);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

    function start() {
    if (!document.getElementById("proton-services-widget")) {
      // Не ждём services-widget: он теперь нужен только как источник API,
      // а не как видимая карточка. Если он вовсе не создастся,
      // ProtonServicesApi всё равно создаст его instance через initWidget().
      // Но для надёжности подождём немного.
      if (!window.protonServicesWidget) return false;
    }

    const card = ensureCard();
    if (!card) return false;

    const services = readAppsList();
    renderList(card, services, {});
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

    if (start()) return;

    // Ждём появления services-widget (его создаёт services-widget.js)
    const container = document.getElementById("proton-widgets-container");
    if (!container) {
      // Ещё и контейнера нет — ждём body
      const bodyObserver = new MutationObserver(function () {
        if (document.getElementById("proton-widgets-container")) {
          bodyObserver.disconnect();
          init();
        }
      });
      bodyObserver.observe(document.body, { childList: true, subtree: true });
      setTimeout(function () {
        bodyObserver.disconnect();
      }, 15000);
      return;
    }

    servicesGridWrapObserver = new MutationObserver(function () {
      if (document.getElementById("proton-services-widget")) {
        servicesGridWrapObserver.disconnect();
        servicesGridWrapObserver = null;
        start();
      }
    });
    servicesGridWrapObserver.observe(container, {
      childList: true,
      subtree: true,
    });

    setTimeout(function () {
      if (servicesGridWrapObserver) {
        servicesGridWrapObserver.disconnect();
        servicesGridWrapObserver = null;
        start();
      }
    }, 8000);
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
