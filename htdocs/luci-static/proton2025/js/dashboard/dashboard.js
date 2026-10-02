/**
 * Proton2025 Dashboard
 * First widget: Internet / WAN realtime monitor.
 */

(function () {
  "use strict";

  const POLL_INTERVAL = 3000;
  const MAX_SAMPLES = 60;

  class InternetWidget {
    constructor() {
      this.samples = [];
      this.timer = null;
      this.mounted = false;
      this.previous = null;
      this.container = null;
      this.onVisibilityChange = null;
    }

    t(value) {
      if (typeof window.protonT === "function") return window.protonT(value);
      return value;
    }

    isOverviewPage() {
      if (
        window.L &&
        L.env &&
        Array.isArray(L.env.dispatchpath) &&
        L.env.dispatchpath[0] === "admin" &&
        L.env.dispatchpath[1] === "status" &&
        L.env.dispatchpath[2] === "overview"
      ) {
        return true;
      }

      return (
        document.body.dataset.page === "admin-status-overview" ||
        window.location.pathname.includes("/admin/status/overview")
      );
    }

    formatRate(bytesPerSecond) {
      if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0)
        return "0 bps";

      const bits = bytesPerSecond * 8;

      if (bits >= 1000000000)
        return `${(bits / 1000000000).toFixed(1)} Gbps`;
      if (bits >= 1000000)
        return `${(bits / 1000000).toFixed(1)} Mbps`;
      if (bits >= 1000)
        return `${(bits / 1000).toFixed(1)} Kbps`;

      return `${Math.round(bits)} bps`;
    }

    calculateRates(snapshot) {
      if (
        !snapshot.statistics ||
        !this.previous ||
        !this.previous.statistics
      ) {
        this.previous = snapshot;
        return { rx: 0, tx: 0 };
      }

      const elapsed =
        (snapshot.timestamp - this.previous.timestamp) / 1000;

      if (!Number.isFinite(elapsed) || elapsed <= 0) {
        this.previous = snapshot;
        return { rx: 0, tx: 0 };
      }

      const rxDelta =
        snapshot.statistics.rxBytes - this.previous.statistics.rxBytes;
      const txDelta =
        snapshot.statistics.txBytes - this.previous.statistics.txBytes;

      this.previous = snapshot;

      return {
        rx: rxDelta >= 0 ? rxDelta / elapsed : 0,
        tx: txDelta >= 0 ? txDelta / elapsed : 0,
      };
    }

    addSample(rates) {
      this.samples.push({
        rx: rates.rx,
        tx: rates.tx,
      });

      if (this.samples.length > MAX_SAMPLES)
        this.samples.shift();
    }

    inject() {
      const maincontent = document.getElementById("maincontent");
      if (!maincontent) return false;

      let section = document.getElementById("proton-dashboard-section");

      if (!section) {
        section = document.createElement("section");
        section.id = "proton-dashboard-section";
        section.className = "proton-dashboard-section";

        section.innerHTML = `
          <div class="proton-dashboard-section-header">
            <h2 class="proton-dashboard-section-title">${this.t("Dashboard")}</h2>
          </div>

          <article class="proton-dashboard-internet" id="proton-dashboard-internet">
            <div class="proton-dashboard-internet-header">
              <div>
                <div class="proton-dashboard-internet-title-row">
                  <span class="proton-dashboard-internet-status-dot"></span>
                  <h3 class="proton-dashboard-internet-title">${this.t("Internet")}</h3>
                </div>
                <div class="proton-dashboard-internet-subtitle" data-role="status">
                  ${this.t("Checking connection...")}
                </div>
              </div>
              <div class="proton-dashboard-internet-device" data-role="device">—</div>
            </div>

            <div class="proton-dashboard-rates">
              <div class="proton-dashboard-rate">
                <span class="proton-dashboard-rate-label">
                  <span class="proton-dashboard-rate-dot rx"></span>
                  ${this.t("Download")}
                </span>
                <strong data-role="rx">0 bps</strong>
              </div>

              <div class="proton-dashboard-rate">
                <span class="proton-dashboard-rate-label">
                  <span class="proton-dashboard-rate-dot tx"></span>
                  ${this.t("Upload")}
                </span>
                <strong data-role="tx">0 bps</strong>
              </div>
            </div>

            <div class="proton-dashboard-chart-wrap" data-role="chart"></div>

            <div class="proton-dashboard-footer">
              <span data-role="interface">WAN</span>
              <span class="proton-dashboard-legend">
                <span><i class="rx"></i>${this.t("Download")}</span>
                <span><i class="tx"></i>${this.t("Upload")}</span>
              </span>
            </div>
          </article>
        `;

        const legacySection = document.querySelector(".proton-widgets-section");

        if (legacySection && legacySection.parentNode) {
          legacySection.parentNode.insertBefore(section, legacySection);
        } else {
          maincontent.insertBefore(section, maincontent.firstElementChild);
        }
      }

      this.container = section.querySelector("#proton-dashboard-internet");
      this.mounted = !!this.container;

      return this.mounted;
    }

    render(snapshot, rates) {
      if (!this.container) return;

      const status = this.container.querySelector('[data-role="status"]');
      const device = this.container.querySelector('[data-role="device"]');
      const rx = this.container.querySelector('[data-role="rx"]');
      const tx = this.container.querySelector('[data-role="tx"]');
      const iface = this.container.querySelector('[data-role="interface"]');
      const dot = this.container.querySelector(
        ".proton-dashboard-internet-status-dot",
      );

      const connected = !!snapshot.connected;

      status.textContent = connected
        ? this.t("Connected")
        : this.t("Disconnected");

      dot.dataset.state = connected ? "connected" : "disconnected";
      device.textContent = snapshot.device || "—";
      iface.textContent = snapshot.interface
        ? snapshot.interface.toUpperCase()
        : "WAN";

      rx.textContent = this.formatRate(rates.rx);
      tx.textContent = this.formatRate(rates.tx);

      ProtonDashboardCharts.render(
        this.container.querySelector('[data-role="chart"]'),
        this.samples.map((sample) => sample.rx),
        this.samples.map((sample) => sample.tx),
      );
    }

    async poll() {
      if (!this.mounted || document.hidden) return;

      try {
        const snapshot = await ProtonDashboardData.getSnapshot();
        const rates = this.calculateRates(snapshot);

        if (snapshot.statistics)
          this.addSample(rates);

        this.render(snapshot, rates);
      } catch (error) {
        const status = this.container?.querySelector('[data-role="status"]');
        if (status)
          status.textContent = this.t("Unable to read network statistics");
      }
    }

    start() {
      if (!this.mounted || this.timer) return;

      this.poll();

      this.timer = setInterval(() => {
        this.poll();
      }, POLL_INTERVAL);

      this.onVisibilityChange = () => {
        if (!document.hidden) {
          this.previous = null;
          this.poll();
        }
      };

      document.addEventListener(
        "visibilitychange",
        this.onVisibilityChange,
      );
    }

    stop() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }

      if (this.onVisibilityChange) {
        document.removeEventListener(
          "visibilitychange",
          this.onVisibilityChange,
        );
        this.onVisibilityChange = null;
      }

      this.mounted = false;
    }

    init() {
      if (!this.isOverviewPage()) return;
      if (!this.inject()) return;
      this.start();
    }
  }

  function initDashboard() {
    if (
      window.protonInternetWidget &&
      window.protonInternetWidget.mounted
    ) {
      return;
    }

    if (
      window.protonInternetWidget &&
      typeof window.protonInternetWidget.stop === "function"
    ) {
      window.protonInternetWidget.stop();
    }

    window.protonInternetWidget = new InternetWidget();
    window.protonInternetWidget.init();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDashboard);
  } else {
    initDashboard();
  }
})();
