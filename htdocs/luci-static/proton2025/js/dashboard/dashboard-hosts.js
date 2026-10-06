/**
 * Proton2025 Dashboard - Hosts widget
 * Copyright 2025-2026 ChesterGoodiny
 * Licensed under the Apache License, Version 2.0
 * See LICENSE and NOTICE for details.
 *
 * KeeneticOS-style hosts panel:
 *   - List of connected devices with realtime traffic (rx/tx rates)
 *   - Sparkline charts for each host (last 30 samples)
 *   - Wi-Fi / LAN detection via iwinfo
 *   - Signal strength for Wi-Fi clients
 *
 * Data sources:
 *   - luci.proton-nlbw.getHostTraffic     → per-MAC cumulative bytes (nlbwmon)
 *   - luci-rpc.getHostHints               → MAC → IP mapping
 *   - luci-rpc.getDHCPLeases              → MAC → hostname + IP
 *   - iwinfo.devices + iwinfo.assoclist   → Wi-Fi clients + signal
 */

(function () {
  "use strict";

  const POLL_INTERVAL = 5000;
  const HISTORY_SIZE = 30;
  const MAX_HOSTS = 100;

  let callGetHostTraffic = null;
  let callGetHostHints = null;
  let callGetDHCPLeases = null;
  let callIwinfoDevices = null;
  let callIwinfoAssoclist = null;

  let pollTimer = null;
  let visibilityHandler = null;
  let mounted = false;

  // mac (lowercase) → { rxHistory: [...], txHistory: [...], prevRx, prevTx, prevTs }
  const hostHistory = new Map();

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

    if (!callGetHostTraffic) {
      callGetHostTraffic = L.rpc.declare({
        object: "luci.proton-nlbw",
        method: "getHostTraffic",
        expect: { "": {} },
      });
    }
    if (!callGetHostHints) {
      callGetHostHints = L.rpc.declare({
        object: "luci-rpc",
        method: "getHostHints",
        expect: { "": {} },
      });
    }
    if (!callGetDHCPLeases) {
      callGetDHCPLeases = L.rpc.declare({
        object: "luci-rpc",
        method: "getDHCPLeases",
        expect: { "": {} },
      });
    }
    if (!callIwinfoDevices) {
      callIwinfoDevices = L.rpc.declare({
        object: "iwinfo",
        method: "devices",
        expect: { "": {} },
      });
    }
    if (!callIwinfoAssoclist) {
      callIwinfoAssoclist = L.rpc.declare({
        object: "iwinfo",
        method: "assoclist",
        params: ["device"],
        expect: { "": {} },
      });
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    if (unit === 0) return `${Math.round(value)} ${units[unit]}`;
    return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
  }

  function formatRate(bytesPerSec) {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec < 0) return "0 B/s";
    return formatBytes(bytesPerSec) + "/s";
  }

  function formatSignal(dbm) {
    if (!Number.isFinite(dbm)) return "";
    return `${dbm} dBm`;
  }

  function pickBestIp(hints) {
    if (!hints) return "";
    if (Array.isArray(hints.ipaddrs) && hints.ipaddrs.length) {
      return hints.ipaddrs[0];
    }
    if (Array.isArray(hints.ip6addrs) && hints.ip6addrs.length) {
      return hints.ip6addrs[0];
    }
    return "";
  }

  function normalizeMac(mac) {
    return String(mac || "").trim().toLowerCase();
  }

  // ---------------------------------------------------------------------------
  // Data collection
  // ---------------------------------------------------------------------------

  async function collectWiFiClients() {
    const map = new Map(); // mac (lowercase) → { signal, device }
    if (!callIwinfoDevices) return map;

    let devices = [];
    try {
      const res = await L.resolveDefault(callIwinfoDevices(), null);
      if (res && Array.isArray(res.devices)) devices = res.devices;
    } catch (e) {}

    await Promise.all(
      devices.map(async (device) => {
        try {
          const res = await L.resolveDefault(callIwinfoAssoclist(device), null);
          const results = res && Array.isArray(res.results) ? res.results : [];
          results.forEach((client) => {
            const mac = normalizeMac(client.mac);
            if (!mac) return;
            map.set(mac, {
              signal: Number(client.signal),
              device: device,
            });
          });
        } catch (e) {}
      }),
    );

    return map;
  }

  async function collectData() {
    if (!ensureRpc()) return { hosts: [], timestamp: Date.now() };

    const [trafficRes, hintsRes, leasesRes, wifiMap] = await Promise.all([
      L.resolveDefault(callGetHostTraffic(), null),
      L.resolveDefault(callGetHostHints(), null),
      L.resolveDefault(callGetDHCPLeases(), null),
      collectWiFiClients(),
    ]);

    const trafficByMac = (trafficRes && trafficRes.success && trafficRes.hosts)
      ? trafficRes.hosts
      : {};

    // Собираем все MAC из всех источников
    const allMacs = new Set();

    for (const mac of Object.keys(trafficByMac)) {
      allMacs.add(normalizeMac(mac));
    }
    if (hintsRes && typeof hintsRes === "object") {
      for (const mac of Object.keys(hintsRes)) allMacs.add(normalizeMac(mac));
    }
    for (const mac of wifiMap.keys()) allMacs.add(mac);

    // Hostname map из DHCP lease
    const hostnameByMac = new Map();
    const ipByMac = new Map();

    if (hintsRes && typeof hintsRes === "object") {
      for (const rawMac of Object.keys(hintsRes)) {
        const mac = normalizeMac(rawMac);
        const ip = pickBestIp(hintsRes[rawMac]);
        if (ip) ipByMac.set(mac, ip);
      }
    }

    if (leasesRes && Array.isArray(leasesRes.dhcp_leases)) {
      leasesRes.dhcp_leases.forEach((lease) => {
        const mac = normalizeMac(lease.macaddr);
        if (!mac) return;
        if (lease.hostname && lease.hostname.trim()) {
          hostnameByMac.set(mac, lease.hostname.trim());
        }
        if (lease.ipaddr && !ipByMac.has(mac)) {
          ipByMac.set(mac, lease.ipaddr);
        }
      });
    }
    if (leasesRes && Array.isArray(leasesRes.dhcp6_leases)) {
      leasesRes.dhcp6_leases.forEach((lease) => {
        const mac = normalizeMac(lease.macaddr);
        if (!mac) return;
        if (lease.hostname && lease.hostname.trim() && !hostnameByMac.has(mac)) {
          hostnameByMac.set(mac, lease.hostname.trim());
        }
        if (lease.ip6addr && !ipByMac.has(mac)) {
          ipByMac.set(mac, lease.ip6addr);
        }
      });
    }

    const now = Date.now();
    const hosts = [];

    for (const mac of allMacs) {
      // Пропускаем нулевые
      if (mac === "00:00:00:00:00:00") continue;

      const traffic = trafficByMac[mac] || trafficByMac[mac.toUpperCase()] || null;
      const rxBytes = traffic ? Number(traffic.rx_bytes) || 0 : 0;
      const txBytes = traffic ? Number(traffic.tx_bytes) || 0 : 0;

      // Считаем скорости от предыдущего сэмпла
      let rateRx = 0;
      let rateTx = 0;
      let hist = hostHistory.get(mac);
      if (!hist) {
        hist = {
          rxHistory: [],
          txHistory: [],
          prevRx: null,
          prevTx: null,
          prevTs: null,
        };
        hostHistory.set(mac, hist);
      }
      if (hist.prevRx != null && hist.prevTs != null) {
        const dt = (now - hist.prevTs) / 1000;
        if (dt > 0) {
          const drx = rxBytes - hist.prevRx;
          const dtx = txBytes - hist.prevTx;
          rateRx = drx >= 0 ? drx / dt : 0;
          rateTx = dtx >= 0 ? dtx / dt : 0;
        }
      }
      hist.prevRx = rxBytes;
      hist.prevTx = txBytes;
      hist.prevTs = now;

      hist.rxHistory.push(rateRx);
      hist.txHistory.push(rateTx);
      if (hist.rxHistory.length > HISTORY_SIZE) hist.rxHistory.shift();
      if (hist.txHistory.length > HISTORY_SIZE) hist.txHistory.shift();

      const wifi = wifiMap.get(mac);

      hosts.push({
        mac: mac,
        hostname: hostnameByMac.get(mac) || "",
        ip: ipByMac.get(mac) || "",
        type: wifi ? "wifi" : "lan",
        signal: wifi ? wifi.signal : null,
        rxBytes,
        txBytes,
        rateRx,
        rateTx,
        rxHistory: hist.rxHistory.slice(),
        txHistory: hist.txHistory.slice(),
      });
    }

    hosts.sort((a, b) => {
      const an = a.hostname || a.ip || a.mac;
      const bn = b.hostname || b.ip || b.mac;
      return an.localeCompare(bn);
    });

    return { hosts, timestamp: now };
  }

  // ---------------------------------------------------------------------------
  // Card
  // ---------------------------------------------------------------------------

  function ensureCard() {
    let card = document.getElementById("proton-dashboard-hosts");
    if (card) {
      mounted = true;
      return card;
    }

    card = document.createElement("article");
    card.className = "proton-dashboard-card proton-dashboard-hosts";
    card.id = "proton-dashboard-hosts";

    card.innerHTML = `
      <div class="proton-dashboard-card-header">
        <div>
          <div class="proton-dashboard-card-title-row">
            <span class="proton-dashboard-card-status-dot" data-role="status-dot"></span>
            <h3 class="proton-dashboard-card-title">${t("Hosts")}</h3>
          </div>
          <div class="proton-dashboard-card-subtitle" data-role="subtitle">${t("Loading...")}</div>
        </div>
      </div>
      <div class="proton-dashboard-card-body">
        <ul class="proton-hosts-list" data-role="list" role="list"></ul>
      </div>
      <div class="proton-dashboard-card-footer">
        <span data-role="footer">—</span>
      </div>
    `;

    const maincontent = document.getElementById("maincontent");
    if (!maincontent) return null;
    maincontent.appendChild(card);

    mounted = true;
    return card;
  }

  // ---------------------------------------------------------------------------
  // Sparkline
  // ---------------------------------------------------------------------------

  function buildSparkline(rxHistory, txHistory) {
    const width = 90;
    const height = 24;
    const padding = 1;

    const max = Math.max(1, ...rxHistory, ...txHistory);
    const innerW = width - padding * 2;
    const innerH = height - padding * 2;

    function buildPath(values) {
      if (values.length < 2) return "";
      const step = innerW / (values.length - 1);
      return values
        .map((v, i) => {
          const x = padding + i * step;
          const y = padding + innerH - (v / max) * innerH;
          return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join(" ");
    }

    const rxPath = buildPath(rxHistory);
    const txPath = buildPath(txHistory);

    return `
      <svg class="proton-hosts-sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
        <path class="proton-hosts-sparkline-rx" d="${rxPath}" />
        <path class="proton-hosts-sparkline-tx" d="${txPath}" />
      </svg>
    `;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  function renderHosts(card, hosts) {
    const list = card.querySelector('[data-role="list"]');
    if (!list) return;

    list.replaceChildren();

    if (!hosts.length) {
      const empty = document.createElement("li");
      empty.className = "proton-hosts-empty";
      empty.textContent = t("No active clients");
      list.appendChild(empty);
      return;
    }

    const shown = hosts.slice(0, MAX_HOSTS);

    shown.forEach((h) => {
      const row = document.createElement("li");
      row.className = "proton-hosts-row";
      row.dataset.mac = h.mac;

      const icon = document.createElement("span");
      icon.className = "proton-hosts-icon";
      icon.textContent = h.type === "wifi" ? "📱" : "💻";

      const main = document.createElement("div");
      main.className = "proton-hosts-main";

      const top = document.createElement("div");
      top.className = "proton-hosts-top";

      const name = document.createElement("span");
      name.className = "proton-hosts-name";
      name.textContent = h.hostname || t("Unknown");

      const ip = document.createElement("span");
      ip.className = "proton-hosts-ip";
      ip.textContent = h.ip || h.mac;

      top.appendChild(name);
      top.appendChild(ip);

      const bottom = document.createElement("div");
      bottom.className = "proton-hosts-bottom";

      const type = document.createElement("span");
      type.className = "proton-hosts-type";
      if (h.type === "wifi") {
        type.textContent = t("Wi-Fi") + (h.signal ? " · " + formatSignal(h.signal) : "");
      } else {
        type.textContent = "LAN";
      }

      const rates = document.createElement("span");
      rates.className = "proton-hosts-rates";
      rates.innerHTML =
        `<span class="proton-hosts-rate-rx">▼ ${formatRate(h.rateRx)}</span>` +
        `<span class="proton-hosts-rate-tx">▲ ${formatRate(h.rateTx)}</span>`;

      bottom.appendChild(type);
      bottom.appendChild(rates);

      main.appendChild(top);
      main.appendChild(bottom);

      const chart = document.createElement("div");
      chart.className = "proton-hosts-chart";
      chart.innerHTML = buildSparkline(h.rxHistory, h.txHistory);

      row.appendChild(icon);
      row.appendChild(main);
      row.appendChild(chart);

      list.appendChild(row);
    });
  }

  function updateSubtitle(card, hosts) {
    const el = card.querySelector('[data-role="subtitle"]');
    if (!el) return;
    const wifiCount = hosts.filter((h) => h.type === "wifi").length;
    const lanCount = hosts.length - wifiCount;
    const parts = [];
    if (wifiCount) parts.push(`${wifiCount} ${t("Wi-Fi")}`);
    if (lanCount) parts.push(`${lanCount} LAN`);
    el.textContent = parts.length ? parts.join(" · ") : t("No active clients");
  }

  function updateFooter(card, hosts) {
    const el = card.querySelector('[data-role="footer"]');
    if (!el) return;
    let totalRx = 0;
    let totalTx = 0;
    hosts.forEach((h) => {
      totalRx += h.rateRx || 0;
      totalTx += h.rateTx || 0;
    });
    el.textContent = `▼ ${formatRate(totalRx)}  ▲ ${formatRate(totalTx)}`;
  }

  function setStatusDot(card, state) {
    const dot = card.querySelector('[data-role="status-dot"]');
    if (dot) dot.dataset.state = state;
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  async function poll() {
    if (!mounted || document.hidden) return;

    const card = document.getElementById("proton-dashboard-hosts");
    if (!card) return;

    try {
      const { hosts } = await collectData();
      renderHosts(card, hosts);
      updateSubtitle(card, hosts);
      updateFooter(card, hosts);
      setStatusDot(card, "ok");
    } catch (error) {
      console.warn("[Proton2025] Hosts poll failed:", error);
      setStatusDot(card, "err");
      const subtitle = card.querySelector('[data-role="subtitle"]');
      if (subtitle) subtitle.textContent = t("Unable to read host data");
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function start() {
    const card = ensureCard();
    if (!card) return false;

    if (pollTimer) return true;

    poll();
    pollTimer = setInterval(poll, POLL_INTERVAL);

    visibilityHandler = () => {
      if (!document.hidden) poll();
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

  window.ProtonDashboardHosts = {
    start,
    stop,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
