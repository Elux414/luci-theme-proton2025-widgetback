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

  // Хранилище истории трафика по MAC
  const hostHistory = new Map();

  // --- Загрузка IP и подсетей ---
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

      raw.interface.forEach(iface => {
        (iface['ipv4-address'] || []).forEach(addr => {
          if (addr && addr.address) {
            localIPs.add(addr.address);
            // Формируем подсеть из IP и маски
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
          if (addr && addr.address) localIPs.add(addr.address);
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

  // Проверка: входит ли IP в подсеть (IPv4)
  function ipInSubnet(ip, cidr) {
    if (!ip || !cidr) return false;
    if (ip.indexOf(':') !== -1) return true; // IPv6 не фильтруем
    const idx = cidr.indexOf('/');
    if (idx < 0) return false;
    const base = cidr.slice(0, idx);
    const mask = parseInt(cidr.slice(idx + 1), 10);
    if (isNaN(mask)) return false;

    const ipParts = ip.split('.');
    const baseParts = base.split('.');
    if (ipParts.length !== 4 || baseParts.length !== 4) return false;

    const ipNum = (parseInt(ipParts[0]) << 24) + (parseInt(ipParts[1]) << 16) + (parseInt(ipParts[2]) << 8) + parseInt(ipParts[3]);
    const baseNum = (parseInt(baseParts[0]) << 24) + (parseInt(baseParts[1]) << 16) + (parseInt(baseParts[2]) << 8) + parseInt(baseParts[3]);
    const shift = 32 - mask;
    return ((ipNum >>> shift) === (baseNum >>> shift));
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

  function pickBestIp(hints) {
    if (!hints) return "";
    let ip = "";
    // Приоритет IPv4
    if (Array.isArray(hints.ipaddrs) && hints.ipaddrs.length) {
      ip = hints.ipaddrs[0];
    } else if (Array.isArray(hints.ip6addrs) && hints.ip6addrs.length) {
      // Игнорируем link-local и loopback
      const valid = hints.ip6addrs.filter(a => a && !a.startsWith("fe80:") && a !== "::1");
      if (valid.length) ip = valid[0];
    }
    if (ip && typeof ip === "string") ip = ip.split("/")[0];
    return ip;
  }

  // --- Сбор данных ---
  async function collectWiFiClients() {
    const map = new Map();
    if (!callIwinfoDevices) return map;
    let devices = [];
    try {
      const res = await L.resolveDefault(callIwinfoDevices(), null);
      if (res && Array.isArray(res.devices)) devices = res.devices;
    } catch (e) {}
    await Promise.all(devices.map(async (device) => {
      try {
        const res = await L.resolveDefault(callIwinfoAssoclist(device), null);
        const results = res && Array.isArray(res.results) ? res.results : [];
        results.forEach((client) => {
          const mac = normalizeMac(client.mac);
          if (!mac) return;
          map.set(mac, { signal: Number(client.signal), device: device });
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
        const ip = pickBestIp(hintsRes[rawMac]);
        if (ip) ipByMac.set(mac, ip);
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
	
	// Добавляем IPv6-адреса роутера в localIPs.
    // Если MAC-адрес уже есть в localIPs по IPv4, считаем его роутером.
    if (hintsRes && typeof hintsRes === "object") {
      for (const rawMac of Object.keys(hintsRes)) {
        const mac = normalizeMac(rawMac);
        const ipv4 = pickBestIp(hintsRes[rawMac]);
        // Если у этого MAC есть IPv4, который уже в localIPs — это роутер.
        // Его IPv6 тоже добавляем в исключения.
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
      
      const ip = ipByMac.get(mac) || "";
      const ipClean = ip.split("/")[0];
	  if (ipClean.startsWith("fe80:") || ipClean === "::1") {
        continue;
      }
      if (localIPs.has(ipClean)) continue;

      // Фильтр по подсетям
      if (filterSubnets.length > 0 && !ipInAnySubnet(ipClean, filterSubnets)) {
        continue;
      }

      const traffic = trafficByMac[mac] || trafficByMac[mac.toUpperCase()] || null;
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

      hosts.push({
        mac: mac,
        hostname: hostnameByMac.get(mac) || "",
        ip: ip,
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

    return { hosts, timestamp: now };
  }

  // --- UI ---
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
    const lan = hosts.filter(h => h.type === 'lan');

    const renderItem = (h) => `
      <li class="proton-hosts-row" data-mac="${h.mac}">
        <span class="proton-hosts-icon">${h.type === 'wifi' ? '📱' : '💻'}</span>
        <div class="proton-hosts-main">
          <div class="proton-hosts-top">
            <span class="proton-hosts-name">${h.hostname || t('Unknown')}</span>
            <span class="proton-hosts-ip">${h.ip || h.mac}</span>
          </div>
          <div class="proton-hosts-bottom">
            <span class="proton-hosts-type">${h.type === 'wifi' ? t('Wi-Fi') : 'LAN'}</span>
            <span class="proton-hosts-rates">
              <span class="proton-hosts-rate-rx">▼ ${formatRate(h.rateRx)}</span>
              <span class="proton-hosts-rate-tx">▲ ${formatRate(h.rateTx)}</span>
            </span>
          </div>
        </div>
        <div class="proton-hosts-chart">${buildSparkline(h.rxHistory, h.txHistory)}</div>
      </li>`;

    list.innerHTML = `
      <div class="proton-hosts-columns">
        <div class="proton-hosts-column">
          <h4 class="proton-hosts-col-title">Wi-Fi (${wifi.length})</h4>
          <ul class="proton-hosts-list-inner">${wifi.map(renderItem).join('') || '<li class="proton-hosts-empty">' + t('No active clients') + '</li>'}</ul>
        </div>
        <div class="proton-hosts-column">
          <h4 class="proton-hosts-col-title">LAN (${lan.length})</h4>
          <ul class="proton-hosts-list-inner">${lan.map(renderItem).join('') || '<li class="proton-hosts-empty">' + t('No active clients') + '</li>'}</ul>
        </div>
      </div>
    `;
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

  // --- Модалка фильтра ---
  function openHostsFilterModal() {
    loadHostsFilter().then((currentFilter) => {
      const overlay = document.createElement("div");
      overlay.className = "proton-confirm-modal-overlay";
      const modal = document.createElement("div");
      modal.className = "proton-confirm-modal";
      modal.style.maxWidth = "480px";

      let checkboxesHtml = "";
      if (availableSubnets.size === 0) {
        checkboxesHtml = `<div style="font-size:0.85rem;color:var(--proton-muted);">${t("No subnets detected")}</div>`;
      } else {
        // Если фильтр пуст, значит "показывать всё", и все галочки должны быть СНЯТЫ.
        // Если в фильтре что-то есть, ставим галочки только на выбранное.
        Array.from(availableSubnets).sort().forEach(subnet => {
          const checked = currentFilter.includes(subnet);
          checkboxesHtml += `
            <label style="display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer;">
              <input type="checkbox" value="${subnet}" class="proton-hosts-filter-cb" ${checked ? 'checked' : ''}>
              <span>${subnet}</span>
            </label>
          `;
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
          <div>
            <div style="font-size:0.85rem;font-weight:600;margin-bottom:6px;">${t("Custom subnets (CIDR)")}</div>
            <input type="text" id="proton-hosts-filter-custom" class="cbi-input-text" 
                   style="width:100%;" placeholder="192.168.2.0/24, 10.0.0.0/8" 
                   value="${currentFilter.filter(s => !availableSubnets.has(s)).join(', ')}">
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
        
        // Если пользователь отметил все существующие подсети и не добавил кастомных,
        // это равносильно "показывать всё" (пустой фильтр).
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

  window.ProtonDashboardHosts = { start, stop };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();