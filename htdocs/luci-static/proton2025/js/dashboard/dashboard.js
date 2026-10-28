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
              <div style="display:flex; align-items:center; gap:8px;">
                <div class="proton-dashboard-internet-device" data-role="device">—</div>
                <button type="button" class="proton-dashboard-network-settings" data-role="wan-settings" title="${this.t("Configure WAN interface")}">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                  </svg>
                </button>
              </div>
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
	  
	  // Находим кнопку и вешаем обработчик
      const settingsBtn = this.container.querySelector('[data-role="wan-settings"]');
      if (settingsBtn) {
          settingsBtn.addEventListener('click', () => this.openWanSettingsModal());
      }

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
	
	async openWanSettingsModal() {
      if (!window.L || !L.rpc) return;
	  
	  // Дожидаемся синхронизации localStorage ← UCI, чтобы не показать
	  // "Auto-detect" при уже сохранённом WAN.
	  if (window.protonSettingsSync
         && typeof window.protonSettingsSync.forceSync === 'function') {
         try { await window.protonSettingsSync.forceSync(); } catch (e) {}
      }

            // Получаем список интерфейсов.
      // LuCI RPC возвращает структуру { interface: [ ... ] } или null.
      // Надёжно разбираем все варианты, чтобы не показать пустой список.
      let interfaces = [];
      try {
        if (!this._callInterfaceDump) {
          this._callInterfaceDump = L.rpc.declare({
            object: "network.interface",
            method: "dump",
            expect: { "": {} },
          });
        }

        const raw = await L.resolveDefault(this._callInterfaceDump(), null);
        let payload = null;

        // Вариант 1: payload = { interface: [...] }
        if (raw && Array.isArray(raw.interface)) {
          payload = raw.interface;
        }
        // Вариант 2: payload = { interface: { interface: [...] } } (двойная обёртка)
        else if (raw && raw.interface && Array.isArray(raw.interface.interface)) {
          payload = raw.interface.interface;
        }
        // Вариант 3: сырой ubus-ответ { result: [0, { interface: [...] }] }
        else if (raw && Array.isArray(raw.result) && raw.result[1]
                 && Array.isArray(raw.result[1].interface)) {
          payload = raw.result[1].interface;
        }
        // Вариант 4: payload — уже массив
        else if (Array.isArray(raw)) {
          payload = raw;
        }

        if (Array.isArray(payload)) {
          interfaces = payload.filter(function (iface) {
            if (!iface || typeof iface !== "object" || !iface.interface) return false;

            if (iface.interface === "loopback") return false;
            if (iface.device === "lo") return false;
            if (iface.l3_device === "lo") return false;

            return true;
          });
        }
      } catch (e) {
        console.warn("[Proton2025] Failed to load interfaces for WAN settings:", e);
      }

      // Fallback: если dump вернул пусто — берём имена из сети через ubus call network.interface dump через system?
      // Нет. Просто показываем подсказку в модалке, если пусто.

      const currentWan = localStorage.getItem('proton-wan-interface') || '';

      // Создаём модалку
      const overlay = document.createElement("div");
      overlay.className = "proton-confirm-modal-overlay";

      const modal = document.createElement("div");
      modal.className = "proton-confirm-modal proton-network-modal";
      modal.style.maxWidth = "500px";

      modal.innerHTML = `
        <h3>${this.t("Configure WAN interface")}</h3>
        <div class="proton-network-modal-body">
          <div class="proton-monitoring-row">
            <label class="proton-monitoring-label" style="flex:0 0 100px;">${this.t("Interface")}</label>
                        <select id="proton-wan-select" class="cbi-input-select proton-monitoring-select" style="flex:1;">
              <option value="">${this.t("Auto-detect")}</option>
              ${interfaces.length === 0 ? `
                <option value="" disabled>${this.t("No interfaces available")}</option>
              ` : interfaces.map(i => {
                const up = i.up ? "↑" : "↓";
                const proto = i.proto ? i.proto : "—";
                const dev = i.device || i.l3_device || "";
                const label = `${up} ${i.interface} (${proto}${dev ? ", " + dev : ""})`;
                return `<option value="${i.interface}" ${currentWan === i.interface ? 'selected' : ''}>${label}</option>`;
              }).join('')}
            </select>
          </div>
        </div>
        <div class="proton-confirm-modal-actions">
          <button type="button" class="cbi-button cbi-button-neutral" data-action="cancel">${this.t("Cancel")}</button>
          <button type="button" class="cbi-button cbi-button-positive" data-action="save">${this.t("Save")}</button>
        </div>
      `;
	  
	  if (interfaces.length === 0) {
        const body = modal.querySelector(".proton-network-modal-body");
        if (body) {
          const hint = document.createElement("div");
          hint.style.cssText = "margin-top:8px;color:#f87171;font-size:12px;";
          hint.textContent = "⚠ " + this.t("Unable to read network interfaces list") + " (ubus network.interface dump)";
          body.appendChild(hint);
        }
      }

      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      requestAnimationFrame(() => overlay.classList.add("is-open"));

      const closeModal = () => {
        overlay.classList.remove("is-open");
        setTimeout(() => overlay.remove(), 220);
      };

      modal.querySelector('[data-action="cancel"]').addEventListener("click", closeModal);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
      document.addEventListener("keydown", function esc(e) { if (e.key === "Escape") { closeModal(); document.removeEventListener("keydown", esc); } });

      modal.querySelector('[data-action="save"]').addEventListener("click", async () => {
	  const val = modal.querySelector('#proton-wan-select').value;

	  localStorage.setItem('proton-wan-interface', val);

      let savedToUci = false;
		if (window.protonSettingsSync
			&& typeof window.protonSettingsSync.saveLocalKeyToUci === 'function') {
        try {
            savedToUci = await window.protonSettingsSync.saveLocalKeyToUci(
                'proton-wan-interface', val
            );
        } catch (e) {}
    }

	    if (!savedToUci && window.protonServicesApi) {
        // Не критично: локально сохранено, UCI догонит по syncFromUci.
        console.warn('[Proton2025] WAN interface saved locally, UCI not confirmed');
        }

      closeModal();

      // Перезапуск опроса — если выбран WAN, данные придут со следующего тика.
      this.previous = null;
      this.poll();
      });
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
