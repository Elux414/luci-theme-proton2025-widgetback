/**
 * Proton2025 Dashboard — Hosts widget
 * Copyright 2025-2026 ChesterGoodiny
 * Licensed under the Apache License, Version 2.0
 *
 * Скорость: conntrack-дельты (адаптивный опрос). Тоталы: nlbwmon (LAN/Wi-Fi),
 * для пиров за WAN — сессионные накопления conntrack (копятся, пока виджет открыт).
 * Наблюдаемые сети передаются в RPC строкой через запятую.
 */
(function () {
	"use strict";

	const META_MS = 20000;
	const RATE_MIN = 800, RATE_MAX = 8000;
	const SPARK_MAX_POINTS = 240;
	const WIFI_TTL = 24 * 3600 * 1000;
	const CPU_BUDGET = 0.06;

	// Канонические ключи. K_FILTER и K_ALIASES есть в SETTINGS_MAP → живут в UCI.
	const K_FILTER  = "proton-hosts-filter";
	const K_FILTER_MINE = "proton-hosts-network-filter";
	const K_ALIASES = "proton-host-aliases";
	const K_CUSTOM  = "proton-hosts-custom-subnets";
	const K_PREFS   = "proton-hosts-prefs";
	const K_FILTER_OLD  = "proton-hosts-filter";
	const K_ALIASES_OLD = "proton-hosts-aliases";

	const DEFAULTS = {
		sort: "activity", units: "bytes", release: 2.0,
		hot: 1048576, speed: "auto", window: 60
	};

	let prefs = Object.assign({}, DEFAULTS);
	let hostAliases = {}, filterSubnets = null;
	let detectedSubnets = new Set(), customSubnets = [], availableSubnets = new Set();

	let mounted = false, rateTimer = null, metaTimer = null;
	let rateBusy = false, metaBusy = false, editing = false;
	let visHandler = null, syncHandler = null;

	let rpcRates, rpcAcct, rpcTraffic, rpcHints, rpcLeases, rpcIwDev, rpcIwAssoc, rpcIfaces;

	const registry = new Map();
	const ipToMac = new Map();
	const rateState = new Map();
	const rowRefs = new Map();
	const wifiCache = new Map();
	const synthetic = new Map();

	let localIPs = new Set(), vpnSubnets = [];
	let listSignature = "";
	let source = "—", coarse = false, offloaded = 0, connCount = 0;
	let rtt = 40, totalRate = 0, interval = 1500, lastOrder = 0;
	let tipEl = null, tipRow = null, mouseX = 0, mouseY = 0;

	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

	/* ── utils ── */

	function t(v) {
		if (typeof window.protonT === "function") {
			try { const s = window.protonT(v); if (s && s !== v) return s; } catch (e) {}
		}
		if (window.L && typeof L.tr === "function") { const s = L.tr(v); if (s && s !== v) return s; }
		return v;
	}
	function esc(v) {
		return String(v == null ? "" : v).replace(/[&<>"']/g, c =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
	}
	function normMac(m) {
		const s = String(m || "").toLowerCase().replace(/[^0-9a-f]/g, "");
		return s.length === 12 ? s.match(/../g).join(":") : null;
	}
	function bareIp(v) { return String(v || "").split("/")[0].split("%")[0].trim(); }
	function readLS(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
	function writeLS(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
	function uciSave(k, v) {
		if (window.protonSettingsSync && typeof window.protonSettingsSync.saveLocalKeyToUci === "function")
			return window.protonSettingsSync.saveLocalKeyToUci(k, v);
		return Promise.resolve(false);
	}
	function persist(k, v) { writeLS(k, v); uciSave(k, v); }

	function formatBytes(b) {
		b = Number(b) || 0;
		const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
		while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
		return (i === 0 ? b.toFixed(0) : b.toFixed(b < 10 ? 2 : 1)) + " " + u[i];
	}
	function formatRate(bps) {
		bps = Math.max(0, Number(bps) || 0);
		if (prefs.units === "bits") {
			let v = bps * 8; const u = ["bit/s", "Kbit/s", "Mbit/s", "Gbit/s"]; let i = 0;
			while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
			return (i === 0 ? v.toFixed(0) : v.toFixed(v < 10 ? 2 : 1)) + " " + u[i];
		}
		let v = bps; const u = ["B/s", "KB/s", "MB/s", "GB/s"]; let i = 0;
		while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
		return (i === 0 ? v.toFixed(0) : v.toFixed(v < 10 ? 2 : 1)) + " " + u[i];
	}
	// nlbwmon приоритетен; для пиров без nlbw-записей — сессионные тоталы conntrack.
	function totalBytes(h, dir) {
		const nlbw = dir === "rx" ? (h.rxBytes || 0) : (h.txBytes || 0);
		const sess = dir === "rx" ? (h.sessRx || 0) : (h.sessTx || 0);
		return nlbw > 0 ? nlbw : sess;
	}

	/* ── CIDR ── */

	function ip4ToInt(ip) {
		const p = bareIp(ip).split(".");
		if (p.length !== 4) return null;
		let n = 0;
		for (const o of p) {
			if (!/^\d{1,3}$/.test(o)) return null;
			const v = parseInt(o, 10);
			if (v > 255) return null;
			n = n * 256 + v;
		}
		return n >>> 0;
	}
	function ip6ToHex(ip) {
		let s = bareIp(ip).toLowerCase();
		if (!s) return null;
		if (s.indexOf(".") >= 0) {
			const i = s.lastIndexOf(":");
			const v = ip4ToInt(s.slice(i + 1));
			if (v === null) return null;
			s = s.slice(0, i + 1) + ((v >>> 16) & 0xffff).toString(16) + ":" + (v & 0xffff).toString(16);
		}
		const halves = s.split("::");
		if (halves.length > 2) return null;
		let groups;
		if (halves.length === 2) {
			const head = halves[0] ? halves[0].split(":") : [];
			const tail = halves[1] ? halves[1].split(":") : [];
			const miss = 8 - head.length - tail.length;
			if (miss < 0) return null;
			groups = head.concat(new Array(miss).fill("0"), tail);
		} else groups = s.split(":");
		if (groups.length !== 8) return null;
		let out = "";
		for (const g of groups) {
			if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
			out += g.padStart(4, "0");
		}
		return out;
	}
	function ip4InNet(ip, cidr) {
		const [net, raw] = String(cidr).split("/");
		const bits = raw === undefined ? 32 : parseInt(raw, 10);
		if (!(bits >= 0 && bits <= 32)) return false;
		const a = ip4ToInt(ip), b = ip4ToInt(net);
		if (a === null || b === null) return false;
		if (bits === 0) return true;
		const sh = 32 - bits;
		return (a >>> sh) === (b >>> sh);
	}
	function ip6InNet(ip, cidr) {
		const [net, raw] = String(cidr).split("/");
		const bits = raw === undefined ? 128 : parseInt(raw, 10);
		if (!(bits >= 0 && bits <= 128)) return false;
		const a = ip6ToHex(ip), b = ip6ToHex(net);
		if (!a || !b) return false;
		const full = Math.floor(bits / 4), rem = bits % 4;
		if (a.slice(0, full) !== b.slice(0, full)) return false;
		if (rem === 0) return true;
		const sh = 4 - rem;
		return (parseInt(a[full], 16) >> sh) === (parseInt(b[full], 16) >> sh);
	}
	function normalizeCidr(raw) {
		const s = String(raw || "").trim();
		if (!s) return null;
		const parts = s.split("/");
		if (parts.length > 2) return null;
		const addr = parts[0].trim();
		const is6 = addr.indexOf(":") >= 0;
		const max = is6 ? 128 : 32;
		let bits = max;
		if (parts.length === 2) {
			if (!/^\d{1,3}$/.test(parts[1].trim())) return null;
			bits = parseInt(parts[1], 10);
			if (bits > max) return null;
		}
		if (is6 ? !ip6ToHex(addr) : ip4ToInt(addr) === null) return null;
		return (is6 ? addr.toLowerCase() : addr) + "/" + bits;
	}
	function networkOf(ip, bits) {
		if (String(ip).indexOf(":") >= 0) {
			const h = ip6ToHex(ip);
			if (!h) return null;
			const b = Math.max(0, Math.min(128, bits | 0));
			const keep = Math.floor(b / 4), rem = b % 4;
			let out = h.slice(0, keep);
			if (rem) out += (parseInt(h[keep], 16) & (0xf << (4 - rem))).toString(16);
			out = out.padEnd(32, "0");
			const g = out.match(/.{4}/g).map(x => x.replace(/^0+(?=.)/, ""));
			return g.join(":") + "/" + b;
		}
		const v = ip4ToInt(ip);
		if (v === null) return null;
		const b = Math.max(0, Math.min(32, bits | 0));
		const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
		const n = (v & mask) >>> 0;
		return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".") + "/" + b;
	}
	function inSubnet(ip) {
		if (!filterSubnets) return true;
		const v = bareIp(ip);
		if (!v) return false;
		const is6 = v.indexOf(":") >= 0;
		for (const cidr of filterSubnets) {
			if ((cidr.indexOf(":") >= 0) !== is6) continue;
			if (is6 ? ip6InNet(v, cidr) : ip4InNet(v, cidr)) return true;
		}
		return false;
	}
	function inNetOf(ip, cidr) {
		if (!ip) return false;
		return ip.indexOf(":") >= 0 ? ip6InNet(ip, cidr) : ip4InNet(ip, cidr);
	}

	/* ── persistence ── */

	function loadPrefs() {
		try {
			const raw = readLS(K_PREFS);
			if (raw) Object.assign(prefs, JSON.parse(raw));
		} catch (e) {}
		prefs.release = Math.min(8, Math.max(0.3, Number(prefs.release) || 2));
		prefs.hot = Math.max(4096, Number(prefs.hot) || DEFAULTS.hot);
		prefs.window = [30, 60, 120].indexOf(Number(prefs.window)) >= 0 ? Number(prefs.window) : 60;
		if (["activity", "name"].indexOf(prefs.sort) < 0) prefs.sort = "activity";
		if (["bytes", "bits"].indexOf(prefs.units) < 0) prefs.units = "bytes";
		if (["auto", "fast", "calm"].indexOf(prefs.speed) < 0) prefs.speed = "auto";
	}
	function savePrefs() { persist(K_PREFS, JSON.stringify(prefs)); }

	function loadAliases() {
		let out = {};
		try { out = JSON.parse(readLS(K_ALIASES) || "{}") || {}; } catch (e) {}
		if (typeof out !== "object" || Array.isArray(out)) out = {};
		try {
			const alt = JSON.parse(readLS(K_ALIASES_OLD) || "{}") || {};
			const keys = Object.keys(alt);
			if (keys.length) {
				for (const k of keys) if (!out[k]) out[k] = alt[k];
				try { localStorage.removeItem(K_ALIASES_OLD); } catch (e) {}
				writeLS(K_ALIASES, JSON.stringify(out));
				uciSave(K_ALIASES, JSON.stringify(out));
			}
		} catch (e) {}
		hostAliases = out;
	}
	function persistAliases() { persist(K_ALIASES, JSON.stringify(hostAliases)); }
	function saveHostAlias(mac, name) {
		const v = String(name || "").trim();
		if (v) hostAliases[mac] = v; else delete hostAliases[mac];
		persistAliases();
	}

	function loadCustom() {
		try {
			const arr = JSON.parse(readLS(K_CUSTOM) || "[]");
			customSubnets = Array.isArray(arr)
				? Array.from(new Set(arr.map(normalizeCidr).filter(Boolean))) : [];
		} catch (e) { customSubnets = []; }
	}
	function saveCustom() { persist(K_CUSTOM, JSON.stringify(customSubnets)); }

	function loadFilter() {
		let arr = null;
		try { arr = JSON.parse(readLS(K_FILTER) || "null"); } catch (e) {}
		if (!Array.isArray(arr) || !arr.length) {
			try {
				const mine = JSON.parse(readLS(K_FILTER_MINE) || "null");
				if (Array.isArray(mine) && mine.length) {
					arr = mine;
					writeLS(K_FILTER, JSON.stringify(mine));
					uciSave(K_FILTER, JSON.stringify(mine));
					try { localStorage.removeItem(K_FILTER_MINE); } catch (e) {}
				}
			} catch (e) {}
		}
		if (Array.isArray(arr) && arr.length) {
			const norm = Array.from(new Set(arr.map(normalizeCidr).filter(Boolean)));
			filterSubnets = norm.length ? new Set(norm) : null;
		} else filterSubnets = null;
	}
	function saveFilter() {
		persist(K_FILTER, JSON.stringify(filterSubnets ? Array.from(filterSubnets) : []));
	}

	function rebuildSubnets() {
		availableSubnets = new Set([...detectedSubnets, ...customSubnets]);
		if (filterSubnets) for (const s of filterSubnets) availableSubnets.add(s);
	}

	function watchedNetworks() {
		const out = new Set(availableSubnets);
		for (const s of customSubnets) out.add(s);
		if (filterSubnets) for (const s of filterSubnets) out.add(s);
		return Array.from(out);
	}

	/* ── RPC ── */

	function ensureRpc() {
		if (!window.L || !L.rpc || typeof L.rpc.declare !== "function") return false;
		const d = (o, m) => L.rpc.declare({ object: o, method: m, expect: { "": {} } });
		if (!rpcRates) rpcRates = L.rpc.declare({
			object: "luci.proton-hostrates", method: "getRates",
			params: ["networks"], expect: { "": {} }
		});
		rpcAcct    = rpcAcct    || d("luci.proton-hostrates", "enableAccounting");
		rpcTraffic = rpcTraffic || d("luci.proton-nlbw", "getHostTraffic");
		rpcHints   = rpcHints   || d("luci-rpc", "getHostHints");
		rpcLeases  = rpcLeases  || d("luci-rpc", "getDHCPLeases");
		rpcIwDev   = rpcIwDev   || d("iwinfo", "devices");
		rpcIwAssoc = rpcIwAssoc || L.rpc.declare({
			object: "iwinfo", method: "assoclist", params: ["device"], expect: { "": {} }
		});
		rpcIfaces  = rpcIfaces  || d("network.interface", "dump");
		return true;
	}
	const soft = p => Promise.resolve(p).catch(() => null);

	/* ── сетевой контекст ── */

	async function fetchContext() {
		const dump = await soft(rpcIfaces());
		localIPs = new Set(); vpnSubnets = [];
		const found = new Set();
		if (dump && Array.isArray(dump.interface)) {
			for (const i of dump.interface) {
				const name = String(i.interface || "").toLowerCase();
				if (name === "loopback") continue;
				const dev = String(i.device || i.l3_device || i.ifname || "").toLowerCase();
				const proto = String(i.proto || "").toLowerCase();
				const isVpn = proto === "wireguard" || /^(wg|zt|tun|tap|ppp|l2tp)/.test(dev);

				for (const a of (i["ipv4-address"] || [])) {
					if (!a || !a.address) continue;
					if (a.address.startsWith("127.")) continue;
					localIPs.add(a.address);
					const net = networkOf(a.address, a.mask == null ? 24 : a.mask);
					if (net) { found.add(net); if (isVpn) vpnSubnets.push(net); }
				}
				for (const p of (i["ipv6-prefix"] || [])) {
					if (!p || !p.address) continue;
					const net = networkOf(p.address, p.mask == null ? 64 : p.mask);
					if (net) { found.add(net); if (isVpn) vpnSubnets.push(net); }
				}
			}
		}
		detectedSubnets = found;
		rebuildSubnets();
	}

	/* ── реестр хостов (медленный цикл) ── */

	function groupOf(h) { return h.type === "wifi" ? "wifi" : h.type === "remote" ? "net" : "lan"; }

	function makeSynthetic(ip) {
		const mac = "ip:" + ip;
		const is6 = ip.indexOf(":") >= 0;
		const h = {
			mac, ips: [ip], ip: is6 ? "" : ip, ipv6: is6 ? ip : "",
			name: "", type: "remote", signal: null, rxBytes: 0, txBytes: 0
		};
		h.display = hostAliases[mac] || ip;
		synthetic.set(ip, h);
		return h;
	}

	async function collectMeta() {
		if (metaBusy || !mounted) return;
		metaBusy = true;
		try {
			const [hints, leases, traffic, devs] = await Promise.all([
				soft(rpcHints()), soft(rpcLeases()), soft(rpcTraffic()), soft(rpcIwDev())
			]);

			const seen = new Map();
			const put = mac => {
				if (!mac) return null;
				let h = seen.get(mac);
				if (!h) {
					h = { mac, ips: [], name: "", type: "lan", signal: null, rxBytes: 0, txBytes: 0 };
					seen.set(mac, h);
				}
				return h;
			};
			const addIp = (h, ip) => {
				const v = bareIp(ip);
				if (v && h.ips.indexOf(v) < 0) h.ips.push(v);
			};

			if (hints) for (const k in hints) {
				const h = put(normMac(k)); if (!h) continue;
				const src = hints[k] || {};
				(src.ipaddrs || []).forEach(x => addIp(h, x));
				(src.ip6addrs || []).forEach(x => addIp(h, x));
				if (src.name) h.name = src.name;
			}

			const l4 = (leases && leases.dhcp_leases) || [];
			const l6 = (leases && leases.dhcp6_leases) || [];
			for (const l of l4.concat(l6)) {
				const h = put(normMac(l.macaddr)); if (!h) continue;
				addIp(h, l.ipaddr || l.ip6addr);
				if (l.hostname && !h.name) h.name = l.hostname;
			}

			if (traffic && traffic.success && traffic.hosts) for (const k in traffic.hosts) {
				const h = put(normMac(k)); if (!h) continue;
				h.rxBytes = Number(traffic.hosts[k].rx_bytes) || 0;
				h.txBytes = Number(traffic.hosts[k].tx_bytes) || 0;
			}

			if (devs && Array.isArray(devs.result)) {
				for (const dev of devs.result) {
					const list = await soft(rpcIwAssoc(dev));
					for (const st of ((list && list.results) || [])) {
						const mac = normMac(st.mac); if (!mac) continue;
						wifiCache.set(mac, { at: Date.now(), signal: st.signal });
						const h = put(mac); if (!h) continue;
						h.type = "wifi"; h.signal = st.signal;
					}
				}
			}

			const now = Date.now();
			for (const [mac, c] of wifiCache) {
				if (now - c.at > WIFI_TTL) { wifiCache.delete(mac); continue; }
				const h = seen.get(mac);
				if (h) { h.type = "wifi"; if (h.signal == null) h.signal = c.signal; }
			}

			// Пиры за WAN, найденные conntrack — сохраняем между циклами.
			for (const [ip, sh] of synthetic) {
				if (seen.has(sh.mac)) continue;
				const h = put(sh.mac);
				if (h) { h.ips = [ip]; h.type = "remote"; h.ip = sh.ip; h.ipv6 = sh.ipv6; }
			}

			registry.clear(); ipToMac.clear();
			for (const [mac, h] of seen) {
				h.ips.sort((a, b) => (a.indexOf(":") < 0 ? 0 : 1) - (b.indexOf(":") < 0 ? 0 : 1));
				h.ip = h.ips.find(x => x.indexOf(":") < 0) || "";
				h.ipv6 = h.ips.find(x => x.indexOf(":") >= 0) || "";
				if (h.type !== "remote" && localIPs.has(h.ip)) continue;
				if (h.type !== "wifi" && h.type !== "remote" && vpnSubnets.some(s => inNetOf(h.ip, s)))
					h.type = "lan-vpn";
				h.display = hostAliases[mac] || h.name || h.ip || h.ipv6 || mac;
				const prev = rateState.get(mac);
				h.rateRx = prev ? prev.rx : 0;
				h.rateTx = prev ? prev.tx : 0;
				registry.set(mac, h);
				for (const ip of h.ips) ipToMac.set(ip, mac);
			}

			renderList();
		} finally { metaBusy = false; }
	}

	function refreshNames() {
		for (const [mac, h] of registry)
			h.display = hostAliases[mac] || h.name || h.ip || h.ipv6 || mac;
		for (const [ip, h] of synthetic) h.display = hostAliases[h.mac] || ip;
		listSignature = "";
		renderList();
	}

	/* ── скорость (быстрый цикл) ── */

	function stateFor(mac) {
		let s = rateState.get(mac);
		if (!s) {
			s = { prevRx: null, prevTx: null, prevT: 0, lastT: 0,
			      rx: 0, tx: 0, samples: [], scale: 65536 };
			rateState.set(mac, s);
		}
		return s;
	}

	function pickInterval() {
		if (prefs.speed === "calm") return 4000;
		if (prefs.speed === "fast") return Math.max(RATE_MIN, Math.ceil(rtt / CPU_BUDGET));
		const base = totalRate > 262144 ? 1000 : totalRate > 16384 ? 1500 : 4000;
		const floor = connCount > 6000 ? 3000 : connCount > 2500 ? 1500 : RATE_MIN;
		return Math.min(RATE_MAX, Math.max(base, floor, Math.ceil(rtt / CPU_BUDGET)));
	}

	function schedule() {
		if (!mounted) return;
		if (rateTimer) clearTimeout(rateTimer);
		rateTimer = setTimeout(tickRates, interval);
	}

	async function tickRates() {
		rateTimer = null;
		if (!mounted || document.hidden || rateBusy) return schedule();
		rateBusy = true;
		const t0 = performance.now();
		let res = null;
		try { res = await soft(rpcRates(watchedNetworks().join(","))); }
		finally { rateBusy = false; }
		rtt = rtt * 0.7 + (performance.now() - t0) * 0.3;

		const card = document.getElementById("proton-dashboard-hosts");
		if (!card || !mounted) return;

		if (!res || !res.success) {
			const acctOff = res && res.reason === "acct-off";
			source = acctOff ? "acct-off" : "offline";
			setStatus(card, acctOff ? "warn" : "err");
			renderNotice(card);
			return schedule();
		}

		source = res.source; coarse = !!res.coarse;
		connCount = res.conns || 0; offloaded = res.offloaded || 0;
		setStatus(card, coarse || offloaded > 0 ? "warn" : "ok");
		renderNotice(card);

		const now = performance.now(), tSec = now / 1000;
		const byMac = new Map();
		let listDirty = false;

		if (res.keyBy === "mac") {
			for (const k in res.hosts) { const m = normMac(k); if (m) byMac.set(m, res.hosts[k]); }
		} else {
			for (const ip in res.hosts) {
				let mac = ipToMac.get(ip);
				if (!mac) {
					let sh = synthetic.get(ip);
					if (!sh) { sh = makeSynthetic(ip); listDirty = true; }
					mac = sh.mac;
					ipToMac.set(ip, mac);
					if (!registry.has(mac)) {
						sh.display = hostAliases[mac] || ip;
						sh.rateRx = 0; sh.rateTx = 0;
						registry.set(mac, sh);
						listDirty = true;
					}
				}
				const cur = byMac.get(mac) || { rx: 0, tx: 0 };
				cur.rx += Number(res.hosts[ip].rx) || 0;
				cur.tx += Number(res.hosts[ip].tx) || 0;
				byMac.set(mac, cur);
			}
		}

		if (listDirty) renderList();

		// Сессионные тоталы conntrack, сгруппированные по MAC.
		const totByMac = new Map();
		if (res.totals) for (const ip in res.totals) {
			const mac = ipToMac.get(ip);
			if (!mac) continue;
			const cur = totByMac.get(mac) || { rx: 0, tx: 0 };
			cur.rx += Number(res.totals[ip].rx) || 0;
			cur.tx += Number(res.totals[ip].tx) || 0;
			totByMac.set(mac, cur);
		}

		totalRate = 0;
		let totalTx = 0;
		for (const [mac, h] of registry) {
			const s = stateFor(mac);
			const c = byMac.get(mac);
			const tt = totByMac.get(mac);
			if (tt) { h.sessRx = tt.rx; h.sessTx = tt.tx; }
			let rawRx = 0, rawTx = 0;

			if (c) {
				if (s.prevRx != null) {
					const dt = (now - s.prevT) / 1000;
					const dRx = c.rx - s.prevRx, dTx = c.tx - s.prevTx;
					if (dt > 0.15 && dt < 30 && dRx >= 0 && dTx >= 0) { rawRx = dRx / dt; rawTx = dTx / dt; }
				}
				s.prevRx = c.rx; s.prevTx = c.tx; s.prevT = now;
			}

			const dt = Math.max(0.05, (now - (s.lastT || now)) / 1000);
			s.lastT = now;
			const k = reduceMotion ? 1 : 1 - Math.exp(-dt / prefs.release);
			s.rx = rawRx >= s.rx ? rawRx : s.rx + (rawRx - s.rx) * k;
			s.tx = rawTx >= s.tx ? rawTx : s.tx + (rawTx - s.tx) * k;
			if (s.rx < 512) s.rx = 0;
			if (s.tx < 512) s.tx = 0;

			s.samples.push({ t: tSec, rx: rawRx, tx: rawTx });
			const cut = tSec - prefs.window - 3;
			while (s.samples.length && (s.samples[0].t < cut || s.samples.length > SPARK_MAX_POINTS))
				s.samples.shift();

			h.rateRx = s.rx; h.rateTx = s.tx;
			totalRate += s.rx; totalTx += s.tx;
		}

		paintRates(card, false, totalTx);
		interval = pickInterval();
		schedule();
	}

	/* ── спарклайн ── */

	function sparkPaths(samples, tNow, maxV) {
		const W = 120, H = 34, P = 3, t0 = tNow - prefs.window, y0 = H - P, ih = H - 2 * P;
		const pts = [];
		for (const s of samples) {
			if (s.t < t0) continue;
			pts.push({ x: P + ((s.t - t0) / prefs.window) * (W - 2 * P),
				rx: y0 - Math.min(1, s.rx / maxV) * ih,
				tx: y0 - Math.min(1, s.tx / maxV) * ih });
		}
		if (!pts.length) pts.push({ x: P, rx: y0, tx: y0 }, { x: W - P, rx: y0, tx: y0 });
		const a = pts[0], b = pts[pts.length - 1];
		if (a.x > P) pts.unshift({ x: P, rx: a.rx, tx: a.tx });
		if (b.x < W - P) pts.push({ x: W - P, rx: b.rx, tx: b.tx });
		const line = k => pts.map((p, i) => (i ? " L " : "M ") + p.x.toFixed(1) + " " + p[k].toFixed(1)).join("");
		const rx = line("rx");
		return { rx, tx: line("tx"), area: rx + ` L ${W - P} ${y0} L ${P} ${y0} Z` };
	}

	/* ── рендер ── */

	function visibleHosts() {
		return Array.from(registry.values()).filter(h => {
			if (!filterSubnets) return true;
			return inSubnet(h.ip) || inSubnet(h.ipv6);
		});
	}
	function ordered(list) {
		if (prefs.sort === "activity")
			return list.slice().sort((a, b) =>
				((b.rateRx || 0) + (b.rateTx || 0)) - ((a.rateRx || 0) + (a.rateTx || 0)) ||
				String(a.display).localeCompare(String(b.display)));
		return list.slice().sort((a, b) => String(a.display).localeCompare(String(b.display)));
	}
	function signature(list) {
		return list.map(h => [h.mac, h.display, h.ip, h.ipv6, h.type].join("~")).sort().join("|") +
			"#" + prefs.sort + "#" + prefs.window;
	}

	function renderList() {
		const card = document.getElementById("proton-dashboard-hosts");
		if (!card || editing) return;
		const list = card.querySelector('[data-role="list"]');
		if (!list) return;

		const hosts = visibleHosts();
		const sig = signature(hosts);
		if (sig === listSignature) return;
		listSignature = sig;

		rowRefs.clear();
		list.innerHTML = "";

		if (!hosts.length) {
			list.innerHTML = '<li class="proton-hosts-empty">' + esc(t("No active clients")) + "</li>";
			return;
		}

		for (const g of [{ k: "wifi", t: t("Wi-Fi") }, { k: "lan", t: "LAN" }, { k: "net", t: t("Network") }]) {
			const items = ordered(hosts.filter(h => groupOf(h) === g.k));
			if (!items.length) continue;
			const head = document.createElement("li");
			head.className = "proton-hosts-group";
			head.dataset.group = g.k;
			head.innerHTML = `<span>${esc(g.t)}</span><i>${items.length}</i>`;
			list.appendChild(head);
			for (const h of items) list.appendChild(buildRow(h));
		}
		const totalTx = Array.from(rateState.values()).reduce((s, x) => s + x.tx, 0);
		paintRates(card, true, totalTx);
	}

	function buildRow(h) {
		const li = document.createElement("li");
		li.className = "proton-hosts-row";
		li.dataset.mac = h.mac;
		const icon = h.type === "wifi" ? "📶" : h.type === "remote" ? "🌐" : h.type === "lan-vpn" ? "🔒" : "🖥";
		const label = h.type === "wifi" ? (h.signal != null ? h.signal + " dBm" : "Wi-Fi")
			: h.type === "remote" ? t("Network") : h.type === "lan-vpn" ? "VPN" : "LAN";
		li.innerHTML =
			'<span class="proton-hosts-bar"></span>' +
			'<span class="proton-hosts-icon">' + icon + "</span>" +
			'<div class="proton-hosts-main">' +
				'<div class="proton-hosts-top">' +
					'<span class="proton-hosts-name" data-mac="' + esc(h.mac) + '" title="' + esc(t("Click to rename")) + '">' + esc(h.display) + "</span>" +
					'<div class="proton-hosts-ips">' +
						'<span class="proton-hosts-ip">' + esc(h.ip || "") + "</span>" +
						'<span class="proton-hosts-ip proton-hosts-ipv6">' + esc(h.ipv6 || "") + "</span>" +
					"</div>" +
				"</div>" +
				'<div class="proton-hosts-bottom">' +
					'<span class="proton-hosts-type">' + esc(label) + "</span>" +
					'<span class="proton-hosts-rates">' +
						'<span class="proton-hosts-rate-rx">▼ 0 B/s</span>' +
						'<span class="proton-hosts-rate-tx">▲ 0 B/s</span>' +
					"</span>" +
				"</div>" +
			"</div>" +
			'<div class="proton-hosts-chart">' +
				'<svg viewBox="0 0 120 34" preserveAspectRatio="none" aria-hidden="true">' +
					'<path class="proton-hosts-area"/>' +
					'<path class="proton-hosts-sparkline-tx"/>' +
					'<path class="proton-hosts-sparkline-rx"/>' +
				"</svg>" +
			"</div>";

		rowRefs.set(h.mac, {
			row: li,
			rx: li.querySelector(".proton-hosts-rate-rx"),
			tx: li.querySelector(".proton-hosts-rate-tx"),
			prx: li.querySelector(".proton-hosts-sparkline-rx"),
			ptx: li.querySelector(".proton-hosts-sparkline-tx"),
			area: li.querySelector(".proton-hosts-area"),
			lastRx: "", lastTx: "", hot: false
		});
		return li;
	}

	function paintRates(card, force, totalTx) {
		const tNow = performance.now() / 1000;
		const hotV = prefs.hot;
		let tx = totalTx;
		if (tx == null) { tx = 0; for (const [, s] of rateState) tx += s.tx; }

		for (const [mac, ref] of rowRefs) {
			const s = rateState.get(mac);
			if (!s) continue;
			const rxTxt = "▼ " + formatRate(s.rx), txTxt = "▲ " + formatRate(s.tx);
			if (force || rxTxt !== ref.lastRx) { ref.rx.textContent = rxTxt; ref.lastRx = rxTxt; }
			if (force || txTxt !== ref.lastTx) { ref.tx.textContent = txTxt; ref.lastTx = txTxt; }

			const hot = (s.rx + s.tx) >= hotV;
			if (hot !== ref.hot) { ref.row.dataset.hot = hot ? "1" : "0"; ref.hot = hot; }
			ref.row.dataset.active = (s.rx + s.tx) > 2048 ? "1" : "0";

			let peak = 65536;
			for (const p of s.samples) {
				if (p.t < tNow - prefs.window) continue;
				if (p.rx > peak) peak = p.rx;
				if (p.tx > peak) peak = p.tx;
			}
			s.scale += (peak * 1.15 - s.scale) * 0.12;
			const d = sparkPaths(s.samples, tNow, Math.max(4096, s.scale));
			ref.prx.setAttribute("d", d.rx);
			ref.ptx.setAttribute("d", d.tx);
			ref.area.setAttribute("d", d.area);
		}

		const foot = card.querySelector('[data-role="total"]');
		if (foot) foot.textContent = `▼ ${formatRate(totalRate)}  ▲ ${formatRate(tx)}`;

		const meta = card.querySelector('[data-role="source"]');
		if (meta) {
			meta.dataset.mode = coarse ? "coarse" : "live";
			meta.textContent = coarse ? t("nlbwmon · ~30 s") : `${t("live")} · ${(interval / 1000).toFixed(1)}s`;
			meta.title = `${source} · ${connCount} ${t("connections")}` + (offloaded ? ` · ${offloaded} offloaded` : "");
		}

		if (prefs.sort === "activity" && tNow - lastOrder > 2.5) { lastOrder = tNow; reorder(card); }
		if (tipRow) fillTip(tipRow);
	}

	function reorder(card) {
		if (editing) return;
		const list = card.querySelector('[data-role="list"]');
		if (!list) return;
		const hosts = visibleHosts();
		const before = new Map();
		for (const [mac, ref] of rowRefs) before.set(mac, ref.row.getBoundingClientRect().top);

		for (const g of ["wifi", "lan", "net"]) {
			const head = list.querySelector(`.proton-hosts-group[data-group="${g}"]`);
			if (!head) continue;
			let anchor = head;
			for (const h of ordered(hosts.filter(x => groupOf(x) === g))) {
				const ref = rowRefs.get(h.mac); if (!ref) continue;
				if (anchor.nextSibling !== ref.row) list.insertBefore(ref.row, anchor.nextSibling);
				anchor = ref.row;
			}
		}
		if (reduceMotion) return;

		const deltas = [];
		for (const [mac, top] of before) {
			const ref = rowRefs.get(mac); if (!ref) continue;
			const dy = top - ref.row.getBoundingClientRect().top;
			if (Math.abs(dy) > 0.5) deltas.push([ref.row, dy]);
		}
		for (const [el, dy] of deltas) { el.style.transition = "none"; el.style.transform = `translateY(${dy}px)`; }
		requestAnimationFrame(() => {
			for (const [el] of deltas) {
				el.style.transition = "transform .45s cubic-bezier(.22,.61,.36,1)";
				el.style.transform = "";
			}
		});
	}

	function renderNotice(card) {
		const box = card.querySelector('[data-role="notice"]');
		if (!box) return;
		if (source === "acct-off") {
			box.hidden = false;
			box.innerHTML = `<span>${esc(t("Connection accounting is disabled"))}</span>` +
				`<button type="button" data-role="enable-acct">${esc(t("Enable"))}</button>`;
			const btn = box.querySelector('[data-role="enable-acct"]');
			if (btn && !btn.dataset.bound) {
				btn.dataset.bound = "1";
				btn.addEventListener("click", async () => {
					btn.disabled = true; btn.textContent = t("Please wait...");
					await soft(rpcAcct());
					box.hidden = true; interval = RATE_MIN; schedule();
				});
			}
		} else if (offloaded > 0) {
			box.hidden = false;
			box.innerHTML = `<span>${esc(t("Flow offloading active — counters may lag"))}</span>`;
		} else box.hidden = true;
	}

	function setStatus(card, state) {
		const dot = card.querySelector('[data-role="status-dot"]');
		if (dot) dot.dataset.state = state;
	}

	/* ── тултип ── */

	function initTip(card) {
		if (tipEl) return;
		tipEl = document.createElement("div");
		tipEl.className = "proton-hosts-tooltip";
		tipEl.hidden = true;
		document.body.appendChild(tipEl);

		const list = card.querySelector('[data-role="list"]');
		list.addEventListener("mousemove", e => {
			mouseX = e.clientX; mouseY = e.clientY;
			const row = e.target.closest(".proton-hosts-row");
			if (row !== tipRow) { tipRow = row; row ? fillTip(row) : hideTip(); }
			if (tipRow) placeTip();
		});
		list.addEventListener("mouseleave", () => { tipRow = null; hideTip(); });
		list.addEventListener("scroll", () => { tipRow = null; hideTip(); }, { passive: true });
	}
	function fillTip(row) {
		const h = registry.get(row.dataset.mac); if (!h) return;
		const s = rateState.get(h.mac) || { rx: 0, tx: 0 };
		const idLabel = h.mac.indexOf("ip:") === 0 ? "IP" : "MAC";
		const idValue = h.mac.indexOf("ip:") === 0 ? h.mac.slice(3) : h.mac;
		// nlbwmon ничего не знает о хосте → показываем сессионные тоталы и пометку.
		const sess = !((h.rxBytes || 0) > 0 || (h.txBytes || 0) > 0);
		tipEl.innerHTML =
			`<b>${esc(h.display)}</b>` +
			`<div class="tt-r"><span>${idLabel}</span><i>${esc(idValue)}</i></div>` +
			(h.ip ? `<div class="tt-r"><span>IPv4</span><i>${esc(h.ip)}</i></div>` : "") +
			(h.ipv6 ? `<div class="tt-r"><span>IPv6</span><i>${esc(h.ipv6)}</i></div>` : "") +
			`<div class="tt-r"><span>${esc(t("Download"))}</span><i>${esc(formatRate(s.rx))}</i></div>` +
			`<div class="tt-r"><span>${esc(t("Upload"))}</span><i>${esc(formatRate(s.tx))}</i></div>` +
			`<div class="tt-sep"></div>` +
			`<div class="tt-r"><span>${esc(t("Total RX"))}</span><i>${esc(formatBytes(totalBytes(h, "rx")))}</i></div>` +
			`<div class="tt-r"><span>${esc(t("Total TX"))}</span><i>${esc(formatBytes(totalBytes(h, "tx")))}</i></div>` +
			(sess ? `<div class="tt-note">${esc(t("Peer totals are session-based: they accumulate while the widget is open and reset when rpcd restarts."))}</div>` : "");
		tipEl.hidden = false;
		placeTip();
	}
	function placeTip() {
		if (!tipEl || tipEl.hidden) return;
		const r = tipEl.getBoundingClientRect();
		let x = mouseX + 16, y = mouseY + 16;
		if (x + r.width > innerWidth - 8) x = mouseX - r.width - 16;
		if (y + r.height > innerHeight - 8) y = mouseY - r.height - 16;
		tipEl.style.left = Math.max(8, x) + "px";
		tipEl.style.top = Math.max(8, y) + "px";
	}
	function hideTip() { if (tipEl) tipEl.hidden = true; }

	/* ── переименование ── */

	function onNameClick(e) {
		const el = e.target.closest(".proton-hosts-name");
		if (!el || el.tagName === "INPUT") return;
		e.stopPropagation();
		const mac = el.dataset.mac, prev = el.textContent;
		editing = true; hideTip();

		const input = document.createElement("input");
		input.type = "text"; input.className = "proton-hosts-name-edit";
		input.value = hostAliases[mac] || ""; input.placeholder = prev; input.maxLength = 64;
		el.replaceWith(input); input.focus(); input.select();

		let done = false;
		const finish = save => {
			if (done) return; done = true;
			const val = input.value.trim();
			if (save) {
				saveHostAlias(mac, val);
				const h = registry.get(mac);
				if (h) h.display = val || h.name || h.ip || h.ipv6 || mac;
				const sh = synthetic.get(mac.slice(3));
				if (sh) sh.display = val || sh.ip || sh.ipv6;
			}
			const span = document.createElement("span");
			span.className = "proton-hosts-name";
			span.dataset.mac = mac; span.title = t("Click to rename");
			span.textContent = save ? (val || prev) : prev;
			input.replaceWith(span);
			editing = false; listSignature = ""; renderList();
		};
		input.addEventListener("keydown", ev => {
			if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
			else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
		});
		input.addEventListener("blur", () => finish(true));
	}

	/* ── модалка ── */

	function renderSubnetList(box) {
		const subs = Array.from(availableSubnets).sort();
		box.innerHTML = subs.length
			? subs.map(s => `<label><input type="checkbox" class="proton-hosts-filter-cb" value="${esc(s)}" ${(!filterSubnets || filterSubnets.has(s)) ? "checked" : ""}><span>${esc(s)}</span></label>`).join("")
			: `<i>${esc(t("No active clients"))}</i>`;
	}
	function renderAliasList(box) {
		const keys = Object.keys(hostAliases).sort();
		box.innerHTML = keys.length
			? keys.map(mac => `
				<div class="proton-hosts-alias-row" data-mac="${esc(mac)}">
					<span class="ph-alias-mac">${esc(mac.indexOf("ip:") === 0 ? mac.slice(3) : mac)}</span>
					<span class="ph-alias-name">${esc(hostAliases[mac])}</span>
					<button type="button" class="ph-alias-del" data-mac="${esc(mac)}" title="${esc(t("Remove"))}" aria-label="${esc(t("Remove"))}">×</button>
				</div>`).join("")
			: `<div class="ph-alias-empty">${esc(t("No custom names yet"))}</div>`;
	}

	async function openSettings() {
		const old = document.querySelector(".proton-hosts-modal-overlay");
		if (old) old.remove();

		// UCI — источник истины: дожидаемся синхронизации, иначе покажем старое.
		if (window.protonSettingsSync && typeof window.protonSettingsSync.forceSync === "function") {
			try { await window.protonSettingsSync.forceSync(); } catch (e) {}
		}
		loadAliases(); loadCustom(); loadFilter();
		await fetchContext();

		const ov = document.createElement("div");
		ov.className = "proton-confirm-modal-overlay proton-hosts-modal-overlay";

		const modal = document.createElement("div");
		modal.className = "proton-confirm-modal proton-network-modal proton-hosts-modal";
		modal.setAttribute("role", "dialog");
		modal.setAttribute("aria-modal", "true");
		modal.setAttribute("aria-labelledby", "proton-hosts-modal-title");

		modal.innerHTML = `
			<h3 id="proton-hosts-modal-title">${esc(t("Hosts"))}</h3>
			<div class="proton-hosts-modal-body">
				<div class="proton-monitoring-row">
					<label class="proton-monitoring-label" for="ph-sort">${esc(t("Sort"))}</label>
					<select id="ph-sort" class="proton-monitoring-select" data-p="sort">
						<option value="activity">${esc(t("By activity"))}</option>
						<option value="name">${esc(t("By name"))}</option>
					</select>
				</div>
				<div class="proton-monitoring-row">
					<label class="proton-monitoring-label" for="ph-units">${esc(t("Units"))}</label>
					<select id="ph-units" class="proton-monitoring-select" data-p="units">
						<option value="bytes">MB/s</option><option value="bits">Mbit/s</option>
					</select>
				</div>
				<div class="proton-monitoring-row">
					<label class="proton-monitoring-label" for="ph-speed">${esc(t("Polling"))}</label>
					<select id="ph-speed" class="proton-monitoring-select" data-p="speed">
						<option value="auto">${esc(t("Adaptive"))}</option>
						<option value="fast">${esc(t("Fast"))}</option>
						<option value="calm">${esc(t("Economical"))}</option>
					</select>
				</div>
				<div class="proton-monitoring-row">
					<label class="proton-monitoring-label" for="ph-window">${esc(t("Chart window"))}</label>
					<select id="ph-window" class="proton-monitoring-select" data-p="window">
						<option value="30">30 s</option><option value="60">60 s</option><option value="120">120 s</option>
					</select>
				</div>
				<div class="ph-slider">
					<label for="ph-release">${esc(t("Fade time"))} <b data-out="release">${prefs.release.toFixed(1)}s</b></label>
					<input type="range" id="ph-release" min="0.3" max="8" step="0.1" data-p="release" value="${prefs.release}">
				</div>
				<div class="ph-slider">
					<label for="ph-hot">${esc(t("Highlight above"))} <b data-out="hot">${formatRate(prefs.hot)}</b></label>
					<input type="range" id="ph-hot" min="14" max="24" step="0.25" data-p="hot" value="${Math.log2(prefs.hot).toFixed(2)}">
				</div>

				<div class="ph-block">
					<label>${esc(t("Detected subnets"))}</label>
					<div class="ph-subs-list" data-role="subnets"></div>
					<small>${esc(t("Check the networks you want to see. Uncheck all to show everything."))}</small>
				</div>

				<div class="ph-block">
					<div class="ph-block-head">
						<label>${esc(t("Custom device names"))}</label>
						<button type="button" class="ph-mini-btn" data-role="clear-aliases">${esc(t("Clear all"))}</button>
					</div>
					<div class="ph-alias-list" data-role="aliases"></div>
				</div>

				<div class="ph-block">
					<label for="ph-cidr">${esc(t("Custom subnets (CIDR)"))}</label>
					<input type="text" id="ph-cidr" class="ph-cidr" spellcheck="false" autocomplete="off"
						placeholder="192.168.2.0/24, 10.0.0.0/8">
					<small>${esc(t("Comma-separated CIDR. Adds to the list above."))}</small>
					<div class="ph-cidr-err" data-role="cidr-err" hidden></div>
				</div>
			</div>
			<div class="proton-confirm-modal-actions">
				<button type="button" data-role="reset">${esc(t("Reset to default"))}</button>
				<button type="button" class="primary" data-role="close">${esc(t("Done"))}</button>
			</div>`;

		ov.appendChild(modal);
		document.body.appendChild(ov);

		const subBox = modal.querySelector('[data-role="subnets"]');
		const aliasBox = modal.querySelector('[data-role="aliases"]');
		const cidrInput = modal.querySelector("#ph-cidr");
		const cidrErr = modal.querySelector('[data-role="cidr-err"]');

		renderSubnetList(subBox);
		renderAliasList(aliasBox);
		cidrInput.value = customSubnets.join(", ");

		const onKey = e => { if (e.key === "Escape") { e.preventDefault(); close(); } };
		const close = () => {
			document.removeEventListener("keydown", onKey);
			ov.classList.add("is-closing");
			setTimeout(() => ov.remove(), 200);
			interval = RATE_MIN; schedule();
		};
		document.addEventListener("keydown", onKey);
		ov.addEventListener("click", e => { if (e.target === ov) close(); });
		modal.querySelector('[data-role="close"]').addEventListener("click", close);
		modal.querySelector('[data-role="reset"]').addEventListener("click", () => {
			prefs = Object.assign({}, DEFAULTS); savePrefs(); close();
			listSignature = ""; renderList(); interval = pickInterval(); schedule();
		});

		subBox.addEventListener("change", e => {
			if (!e.target.classList.contains("proton-hosts-filter-cb")) return;
			const boxes = Array.from(subBox.querySelectorAll(".proton-hosts-filter-cb"));
			const on = boxes.filter(x => x.checked).map(x => x.value);
			filterSubnets = on.length ? new Set(on) : null;
			saveFilter();
			rebuildSubnets();
			listSignature = ""; renderList();
			interval = RATE_MIN; schedule();
		});

		aliasBox.addEventListener("click", e => {
			const btn = e.target.closest(".ph-alias-del");
			if (!btn) return;
			e.stopPropagation();
			const mac = btn.dataset.mac; if (!mac) return;
			saveHostAlias(mac, "");
			renderAliasList(aliasBox);
			refreshNames();
		});

		modal.querySelector('[data-role="clear-aliases"]').addEventListener("click", () => {
			if (!Object.keys(hostAliases).length) return;
			if (!confirm(t("Clear all custom device names?"))) return;
			hostAliases = {};
			persistAliases();
			renderAliasList(aliasBox);
			refreshNames();
		});

		const applyCidr = () => {
			const parts = cidrInput.value.split(",").map(s => s.trim()).filter(Boolean);
			const good = [], bad = [];
			for (const p of parts) { const n = normalizeCidr(p); if (n) good.push(n); else bad.push(p); }
			customSubnets = Array.from(new Set(good));
			saveCustom();
			cidrErr.hidden = !bad.length;
			if (bad.length) cidrErr.textContent = t("Invalid CIDR") + ": " + bad.join(", ");
			rebuildSubnets();
			renderSubnetList(subBox);
			listSignature = ""; renderList();
			interval = RATE_MIN; schedule();
		};
		cidrInput.addEventListener("change", applyCidr);
		cidrInput.addEventListener("keydown", e => {
			if (e.key === "Enter") { e.preventDefault(); applyCidr(); }
		});

		modal.querySelectorAll("[data-p]").forEach(inp => {
			const key = inp.dataset.p;
			if (inp.tagName === "SELECT") inp.value = String(prefs[key]);
			const apply = () => {
				if (key === "hot") prefs.hot = Math.pow(2, parseFloat(inp.value));
				else if (key === "release") prefs.release = parseFloat(inp.value);
				else if (key === "window") prefs.window = parseInt(inp.value, 10);
				else prefs[key] = inp.value;
				const out = modal.querySelector(`[data-out="${key}"]`);
				if (out) out.textContent = key === "hot" ? formatRate(prefs.hot) : prefs.release.toFixed(1) + "s";
				savePrefs();
				if (key === "sort" || key === "window") { listSignature = ""; renderList(); }
				if (key === "speed") { interval = pickInterval(); schedule(); }
				const card = document.getElementById("proton-dashboard-hosts");
				if (card) paintRates(card, true);
			};
			inp.addEventListener("input", apply);
			inp.addEventListener("change", apply);
		});
	}

	/* ── шаблон ── */

	function template() {
		return `
		<div class="proton-dashboard-card proton-hosts-card" id="proton-dashboard-hosts">
			<div class="proton-dashboard-card-header">
				<div class="proton-hosts-title">
					<span class="proton-dashboard-status-dot" data-role="status-dot" data-state="ok"></span>
					<h3>${esc(t("Hosts"))}</h3>
					<span class="proton-hosts-source" data-role="source" data-mode="live">live</span>
				</div>
				<button type="button" class="proton-dashboard-network-settings" data-role="hosts-settings" title="${esc(t("Hosts filter"))}">
					<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<circle cx="12" cy="12" r="3"></circle>
						<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
					</svg>
				</button>
			</div>
			<div class="proton-hosts-notice" data-role="notice" hidden></div>
			<div class="proton-dashboard-card-body">
				<ul class="proton-hosts-list" data-role="list" role="list"></ul>
			</div>
			<div class="proton-hosts-footer">
				<span class="proton-hosts-total" data-role="total">▼ 0 B/s ▲ 0 B/s</span>
			</div>
		</div>`;
	}

	/* ── lifecycle ── */

	async function mount(card) {
		if (!card || mounted) return;
		if (!ensureRpc()) { setTimeout(() => mount(card), 400); return; }
		mounted = true;

		loadPrefs(); loadAliases(); loadCustom(); loadFilter();

		const btn = card.querySelector('[data-role="hosts-settings"]');
		if (btn) btn.addEventListener("click", () => { openSettings(); });
		const list = card.querySelector('[data-role="list"]');
		if (list) list.addEventListener("click", onNameClick);
		initTip(card);

		if (window.protonSettingsSync && typeof window.protonSettingsSync.forceSync === "function") {
			try { await window.protonSettingsSync.forceSync(); } catch (e) {}
			loadAliases(); loadCustom(); loadFilter();
		}

		await fetchContext();
		await collectMeta();
		interval = RATE_MIN;
		tickRates();

		metaTimer = setInterval(() => {
			if (!document.hidden) { fetchContext().then(collectMeta); }
		}, META_MS);

		visHandler = () => {
			if (document.hidden) { if (rateTimer) { clearTimeout(rateTimer); rateTimer = null; } }
			else {
				for (const [, s] of rateState) { s.prevRx = null; s.prevTx = null; }
				interval = RATE_MIN; tickRates(); fetchContext().then(collectMeta);
			}
		};
		document.addEventListener("visibilitychange", visHandler);

		syncHandler = () => {
			loadAliases(); loadCustom(); loadFilter();
			rebuildSubnets(); refreshNames();
			interval = RATE_MIN; schedule();
		};
		window.addEventListener("proton-settings-synced", syncHandler);
		window.addEventListener("proton-setting-changed", syncHandler);
	}

	function unmount() {
		mounted = false;
		if (rateTimer) clearTimeout(rateTimer);
		if (metaTimer) clearInterval(metaTimer);
		rateTimer = metaTimer = null;
		if (visHandler) document.removeEventListener("visibilitychange", visHandler);
		if (syncHandler) {
			window.removeEventListener("proton-settings-synced", syncHandler);
			window.removeEventListener("proton-setting-changed", syncHandler);
		}
		visHandler = syncHandler = null;
		if (tipEl) { tipEl.remove(); tipEl = null; }
		tipRow = null; rowRefs.clear(); listSignature = "";
		const ov = document.querySelector(".proton-hosts-modal-overlay");
		if (ov) ov.remove();
	}

	function boot() {
		const card = document.getElementById("proton-dashboard-hosts");
		if (card) { if (!mounted) mount(card); return; }
		const host = document.querySelector('[data-proton-layout-tag="hosts"]') ||
			document.getElementById("proton-widgets-container");
		if (host) {
			host.insertAdjacentHTML("beforeend", template());
			mount(document.getElementById("proton-dashboard-hosts"));
		}
	}

	const obs = new MutationObserver(() => {
		const card = document.getElementById("proton-dashboard-hosts");
		if (!card && mounted) unmount();
		else boot();
	});

	function start() {
		boot();
		obs.observe(document.getElementById("maincontent") || document.body,
			{ childList: true, subtree: true });
	}

	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
	else start();
	window.addEventListener("proton-spa-navigated", () => { unmount(); setTimeout(boot, 60); });
	window.addEventListener("pagehide", unmount);
})();
