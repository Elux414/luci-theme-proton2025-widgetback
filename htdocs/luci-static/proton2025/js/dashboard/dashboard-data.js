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

    const exactWan = usable.find((item) => item.interface === "wan");
    if (exactWan) return exactWan;

    const exactWan6 = usable.find((item) => item.interface === "wan6");
    if (exactWan6) return exactWan6;

    const defaultRoute = usable.find((item) => {
      if (!Array.isArray(item.route)) return false;

      return item.route.some(
        (route) =>
          route &&
          (route.target === "0.0.0.0" || route.target === "::") &&
          Number(route.mask) === 0,
      );
    });

    return defaultRoute || null;
  }

  async function getSnapshot() {
    if (!ensureRpc())
      throw new Error("LuCI RPC API is not ready");

    const interfaces = await L.resolveDefault(callInterfaceDump(), []);
    const wan = pickWanInterface(interfaces);

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

    const device = await L.resolveDefault(
      callDeviceStatus(deviceName),
      null,
    );

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

