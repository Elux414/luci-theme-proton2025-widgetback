/**
 * Proton2025 Dashboard - Hosts widget
 * Copyright 2025-2026 ChesterGoodiny
 * Licensed under the Apache License, Version 2.0
 * See LICENSE and NOTICE for details.
 */

(function () {
  "use strict";

  const POLL_INTERVAL = 3000;
  const HISTORY_SIZE = 30;

  let callGetHostTraffic = null;
  let callGetHostHints = null;
  let callGetDHCPLeases = null;
  let callIwinfoDevices = null;
  let callIwinfoAssoclist = null;

  let pollTimer = null;
  let visibilityHandler = null;
  let mounted = false;

  let localIPs = new Set();
  let availableSubnets = new Set();
  let hostsFilterSubnets = null;

  const wifiMacCache = new Map();
  const WIFI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  let iwinfoReady = false;
  let hostAliases = {};
  const hostHistory = new Map();
  let vpnSubnets = [];
  let isEditingHostName = false; // Флаг для блокировки перерисовки при вводе имени

  // --- Загрузка IP и подсетей ---
  function isVpnInterface(iface) {
    if (!iface) return false;
    const proto = String(iface.proto || "").toLowerCase();
    const device = String(iface.device || iface.l3_device || iface.ifname || "").toLowerCase();
    const ifaceName = String(iface.interface || "").toLowerCase();
    if (proto === "wireguard") return true;
    if (proto === "none") {
      const vpnDevicePrefixes = ["wg", "zt", "tun", "tap", "tailscale", "ovpn"];
      if (vpnDevicePrefixes.some(p => device.startsWith(p))) return true;
      if (vpnDevicePrefixes.some(p => ifaceName.startsWith(p))) return true;
    }
    return false;
  }

  function cidrFromAddr(addr) {
    if (!addr || !addr.address) return null;
    const ip = String(addr.address).split("/")[0];
    const mask = addr.mask != null ? parseInt(addr.mask, 10) : (addr.prefix != null ? parseInt(addr.prefix, 10) : null);
    if (mask == null || isNaN(mask)) return null;
    if (ip.indexOf(":") !== -1) return { cidr: ip + "/" + mask, family: 6 };
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    const ipNum = ((+parts[0] & 255) << 24) | ((+parts[1] & 255) << 16) | ((+parts[2] & 255) << 8) | (+parts[3] & 255);
    const shift = 32 - mask;
    const baseNum = (ipNum >>> shift) << shift;
    const base = ((baseNum >>> 24) & 255) + "." + ((baseNum >>> 16) & 255) + "." + ((baseNum >>> 8) & 255) + "." + (baseNum & 255);
    return { cidr: base + "/" + mask, family: 4 };
  }

  function ipInVpnSubnet(ip) {
    if (!ip) return false;
    if (ip.indexOf(":") !== -1) return false;
    const parts = ip.split(".");
    if (parts.length !== 4) return false;
    const ipNum = ((+parts[0] & 255) << 24) | ((+parts[1] & 255) << 16) | ((+parts[2] & 255) << 8) | (+parts[3] & 255);
    for (const sub of vpnSubnets) {
      if (sub.family !== 4) continue;
      const [base, maskStr] = sub.cidr.split("/");
      const mask = parseInt(maskStr, 10);
      if (isNaN(mask)) continue;
      const baseParts = base.split(".");
      if (baseParts.length !== 4) continue;
      const baseNum = ((+baseParts[0] & 255) << 24) | ((+baseParts[1] & 255) << 16) | ((+baseParts[2] & 255) << 8) | (+baseParts[3] & 255);
      const shift = 32 - mask;
      if ((ipNum >>> shift) === (baseNum >>> shift)) return true;
    }
    return false;
  }

  async function fetchLocalAddressesAndSubnets() {
    let attempts = 0;
    while ((!window.L || !L.rpc) && attempts < 50) {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }
    if (!window.L || !L.rpc) return;

    try {
      if (!window.__protonHostsDumpRpc) {
        window.__protonHostsDumpRpc = L.rpc.declare({
          object: "network.interface",
          method: "dump",
          expect: { "": {} },
        });
      }

      const raw = await L.resolveDefault(window.__protonHostsDumpRpc(), null);
      if (!raw || !Array.isArray(raw.interface)) return;

      vpnSubnets = [];

      raw.interface.forEach(iface => {
        if (isVpnInterface(iface)) {
          (iface['ipv4-address'] || []).forEach(addr => {
            const c = cidrFromAddr(addr);
            if (c && c.family === 4) vpnSubnets.push(c);
          });
        }

        (iface['ipv4-address'] || []).forEach(addr => {
          if (addr && addr.address) {
            localIPs.add(addr.address);
            const mask = addr.mask || 24;
            const parts = addr.address.split('.');
            if (parts.length === 4) {
              const ipNum = (parseInt(parts[0]) << 24) + (parseInt(parts[1]) << 16) + (parseInt(parts[2]) << 8) + parseInt(parts[3]);
              const shift = 32 - mask;
              const baseNum = (ipNum >>> shift) << shift;
              const base = [
                (baseNum >>> 24) & 255,
                                              (baseNum >>> 16) & 255,
                                              (baseNum >>> 8) & 255,
                                              baseNum & 255
              ].join('.');
              availableSubnets.add(`${base}/${mask}`);
            }
          }
        });
        (iface['ipv6-address'] || []).forEach(addr => {
          if (addr && addr.address) {
            localIPs.add(addr.address.split("/")[0]);
            let prefix = addr.mask || addr.prefix || 64;
            const ip = addr.address.split("/")[0];
            const isLinkLocal = ip.toLowerCase().startsWith("fe80:");
            const isMulticast = ip.toLowerCase().startsWith("ff");
            if (!isLinkLocal && !isMulticast) availableSubnets.add(ip + "/" + prefix);
          }
        });
          (iface['route'] || []).forEach(route => {
            if (route && route.source) {
              const ip = route.source.split('/')[0];
              if (ip) localIPs.add(ip);
            }
          });
      });
    } catch (e) {
      console.warn("[Proton2025 Hosts] Failed to fetch local IPs:", e);
    }
  }

  async function loadHostsFilter() {
    if (hostsFilterSubnets !== null) return hostsFilterSubnets;
    try {
      const raw = localStorage.getItem('proton-hosts-filter');
      if (raw) {
        const arr = JSON.parse(raw);
        hostsFilterSubnets = Array.isArray(arr) ? arr : [];
      } else {
        hostsFilterSubnets = [];
      }
    } catch (e) {
      hostsFilterSubnets = [];
    }
    return hostsFilterSubnets;
  }

  function ipToBigInt(ip) {
    if (ip.indexOf(':') === -1) return null;
    let parts = ip.split('::');
    let head = parts[0] ? parts[0].split(':') : [];
    let tail = parts[1] ? parts[1].split(':') : [];
    if (head.length + tail.length < 8) {
      let fill = 8 - (head.length + tail.length);
      for (let i = 0; i < fill; i++) head.push('0');
    }
    let hex = '';
    for (let i = 0; i < 8; i++) {
      let part = head[i] || tail[i - head.length] || '0';
      hex += part.padStart(4, '0');
    }
    try {
      return BigInt('0x' + hex);
    } catch (e) {
      return null;
    }
  }

  function ipInSubnet(ip, cidr) {
    if (!ip || !cidr) return false;
    const idx = cidr.indexOf('/');
    if (idx < 0) return false;
    const base = cidr.slice(0, idx);
    const mask = parseInt(cidr.slice(idx + 1), 10);
    if (isNaN(mask)) return false;

    if (ip.indexOf(':') !== -1) {
      const ipBig = ipToBigInt(ip);
      const baseBig = ipToBigInt(base);
      if (ipBig === null || baseBig === null) return false;
      const shift = 128n - BigInt(mask);
      return (ipBig >> shift) === (baseBig >> shift);
    } else {
      const ipParts = ip.split('.');
      const baseParts = base.split('.');
      if (ipParts.length !== 4 || baseParts.length !== 4) return false;
      const ipNum = (parseInt(ipParts[0]) << 24) + (parseInt(ipParts[1]) << 16) + (parseInt(ipParts[2]) << 8) + parseInt(ipParts[3]);
      const baseNum = (parseInt(baseParts[0]) << 24) + (parseInt(baseParts[1]) << 16) + (parseInt(baseParts[2]) << 8) + parseInt(baseParts[3]);
      const shift = 32 - mask;
      return ((ipNum >>> shift) === (baseNum >>> shift));
    }
  }

  function ipInAnySubnet(ip, subnets) {
    if (!subnets || subnets.length === 0) return true;
    return subnets.some(cidr => ipInSubnet(ip, cidr));
  }

  function normalizeMac(mac) {
    return String(mac || "").trim().toLowerCase();
  }

  function t(value) {
    if (typeof window.protonT === "function") return window.protonT(value);
    if (window.L && typeof L.tr === "function") {
      const tr = L.tr(value);
      if (tr && tr !== value) return tr;
    }
    return value;
  }

  function ensureRpc() {
    if (!window.L || !L.rpc || typeof L.rpc.declare !== "function") return false;

    if (!callGetHostTraffic) {
      callGetHostTraffic = L.rpc.declare({ object: "luci.proton-nlbw", method: "getHostTraffic", expect: { "": {} } });
    }
    if (!callGetHostHints) {
      callGetHostHints = L.rpc.declare({ object: "luci-rpc", method: "getHostHints", expect: { "": {} } });
    }
    if (!callGetDHCPLeases) {
      callGetDHCPLeases = L.rpc.declare({ object: "luci-rpc", method: "getDHCPLeases", expect: { "": {} } });
    }
    if (!callIwinfoDevices) {
      callIwinfoDevices = L.rpc.declare({ object: "iwinfo", method: "devices", expect: { "": {} } });
    }
    if (!callIwinfoAssoclist) {
      callIwinfoAssoclist = L.rpc.declare({ object: "iwinfo", method: "assoclist", params: ["device"], expect: { "": {} } });
    }
    return true;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    if (unit === 0) return `${Math.round(value)} ${units[unit]}`;
    return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
  }

  function formatRate(bytesPerSec) {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec < 0) return "0 B/s";
    return formatBytes(bytesPerSec) + "/s";
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  function pickBestIp(hints) {
    let result = { ipv4: "", ipv6: "" };
    if (!hints) return result;

    if (Array.isArray(hints.ipaddrs) && hints.ipaddrs.length) {
      let ip = hints.ipaddrs[0];
      if (typeof ip === "string") result.ipv4 = ip.split("/")[0];
    }

    if (Array.isArray(hints.ip6addrs) && hints.ip6addrs.length) {
      const valid = hints.ip6addrs.filter(a => {
        if (!a) return false;
        const clean = a.split("/")[0].toLowerCase();
        return !clean.startsWith("fe80:") && clean !== "::1" && !clean.startsWith("ff");
      });
      if (valid.length) result.ipv6 = valid[0].split("/")[0];
    }
    return result;
  }

  async function collectWiFiClients() {
    const map = new Map();
    if (!callIwinfoDevices) return map;
    let devices = [];
    try {
      const res = await L.resolveDefault(callIwinfoDevices(), null);
      if (res && Array.isArray(res.devices)) devices = res.devices;
    } catch (e) {}

    if (devices.length > 0) iwinfoReady = true;

    await Promise.all(devices.map(async (device) => {
      try {
        const res = await L.resolveDefault(callIwinfoAssoclist(device), null);
        const results = res && Array.isArray(res.results) ? res.results : [];
        results.forEach((client) => {
          const mac = normalizeMac(client.mac);
          if (!mac) return;
          map.set(mac, { signal: Number(client.signal), device: device });
          wifiMacCache.set(mac, { lastSeen: Date.now() });
        });
      } catch (e) {}
    }));
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

    const trafficByMac = (trafficRes && trafficRes.success && trafficRes.hosts) ? trafficRes.hosts : {};
    const allMacs = new Set();
    for (const mac of Object.keys(trafficByMac)) allMacs.add(normalizeMac(mac));
    if (hintsRes && typeof hintsRes === "object") {
      for (const mac of Object.keys(hintsRes)) allMacs.add(normalizeMac(mac));
    }
    for (const mac of wifiMap.keys()) allMacs.add(mac);

    const hostnameByMac = new Map();
    const ipByMac = new Map();
    if (hintsRes && typeof hintsRes === "object") {
      for (const rawMac of Object.keys(hintsRes)) {
        const mac = normalizeMac(rawMac);
        const ips = pickBestIp(hintsRes[rawMac]);
        if (ips.ipv4 || ips.ipv6) ipByMac.set(mac, ips);
      }
    }

    if (leasesRes && Array.isArray(leasesRes.dhcp_leases)) {
      leasesRes.dhcp_leases.forEach((lease) => {
        const mac = normalizeMac(lease.macaddr);
        if (!mac) return;
        if (lease.hostname && lease.hostname.trim()) hostnameByMac.set(mac, lease.hostname.trim());
        if (lease.ipaddr && !ipByMac.has(mac)) ipByMac.set(mac, lease.ipaddr);
      });
    }
    if (leasesRes && Array.isArray(leasesRes.dhcp6_leases)) {
      leasesRes.dhcp6_leases.forEach((lease) => {
        const mac = normalizeMac(lease.macaddr);
        if (!mac) return;
        if (lease.hostname && lease.hostname.trim() && !hostnameByMac.has(mac)) hostnameByMac.set(mac, lease.hostname.trim());
        if (lease.ip6addr && !ipByMac.has(mac)) ipByMac.set(mac, lease.ip6addr);
      });
    }

    const now = Date.now();
    const hosts = [];
    const filterSubnets = await loadHostsFilter();

    if (hintsRes && typeof hintsRes === "object") {
      for (const rawMac of Object.keys(hintsRes)) {
        const mac = normalizeMac(rawMac);
        const ipv4 = pickBestIp(hintsRes[rawMac]);
        if (ipv4 && localIPs.has(ipv4)) {
          const ip6 = hintsRes[rawMac].ip6addrs || [];
          ip6.forEach(addr => {
            if (addr) localIPs.add(addr.split("/")[0]);
          });
        }
      }
    }

    for (const mac of allMacs) {
      if (mac === "00:00:00:00:00:00") continue;

      const ips = ipByMac.get(mac) || { ipv4: "", ipv6: "" };
      const ipv4 = ips.ipv4;
      const ipv6 = ips.ipv6;
      const ipForFilter = ipv4 || ipv6;
      const ipClean = ipForFilter.split("/")[0];

      if (ipClean.startsWith("fe80:") || ipClean === "::1") continue;
      if (localIPs.has(ipClean)) continue;
      if (filterSubnets.length > 0 && !ipInAnySubnet(ipClean, filterSubnets)) continue;

      const traffic = trafficByMac[mac] || null;
      const rxBytes = traffic ? Number(traffic.rx_bytes) || 0 : 0;
      const txBytes = traffic ? Number(traffic.tx_bytes) || 0 : 0;

      let rateRx = 0;
      let rateTx = 0;
      let hist = hostHistory.get(mac);
      if (!hist) {
        hist = { rxHistory: [], txHistory: [], prevRx: null, prevTx: null, prevTs: null };
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
      const knownWifi = wifiMacCache.has(mac);
      const isVpn = ipInVpnSubnet(ipClean);

      let hostType;
      if (wifi || knownWifi) {
        hostType = "wifi";
        if (wifi) wifiMacCache.set(mac, { lastSeen: now });
      } else if (isVpn) {
        hostType = "lan-vpn";
      } else if (iwinfoReady) {
        hostType = "lan";
      } else {
        hostType = "unknown";
      }

      const alias = hostAliases[mac] || "";

      hosts.push({
        mac: mac,
        alias: alias,
        hostname: alias || hostnameByMac.get(mac) || "",
                 ip: ipv4 || ipv6,
                 ipv6: ipv4 && ipv6 ? ipv6 : "",
                 type: hostType,
                 signal: wifi ? wifi.signal : null,
                 rxBytes,
                 txBytes,
                 rateRx,
                 rateTx,
                 rxHistory: hist.rxHistory.slice(),
                 txHistory: hist.txHistory.slice(),
      });
    }

    const allMacsNow = new Set(hosts.map(h => h.mac));
    for (const [mac, info] of wifiMacCache) {
      if (!allMacsNow.has(mac) || (now - info.lastSeen) > WIFI_CACHE_TTL_MS) {
        wifiMacCache.delete(mac);
      }
    }

    return { hosts, timestamp: now };
  }

  function ensureCard() {
    let card = document.getElementById("proton-dashboard-hosts");
    if (card) { mounted = true; return card; }

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
    <button type="button" class="proton-dashboard-network-settings" data-role="hosts-settings" title="${t("Hosts filter")}">
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3"></circle>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
    </svg>
    </button>
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

  function buildSparkline(rxHistory, txHistory) {
    const width = 90, height = 24, padding = 1;
    const max = Math.max(1, ...rxHistory, ...txHistory);
    const innerW = width - padding * 2;
    const innerH = height - padding * 2;

    function buildPath(values) {
      if (values.length < 2) return "";
      const step = innerW / (values.length - 1);
      return values.map((v, i) => {
        const x = padding + i * step;
        const y = padding + innerH - (v / max) * innerH;
        return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join(" ");
    }

    return `
    <svg class="proton-hosts-sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <path class="proton-hosts-sparkline-rx" d="${buildPath(rxHistory)}" />
    <path class="proton-hosts-sparkline-tx" d="${buildPath(txHistory)}" />
    </svg>
    `;
  }

  function renderHosts(card, hosts) {
    const list = card.querySelector('[data-role="list"]');
    if (!list) return;

    hosts.sort((a, b) => (a.hostname || a.ip || a.mac).localeCompare(b.hostname || b.ip || b.mac));

    const wifi = hosts.filter(h => h.type === 'wifi');
    const lan  = hosts.filter(h => h.type !== 'wifi');

    function iconFor(h) {
      if (h.type === 'wifi') return '📱';
      if (h.type === 'lan-vpn') return '🔒';
      return '💻';
    }

    function renderItem(h) {
      const displayName = h.hostname || h.ip || h.mac || t('Unknown');
      const typeLabel = h.type === 'wifi' ? t('Wi-Fi') : (h.type === 'lan-vpn' ? 'VPN' : 'LAN');

      let html = '';
      html += '<li class="proton-hosts-row" data-mac="' + escapeHtml(h.mac) + '" ' +
      'data-h-name="' + escapeHtml(displayName) + '" ' +
      'data-h-ipv4="' + escapeHtml(h.ip || "") + '" ' +
      'data-h-ipv6="' + escapeHtml(h.ipv6 || "") + '" ' +
      'data-h-rx="' + escapeHtml(formatBytes(h.rxBytes)) + '" ' +
      'data-h-tx="' + escapeHtml(formatBytes(h.txBytes)) + '">';

      html += '  <span class="proton-hosts-icon">' + iconFor(h) + '</span>';

      html += '  <div class="proton-hosts-main">';

      // Верхняя строка: Имя + IP
      html += '    <div class="proton-hosts-top">';
      html += '      <span class="proton-hosts-name" data-mac="' + escapeHtml(h.mac) + '" title="' + t('Click to rename') + '">' + escapeHtml(displayName) + '</span>';

      // Контейнер для IP с фиксированной высотой (чтобы не прыгало)
      html += '      <div class="proton-hosts-ips">';
      if (h.ip) html += '<span class="proton-hosts-ip">' + escapeHtml(h.ip) + '</span>';
      else html += '<span class="proton-hosts-ip" style="visibility:hidden">&nbsp;</span>';

      if (h.ipv6) html += '<span class="proton-hosts-ip proton-hosts-ipv6">' + escapeHtml(h.ipv6) + '</span>';
      else html += '<span class="proton-hosts-ip proton-hosts-ipv6" style="visibility:hidden">&nbsp;</span>';
      html += '      </div>';

      html += '    </div>'; // конец top

      // Нижняя строка: Тип и Скорости
      html += '    <div class="proton-hosts-bottom">';
      html += '      <span class="proton-hosts-type">' + typeLabel + '</span>';
      html += '      <span class="proton-hosts-rates">';
      html += '        <span class="proton-hosts-rate-rx">▼ ' + formatRate(h.rateRx) + '</span>';
      html += '        <span class="proton-hosts-rate-tx">▲ ' + formatRate(h.rateTx) + '</span>';
      html += '      </span>';
      html += '    </div>'; // конец bottom

      html += '  </div>'; // конец main

      html += '  <div class="proton-hosts-chart">' + buildSparkline(h.rxHistory, h.txHistory) + '</div>';
      html += '</li>';

      return html;
    }

    function renderColumn(title, items) {
      let rows = items.length ? items.map(renderItem).join('') : '<li class="proton-hosts-empty">' + t('No active clients') + '</li>';
      return '<div class="proton-hosts-column">' +
      '  <h4 class="proton-hosts-col-title">' + title + ' (' + items.length + ')</h4>' +
      '  <ul class="proton-hosts-list-inner">' + rows + '</ul>' +
      '</div>';
    }

    list.innerHTML = '<div class="proton-hosts-columns">' +
    renderColumn('Wi-Fi', wifi) +
    renderColumn('LAN', lan) +
    '</div>';

      if (!list.dataset.protonEditBound) {
        list.dataset.protonEditBound = "1";
        list.addEventListener("click", handleHostNameClick);
      }

      if (isHoveringList && lastMouseX > 0) {
        const el = document.elementFromPoint(lastMouseX, lastMouseY);
        if (el) {
          const newRow = el.closest(".proton-hosts-row");
          if (newRow) {
            lastHoveredRow = newRow;
            showTooltip(newRow);
          }
        }
      } else {
        hideTooltip();
      }
  }

  function handleHostNameClick(e) {
    const nameEl = e.target.closest(".proton-hosts-name");
    if (!nameEl) return;
    e.stopPropagation();

    const mac = nameEl.dataset.mac;
    if (!mac) return;
    if (nameEl.tagName === "INPUT") return;

    isEditingHostName = true; // Блокируем перерисовку

    const currentText = nameEl.textContent;
    const currentAlias = hostAliases[mac] || "";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "proton-hosts-name-edit";
    input.value = currentAlias;
    input.placeholder = currentText;
    input.maxLength = 64;

    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;

    const commit = () => {
      if (committed) return;
      committed = true;
      const val = input.value.trim();
      saveHostAlias(mac, val);
      const span = document.createElement("span");
      span.className = "proton-hosts-name";
      span.dataset.mac = mac;
      span.title = t("Click to rename");
      span.textContent = val || currentText;
      input.replaceWith(span);

      isEditingHostName = false; // Разблокируем
      poll();
    };

    const cancel = () => {
      if (committed) return;
      committed = true;
      const span = document.createElement("span");
      span.className = "proton-hosts-name";
      span.dataset.mac = mac;
      span.title = t("Click to rename");
      span.textContent = currentText;
      input.replaceWith(span);

      isEditingHostName = false; // Разблокируем
    };

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); commit(); }
      else if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", commit);
  }

  function saveHostAlias(mac, name) {
    const trimmed = String(name || "").trim();
    if (trimmed) {
      hostAliases[mac] = trimmed;
    } else {
      delete hostAliases[mac];
    }
    const json = JSON.stringify(hostAliases);
    try {
      localStorage.setItem("proton-host-aliases", json);
    } catch (e) {}
    if (
      window.protonSettingsSync &&
      typeof window.protonSettingsSync.saveLocalKeyToUci === "function"
    ) {
      window.protonSettingsSync.saveLocalKeyToUci("proton-host-aliases", json);
    }
  }

  function loadHostAliases() {
    try {
      const raw = localStorage.getItem("proton-host-aliases");
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function updateSubtitle(card, hosts) {
    const el = card.querySelector('[data-role="subtitle"]');
    if (!el) return;
    const wifiCount = hosts.filter(h => h.type === "wifi").length;
    const lanCount = hosts.length - wifiCount;
    const parts = [];
    if (wifiCount) parts.push(`${wifiCount} ${t("Wi-Fi")}`);
    if (lanCount) parts.push(`${lanCount} LAN`);
    el.textContent = parts.length ? parts.join(" · ") : t("No active clients");
  }

  function updateFooter(card, hosts) {
    const el = card.querySelector('[data-role="footer"]');
    if (!el) return;
    let totalRx = 0, totalTx = 0;
    hosts.forEach(h => { totalRx += h.rateRx || 0; totalTx += h.rateTx || 0; });
    el.textContent = `▼ ${formatRate(totalRx)}  ▲ ${formatRate(totalTx)}`;
  }

  function setStatusDot(card, state) {
    const dot = card.querySelector('[data-role="status-dot"]');
    if (dot) dot.dataset.state = state;
  }

  async function poll() {
    if (!mounted || document.hidden) return;
    if (isEditingHostName) return; // Не перерисовываем, если идёт ввод имени

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

  function openHostsFilterModal() {
    loadHostsFilter().then((currentFilter) => {
      const overlay = document.createElement("div");
      overlay.className = "proton-confirm-modal-overlay";
      const modal = document.createElement("div");
      modal.className = "proton-confirm-modal";
      modal.style.maxWidth = "480px";

      let checkboxesHtml = "";
      let aliasesHtml = "";
      const aliasMacs = Object.keys(hostAliases);

      if (aliasMacs.length === 0) {
        aliasesHtml = '<div style="font-size:0.85rem;color:var(--proton-muted);">' + t("No custom names yet") + '</div>';
      } else {
        const parts = [];
        aliasMacs.sort().forEach(function (mac) {
          let h = '';
          h += '<div class="proton-hosts-alias-row" data-mac="' + escapeHtml(mac) + '" style="display:flex;align-items:center;gap:8px;padding:4px 0;">';
          h += '<span style="font-family:monospace;font-size:0.75rem;color:var(--proton-muted);">' + escapeHtml(mac) + '</span>';
          h += '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(hostAliases[mac]) + '</span>';
          h += '<button type="button" class="cbi-button cbi-button-remove proton-hosts-alias-del" data-mac="' + escapeHtml(mac) + '" style="padding:2px 8px;font-size:0.75rem;">×</button>';
          h += '</div>';
          parts.push(h);
        });
        aliasesHtml = parts.join('');
      }

      if (availableSubnets.size === 0) {
        checkboxesHtml = '<div style="font-size:0.85rem;color:var(--proton-muted);">' + t("No subnets detected") + '</div>';
      } else {
        Array.from(availableSubnets).sort().forEach(subnet => {
          const checked = currentFilter.includes(subnet);
          checkboxesHtml += '<label style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer;">';
          checkboxesHtml += '  <input type="checkbox" value="' + subnet + '" class="proton-hosts-filter-cb" ' + (checked ? 'checked' : '') + '>';
          checkboxesHtml += '  <span>' + subnet + '</span>';
          checkboxesHtml += '</label>';
        });
      }

      modal.innerHTML = `
      <h3>${t("Hosts filter")}</h3>
      <div class="proton-network-modal-body">
      <div style="margin-bottom:12px;">
      <div style="font-size:0.85rem;font-weight:600;margin-bottom:8px;">${t("Detected subnets")}</div>
      <div id="proton-hosts-filter-list" style="max-height:150px;overflow-y:auto;padding:8px;border:1px solid var(--proton-border);border-radius:var(--proton-radius-sm);">
      ${checkboxesHtml}
      </div>
      <div style="font-size:0.75rem;color:var(--proton-muted);margin-top:6px;">
      ${t("Check the networks you want to see. Uncheck all to show everything.")}
      </div>
      </div>
      <div style="margin-top:12px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
      <div style="font-size:0.85rem;font-weight:600;">${t("Custom device names")}</div>
      <button type="button" id="proton-hosts-clear-all-aliases" class="cbi-button cbi-button-neutral" style="padding:2px 8px;font-size:0.75rem;">
      ${t("Clear all")}
      </button>
      </div>
      <div id="proton-hosts-aliases-list" style="max-height:150px;overflow-y:auto;padding:8px;border:1px solid var(--proton-border);border-radius:var(--proton-radius-sm);">
      ${aliasesHtml}
      </div>
      </div>
      <div>
      <div style="font-size:0.85rem;font-weight:600;margin-bottom:6px;">${t("Custom subnets (CIDR)")}</div>
      <input type="text" id="proton-hosts-filter-custom" class="cbi-input-text" style="width:100%;" placeholder="192.168.2.0/24, 10.0.0.0/8" value="${currentFilter.filter(s => !availableSubnets.has(s)).join(', ')}">
      <div style="font-size:0.75rem;color:var(--proton-muted);margin-top:6px;">
      ${t("Comma-separated CIDR. Adds to the list above.")}
      </div>
      </div>
      </div>
      <div class="proton-confirm-modal-actions">
      <button type="button" class="cbi-button cbi-button-neutral" data-action="cancel">${t("Cancel")}</button>
      <button type="button" class="cbi-button cbi-button-positive" data-action="save">${t("Save")}</button>
      </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add("is-open"));

      const closeModal = () => {
        overlay.classList.remove("is-open");
        setTimeout(() => overlay.remove(), 220);
      };

      modal.querySelector('[data-action="cancel"]').addEventListener("click", closeModal);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

      modal.querySelectorAll(".proton-hosts-alias-del").forEach(function (btn) {
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          const mac = btn.dataset.mac;
          if (!mac) return;
          saveHostAlias(mac, "");
          const row = btn.closest(".proton-hosts-alias-row");
          if (row) row.remove();
          if (modal.querySelectorAll(".proton-hosts-alias-row").length === 0) {
            const listEl = modal.querySelector("#proton-hosts-aliases-list");
            if (listEl) listEl.innerHTML = '<div style="font-size:0.85rem;color:var(--proton-muted);">' + t("No custom names yet") + '</div>';
          }
        });
      });

      const clearAllBtn = modal.querySelector("#proton-hosts-clear-all-aliases");
      if (clearAllBtn) {
        clearAllBtn.addEventListener("click", function () {
          if (Object.keys(hostAliases).length === 0) return;
          if (!confirm(t("Clear all custom device names?"))) return;
          hostAliases = {};
          const json = "{}";
          try { localStorage.setItem("proton-host-aliases", json); } catch (e) {}
          if (window.protonSettingsSync && typeof window.protonSettingsSync.saveLocalKeyToUci === "function") {
            window.protonSettingsSync.saveLocalKeyToUci("proton-host-aliases", json);
          }
          const listEl = modal.querySelector("#proton-hosts-aliases-list");
          if (listEl) listEl.innerHTML = '<div style="font-size:0.85rem;color:var(--proton-muted);">' + t("No custom names yet") + '</div>';
        });
      }

      modal.querySelector('[data-action="save"]').addEventListener("click", async () => {
        const checked = Array.from(modal.querySelectorAll(".proton-hosts-filter-cb:checked")).map(cb => cb.value);
        const customVal = modal.querySelector("#proton-hosts-filter-custom").value;
        const custom = customVal.split(",").map(s => s.trim()).filter(Boolean);

        const validCustom = custom.filter(c => /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(c));
        if (validCustom.length !== custom.length) {
          alert(t("Invalid CIDR format in custom subnets"));
          return;
        }

        const finalFilter = [...new Set([...checked, ...validCustom])];

        let isAllSelected = false;
        if (availableSubnets.size > 0 && validCustom.length === 0) {
          isAllSelected = Array.from(availableSubnets).every(sub => finalFilter.includes(sub));
        }

        const payload = isAllSelected ? [] : finalFilter;

        localStorage.setItem("proton-hosts-filter", JSON.stringify(payload));
        if (window.protonSettingsSync && typeof window.protonSettingsSync.saveLocalKeyToUci === "function") {
          await window.protonSettingsSync.saveLocalKeyToUci("proton-hosts-filter", JSON.stringify(finalFilter));
        }
        hostsFilterSubnets = null;
        closeModal();
        poll();
      });
    });
  }

  async function start() {
    const card = ensureCard();
    if (!card) return false;
    if (pollTimer) return true;

    hostAliases = loadHostAliases();
    initTooltip();

    const settingsBtn = card.querySelector('[data-role="hosts-settings"]');
    if (settingsBtn && !settingsBtn.dataset.protonBound) {
      settingsBtn.dataset.protonBound = "1";
      settingsBtn.addEventListener("click", openHostsFilterModal);
    }

    await fetchLocalAddressesAndSubnets();
    poll();
    pollTimer = setInterval(poll, POLL_INTERVAL);

    visibilityHandler = () => { if (!document.hidden) poll(); };
    document.addEventListener("visibilitychange", visibilityHandler);
    return true;
  }

  function stop() {
    mounted = false;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (visibilityHandler) { document.removeEventListener("visibilitychange", visibilityHandler); visibilityHandler = null; }
  }

  function isOverviewPage() {
    return document.body.dataset.page === "admin-status-overview" || window.location.pathname.includes("/admin/status/overview");
  }

  function init() {
    if (!isOverviewPage()) return;
    start();
  }

  let tooltipEl = null;
  let lastHoveredRow = null;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let isHoveringList = false;

  function initTooltip() {
    if (tooltipEl) return;
    tooltipEl = document.createElement("div");
    tooltipEl.className = "proton-hosts-tooltip";
    tooltipEl.style.display = "none";
    document.body.appendChild(tooltipEl);

    document.addEventListener("mousemove", (e) => {
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      if (!isHoveringList) return;

      const row = e.target.closest(".proton-hosts-row");
      if (row && row === lastHoveredRow) {
        updateTooltipPosition();
      } else if (row) {
        lastHoveredRow = row;
        showTooltip(row);
      } else if (lastHoveredRow && !e.target.closest(".proton-hosts-list-inner")) {
        hideTooltip();
      }
    }, { passive: true });

    const list = document.querySelector(".proton-hosts-list");
    if (list) {
      list.addEventListener("mouseenter", () => { isHoveringList = true; });
      list.addEventListener("mouseleave", () => { isHoveringList = false; hideTooltip(); });
    }
  }

  function showTooltip(row) {
    if (!tooltipEl) return;
    const name = row.dataset.hName || "";
    const ipv4 = row.dataset.hIpv4 || "";
    const ipv6 = row.dataset.hIpv6 || "";
    const rx = row.dataset.hRx || "0 B";
    const tx = row.dataset.hTx || "0 B";
    const mac = row.dataset.mac || "";

    let html = '<div class="proton-hosts-tooltip-title">' + escapeHtml(name) + '</div>';
    if (ipv4) html += '<div class="proton-hosts-tooltip-row"><strong>IPv4:</strong> ' + escapeHtml(ipv4) + '</div>';
    if (ipv6) html += '<div class="proton-hosts-tooltip-row"><strong>IPv6:</strong> ' + escapeHtml(ipv6) + '</div>';
    html += '<div class="proton-hosts-tooltip-row"><strong>MAC:</strong> ' + escapeHtml(mac) + '</div>';
    html += '<div class="proton-hosts-tooltip-divider"></div>';
    html += '<div class="proton-hosts-tooltip-row"><strong>' + t("Total RX") + ':</strong> ' + escapeHtml(rx) + '</div>';
    html += '<div class="proton-hosts-tooltip-row"><strong>' + t("Total TX") + ':</strong> ' + escapeHtml(tx) + '</div>';

    tooltipEl.innerHTML = html;
    tooltipEl.style.display = "block";
    updateTooltipPosition();
  }

  function updateTooltipPosition() {
    if (!tooltipEl || tooltipEl.style.display === "none") return;
    let x = lastMouseX + 15;
    let y = lastMouseY + 15;
    const rect = tooltipEl.getBoundingClientRect();
    if (x + rect.width > window.innerWidth - 10) x = lastMouseX - rect.width - 10;
    if (y + rect.height > window.innerHeight - 10) y = lastMouseY - rect.height - 10;
    tooltipEl.style.left = x + "px";
    tooltipEl.style.top = y + "px";
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = "none";
    lastHoveredRow = null;
  }

  window.ProtonDashboardHosts = { start, stop };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
