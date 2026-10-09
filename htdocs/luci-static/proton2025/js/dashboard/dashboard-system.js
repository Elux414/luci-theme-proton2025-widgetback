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
  let callProcessCount = null;
  let callTopProcesses = null;
  let callNetworkStats = null;

  // История количества процессов для sparkline.
  // 30 точек × 3 сек = 90 секунд «живого» окна.
  const PROCESS_HISTORY_SIZE = 30;
  let processHistory = [];
  let prevCpuSnapshot = null; // { pids: { pid: ticks } } для расчёта ΔCPU
  let processStats = {
	running: null,
	total: null,
	topByCpu: [],
	topByRam: [],
	error: false,
};

// --- Сетевые интерфейсы ---
// Храним предыдущие счётчики байт, чтобы считать rate (bytes/sec).
// Структура: { <ifaceName>: { rx: <bytes>, tx: <bytes>, ts: <ms> } }
  const NETWORK_HISTORY_SIZE = 30;
  const NETWORK_MAX_DEFAULT = 6; // авто-режим: топ-6 активных
  let networkHistory = {};       // { <ifaceName>: { rx: [..], tx: [..] } }
  let prevNetworkCounters = {};
  let userSelectedInterfaces = null; // null = авто-режим, массив = ручной
  let interfaceAliases = {};         // { <ifaceName>: "Custom name" }
  
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

    if (!callProcessCount) {
      callProcessCount = L.rpc.declare({
        object: "luci.proton-system",
        method: "getProcessCount",
        expect: { "": {} },
      });
    }

        if (!callTopProcesses) {
      callTopProcesses = L.rpc.declare({
        object: "luci.proton-system",
        method: "getTopProcesses",
        params: ["kind", "limit"],
        expect: { "": {} },
      });
    }

    if (!callNetworkStats) {
      callNetworkStats = L.rpc.declare({
        object: "luci.proton-system",
        method: "getNetworkStats",
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
  
  function formatLocalTime(localtime, ianaTimezone) {
    if (!Number.isFinite(localtime) || localtime <= 0) return "—";

    // system.info.localtime в OpenWrt — это epoch, закодированный из
    // ЛОКАЛЬНОГО времени роутера (wall clock), а не из UTC.
    // Поэтому читаем через getUTC* и получаем точное локальное время.
    const d = new Date(localtime * 1000);

    const pad = (n) => String(n).padStart(2, "0");

    const day = pad(d.getUTCDate());
    const month = pad(d.getUTCMonth() + 1);
    const year = d.getUTCFullYear();
    const hours = pad(d.getUTCHours());
    const minutes = pad(d.getUTCMinutes());
    const seconds = pad(d.getUTCSeconds());

    const dateStr = `${day}.${month}.${year}`;
    const timeStr = `${hours}:${minutes}:${seconds}`;

    // TZ-label через IANA (если есть)
    let tzLabel = "";
    if (ianaTimezone) {
      try {
        const fmt = new Intl.DateTimeFormat("en-US", {
          timeZone: ianaTimezone,
          timeZoneName: "shortOffset",
        });
        const parts = fmt.formatToParts(new Date());
        const tzPart = parts.find((p) => p.type === "timeZoneName");
        if (tzPart) tzLabel = " " + tzPart.value;
      } catch (e) {}
    }

    return `${dateStr}, ${timeStr}${tzLabel}`;
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

        <!-- Процессы: крупная цифра + sparkline + топ-3 -->
        <div class="proton-dashboard-processes">
          <div class="proton-dashboard-processes-head">
            <span class="proton-dashboard-metric-label">${t("Processes")}</span>
            <span class="proton-dashboard-processes-spark" data-role="processes-spark"></span>
          </div>
          <div class="proton-dashboard-processes-body">
            <div class="proton-dashboard-processes-value-row">
              <strong class="proton-dashboard-processes-value" data-role="processes-total">—</strong>
              <span class="proton-dashboard-processes-running" data-role="processes-running">—</span>
            </div>
            <div class="proton-dashboard-processes-tops">
              <div class="proton-dashboard-processes-top">
                <span class="proton-dashboard-processes-top-label">${t("Top CPU")}</span>
                <ol data-role="top-cpu" class="proton-dashboard-processes-list"></ol>
              </div>
              <div class="proton-dashboard-processes-top">
                <span class="proton-dashboard-processes-top-label">${t("Top RAM")}</span>
                <ol data-role="top-ram" class="proton-dashboard-processes-list"></ol>
              </div>
            </div>
          </div>
        </div>

        <!-- Сетевые интерфейсы: компактный список с rx/tx rate -->
        <div class="proton-dashboard-network">
          <div class="proton-dashboard-network-head">
            <span class="proton-dashboard-metric-label">${t("Interfaces")}</span>
            <button type="button" class="proton-dashboard-network-settings" data-role="network-settings" title="${t("Configure interfaces")}" aria-label="${t("Configure interfaces")}">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </button>
          </div>
          <div class="proton-dashboard-network-list" data-role="network-list">
            <div class="proton-dashboard-network-empty">${t("Loading...")}</div>
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
          <div class="proton-dashboard-system-meta-item" data-role="meta-localtime">
            <strong>${t("Local Time")}:</strong>
            <span data-role="localtime">—</span>
          </div>
          <div class="proton-dashboard-system-meta-item" data-role="meta-arch">
            <strong>${t("Architecture")}:</strong>
            <span class="proton-package-arch" data-role="arch-badge">—</span>
          </div>
        </div>
      </div>

      <div class="proton-dashboard-card-footer">
        <span data-role="target">—</span>
        <span data-role="kernel">—</span>
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

  function formatKernelTime() { return ""; }  // placeholder
  
  // ---------------------------------------------------------------------------
// Процессы: sparkline + топ-3
// ---------------------------------------------------------------------------

function renderProcesses(card, counts) {
  const totalEl = card.querySelector('[data-role="processes-total"]');
  const runningEl = card.querySelector('[data-role="processes-running"]');
  const sparkEl = card.querySelector('[data-role="processes-spark"]');

  if (totalEl) {
    totalEl.textContent = counts.total != null ? String(counts.total) : "—";
  }

  if (runningEl) {
    if (counts.running != null) {
      runningEl.textContent = `${counts.running} ${t("running")}`;
    } else {
      runningEl.textContent = "—";
    }
  }

  // История
  if (counts.total != null) {
    processHistory.push(counts.total);
    while (processHistory.length > PROCESS_HISTORY_SIZE) {
      processHistory.shift();
    }
  }

  if (sparkEl) {
    sparkEl.innerHTML = buildProcessSparkline(processHistory);
  }
}

function buildProcessSparkline(values) {
  const width = 90;
  const height = 24;
  const padding = 1;

  if (values.length < 2) {
    return `<svg class="proton-dashboard-processes-spark-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"></svg>`;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  // Всегда хотя бы 10, чтобы не было «плоской линии» при 5 процессах
  const range = Math.max(max - min, 10);
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const step = innerW / (values.length - 1);

  const path = values
    .map((v, i) => {
      const x = padding + i * step;
      const y = padding + innerH - ((v - min) / range) * innerH;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return `
    <svg class="proton-dashboard-processes-spark-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <path class="proton-dashboard-processes-spark-line" d="${path}" />
    </svg>
  `;
}

function formatCpuTicks(ticks, elapsedSeconds, cores) {
  // ticks — разница utime+stime между двумя опросами.
  // HZ в OpenWrt обычно 100. Процент = ticks / (HZ * elapsed) * 100.
  const HZ = 100;
  if (!elapsedSeconds || elapsedSeconds <= 0 || !cores) return 0;
  const pct = (ticks / (HZ * elapsedSeconds)) * 100 / cores;
  return Math.max(0, Math.min(pct, 100));
}

function renderTopProcesses(card, topByCpu, topByRam) {
  const cpuEl = card.querySelector('[data-role="top-cpu"]');
  const ramEl = card.querySelector('[data-role="top-ram"]');

  const renderList = (el, items, isRam) => {
    if (!el) return;
    el.replaceChildren();
    if (!items || !items.length) {
      const li = document.createElement("li");
      li.className = "proton-dashboard-processes-empty";
      li.textContent = t("no data");
      el.appendChild(li);
      return;
    }
    items.forEach((p) => {
      const li = document.createElement("li");
      li.className = "proton-dashboard-processes-item";
      const name = document.createElement("span");
      name.className = "proton-dashboard-processes-name";
      name.textContent = p.name || "?";
      name.title = `${p.name} (PID ${p.pid})`;
      const val = document.createElement("span");
      val.className = "proton-dashboard-processes-val";
      if (isRam) {
        val.textContent = formatBytes(p.rss_bytes || 0);
      } else {
        val.textContent = `${(p.cpu_pct || 0).toFixed(1)}%`;
      }
      li.appendChild(name);
      li.appendChild(val);
      el.appendChild(li);
    });
  };

  renderList(cpuEl, topByCpu, false);
  renderList(ramEl, topByRam, true);
}

function computeProcessDeltas(topCpu, info) {
  // topCpu — массив процессов с полем cpu_ticks (накопленный)
  // Считаем ΔCPU на основе prevCpuSnapshot.
  const now = Date.now();
  const cores = (info && Number(info.cores)) || 1;
  const elapsedSec = prevCpuSnapshot ? (now - prevCpuSnapshot.ts) / 1000 : 0;
  const result = [];

  const map = prevCpuSnapshot && prevCpuSnapshot.pids
    ? prevCpuSnapshot.pids
    : {};

  topCpu.forEach((p) => {
    const prev = map[p.pid];
    const delta = prev != null ? Math.max(p.cpu_ticks - prev, 0) : 0;
    const pct = formatCpuTicks(delta, elapsedSec, cores);
    result.push({
      pid: p.pid,
      name: p.name,
      cpu_ticks: p.cpu_ticks,
      cpu_pct: pct,
      rss_bytes: p.rss_bytes || 0,
    });
  });

  // Обновляем снапшот
  const nextPids = {};
  topCpu.forEach((p) => {
    nextPids[p.pid] = p.cpu_ticks;
  });
  // Дополнительно — все процессы из топа RAM, чтобы их CPU тоже отслеживался
  prevCpuSnapshot = { ts: now, pids: nextPids };

  // Сортируем по факту по pct (обычно topProcesses вернул по ticks, но после
  // дельты порядок может измениться)
  return result.sort((a, b) => b.cpu_pct - a.cpu_pct);
}

// ---------------------------------------------------------------------------
// Сетевые интерфейсы
// ---------------------------------------------------------------------------

// Форматирование скорости (bytes/sec → "1.2 Mbps", "24.5 Kbps", "500 B/s")
function formatRate(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec < 0) return "0 B/s";
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} MB/s`;
}

// Пересчёт rate (bytes/sec) на основе разницы счётчиков между опросами
function computeNetworkRates(interfaces) {
  const now = Date.now();
  const result = [];

  interfaces.forEach((iface) => {
    const name = iface.name;
    const prev = prevNetworkCounters[name];
    let rxRate = 0;
    let txRate = 0;

    if (prev) {
      const dt = (now - prev.ts) / 1000;
      if (dt > 0) {
        const drx = iface.rx_bytes - prev.rx;
        const dtx = iface.tx_bytes - prev.tx;
        rxRate = drx >= 0 ? drx / dt : 0;
        txRate = dtx >= 0 ? dtx / dt : 0;
      }
    }

    prevNetworkCounters[name] = {
      rx: iface.rx_bytes,
      tx: iface.tx_bytes,
      ts: now,
    };

    // История для sparkline
    let hist = networkHistory[name];
    if (!hist) {
      hist = { rx: [], tx: [] };
      networkHistory[name] = hist;
    }
    hist.rx.push(rxRate);
    hist.tx.push(txRate);
    while (hist.rx.length > NETWORK_HISTORY_SIZE) hist.rx.shift();
    while (hist.tx.length > NETWORK_HISTORY_SIZE) hist.tx.shift();

    result.push({
      ...iface,
      rx_rate: rxRate,
      tx_rate: txRate,
    });
  });

  return result;
}

// Авто-режим: сортируем активные (up) интерфейсы по суммарной активности,
// берём топ-N.
function selectAutoInterfaces(rates) {
  const active = rates
    .filter((i) => i.up)
    .sort((a, b) => (b.rx_rate + b.tx_rate) - (a.rx_rate + a.tx_rate));
  return active.slice(0, NETWORK_MAX_DEFAULT);
}

// Ручной режим: берём ровно выбранные пользователем, сохраняя порядок.
function selectManualInterfaces(rates, selected) {
  const byName = {};
  rates.forEach((i) => { byName[i.name] = i; });
  return selected
    .map((name) => byName[name])
    .filter(Boolean);
}

// Основной рендер списка интерфейсов
function renderNetworkInterfaces(card, rates) {
  const listEl = card.querySelector('[data-role="network-list"]');
  if (!listEl) return;

  // Выбор: ручной или авто
  let shown;
  if (userSelectedInterfaces && userSelectedInterfaces.length) {
    shown = selectManualInterfaces(rates, userSelectedInterfaces);
  } else {
    shown = selectAutoInterfaces(rates);
  }

  // Если ничего не выбрано/активно — заглушка
  if (!shown.length) {
    listEl.innerHTML = `<div class="proton-dashboard-network-empty">${t("No active interfaces")}</div>`;
    return;
  }

  // Очищаем и заполняем
  listEl.replaceChildren();

  shown.forEach((iface) => {
    const row = document.createElement("div");
    row.className = "proton-dashboard-network-row";
    if (!iface.up) row.classList.add("is-down");
    row.dataset.name = iface.name;

    // Иконка по типу/имени
    const icon = document.createElement("span");
    icon.className = "proton-dashboard-network-icon";
    icon.textContent = getInterfaceIcon(iface);

    // Имя
    const nameEl = document.createElement("span");
    nameEl.className = "proton-dashboard-network-name";
    const alias = interfaceAliases[iface.name];
    nameEl.textContent = alias || iface.display_name || iface.name;
    nameEl.title = iface.name;

    // Sparkline (заглушка-плейсхолдер, наполним в 2.2)
    const spark = document.createElement("span");
    spark.className = "proton-dashboard-network-spark";
    spark.dataset.iface = iface.name;
    spark.innerHTML = buildNetworkSparkline(networkHistory[iface.name]);

    // Скорости
    const rates_el = document.createElement("span");
    rates_el.className = "proton-dashboard-network-rates";
    rates_el.innerHTML =
      `<span class="rx">▼ ${formatRate(iface.rx_rate)}</span>` +
      `<span class="tx">▲ ${formatRate(iface.tx_rate)}</span>`;

    row.appendChild(icon);
    row.appendChild(nameEl);
    row.appendChild(spark);
    row.appendChild(rates_el);

    listEl.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Чтение/запись состояния интерфейсов (localStorage)
// ---------------------------------------------------------------------------
//
// Ключи:
//   proton-network-selected  — JSON-массив имён выбранных интерфейсов
//   proton-network-aliases   — JSON-объект { ifaceName: "Custom name" }
//
// Хранение в UCI — в 2.3.4.

function readSelectedInterfacesFromStorage() {
  try {
    const raw = localStorage.getItem("proton-network-selected");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : null;
  } catch (e) {
    return null;
  }
}

function readAliasesFromStorage() {
  try {
    const raw = localStorage.getItem("proton-network-aliases");
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const result = {};
    Object.keys(parsed).forEach((k) => {
      if (typeof parsed[k] === "string" && parsed[k].trim()) {
        result[k] = parsed[k].trim();
      }
    });
    return result;
  } catch (e) {
    return {};
  }
}

function saveNetworkModalState() {
  if (!_networkModalState) return;

  // Selected
  const selectedArr = Array.from(_networkModalState.selected);
  const selectedJson = JSON.stringify(selectedArr);
  localStorage.setItem("proton-network-selected", selectedJson);
  userSelectedInterfaces = selectedArr.length === 0 ? null : selectedArr;

  // Aliases
  const aliases = _networkModalState.aliases || {};
  const aliasesJson = JSON.stringify(aliases);
  localStorage.setItem("proton-network-aliases", aliasesJson);
  interfaceAliases = aliases;

  // === Прямое сохранение в UCI ===
  // Не полагаемся на перехват localStorage.setItem — он сбрасывается
  // LuCI-core'ом и работает нестабильно.
  if (
    window.protonSettingsSync &&
    typeof window.protonSettingsSync.saveLocalKeysToUci === "function"
  ) {
    window.protonSettingsSync
      .saveLocalKeysToUci({
        "proton-network-selected": selectedJson,
        "proton-network-aliases": aliasesJson,
      })
      .then((ok) => {
        if (ok) {
          console.log("[Proton2025] Network settings saved to UCI");
        } else {
          console.warn("[Proton2025] Failed to save network settings to UCI");
        }
      });
  }
}

// ---------------------------------------------------------------------------
// Модальное окно настройки интерфейсов
// ---------------------------------------------------------------------------

// Временное состояние в модалке. Сбрасывается при закрытии.
let _networkModalState = null;

async function openNetworkSettingsModal() {
  // Убираем старую модалку, если есть
  const existing = document.getElementById("proton-network-modal-overlay");
  if (existing) existing.remove();

  // Загружаем актуальные интерфейсы
  const networkRaw = await L.resolveDefault(callNetworkStats(), null);
  const allInterfaces = (networkRaw && Array.isArray(networkRaw.interfaces))
    ? networkRaw.interfaces
    : [];

  // Загружаем текущее состояние из localStorage
  const savedSelected = readSelectedInterfacesFromStorage();
  const savedAliases = readAliasesFromStorage();
  const isAutoMode = !savedSelected || savedSelected.length === 0;

  // Инициализируем временное состояние модалки
  _networkModalState = {
    interfaces: allInterfaces,
    selected: new Set(isAutoMode ? [] : savedSelected),
    aliases: { ...savedAliases },
    autoMode: isAutoMode,
  };

  // === Overlay ===
  const overlay = document.createElement("div");
  overlay.className = "proton-confirm-modal-overlay";
  overlay.id = "proton-network-modal-overlay";

  // === Modal ===
  const modal = document.createElement("div");
  modal.className = "proton-confirm-modal proton-network-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "proton-network-modal-title");

  modal.innerHTML = `
    <h3 id="proton-network-modal-title">${t("Configure interfaces")}</h3>

    <div class="proton-network-modal-body">
      <label class="proton-network-modal-auto">
        <input type="checkbox" id="proton-network-auto-mode" ${isAutoMode ? "checked" : ""}>
        <span class="proton-network-modal-auto-slider"></span>
        <span class="proton-network-modal-auto-text">
          <strong>${t("Auto mode")}:</strong> ${t("show top active interfaces")}
        </span>
      </label>

      <div class="proton-network-modal-lists" id="proton-network-modal-lists">
        <div class="proton-network-modal-list-col">
          <div class="proton-network-modal-list-header">${t("Available")}</div>
          <ul class="proton-network-modal-list" id="proton-network-available" data-dropzone="available">
            <li class="proton-network-modal-loading">${t("Loading...")}</li>
          </ul>
        </div>
        <div class="proton-network-modal-list-col">
          <div class="proton-network-modal-list-header">${t("Selected")}</div>
          <ul class="proton-network-modal-list" id="proton-network-selected" data-dropzone="selected">
            <li class="proton-network-modal-empty">${t("Drop interfaces here")}</li>
          </ul>
        </div>
      </div>
    </div>

    <div class="proton-confirm-modal-actions">
      <button type="button" class="cbi-button cbi-button-neutral" data-action="cancel">
        ${t("Cancel")}
      </button>
      <button type="button" class="cbi-button cbi-button-positive" data-action="save">
        ${t("Save")}
      </button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  requestAnimationFrame(() => {
    overlay.classList.add("is-open");
  });

  // === Закрытие ===
  const closeModal = () => {
    overlay.classList.remove("is-open");
    document.removeEventListener("keydown", onEscape, true);
    setTimeout(() => {
      overlay.remove();
      _networkModalState = null;
    }, 220);
  };

  const onEscape = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeModal();
    }
  };
  document.addEventListener("keydown", onEscape, true);

  // === Кнопки ===
  modal.querySelector('[data-action="cancel"]').addEventListener("click", closeModal);
  modal.querySelector('[data-action="save"]').addEventListener("click", () => {
    saveNetworkModalState();
    closeModal();
    // После закрытия — обновить карточку
    const card = document.getElementById("proton-dashboard-system");
    if (card) {
      // Сбросим кэш предыдущих счётчиков, чтобы rate пересчитался корректно
      prevNetworkCounters = {};
      networkHistory = {};
      // Пинаем poll немедленно
      poll();
    }
  });

  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) closeModal();
  });

  // === Обработчик Auto mode ===
  const autoToggle = modal.querySelector("#proton-network-auto-mode");
  const listsWrap = modal.querySelector("#proton-network-modal-lists");
  const updateAutoMode = () => {
    _networkModalState.autoMode = autoToggle.checked;
    listsWrap.classList.toggle("is-disabled", _networkModalState.autoMode);
    listsWrap.style.opacity = _networkModalState.autoMode ? "0.5" : "1";
    listsWrap.style.pointerEvents = _networkModalState.autoMode ? "none" : "";
  };
  autoToggle.addEventListener("change", updateAutoMode);
  updateAutoMode();

  // === Заполняем списки ===
  renderNetworkModalLists(modal);
}

// ---------------------------------------------------------------------------
// Рендер списков в модалке
// ---------------------------------------------------------------------------

function renderNetworkModalLists(modal) {
  if (!_networkModalState) return;

  const availableEl = modal.querySelector("#proton-network-available");
  const selectedEl = modal.querySelector("#proton-network-selected");
  if (!availableEl || !selectedEl) return;

  const { interfaces, selected, aliases } = _networkModalState;

  // Разделяем
  const selectedList = interfaces.filter((i) => selected.has(i.name));
  const availableList = interfaces.filter((i) => !selected.has(i.name));

  // Сохраняем порядок selected — как в Set
  const selectedOrder = Array.from(selected);
  selectedList.sort((a, b) => selectedOrder.indexOf(a.name) - selectedOrder.indexOf(b.name));

  // Available — по имени
  availableList.sort((a, b) => a.name.localeCompare(b.name));

  availableEl.replaceChildren();
  selectedEl.replaceChildren();

  // Заполняем Available
  if (!availableList.length) {
    const empty = document.createElement("li");
    empty.className = "proton-network-modal-empty";
    empty.textContent = t("All interfaces are selected");
    availableEl.appendChild(empty);
  } else {
    availableList.forEach((iface) => {
      availableEl.appendChild(createNetworkModalItem(iface, "available", modal));
    });
  }

  // Заполняем Selected
  if (!selectedList.length) {
    const empty = document.createElement("li");
    empty.className = "proton-network-modal-empty";
    empty.textContent = t("Drop interfaces here");
    selectedEl.appendChild(empty);
  } else {
    selectedList.forEach((iface) => {
      selectedEl.appendChild(createNetworkModalItem(iface, "selected", modal));
    });
  }

  // --- Подключаем drag-n-drop обработчики на оба списка (idempotent) ---
  setupNetworkModalDropZone(availableEl, "available", modal);
  setupNetworkModalDropZone(selectedEl, "selected", modal);
}

// ---------------------------------------------------------------------------
// Drag-n-drop для модалки интерфейсов
// ---------------------------------------------------------------------------

let _draggedItemData = null;

function setupNetworkModalDropZone(listEl, side, modal) {
  // Чтобы не дублировать обработчики
  if (listEl.dataset.dndSetup === "1") return;
  listEl.dataset.dndSetup = "1";

  listEl.addEventListener("dragover", (ev) => {
    // Разрешаем drop только если тащим элемент интерфейса
    if (!_draggedItemData) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";

    listEl.classList.add("is-dragover");

    // Визуальная подсказка, куда встанет элемент
    updateDropIndicator(listEl, ev.clientY);
  });

  listEl.addEventListener("dragleave", (ev) => {
    // Игнорируем dragleave при переходе между детьми списка
    if (ev.relatedTarget && listEl.contains(ev.relatedTarget)) return;
    listEl.classList.remove("is-dragover");
    clearDropIndicators(listEl);
  });

  listEl.addEventListener("drop", (ev) => {
    ev.preventDefault();
    listEl.classList.remove("is-dragover");

    if (!_draggedItemData) return;

    const draggedName = _draggedItemData.name;
    const sourceSide = _draggedItemData.side;

    // Находим, куда пользователь бросил — перед каким элементом
    const targetItem = getDropTargetItem(listEl, ev.clientY);

    // === Логика перемещения ===
    if (side === "selected") {
      // Двигаем в Selected
      _networkModalState.selected.add(draggedName);

      // Если перемещаем из Available в Selected — опционально сохраняем alias
      // (alias уже в _networkModalState.aliases, ничего не делаем)

      // Переставляем порядок в Set: удаляем и добавляем в нужное место
      const arr = Array.from(_networkModalState.selected);
      const idx = arr.indexOf(draggedName);
      if (idx !== -1) arr.splice(idx, 1);

      if (targetItem) {
        // Вставляем перед targetItem
        const insertBefore = arr.indexOf(targetItem.dataset.name);
        if (insertBefore !== -1) {
          arr.splice(insertBefore, 0, draggedName);
        } else {
          arr.push(draggedName);
        }
      } else {
        // Вставляем в конец
        arr.push(draggedName);
      }

      _networkModalState.selected = new Set(arr);
    } else {
      // Двигаем в Available
      _networkModalState.selected.delete(draggedName);

      // Если перетаскиваем из Selected → Available, удаляем alias
      // (не храним лишние данные для неотслеживаемых интерфейсов)
      if (sourceSide === "selected") {
        delete _networkModalState.aliases[draggedName];
      }
    }

    _draggedItemData = null;
    clearDropIndicators(listEl);
    renderNetworkModalLists(modal);
  });

  listEl.addEventListener("dragend", () => {
    listEl.classList.remove("is-dragover");
    clearDropIndicators(listEl);
    _draggedItemData = null;
  });
}

// Возвращает элемент, ПЕРЕД которым должен встать перетаскиваемый
function getDropTargetItem(listEl, clientY) {
  const items = Array.from(listEl.querySelectorAll(".proton-network-modal-item:not(.is-dragging)"));
  if (!items.length) return null;

  for (const item of items) {
    const rect = item.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (clientY < mid) return item;
  }
  return null;
}

// Визуальная подсказка: тонкая линия над/под элементом, куда встанет drop
function updateDropIndicator(listEl, clientY) {
  // Удаляем старый индикатор
  clearDropIndicators(listEl);

  const target = getDropTargetItem(listEl, clientY);
  if (target) {
    target.classList.add("drop-target-before");
  } else {
    // В конец
    const items = listEl.querySelectorAll(".proton-network-modal-item");
    if (items.length) {
      items[items.length - 1].classList.add("drop-target-after");
    }
  }
}

function clearDropIndicators(listEl) {
  listEl.querySelectorAll(".drop-target-before, .drop-target-after").forEach((el) => {
    el.classList.remove("drop-target-before", "drop-target-after");
  });
}

// Создание одного элемента списка в модалке
function createNetworkModalItem(iface, side, modal) {
  const li = document.createElement("li");
  li.className = "proton-network-modal-item";
  li.dataset.name = iface.name;
  li.dataset.side = side;
  li.setAttribute("draggable", "true"); // пока просто атрибут, обработчики в 2.3.3

  // Иконка
  const icon = document.createElement("span");
  icon.className = "proton-network-modal-item-icon";
  icon.textContent = getInterfaceIcon(iface);

  // Статус-точка
  const dot = document.createElement("span");
  dot.className = "proton-network-modal-item-status " + (iface.up ? "is-up" : "is-down");
  dot.title = iface.up ? t("Up") : t("Down");

  // Текст: alias-input + тех-имя
  const text = document.createElement("div");
  text.className = "proton-network-modal-item-text";

  const aliasInput = document.createElement("input");
  aliasInput.type = "text";
  aliasInput.className = "proton-network-modal-item-alias-input";
  aliasInput.placeholder = iface.display_name || iface.name;
  aliasInput.value = _networkModalState.aliases[iface.name] || "";
  aliasInput.maxLength = 40;
  aliasInput.title = t("Rename") + ": " + (iface.display_name || iface.name);
  aliasInput.addEventListener("input", () => {
    const v = aliasInput.value.trim();
    if (v) {
      _networkModalState.aliases[iface.name] = v;
    } else {
      delete _networkModalState.aliases[iface.name];
    }
  });
  // Не даём клику на input двигать элемент
  aliasInput.addEventListener("click", (ev) => ev.stopPropagation());
  aliasInput.addEventListener("mousedown", (ev) => ev.stopPropagation());

  const sub = document.createElement("span");
  sub.className = "proton-network-modal-item-sub";
  sub.textContent = iface.name;

  text.appendChild(aliasInput);
  text.appendChild(sub);

  li.appendChild(icon);
  li.appendChild(text);
  li.appendChild(dot);

    // === Drag-n-drop ===
  li.addEventListener("dragstart", (ev) => {
    // Не даём тащить, если взаимодействуем с input
    if (ev.target === aliasInput) {
      ev.preventDefault();
      return;
    }

    _draggedItemData = { name: iface.name, side: side };
    li.classList.add("is-dragging");

    // Обязательно для Firefox
    try {
      ev.dataTransfer.setData("text/plain", iface.name);
      ev.dataTransfer.effectAllowed = "move";
    } catch (e) {}

    // Прозрачный drag image не обязателен, оставляем дефолт
  });

  li.addEventListener("dragend", () => {
    li.classList.remove("is-dragging");
    _draggedItemData = null;
    // Снимаем подсветку со всех списков
    modal.querySelectorAll(".proton-network-modal-list").forEach((l) => {
      l.classList.remove("is-dragover");
      clearDropIndicators(l);
    });
  });

  // === Клик — по-прежнему работает как быстрый способ перемещения ===
  // (для тех, кто не хочет тащить мышью)
  li.addEventListener("click", (ev) => {
    if (ev.target === aliasInput) return;
    // Игнорируем клик после drag
    if (li.classList.contains("is-dragging")) return;

    if (side === "available") {
      _networkModalState.selected.add(iface.name);
    } else {
      _networkModalState.selected.delete(iface.name);
      delete _networkModalState.aliases[iface.name];
    }
    renderNetworkModalLists(modal);
  });

  return li;
}

// ---------------------------------------------------------------------------
// Эмодзи-иконки интерфейсов
// ---------------------------------------------------------------------------
//
// Используем эмодзи вместо SVG: они одинаково видны в тёмной и светлой
// темах, понятны обычному пользователю и не требуют CSS-масок.
//
// Подбор по типу:
//   🔌  Ethernet (проводное)
//   🏠  Bridge (LAN) — домашняя сеть
//   📶  Wi-Fi
//   🌐  WAN / Internet
//   🛡️  VPN / WireGuard — защита
//   🔒  Tunnel (tun/tap) — зашифрованный туннель
//   🏷️  VLAN — сегментация
//   🔄  Loopback

function getInterfaceIcon(iface) {
  const name = iface.name || "";
  const proto = iface.proto || "";
  const type = iface.type || "";

  // VPN / WireGuard — самый приоритетный (защита)
  if (proto === "wireguard" || name.startsWith("wg")) return "🛡️";

  // Tunnel
  if (name.startsWith("tun") || name.startsWith("tap")) return "🔒";

  // PPPoE — WAN через провайдера
  if (name.startsWith("pppoe-")) return "🌐";

  // Bridge (LAN) — домашняя сеть
  if (name.startsWith("br-")) return "🏠";

  // VLAN
  if (name.startsWith("vlan")) return "🏷️";

  // Wi-Fi
  if (name.startsWith("wlan") || name.startsWith("wl") || type === "wireless") {
    return "📶";
  }

  // Loopback
  if (name === "lo") return "🔄";

  // WAN / Internet (по протоколу)
  if (proto === "dhcp" || proto === "static" || proto === "pppoe") {
    return "🌐";
  }

  // Ethernet (по умолчанию)
  return "🔌";
}

// Sparkline (упрощённый — наполнится в 2.2)
function buildNetworkSparkline(hist) {
  if (!hist || !hist.rx || hist.rx.length < 2) {
    return `<svg class="proton-dashboard-network-spark-svg" viewBox="0 0 60 18" preserveAspectRatio="none" aria-hidden="true"></svg>`;
  }

  const width = 60;
  const height = 18;
  const padding = 1;
  const rx = hist.rx;
  const tx = hist.tx;
  const max = Math.max(1, ...rx, ...tx);
  const innerW = width - padding * 2;
  const innerH = height - padding * 2;
  const step = innerW / (rx.length - 1);

  const buildPath = (values) =>
    values
      .map((v, i) => {
        const x = padding + i * step;
        const y = padding + innerH - (v / max) * innerH;
        return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ");

  return `
    <svg class="proton-dashboard-network-spark-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <path class="proton-dashboard-network-spark-rx" d="${buildPath(rx)}" />
      <path class="proton-dashboard-network-spark-tx" d="${buildPath(tx)}" />
    </svg>
  `;
}

    function renderSystemMeta(card, sysinfo, board, info) {
    const model = (sysinfo && sysinfo.model) || (board && board.model) || (board && board.board_name) || "";
    const release = (sysinfo && sysinfo.release) || (board && board.release && board.release.version) || "";
    const description = (sysinfo && sysinfo.description) || (board && board.release && board.release.description) || "";
    const arch = (sysinfo && sysinfo.package_arch) || "";
    const target = (sysinfo && sysinfo.target) || "";
    const feedUrl = (sysinfo && sysinfo.package_feed_url) || "";
    const kernel = (board && board.kernel) || "";
    const ianaTz = (sysinfo && sysinfo.zonename) || "";

    renderSubtitle(card, model, release, description);

    const modelEl = card.querySelector('[data-role="model"]');
    if (modelEl) modelEl.textContent = model || "—";

    const archBadge = card.querySelector('[data-role="arch-badge"]');
    if (archBadge) {
      archBadge.textContent = arch || "—";
      if (feedUrl) {
        archBadge.setAttribute("href", feedUrl);
        archBadge.setAttribute("target", "_blank");
        archBadge.setAttribute("rel", "noopener noreferrer");
      } else {
        archBadge.removeAttribute("href");
      }
    }

    const localtimeEl = card.querySelector('[data-role="localtime"]');
    if (localtimeEl) {
      const lt = info && Number(info.localtime);
      localtimeEl.textContent = formatLocalTime(lt, ianaTz);
    }

    const targetEl = card.querySelector('[data-role="target"]');
    if (targetEl) {
      targetEl.textContent = target || "—";
      targetEl.title = target || "";
    }

    const kernelEl = card.querySelector('[data-role="kernel"]');
    if (kernelEl) {
      kernelEl.textContent = kernel ? `${t("Kernel")} ${kernel}` : "—";
      kernelEl.title = kernel ? `${t("Kernel")} ${kernel}` : "";
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
      const [info, cpu, sysinfo, board, counts, topCpuRaw, topRamRaw, networkRaw] = await Promise.all([
        L.resolveDefault(callSystemInfo(), null),
        L.resolveDefault(callCpuUsage(), null),
        L.resolveDefault(callProtonSystemInfo(), null),
        L.resolveDefault(callSystemBoard(), null),
        L.resolveDefault(callProcessCount(), null),
        L.resolveDefault(callTopProcesses("cpu", 3), null),
        L.resolveDefault(callTopProcesses("ram", 3), null),
        L.resolveDefault(callNetworkStats(), null),
      ]);

      const memory = getMemory(info);

      renderCpu(card, cpu);
      renderMemory(card, memory);
      renderUptime(card, info);
      renderLoad(card, info);
      renderSystemMeta(card, sysinfo, board, info);

      // --- Процессы ---
      if (counts) {
        renderProcesses(card, {
          running: Number(counts.running) || 0,
          total: Number(counts.total) || 0,
        });
      }

      const topCpu = topCpuRaw && Array.isArray(topCpuRaw.processes)
        ? topCpuRaw.processes
        : [];
      const topRam = topRamRaw && Array.isArray(topRamRaw.processes)
        ? topRamRaw.processes
        : [];

      const topCpuWithPct = computeProcessDeltas(topCpu, cpu || {});
      renderTopProcesses(card, topCpuWithPct, topRam);

      // --- Сетевые интерфейсы ---
      if (networkRaw && Array.isArray(networkRaw.interfaces)) {
        const rates = computeNetworkRates(networkRaw.interfaces);
        renderNetworkInterfaces(card, rates);
      }

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

	// Загружаем сохранённое состояние интерфейсов из localStorage
    // (UCI-синхронизация подхватит и перезапишет после syncFromUci)
    userSelectedInterfaces = readSelectedInterfacesFromStorage();
    interfaceAliases = readAliasesFromStorage();

    startNativeHideObserver();

  // Шестерёнка для выбора интерфейсов
    const networkSettingsBtn = card.querySelector('[data-role="network-settings"]');
    if (networkSettingsBtn && !networkSettingsBtn.dataset.protonBound) {
      networkSettingsBtn.dataset.protonBound = "1";
      networkSettingsBtn.addEventListener("click", () => {
        openNetworkSettingsModal();
      });
    }

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

    // Сброс истории процессов
    processHistory = [];
    prevCpuSnapshot = null;
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
