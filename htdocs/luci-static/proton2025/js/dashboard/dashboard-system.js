/**
 * Proton2025 Dashboard - System widget
 * Copyright 2025-2026 ChesterGoodiny
 * Licensed under the Apache License, Version 2.0
 * See LICENSE and NOTICE for details.
 *
 * KeeneticOS-style system card:
 *   - CPU load (%) with progress bar
 *   - RAM usage (%) with progress bar
 *   - Uptime, Load average, Model, OpenWrt version, Architecture
 *
 * Data sources:
 *   - luci.proton-system.getCpuUsage   → live CPU %
 *   - luci.proton-system.getSystemInfo → model, release, arch, target
 *   - system.info (ubus)               → memory, uptime, load, cores
 *   - system.board (ubus)              → model fallback
 */

(function () {
  "use strict";

  const POLL_INTERVAL = 3000;

  let callSystemInfo = null;
  let callCpuUsage = null;
  let callProtonSystemInfo = null;
  let callSystemBoard = null;

  let timer = null;
  let visibilityHandler = null;
  let mounted = false;
  let nativeHideObserver = null;
  let nativeHideInterval = null;

  function t(value) {
    if (typeof window.protonT === "function") return window.protonT(value);
    if (window.L && typeof L.tr === "function") {
      const tr = L.tr(value);
      if (tr && tr !== value) return tr;
    }
    return value;
  }

  // ---------------------------------------------------------------------------
  // RPC declarations
  // ---------------------------------------------------------------------------

  function ensureRpc() {
    if (!window.L || !L.rpc || typeof L.rpc.declare !== "function") return false;

    if (!callSystemInfo) {
      callSystemInfo = L.rpc.declare({
        object: "system",
        method: "info",
        expect: { "": {} },
      });
    }

    if (!callSystemBoard) {
      callSystemBoard = L.rpc.declare({
        object: "system",
        method: "board",
        expect: { "": {} },
      });
    }

    if (!callCpuUsage) {
      callCpuUsage = L.rpc.declare({
        object: "luci.proton-system",
        method: "getCpuUsage",
        expect: { "": {} },
      });
    }

    if (!callProtonSystemInfo) {
      callProtonSystemInfo = L.rpc.declare({
        object: "luci.proton-system",
        method: "getSystemInfo",
        expect: { "": {} },
      });
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------------

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    if (unit === 0) return `${Math.round(value)} ${units[unit]}`;
    return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
  }

  function formatUptime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "—";
    const total = Math.floor(seconds);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function formatPercent(value, digits) {
    if (!Number.isFinite(value)) return "—";
    const d = digits == null ? 0 : digits;
    return `${value.toFixed(d)}%`;
  }

  function getCpuLevel(usage) {
    if (!Number.isFinite(usage)) return "ok";
    if (usage >= 85) return "err";
    if (usage >= 60) return "warn";
    return "ok";
  }

  function getRamLevel(percent) {
    if (!Number.isFinite(percent)) return "ok";
    if (percent >= 90) return "err";
    if (percent >= 75) return "warn";
    return "ok";
  }

  function getMemory(info) {
    const memory = info && info.memory ? info.memory : {};
    const total = Number(memory.total) || 0;
    if (!total) return null;

    const availableValue = Number(memory.available);
    const free = Number(memory.free) || 0;
    const buffered = Number(memory.buffered) || 0;
    const cached = Number(memory.cached) || 0;

    let available =
      Number.isFinite(availableValue) && availableValue >= 0
        ? availableValue
        : free + buffered + cached;

    available = Math.min(Math.max(available, 0), total);
    const used = Math.max(total - available, 0);

    return {
      total,
      used,
      available,
      percent: Math.min((used / total) * 100, 100),
    };
  }

  function getLoadValues(info) {
    const load = Array.isArray(info && info.load) ? info.load : [];
    return {
      load1: Number(load[0]) / 65536,
      load5: Number(load[1]) / 65536,
      load15: Number(load[2]) / 65536,
    };
  }

  // ---------------------------------------------------------------------------
  // Native System section hider
  //
  // LuCI renders its own "System" table on Overview. We hide it and show our
  // card instead. The selector is defensive: we look for a .cbi-section that
  // contains a table whose first cell text matches known System labels.
  // ---------------------------------------------------------------------------

  const NATIVE_SECTION_LABELS = [
    "hostname",
    "model",
    "firmware version",
    "kernel version",
    "system",
    "uptime",
    "load average",
  ];

  function isNativeSystemSection(section) {
    if (!section || section.dataset.protonHiddenSystem === "1") return false;
    if (section.closest("#proton-dashboard-section")) return false;
    if (section.classList.contains("proton-hide-native-system")) return false;

    // LuCI Overview: <div class="cbi-section"><div class="cbi-title"><h3>Система<span>Скрыть</span></h3></div><table>...</table></div>
    // Важно: h3 содержит <span>Скрыть</span> — берём только текстовые узлы до span.
    const titleH3 = section.querySelector(":scope > .cbi-title > h3, :scope > h3");
    if (!titleH3) return false;

    let heading = "";
    for (const node of titleH3.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            heading += node.textContent;
        } else if (node.nodeType === Node.ELEMENT_NODE && node.tagName !== "SPAN") {
            heading += node.textContent;
        }
    }
    heading = heading.trim().toLowerCase();

    const knownHeadings = ["система", "system", "system info", "системная информация"];
    if (!knownHeadings.includes(heading)) return false;

    return !!section.querySelector("table");
}

  function hideNativeSystemSection() {
    const main = document.getElementById("maincontent") || document.body;
    const sections = main.querySelectorAll(".cbi-section");

    for (const section of sections) {
      if (isNativeSystemSection(section)) {
        section.classList.add("proton-hide-native-system");
        section.dataset.protonHiddenSystem = "1";
      }
    }
  }

  function startNativeHideObserver() {
    if (nativeHideObserver) return;

    const main = document.getElementById("maincontent") || document.body;
    if (!main) return;

    hideNativeSystemSection();

    nativeHideObserver = new MutationObserver(() => {
      hideNativeSystemSection();
    });

    nativeHideObserver.observe(main, {
      childList: true,
      subtree: true,
    });

    // Belt-and-braces: LuCI polls and re-renders; a slow interval catches
    // anything the observer misses (e.g. replaced sections without childList).
    nativeHideInterval = setInterval(hideNativeSystemSection, 2000);
  }

  function stopNativeHideObserver() {
    if (nativeHideObserver) {
      nativeHideObserver.disconnect();
      nativeHideObserver = null;
    }
    if (nativeHideInterval) {
      clearInterval(nativeHideInterval);
      nativeHideInterval = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Grid wrapper: put Internet + System side by side
  // ---------------------------------------------------------------------------

  function ensureCard() {
    let card = document.getElementById("proton-dashboard-system");
    if (card) {
      mounted = true;
      return card;
    }

    card = document.createElement("article");
    card.className = "proton-dashboard-card proton-dashboard-system";
    card.id = "proton-dashboard-system";

    card.innerHTML = `
      <div class="proton-dashboard-card-header">
        <div>
          <div class="proton-dashboard-card-title-row">
            <span class="proton-dashboard-card-status-dot" data-role="status-dot"></span>
            <h3 class="proton-dashboard-card-title">${t("System")}</h3>
          </div>
          <div class="proton-dashboard-card-subtitle" data-role="subtitle">
            ${t("Loading...")}
          </div>
        </div>
      </div>

      <div class="proton-dashboard-card-body">
        <div class="proton-dashboard-system-grid">
          <div class="proton-dashboard-metric">
            <span class="proton-dashboard-metric-label">${t("CPU load")}</span>
            <div class="proton-dashboard-metric-value-row">
              <strong class="proton-dashboard-metric-value" data-role="cpu-value" data-level="ok">—</strong>
            </div>
            <div class="proton-dashboard-metric-bar">
              <div class="proton-dashboard-metric-bar-fill" data-role="cpu-bar" data-level="ok"></div>
            </div>
            <span class="proton-dashboard-metric-detail" data-role="cpu-detail">—</span>
          </div>

          <div class="proton-dashboard-metric">
            <span class="proton-dashboard-metric-label">${t("Memory")}</span>
            <div class="proton-dashboard-metric-value-row">
              <strong class="proton-dashboard-metric-value" data-role="ram-value" data-level="ok">—</strong>
            </div>
            <div class="proton-dashboard-metric-bar">
              <div class="proton-dashboard-metric-bar-fill" data-role="ram-bar" data-level="ok"></div>
            </div>
            <span class="proton-dashboard-metric-detail" data-role="ram-detail">—</span>
          </div>
        </div>

        <div class="proton-dashboard-system-meta">
          <div class="proton-dashboard-system-meta-item">
            <strong>${t("Uptime")}:</strong>
            <span data-role="uptime">—</span>
          </div>
          <div class="proton-dashboard-system-meta-item">
            <strong>${t("Load")}:</strong>
            <span data-role="load">—</span>
          </div>
          <div class="proton-dashboard-system-meta-item" data-role="meta-model">
            <strong>${t("Model")}:</strong>
            <span data-role="model">—</span>
          </div>
          <div class="proton-dashboard-system-meta-item" data-role="meta-release">
            <strong>${t("OpenWrt")}:</strong>
            <span data-role="release">—</span>
          </div>
        </div>
      </div>

      <div class="proton-dashboard-card-footer">
        <span data-role="arch">—</span>
        <span data-role="target">—</span>
      </div>
    `;

    // Кладём прямо в #maincontent — orchestrator (dashboard-layout.js)
    // сам подхватит и переместит в нужную ячейку.
    const maincontent = document.getElementById("maincontent");
    if (!maincontent) return null;
    maincontent.appendChild(card);

    mounted = true;
    return card;
}

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function setStatusDot(card, state) {
    const dot = card.querySelector('[data-role="status-dot"]');
    if (dot) dot.dataset.state = state;
  }

  function renderSubtitle(card, model, release, description) {
    const el = card.querySelector('[data-role="subtitle"]');
    if (!el) return;

    const parts = [];
    if (model) parts.push(model);
    if (description && description !== model) {
      parts.push(description);
    } else if (release) {
      parts.push(`OpenWrt ${release}`);
    }

    el.textContent = parts.length ? parts.join(" · ") : t("System information");
  }

  function renderCpu(card, cpu) {
    const valueEl = card.querySelector('[data-role="cpu-value"]');
    const barEl = card.querySelector('[data-role="cpu-bar"]');
    const detailEl = card.querySelector('[data-role="cpu-detail"]');

    const usage = cpu && Number.isFinite(cpu.usage) ? cpu.usage : null;
    const cores = cpu && Number.isFinite(cpu.cores) ? cpu.cores : null;

    if (usage == null) {
      valueEl.textContent = "—";
      valueEl.dataset.level = "ok";
      barEl.style.width = "0%";
      barEl.dataset.level = "ok";
      detailEl.textContent = cores ? `${cores} ${t("cores")}` : "—";
      return;
    }

    const level = getCpuLevel(usage);
    valueEl.textContent = formatPercent(usage, 1);
    valueEl.dataset.level = level;
    barEl.style.width = `${Math.min(Math.max(usage, 0), 100)}%`;
    barEl.dataset.level = level;
    detailEl.textContent = cores ? `${cores} ${t("cores")}` : "—";
  }

  function renderMemory(card, memory) {
    const valueEl = card.querySelector('[data-role="ram-value"]');
    const barEl = card.querySelector('[data-role="ram-bar"]');
    const detailEl = card.querySelector('[data-role="ram-detail"]');

    if (!memory) {
      valueEl.textContent = "—";
      valueEl.dataset.level = "ok";
      barEl.style.width = "0%";
      barEl.dataset.level = "ok";
      detailEl.textContent = "—";
      return;
    }

    const level = getRamLevel(memory.percent);
    valueEl.textContent = formatPercent(memory.percent, 0);
    valueEl.dataset.level = level;
    barEl.style.width = `${memory.percent}%`;
    barEl.dataset.level = level;
    detailEl.textContent = `${formatBytes(memory.used)} / ${formatBytes(memory.total)}`;
  }

  function renderUptime(card, info) {
    const el = card.querySelector('[data-role="uptime"]');
    if (el) el.textContent = formatUptime(Number(info && info.uptime));
  }

  function renderLoad(card, info) {
    const el = card.querySelector('[data-role="load"]');
    if (!el) return;
    const { load1, load5, load15 } = getLoadValues(info);
    const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2) : "—");
    el.textContent = `${fmt(load1)} ${fmt(load5)} ${fmt(load15)}`;
  }

  function renderSystemMeta(card, sysinfo, board) {
    const model = (sysinfo && sysinfo.model) || (board && board.model) || (board && board.board_name) || "";
    const release = (sysinfo && sysinfo.release) || (board && board.release && board.release.version) || "";
    const description = (sysinfo && sysinfo.description) || (board && board.release && board.release.description) || "";
    const arch = (sysinfo && sysinfo.package_arch) || "";
    const target = (sysinfo && sysinfo.target) || "";

    renderSubtitle(card, model, release, description);

    const modelEl = card.querySelector('[data-role="model"]');
    if (modelEl) modelEl.textContent = model || "—";

    const releaseEl = card.querySelector('[data-role="release"]');
    if (releaseEl) {
      if (release && description) {
        releaseEl.textContent = `${release} · ${description}`;
        releaseEl.title = description;
      } else {
        releaseEl.textContent = release || description || "—";
      }
    }

    const archEl = card.querySelector('[data-role="arch"]');
    if (archEl) {
      archEl.textContent = arch || "—";
      archEl.title = arch || "";
    }

    const targetEl = card.querySelector('[data-role="target"]');
    if (targetEl) {
      targetEl.textContent = target || "—";
      targetEl.title = target || "";
    }
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  async function poll() {
    if (!mounted || document.hidden) return;
    if (!ensureRpc()) return;

    const card = document.getElementById("proton-dashboard-system");
    if (!card) return;

    try {
      const [info, cpu, sysinfo, board] = await Promise.all([
        L.resolveDefault(callSystemInfo(), null),
        L.resolveDefault(callCpuUsage(), null),
        L.resolveDefault(callProtonSystemInfo(), null),
        L.resolveDefault(callSystemBoard(), null),
      ]);

      const memory = getMemory(info);

      renderCpu(card, cpu);
      renderMemory(card, memory);
      renderUptime(card, info);
      renderLoad(card, info);
      renderSystemMeta(card, sysinfo, board);

      setStatusDot(card, "ok");
    } catch (error) {
      console.warn("[Proton2025] System widget poll failed:", error);
      setStatusDot(card, "err");
      const subtitle = card.querySelector('[data-role="subtitle"]');
      if (subtitle) subtitle.textContent = t("Unable to read system information");
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function start() {
    const card = ensureCard();
    if (!card) return;

    startNativeHideObserver();

    if (timer) return;

    poll();
    timer = setInterval(poll, POLL_INTERVAL);

    visibilityHandler = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener("visibilitychange", visibilityHandler);
  }

  function stop() {
    mounted = false;

    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    if (visibilityHandler) {
      document.removeEventListener("visibilitychange", visibilityHandler);
      visibilityHandler = null;
    }

    stopNativeHideObserver();
  }

  function isOverviewPage() {
    return (
      document.body.dataset.page === "admin-status-overview" ||
      window.location.pathname.includes("/admin/status/overview")
    );
  }

  function init() {
    if (!isOverviewPage()) return;

    // dashboard.js (Internet widget) creates #proton-dashboard-section
    // asynchronously. Wait for it, then build our card + grid.
    const section = document.getElementById("proton-dashboard-section");
    if (section) {
      start();
      return;
    }

    const maincontent = document.getElementById("maincontent");
    if (!maincontent) return;

    let observer = null;
    let giveUpTimer = null;

    const tryInit = () => {
      if (document.getElementById("proton-dashboard-section")) {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        if (giveUpTimer) {
          clearTimeout(giveUpTimer);
          giveUpTimer = null;
        }
        start();
        return true;
      }
      return false;
    };

    if (tryInit()) return;

    observer = new MutationObserver(() => {
      tryInit();
    });
    observer.observe(maincontent, { childList: true, subtree: true });

    giveUpTimer = setTimeout(() => {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      // Last attempt: build our own section if Internet widget never appeared
      const grid = ensureGridWrapper();
      if (grid) start();
    }, 10000);
  }

  window.ProtonDashboardSystem = {
    start,
    stop,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
