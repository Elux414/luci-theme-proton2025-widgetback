/**
 * Proton2025 Dashboard - Network data provider
 * Uses only luci-base ubus APIs.
 */

(function () {
  "use strict";

  let callInterfaceDump = null;
  let callDeviceStatus = null;

  function ensureRpc() {
    if (!window.L || !L.rpc || typeof L.rpc.declare !== "function")
      return false;

    if (!callInterfaceDump) {
      callInterfaceDump = L.rpc.declare({
        object: "network.interface",
        method: "dump",
        expect: { interface: [] },
      });
    }

    if (!callDeviceStatus) {
      callDeviceStatus = L.rpc.declare({
        object: "network.device",
        method: "status",
        params: ["name"],
        expect: { "": {} },
      });
    }

    return true;
  }

  function pickWanInterface(items) {
    if (!Array.isArray(items)) return null;

    const usable = items.filter((item) => item && item.interface);

    // 1) Явные имена WAN
    for (const name of ["wan", "wan6", "wwan", "wwan6"]) {
      const exact = usable.find((item) => item.interface === name);
      if (exact) return exact;
    }

    // 2) Интерфейс с маршрутом по умолчанию (target=0.0.0.0 или "default")
    const defaultRoute = usable.find((item) => {
      if (!Array.isArray(item.route)) return false;
      return item.route.some(
        (route) =>
          route &&
          ((route.target === "0.0.0.0" || route.target === "::" ||
            route.target === "default") &&
            (route.mask === undefined || Number(route.mask) === 0)),
      );
    });
    if (defaultRoute) return defaultRoute;

    // 3) Любой up интерфейс с proto dhcp/pppoe/static и не bridge
    const candidate = usable.find((item) => {
      if (!item.up) return false;
      if (item.interface.startsWith("br-")) return false;
      const proto = String(item.proto || "").toLowerCase();
      return proto === "dhcp" || proto === "pppoe" || proto === "static" || proto === "wwan";
    });
    if (candidate) return candidate;

    // 4) Первый up интерфейс, кроме lo
    return usable.find((item) => item.up && item.interface !== "lo") || null;
  }

  async function getSnapshot() {
    if (!ensureRpc())
      throw new Error("LuCI RPC API is not ready");

    let selectedWan = null;
    try {
        selectedWan = localStorage.getItem('proton-wan-interface');
    } catch(e) {}

    const interfaces = await L.resolveDefault(callInterfaceDump(), []);
    
    let wan = null;
    if (selectedWan && selectedWan.trim() !== '') {
        wan = interfaces.find(i => i.interface === selectedWan.trim());
    }
    if (!wan) {
        wan = pickWanInterface(interfaces);
    }

    if (!wan) {
      return {
        connected: false,
        interface: null,
        device: null,
        protocol: null,
        statistics: null,
        timestamp: performance.now(),
      };
    }

    const deviceName = wan.l3_device || wan.device || null;

    if (!deviceName) {
      return {
        connected: !!wan.up,
        interface: wan.interface || null,
        device: null,
        protocol: wan.proto || null,
        statistics: null,
        timestamp: performance.now(),
      };
    }

    const device = await L.resolveDefault(callDeviceStatus(deviceName), null);

    return {
      connected: !!wan.up && !!device && device.present !== false,
      interface: wan.interface || null,
      device: deviceName,
      protocol: wan.proto || null,
      statistics:
        device && device.statistics
          ? {
              rxBytes: Number(device.statistics.rx_bytes) || 0,
              txBytes: Number(device.statistics.tx_bytes) || 0,
            }
          : null,
      timestamp: performance.now(),
    };
  }

  window.ProtonDashboardData = {
    getSnapshot,
  };
})();

