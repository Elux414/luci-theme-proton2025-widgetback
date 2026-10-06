/**
 * Proton2025 - Services Widget
 * Copyright 2025-2026 ChesterGoodiny
 * Licensed under the Apache License, Version 2.0
 * See LICENSE and NOTICE for details.
 * Мониторинг сервисов с группировкой и поиском
 */

(function () {
  "use strict";

  // =====================================================
  // Утилита: управление видимостью секции виджетов
  // =====================================================
  function updateWidgetsSectionVisibility() {
    const section = document.querySelector(".proton-widgets-section");
    if (!section) return;

    const servicesWidget = section.querySelector(".proton-services-widget");
    const tempWidget = section.querySelector(".proton-temp-widget");

    const isVisible = (el) => {
      if (!el) return false;
      // Быстрый путь для inline скрытия
      if (el.style && el.style.display === "none") return false;
      // Корректно обрабатываем скрытие через CSS-классы/стили темы
      if (typeof window.getComputedStyle === "function") {
        return window.getComputedStyle(el).display !== "none";
      }
      return true;
    };

    // Проверяем видимость виджетов
    const servicesVisible = isVisible(servicesWidget);
    const tempVisible = isVisible(tempWidget);

    // Скрываем секцию если все виджеты скрыты
    section.style.display = servicesVisible || tempVisible ? "" : "none";
  }

  // Делаем функцию доступной глобально для внешних вызовов
  window.updateWidgetsSectionVisibility = updateWidgetsSectionVisibility;

  class ProtonServicesWidget {
    constructor() {
      this.services = this.loadServices();

      // Категории сервисов
      this.categories = {
        custom: { icon: "⭐", priority: 0 },
        network: { icon: "🌐", priority: 1 },
        security: { icon: "🛡️", priority: 2 },
        vpn: { icon: "🔒", priority: 3 },
        adblock: { icon: "🚫", priority: 4 },
        system: { icon: "⚙️", priority: 5 },
        other: { icon: "📦", priority: 99 },
      };

      // База известных сервисов с категориями
      // daemon: false - скрипты-настройщики без постоянного процесса (скрыты из списка выбора)
      this.knownServices = {
        // Сеть
        dnsmasq: { category: "network", icon: "🌐" },
        network: { category: "network", icon: "🔌", daemon: false },
        odhcpd: { category: "network", icon: "📡" },
        uhttpd: { category: "network", icon: "🌍" },
        nginx: { category: "network", icon: "🌍" },
        squid: { category: "network", icon: "🦑" },

        // Безопасность
        firewall: { category: "security", icon: "🔥", daemon: false },
        dropbear: { category: "security", icon: "🔐" },
        openssh: { category: "security", icon: "🔐" },
        sshd: { category: "security", icon: "🔐" },

        // VPN
        openvpn: { category: "vpn", icon: "🔒" },
        wireguard: { category: "vpn", icon: "🔒", daemon: false },
        zerotier: { category: "vpn", icon: "🔒" },
        tailscale: { category: "vpn", icon: "🔒" },
        shadowsocks: { category: "vpn", icon: "🔒" },
        v2ray: { category: "vpn", icon: "🔒" },
        xray: { category: "vpn", icon: "🔒" },
        clash: { category: "vpn", icon: "🔒" },
        passwall: { category: "vpn", icon: "🔒" },
        passwall2: { category: "vpn", icon: "🔒" },
        ssr: { category: "vpn", icon: "🔒" },
        trojan: { category: "vpn", icon: "🔒" },
        singbox: { category: "vpn", icon: "🔒" },
        "sing-box": { category: "vpn", icon: "🔒" },
        podkop: { category: "vpn", icon: "🔒", daemon: false },

        // AdBlock / DNS фильтрация
        adblock: { category: "adblock", icon: "🚫" },
        adguardhome: { category: "adblock", icon: "🛡️" },
        smartdns: { category: "adblock", icon: "🛡️" },
        pihole: { category: "adblock", icon: "🕳️" },

        // Система
        cron: { category: "system", icon: "⏰" },
        sysntpd: { category: "system", icon: "🕐" },
        ntpd: { category: "system", icon: "🕐" },
        log: { category: "system", icon: "📝", daemon: false },
        syslog: { category: "system", icon: "📝" },
        rpcd: { category: "system", icon: "⚡" },
        ubus: { category: "system", icon: "🔗" },

        // Системные скрипты (скрыты)
        boot: { category: "system", icon: "🚀", daemon: false },
        done: { category: "system", icon: "✅", daemon: false },
        sysfixtime: { category: "system", icon: "🕐", daemon: false },
        sysctl: { category: "system", icon: "⚙️", daemon: false },
        led: { category: "system", icon: "💡", daemon: false },
        gpio_switch: { category: "system", icon: "🔘", daemon: false },
        umount: { category: "system", icon: "💾", daemon: false },
        urandom_seed: { category: "system", icon: "🎲", daemon: false },
        ucitrack: { category: "system", icon: "📋", daemon: false },
        bootcount: { category: "system", icon: "🔢", daemon: false },
        packet_steering: { category: "network", icon: "📡", daemon: false },
      };

      this.availableServices = [];
      this.checkInterval = null;
      this.pollIntervalMs = 10000;
      this.pollIntervalExecMs = 30000; // Увеличенный интервал для exec-режима
      this._onVisibilityChange = null;
      this._statusCache = new Map();
      this._serviceElements = new Map(); // Кэш DOM-элементов
      this._rcListAll = null;

      // Маппинг имён init-скриптов на имена процессов (для pidof fallback)
      this._processNameMap = {
        ubus: "ubusd",
        rpcd: "rpcd",
        dnsmasq: "dnsmasq",
        dropbear: "dropbear",
        uhttpd: "uhttpd",
        nginx: "nginx",
        odhcpd: "odhcpd",
        cron: "crond",
        sysntpd: "ntpd",
      };
      this._rcListOne = null;
      this._serviceListOne = null; // ubus service list (deep check)
      this._deepCheck =
        this._safeGetItem("proton-services-deep-check") === "true";
      this._initdCache = null;
      this._initdCacheAt = 0;
	  this._refreshPromise = null;
      this._initdCacheTtlMs = 5 * 60 * 1000; // 5 минут
      this._initActionCache = new Map(); // serviceName -> 'running' | 'status'
      this._mounted = false;
      this._useExecMode = false; // Флаг использования медленного exec
      this._mutationObserver = null; // Для отслеживания удаления виджета
      this._updateQueue = []; // Очередь для последовательного опроса
      this._isUpdating = false;

      // Логирование: info (старт/конец цикла) всегда, debug (по сервисам) можно включить
      // localStorage['proton-services-widget-debug']='1' или window.protonServicesWidgetDebug=true
      this._debug =
        this._safeGetItem("proton-services-widget-debug") === "1" ||
        window.protonServicesWidgetDebug === true;

      // UI-лог (внизу секции виджета)
      this._uiLogLines = [];

      // Стартовый retry, если LuCI API (L.rpc/L.fs) ещё не готов
      this._backendRetryTimer = null;
      this._backendRetryAttempts = 0;
      this._backendRetryDelaysMs = [250, 500, 1000, 2000, 4000];
    }

    // ==================== Helpers ====================

    _safeGetItem(key) {
      try {
        return localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    }

    _safeSetItem(key, value) {
      try {
        localStorage.setItem(key, value);
        return true;
      } catch (e) {
        return false;
      }
    }

    escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    _isValidServiceName(value) {
      // Жёсткое ограничение: имена init.d/rc обычно [A-Za-z0-9_-]
      // Запрещаем '/', '.', пробелы и прочее, чтобы не дать собрать путь.
      if (typeof value !== "string") return false;
      if (value.length < 1 || value.length > 64) return false;
      return /^[A-Za-z0-9_-]+$/.test(value);
    }

    _normalizeServiceList(list) {
      if (!Array.isArray(list)) return [];
      const out = [];
      const seen = new Set();
      for (const name of list) {
        if (!this._isValidServiceName(name)) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        out.push(name);
      }
      return out;
    }

    _logInfo(message, extra) {
      try {
        if (
          typeof console !== "undefined" &&
          console &&
          typeof console.info === "function"
        ) {
          if (typeof extra !== "undefined")
            console.info("[ProtonServicesWidget]", message, extra);
          else console.info("[ProtonServicesWidget]", message);
        }
      } catch (e) {
        // Ignore console errors in restricted environments
      }
    }

    _logDebug(message, extra) {
      if (!this._debug) return;
      try {
        if (
          typeof console !== "undefined" &&
          console &&
          typeof console.debug === "function"
        ) {
          if (typeof extra !== "undefined")
            console.debug("[ProtonServicesWidget]", message, extra);
          else console.debug("[ProtonServicesWidget]", message);
        }
      } catch (e) {
        // Ignore console errors in restricted environments
      }
    }

    _getUiLogEl() {
      return document.getElementById("proton-services-log");
    }

    _formatTime(d) {
      const pad = (n) => String(n).padStart(2, "0");
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(
        d.getSeconds(),
      )}`;
    }

    _formatElapsedMs(ms) {
      if (typeof ms !== "number" || !isFinite(ms)) return "";
      if (ms < 1000) return `${Math.round(ms)}ms`;
      return `${(ms / 1000).toFixed(1)}s`;
    }

    _appendUiLogLine(text) {
      if (!text) return;
      const el = this._getUiLogEl();
      if (!el) return;

      const time = this._formatTime(new Date());
      this._uiLogLines.push({ time, text: String(text) });
      if (this._uiLogLines.length > 12)
        this._uiLogLines.splice(0, this._uiLogLines.length - 12);

      el.innerHTML = this._uiLogLines
        .map(
          (l) =>
            `<div class="proton-services-log-line"><span class="proton-services-log-time">${this.escapeHtml(
              l.time,
            )}</span><span class="proton-services-log-text">${this.escapeHtml(
              l.text,
            )}</span></div>`,
        )
        .join("");
    }

    _clearBackendRetry() {
      if (this._backendRetryTimer) {
        clearTimeout(this._backendRetryTimer);
        this._backendRetryTimer = null;
      }
      this._backendRetryAttempts = 0;
    }

    _scheduleBackendRetry(reason) {
      if (!this._mounted) return;
      if (this._backendRetryTimer) return;
      if (this._backendRetryAttempts >= this._backendRetryDelaysMs.length)
        return;

      const delay =
        this._backendRetryDelaysMs[this._backendRetryAttempts++] || 1000;
      this._logDebug("Scheduling backend retry", { reason, delay });
      this._appendUiLogLine(
        `Waiting for LuCI API... (${this._formatElapsedMs(delay)})`,
      );

      this._backendRetryTimer = setTimeout(() => {
        this._backendRetryTimer = null;
        if (!this._mounted) return;
        // Не запускаем поверх текущей проверки
        if (this._isUpdating) return;
        this.updateAllStatuses();
      }, delay);
    }

    // ==================== Локализация ====================

    _t(key) {
      // Используем глобальную функцию из translations.js
      if (window.protonT) {
        return window.protonT(key);
      }

      // Fallback на LuCI i18n
      if (window.L && L.tr) {
        const translated = L.tr(key);
        if (translated !== key) return translated;
      }

      return key;
    }

    getCategoryName(category) {
      const names = {
        custom: this._t("My Services"),
        network: this._t("Network"),
        security: this._t("Security"),
        vpn: this._t("VPN"),
        adblock: this._t("Ad Blocking"),
        system: this._t("System"),
        other: this._t("Other"),
      };
      return names[category] || category;
    }

    getServiceDescription(serviceName) {
      const descriptions = {
        dnsmasq: this._t("DNS and DHCP server"),
        firewall: this._t("Firewall"),
        network: this._t("Network interfaces"),
        uhttpd: this._t("LuCI web server"),
        odhcpd: this._t("DHCPv6 server"),
        dropbear: this._t("SSH access"),
        sysntpd: this._t("Time sync"),
        cron: this._t("Task scheduler"),
      };

      if (descriptions[serviceName]) return descriptions[serviceName];

      // Автоопределение по категории
      const info = this.knownServices[serviceName];
      if (info) {
        if (info.category === "vpn") return this._t("VPN service");
        if (info.category === "adblock") return this._t("Ad blocking");
      }

      return this._t("System service");
    }

    // ==================== Инициализация ====================

    init() {
    if (this._safeGetItem("proton-services-widget-enabled") === "false") {
      return;
    }

    if (!this.isOverviewPage()) return;

    // Legacy services-widget визуально заменён карточкой Applications.
    // Мы НЕ инжектим его карточку, но продолжаем инициализировать
    // список сервисов — ProtonServicesApi использует его данные.
    // (dashboard-apps.js ждёт window.protonServicesWidget.)

    // Пропускаем injectWidget, но выполняем load данных:
    this.refreshAvailableServices()
      .then(() => {
        // Диспатчим событие, чтобы dashboard-apps.js знал, что можно стартовать
        window.dispatchEvent(new CustomEvent("proton-services-widget-ready"));
      })
      .catch(() => {});

    this.startStatusMonitoring();
}

    isOverviewPage() {
      // Проверяем через dispatchpath (надёжнее чем data-page, который пустой на корневой странице)
      if (
        typeof L !== "undefined" &&
        L.env &&
        Array.isArray(L.env.dispatchpath)
      ) {
        const dp = L.env.dispatchpath;
        if (dp[0] === "admin" && dp[1] === "status" && dp[2] === "overview") {
          return true;
        }
      }
      return (
        document.body.dataset.page === "admin-status-overview" ||
        window.location.pathname.includes("/admin/status/overview")
      );
    }

    loadServices() {
      const saved = this._safeGetItem("proton-services-widget");
      // Если ничего не сохранено - показываем дефолтные сервисы
      if (saved === null || saved === undefined) return ["dnsmasq", "dropbear"];
      // Если сохранён пустой массив - возвращаем пустой (пользователь специально очистил)
      try {
        const parsed = JSON.parse(saved);
        return this._normalizeServiceList(parsed);
      } catch (e) {
        return ["dnsmasq", "dropbear"];
      }
    }

    saveServices() {
      this._safeSetItem(
        "proton-services-widget",
        JSON.stringify(this.services),
      );
    }

    // ==================== Виджет ====================

    injectWidget() {
      const maincontent = document.getElementById("maincontent");
      if (!maincontent) return false;

      // Prevent duplicate insertion
      const existing = document.getElementById("proton-services-widget");
      if (existing) {
        this._mounted = true;
        return true;
      }

      let insertPoint =
        maincontent.querySelector("h2") ||
        maincontent.querySelector("h3") ||
        maincontent.querySelector(".cbi-map") ||
        maincontent.firstElementChild;

      if (!insertPoint) return false;

      // Создаем или находим общий контейнер для виджетов
      let widgetsContainer = document.getElementById(
        "proton-widgets-container",
      );
      if (!widgetsContainer) {
        // Создаём секцию с заголовком "Виджеты" и кнопкой настроек
        const widgetsSection = document.createElement("div");
        widgetsSection.className = "proton-widgets-section";

        const sectionHeader = document.createElement("div");
        sectionHeader.className = "proton-widgets-section-header";

        const sectionTitle = document.createElement("h2");
        sectionTitle.className = "proton-widgets-section-title";
        sectionTitle.textContent = this._t("Widgets");

        const settingsBtn = document.createElement("button");
        settingsBtn.className = "proton-widgets-settings-btn";
        settingsBtn.title = this._t("Widget Settings");
        settingsBtn.innerHTML = `
          <svg class="proton-widgets-settings-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="4" y1="6" x2="20" y2="6"></line>
            <circle cx="9" cy="6" r="2"></circle>
            <line x1="4" y1="12" x2="20" y2="12"></line>
            <circle cx="15" cy="12" r="2"></circle>
            <line x1="4" y1="18" x2="20" y2="18"></line>
            <circle cx="7" cy="18" r="2"></circle>
          </svg>
        `;
        settingsBtn.addEventListener("click", () => this.showAddServiceModal());

        sectionHeader.appendChild(sectionTitle);
        sectionHeader.appendChild(settingsBtn);
        widgetsSection.appendChild(sectionHeader);

        widgetsContainer = document.createElement("div");
        widgetsContainer.className = "proton-widgets-container";
        widgetsContainer.id = "proton-widgets-container";
        widgetsSection.appendChild(widgetsContainer);

        insertPoint.parentNode.insertBefore(widgetsSection, insertPoint);
      }

      const widget = document.createElement("div");
      widget.className = "proton-services-widget";
      widget.id = "proton-services-widget";

      // Проверяем настройку отображения лога (по умолчанию выключен)
      const showLog = this._safeGetItem("proton-services-log") === "true";

      widget.innerHTML = `
                <div class="proton-services-header">
                    <h3 class="proton-services-title">${this._t(
                      "Services Monitor",
                    )}</h3>
                    <div class="proton-services-info">?
                        <div class="proton-services-tooltip">
                            <div class="proton-services-tooltip-title">${this._t(
                              "Services Monitor",
                            )}</div>
                            <div class="proton-services-tooltip-text">
                                ${this._t(
                                  "Monitor and manage system services. Click on service card to view details and control actions.",
                                )}
                            </div>
                            <div class="proton-services-tooltip-legend">
                                <div class="proton-services-tooltip-legend-item">
                                    <span class="proton-services-tooltip-legend-dot running"></span>
                                    <span>${this._t("Running")}</span>
                                </div>
                                <div class="proton-services-tooltip-legend-item">
                                    <span class="proton-services-tooltip-legend-dot stopped"></span>
                                    <span>${this._t("Stopped")}</span>
                                </div>
                                <div class="proton-services-tooltip-legend-item">
                                    <span class="proton-services-tooltip-legend-dot disabled"></span>
                                    <span>${this._t("Disabled")}</span>
                                </div>
                                <div class="proton-services-tooltip-legend-item">
                                    <span class="proton-services-tooltip-legend-dot unknown"></span>
                                    <span>${this._t("Unknown")}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="proton-services-grid" id="proton-services-grid"></div>
                <div class="proton-services-log" id="proton-services-log" aria-live="polite" style="${
                  showLog ? "" : "display:none"
                }"></div>
            `;

      widgetsContainer.appendChild(widget);

      this._mounted = true;

      this.renderServices();

      this._appendUiLogLine("Ready");

      return true;
    }

    getServiceInfo(serviceName) {
      const known = this.knownServices[serviceName] || {};
      return {
        name: serviceName,
        displayName: this.formatDisplayName(serviceName),
        description: this.getServiceDescription(serviceName),
        category: known.category || "other",
        icon: known.icon || "📦",
      };
    }

    formatDisplayName(name) {
      // Преобразуем имя в читаемый формат
      return name
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    cssEscape(value) {
      if (window.CSS && typeof window.CSS.escape === "function") {
        return window.CSS.escape(value);
      }
      return String(value).replace(/["\\]/g, "\\$&");
    }

    renderServices() {
      const grid = document.getElementById("proton-services-grid");
      if (!grid) return;

      // Очищаем кэш элементов при полной перерисовке
      this._serviceElements.clear();
      grid.innerHTML = "";

      // Если нет сервисов - показываем минималистичный placeholder
      if (this.services.length === 0) {
        const placeholder = document.createElement("div");
        placeholder.className = "proton-services-empty";
        placeholder.innerHTML = `<span class="proton-services-empty-hint">${this._t(
          "Click ⚙ to add services",
        )}</span>`;
        grid.appendChild(placeholder);
        return;
      }

      this.services.forEach((serviceName) => {
        const info = this.getServiceInfo(serviceName);
        const card = this.createServiceCard({ ...info, serviceName });
        grid.appendChild(card);
      });
      this.updateAllStatuses();
    }

    createServiceCard(info) {
      const card = document.createElement("div");
      card.className = "proton-service-card";
      card.id = `proton-service-${String(info.serviceName || "")
        .trim()
        .replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
      card.dataset.service = info.serviceName;
      card.dataset.category = info.category;

      const safeDisplayName = this.escapeHtml(info.displayName);
      const safeDescription = this.escapeHtml(info.description);
      const safeIcon = this.escapeHtml(info.icon);

      card.innerHTML = `
                <div class="proton-service-card-header">
                    <span class="proton-service-icon">${safeIcon}</span>
                    <h4 class="proton-service-name">${safeDisplayName}</h4>
                    <button class="proton-service-remove" title="${this._t(
                      "Remove",
                    )}">×</button>
                </div>
                <div class="proton-service-status">
                    <span class="proton-service-status-dot" data-status="checking"></span>
                    <span class="proton-service-status-text">${this._t(
                      "Checking...",
                    )}</span>
                </div>
                <p class="proton-service-description">${safeDescription}</p>
            `;

      card
        .querySelector(".proton-service-remove")
        .addEventListener("click", (e) => {
          e.stopPropagation();
          this.removeService(info.serviceName);
        });

      // Кэшируем ссылки на DOM-элементы для быстрого обновления
      this._serviceElements.set(info.serviceName, {
        card: card,
        dot: card.querySelector(".proton-service-status-dot"),
        text: card.querySelector(".proton-service-status-text"),
      });

      // Если статус уже известен из предыдущих проверок, применяем его к новому DOM.
      // Иначе после полной перерисовки карточки могут зависать на "Checking...".
      const cachedStatus = this._statusCache.get(info.serviceName);
      if (cachedStatus) {
        this.updateServiceCard(info.serviceName, cachedStatus);
      }

      return card;
    }

    // ==================== Модальное окно ====================

    async showAddServiceModal() {
      this._appendUiLogLine("Opening configuration...");

      // Проверяем текущее состояние виджетов и настроек
      const tempWidgetEnabled =
        this._safeGetItem("proton-temp-widget-enabled") !== "false";
      const deepCheckEnabled =
        this._safeGetItem("proton-services-deep-check") === "true";

      const modal = document.createElement("div");
      modal.className = "proton-service-modal";
      modal.innerHTML = `
                <div class="proton-service-modal-content">
                    <div class="proton-service-modal-header">
                        <h3 class="proton-service-modal-title">${this._t(
                          "Widget Settings",
                        )}</h3>
                        <button class="proton-service-modal-close">×</button>
                    </div>
                    
                    <div class="proton-widget-toggles">
                        <label class="proton-widget-toggle">
                            <span class="proton-widget-toggle-info">
                                <span class="proton-widget-toggle-icon">🌡</span>
                                <span class="proton-widget-toggle-name">${this._t(
                                  "Temperature Widget",
                                )}</span>
                            </span>
                            <input type="checkbox" id="proton-temp-widget-toggle" ${
                              tempWidgetEnabled ? "checked" : ""
                            }>
                            <span class="proton-widget-toggle-slider"></span>
                        </label>
                        <label class="proton-widget-toggle">
                            <span class="proton-widget-toggle-info">
                                <span class="proton-widget-toggle-icon">🔬</span>
                                <span class="proton-widget-toggle-name">${this._t(
                                  "Deep Service Check",
                                )}</span>
                                <span class="proton-widget-toggle-desc">${this._t(
                                  "Accurate status for adblock, banip, etc.",
                                )}</span>
                            </span>
                            <input type="checkbox" id="proton-deep-check-toggle" ${
                              deepCheckEnabled ? "checked" : ""
                            }>
                            <span class="proton-widget-toggle-slider"></span>
                        </label>
                    </div>
                    
                    <div class="proton-service-modal-section-title">${this._t(
                      "Services",
                    )}</div>
                    
                    <div class="proton-service-search">
                        <input type="text" id="proton-service-search-input" 
                               placeholder="${this._t(
                                 "Search or add custom service...",
                               )}" autocomplete="off" maxlength="64">
                    </div>
                    <div class="proton-service-list" id="proton-service-list">
                        <div class="proton-service-loading">
                            <div class="proton-service-loading-spinner"></div>
                            <span>${this._t("Loading services...")}</span>
                        </div>
                    </div>
                </div>
            `;

      document.body.appendChild(modal);

      // Обработчик переключателя виджета температуры
      const tempToggle = modal.querySelector("#proton-temp-widget-toggle");
      tempToggle.addEventListener("change", () => {
        const enabled = tempToggle.checked;
        this._safeSetItem(
          "proton-temp-widget-enabled",
          enabled ? "true" : "false",
        );

        // Находим виджет температуры и показываем/скрываем
        const tempWidget = document.querySelector(".proton-temp-widget");
        if (tempWidget) {
          tempWidget.style.display = enabled ? "" : "none";
        }

        // Обновляем видимость секции виджетов
        updateWidgetsSectionVisibility();
      });

      // Обработчик переключателя Deep Check
      const deepToggle = modal.querySelector("#proton-deep-check-toggle");
      deepToggle.addEventListener("change", () => {
        const enabled = deepToggle.checked;
        this._safeSetItem("proton-services-deep-check", String(enabled));
        this._deepCheck = enabled;
        // Сбрасываем кэш статусов для переопроса
        this._statusCache.clear();
        this.updateAllStatuses();
      });

      let onEscape;
      const closeModal = () => {
        modal.classList.remove("active");
        setTimeout(() => modal.remove(), 250);
        if (onEscape) {
          document.removeEventListener("keydown", onEscape);
          onEscape = null;
        }
      };

      modal
        .querySelector(".proton-service-modal-close")
        .addEventListener("click", closeModal);
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closeModal();
      });

      // Escape для закрытия
      onEscape = (e) => {
        if (e.key === "Escape") {
          closeModal();
        }
      };
      document.addEventListener("keydown", onEscape);

      await this.refreshAvailableServices();

      const list = modal.querySelector("#proton-service-list");
      const searchInput = modal.querySelector("#proton-service-search-input");

      // Функция добавления пользовательского сервиса из поиска
      const addCustomFromSearch = (name) => {
        const normalizedName = name.trim().toLowerCase();
        if (!this._isValidServiceName(normalizedName)) return;
        if (this.services.includes(normalizedName)) return;

        this.addService(normalizedName);
        searchInput.value = "";
        this.renderServiceList(list, "", this, addCustomFromSearch);
      };

      // Рендерим список с группировкой
      const initialCount = this.renderServiceList(
        list,
        "",
        this,
        addCustomFromSearch,
      );
      this._appendUiLogLine(`Available targets: ${initialCount}`);

      // Поиск с debounce
      let searchTimeout;
      searchInput.addEventListener("input", (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          const q = String(e.target.value || "").toLowerCase();
          const count = this.renderServiceList(
            list,
            q,
            this,
            addCustomFromSearch,
          );
          if (q) {
            this._appendUiLogLine(`Search: "${q}" - ${count}`);
          } else {
            this._appendUiLogLine(`Available: ${count}`);
          }
        }, 150);
      });

      // Enter в поле поиска — добавить как custom если валидно
      searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const q = searchInput.value.trim();
          if (
            q &&
            this._isValidServiceName(q) &&
            !this.services.includes(q.toLowerCase())
          ) {
            addCustomFromSearch(q);
          }
        }
      });

      setTimeout(() => {
        modal.classList.add("active");
        searchInput.focus();
      }, 10);
    }

    renderServiceList(container, filter, widget, addCustomCallback) {
      container.innerHTML = "";

      let matchCount = 0;
      const filterLower = (filter || "").toLowerCase().trim();

      // Группируем по категориям
      const grouped = new Map();

      // Сначала добавляем пользовательские сервисы (которых нет в availableServices)
      const availableNames = new Set(this.availableServices.map((s) => s.name));
      const customServices = this.services.filter(
        (name) => !availableNames.has(name),
      );

      if (customServices.length > 0) {
        customServices.forEach((serviceName) => {
          const info = this.getServiceInfo(serviceName);

          // Фильтрация по поиску
          if (filterLower) {
            const searchText =
              `${serviceName} ${info.displayName} ${info.description}`.toLowerCase();
            if (!searchText.includes(filterLower)) return;
          }

          if (!grouped.has("custom")) {
            grouped.set("custom", []);
          }
          grouped.get("custom").push({
            ...info,
            name: serviceName,
            installed: false,
            isCustom: true,
          });
          matchCount++;
        });
      }

      this.availableServices.forEach((service) => {
        const info = this.getServiceInfo(service.name);

        // Скрываем скрипты-настройщики (daemon: false)
        const knownInfo = this.knownServices[service.name];
        if (knownInfo && knownInfo.daemon === false) return;

        // Фильтрация по поиску
        if (filterLower) {
          const searchText =
            `${service.name} ${info.displayName} ${info.description}`.toLowerCase();
          if (!searchText.includes(filterLower)) return;
        }

        if (!grouped.has(info.category)) {
          grouped.set(info.category, []);
        }
        grouped
          .get(info.category)
          .push({ ...info, ...service, installed: service.fromInitd === true });
        matchCount++;
      });

      // Сортируем категории (custom первым)
      const sortedCategories = Array.from(grouped.keys()).sort((a, b) => {
        if (a === "custom") return -1;
        if (b === "custom") return 1;
        return (
          (this.categories[a]?.priority || 99) -
          (this.categories[b]?.priority || 99)
        );
      });

      // Если ничего не найдено и есть фильтр — предложить добавить как custom
      if (sortedCategories.length === 0 && filterLower) {
        const isValid = this._isValidServiceName(filterLower);
        const alreadyAdded = this.services.includes(filterLower);

        const emptyDiv = document.createElement("div");
        emptyDiv.className = "proton-service-empty-custom";

        if (!isValid) {
          emptyDiv.innerHTML = `
            <div class="proton-service-empty-icon">🔍</div>
            <div class="proton-service-empty-text">${this._t(
              "No services found",
            )}</div>
            <div class="proton-service-empty-hint">${this._t(
              "Invalid name. Use only: a-z, 0-9, -, _",
            )}</div>
          `;
        } else if (alreadyAdded) {
          emptyDiv.innerHTML = `
            <div class="proton-service-empty-icon">✓</div>
            <div class="proton-service-empty-text">"${this.escapeHtml(
              filterLower,
            )}" ${this._t("already added")}</div>
          `;
        } else {
          emptyDiv.innerHTML = `
            <div class="proton-service-empty-icon">📦</div>
            <div class="proton-service-empty-text">${this._t(
              "Service not found in system",
            )}</div>
            <button class="proton-service-add-custom-btn" data-name="${this.escapeHtml(
              filterLower,
            )}">
              + ${this._t("Add")} "${this.escapeHtml(filterLower)}" ${this._t(
                "as custom",
              )}
            </button>
            <div class="proton-service-empty-hint">${this._t(
              "Or press Enter",
            )}</div>
          `;

          const btn = emptyDiv.querySelector(".proton-service-add-custom-btn");
          if (btn && addCustomCallback) {
            btn.addEventListener("click", () => {
              addCustomCallback(filterLower);
            });
          }
        }

        container.appendChild(emptyDiv);
        return 0;
      }

      if (sortedCategories.length === 0) {
        container.innerHTML = `<div class="proton-service-empty">${this._t(
          "No services found",
        )}</div>`;
        return 0;
      }

      sortedCategories.forEach((category) => {
        const services = grouped.get(category);
        const catInfo = this.categories[category] || {};

        // Заголовок категории
        const header = document.createElement("div");
        header.className = "proton-service-list-category";
        header.innerHTML = `${catInfo.icon || ""} ${this.getCategoryName(
          category,
        )}`;
        container.appendChild(header);

        services.forEach((service) => {
          const isAdded = this.services.includes(service.name);
          const isInstalled = service.installed === true;
          const isCustom = service.isCustom === true;

          const safeDisplayName = this.escapeHtml(service.displayName);
          const safeDescription = this.escapeHtml(service.description);
          const safeIcon = this.escapeHtml(service.icon);
          const safeNameAttr = this.escapeHtml(service.name);

          // Определяем текст и класс кнопки
          let btnClass = "proton-service-item-add";
          let btnText = "+ " + this._t("Add");

          if (isCustom) {
            // Пользовательские сервисы всегда показывают "Remove"
            btnClass += " added";
            btnText = this._t("Remove");
          } else if (!isInstalled) {
            btnClass += " not-installed";
            btnText = this._t("Not installed");
          } else if (isAdded) {
            btnClass += " added";
            btnText = this._t("Remove");
          }

          const item = document.createElement("div");
          item.className =
            "proton-service-item" +
            (isCustom ? " proton-service-item-custom" : "");
          item.innerHTML = `
                        <div class="proton-service-item-info">
                            <span class="proton-service-item-icon">${safeIcon}</span>
                            <div>
                                <h4>${safeDisplayName}${
                                  isCustom
                                    ? ' <span class="proton-custom-badge">' +
                                      this._t("custom") +
                                      "</span>"
                                    : ""
                                }</h4>
                                <p>${safeDescription}</p>
                            </div>
                        </div>
                        <button class="${btnClass}" data-service="${safeNameAttr}">
                            ${btnText}
                        </button>
                    `;

          // Сервис добавлен в виджет, но не установлен на роутере — показать кнопку удаления
          const isAddedButMissing = isAdded && !isInstalled && !isCustom;

          if (isCustom || isInstalled || isAddedButMissing) {
            const btn = item.querySelector(".proton-service-item-add");

            // Для не-установленных, но добавленных: переключаем стиль кнопки на "Remove"
            if (isAddedButMissing) {
              btn.classList.remove("not-installed");
              btn.classList.add("added", "not-installed-remove");
              btn.textContent = "✕ " + this._t("Remove");
            }

            btn.addEventListener("click", () => {
              if (btn.classList.contains("added") || isAddedButMissing) {
                // Удаляем сервис
                this.removeService(service.name);
                if (isCustom) {
                  // Для custom сервисов — убираем из списка
                  item.remove();
                } else {
                  btn.classList.remove("added", "not-installed-remove");
                  if (!isInstalled) {
                    btn.classList.add("not-installed");
                    btn.textContent = this._t("Not installed");
                  } else {
                    btn.textContent = "+ " + this._t("Add");
                  }
                }
              } else {
                // Добавляем сервис
                this.addService(service.name);
                btn.classList.add("added");
                btn.textContent = this._t("Remove");
              }
            });
          }

          container.appendChild(item);
        });
      });

      return matchCount;
    }

    // ==================== Управление сервисами ====================

    addService(serviceName) {
      if (!this._isValidServiceName(serviceName)) return;
      if (!this.services.includes(serviceName)) {
        this.services.push(serviceName);
        this.saveServices();
        this._statusCache.delete(serviceName);
        this._initActionCache.delete(serviceName);
        this._appendUiLogLine(`Added: ${serviceName}`);
        this.renderServices();
      }
    }

    removeService(serviceName) {
      const index = this.services.indexOf(serviceName);
      if (index > -1) {
        this.services.splice(index, 1);
        this.saveServices();
        this._statusCache.delete(serviceName);
        this._initActionCache.delete(serviceName);
        this._appendUiLogLine(`Removed: ${serviceName}`);

        // Инкрементальное удаление без полной перерисовки
        const cached = this._serviceElements.get(serviceName);
        if (cached && cached.card && cached.card.parentNode) {
          cached.card.remove();
          this._serviceElements.delete(serviceName);

          // Проверяем, нужно ли удалить пустые заголовки категорий
          this._cleanupEmptyCategoryHeaders();

          // Если это был последний сервис — показываем placeholder
          if (this.services.length === 0) {
            this.renderServices();
          }
        } else {
          // Fallback на полную перерисовку
          this.renderServices();
        }
      }
    }

    // Удаляет пустые заголовки категорий
    _cleanupEmptyCategoryHeaders() {
      const grid = document.getElementById("proton-services-grid");
      if (!grid) return;

      const headers = grid.querySelectorAll(".proton-services-category-header");
      headers.forEach((header) => {
        let nextEl = header.nextElementSibling;
        // Если следующий элемент - другой заголовок или конец, удаляем текущий
        if (
          !nextEl ||
          nextEl.classList.contains("proton-services-category-header")
        ) {
          header.remove();
        }
      });
    }

    // ==================== Обнаружение сервисов ====================

    discoverServicesFromMenu() {
      const out = [];
      const seen = new Set();

      const anchors = document.querySelectorAll(
        '#mainmenu a[href*="/admin/services/"]',
      );
      anchors.forEach((a) => {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/admin\/services\/(.+)$/);
        if (!m) return;
        const slug = decodeURIComponent(m[1]).split(/[?#]/)[0].split("/")[0];
        if (!this._isValidServiceName(slug)) return;
        if (!slug || slug === "services") return;
        if (seen.has(slug)) return;
        seen.add(slug);
        out.push({ name: slug, fromMenu: true });
      });

      return out;
    }

    async discoverServicesFromUbus() {
      const now = Date.now();
      // Используем кэш только если он НЕ пустой и не истёк
      if (
        this._initdCache &&
        this._initdCache.length > 0 &&
        now - this._initdCacheAt < this._initdCacheTtlMs
      ) {
        this._logDebug("Using cached init.d list", this._initdCache.length);
        return this._initdCache;
      }

      // Способ 1: Через RPC rc list (предпочтительный - работает если есть доступ к rc)
      if (window.L && L.resolveDefault && L.rpc) {
        try {
          if (!this._rcListAll) {
            this._rcListAll = L.rpc.declare({
              object: "rc",
              method: "list",
              params: [],
              expect: { "": {} },
            });
          }
          const allServices = await L.resolveDefault(this._rcListAll(), {});
          if (allServices && typeof allServices === "object") {
            const names = Object.keys(allServices);
            if (names.length > 0) {
              this._initdCache = names
                .filter((name) => this._isValidServiceName(name))
                .map((name) => ({ name, fromInitd: true }));
              this._initdCacheAt = now;
              this._logDebug(
                "Discovered services via rc list",
                this._initdCache.length,
              );
              return this._initdCache;
            }
          }
        } catch (e) {
          this._logDebug("rc list error", e);
        }
      }

      // Способ 2: Через L.fs.list (fallback)
      if (window.L && L.fs && L.fs.list) {
        try {
          const files = await L.fs.list("/etc/init.d");
          this._logDebug("L.fs.list result", files);
          if (files && Array.isArray(files)) {
            this._initdCache = files
              .filter(
                (f) =>
                  f.type === "file" &&
                  !f.name.startsWith(".") &&
                  this._isValidServiceName(f.name),
              )
              .map((f) => ({ name: f.name, fromInitd: true }));
            this._initdCacheAt = now;
            this._logDebug(
              "Discovered init.d services via fs.list",
              this._initdCache.length,
            );
            return this._initdCache;
          }
        } catch (e) {
          this._logDebug("L.fs.list error", e);
        }
      } else {
        this._logDebug("L.fs.list not available", {
          L: !!window.L,
          fs: !!(window.L && L.fs),
          list: !!(window.L && L.fs && L.fs.list),
        });
      }

      // Не кэшируем пустой результат - попробуем снова при следующем вызове
      this._logDebug("No services discovered, not caching");
      return [];
    }

        async refreshAvailableServices() {
    if (this._refreshPromise) return this._refreshPromise;

    this._refreshPromise = (async () => {
        this._appendUiLogLine("Loading available services...");

        // Пытаемся получить список сервисов с несколькими попытками,
        // если rc.list вернул пустой результат (гонка с ACL/rpcd).
        let initdServices = [];
        for (let attempt = 0; attempt < 3; attempt++) {
            initdServices = await this.discoverServicesFromUbus();
            if (Array.isArray(initdServices) && initdServices.length > 0) break;
            this._appendUiLogLine(`Retry init.d discovery (${attempt + 1}/3)...`);
            await new Promise((r) => setTimeout(r, 500));
        }

        const initdSet = new Set(initdServices.map((s) => s.name));

        this._appendUiLogLine(`Init.d config size: ${initdSet.size}`);

        const merged = new Map();

        Object.keys(this.knownServices).forEach((name) => {
            if (this._isValidServiceName(name)) {
                merged.set(name, { name, fromInitd: initdSet.has(name) });
            }
        });

        this.discoverServicesFromMenu().forEach((s) => {
            if (!merged.has(s.name)) {
                merged.set(s.name, { ...s, fromInitd: initdSet.has(s.name) });
            }
        });

        initdServices.forEach((s) => {
            if (!merged.has(s.name)) {
                // ВАЖНО: fromInitd: true здесь обязательно
                merged.set(s.name, { name: s.name, fromInitd: true });
            }
        });

        this.availableServices = Array.from(merged.values());
        this._appendUiLogLine(`Services loaded: ${this.availableServices.length}`);
    })();

    try {
        await this._refreshPromise;
    } finally {
        this._refreshPromise = null;
    }

    return this.availableServices;
}

    // ==================== Проверка статуса ====================

    async updateAllStatuses() {
      if (!this._mounted) return;
      if (this._isUpdating) {
        this._logDebug("Skip: update already in progress");
        return;
      }
      this._isUpdating = true;

      const startedAt = Date.now();
      let mode = "unknown";
      this._logInfo("Checking services...");
      this._appendUiLogLine("Checking services...");

      const hasRpc = !!(window.L && L.resolveDefault && L.rpc);
      const hasExec = !!(window.L && L.fs && L.fs.exec);

      try {
        if (!hasRpc && !hasExec) {
          mode = "none";
          for (const serviceName of this.services) {
            if (this._statusCache.get(serviceName) !== "unknown") {
              this._statusCache.set(serviceName, "unknown");
              this.updateServiceCard(serviceName, "unknown");
            }
          }

          // Частый кейс после reload: LuCI JS API ещё не готов.
          // Запланируем несколько коротких ретраев (не периодический таймер).
          this._scheduleBackendRetry("no-backend");
          return;
        }

        // Backend доступен - сбрасываем ретраи
        this._clearBackendRetry();

        if (hasRpc) {
          try {
            if (!this._rcListAll) {
              this._rcListAll = L.rpc.declare({
                object: "rc",
                method: "list",
                params: [],
                expect: { "": {} },
              });
            }
            const allServices = await L.resolveDefault(this._rcListAll(), {});

            // Проверяем, что RPC вернул валидные данные
            if (
              allServices &&
              typeof allServices === "object" &&
              Object.keys(allServices).length > 0
            ) {
              this._useExecMode = false; // RPC работает, используем быстрый режим
              mode = "rpc";

              // Сервисы, которых нет в rc.list — проверим через init-скрипт
              const missingServices = [];

              // Сервисы, требующие глубокой проверки (enabled но не running)
              const needDeepCheck = [];

              for (const serviceName of this.services) {
                if (!this._isValidServiceName(serviceName)) continue;

                let status = "stopped";

                if (allServices[serviceName]) {
                  const svc = allServices[serviceName];
                  if (svc.running === true) {
                    status = "running";
                  } else if (svc.enabled === true) {
                    // Сервис включен, но не запущен как демон (возможно daemonless)
                    if (this._deepCheck) {
                      needDeepCheck.push(serviceName);
                    } else {
                      // Простой режим: принудительно проверяем через init.d
                      const initCheck =
                        await this.checkViaInitScript(serviceName);
                      if (initCheck === "running") {
                        status = "running";
                        this._appendUiLogLine(
                          `[Fallback] ${serviceName} is running`,
                        );
                      } else if (initCheck === null) {
                        status = "unknown";
                        this._appendUiLogLine(
                          `[Fallback] ${serviceName} init.d check unavailable`,
                        );
                      }
                    }
                  }
                } else {
                  // Сервис не найден в rc.list — нужна отдельная проверка
                  missingServices.push(serviceName);
                  continue;
                }

                if (this._statusCache.get(serviceName) !== status) {
                  this._statusCache.set(serviceName, status);
                  this.updateServiceCard(serviceName, status);
                }
              }

              // Deep check: запрашиваем service list для «спящих» сервисов
              for (const serviceName of needDeepCheck) {
                try {
                  const status = await this._deepCheckService(serviceName);
                  if (status === "running") {
                    this._appendUiLogLine(`[Deep] ${serviceName} is running`);
                  }
                  if (this._statusCache.get(serviceName) !== status) {
                    this._statusCache.set(serviceName, status);
                    this.updateServiceCard(serviceName, status);
                  }
                } catch (e) {
                  if (this._statusCache.get(serviceName) !== "stopped") {
                    this._statusCache.set(serviceName, "stopped");
                    this.updateServiceCard(serviceName, "stopped");
                  }
                }
              }

              // Fallback: для сервисов, не найденных в rc.list,
              // проверяем через init-скрипт или индивидуальный RPC-запрос
              if (missingServices.length > 0) {
                this._appendUiLogLine(
                  `Checking ${missingServices.length} missing services...`,
                );
              }
              for (const serviceName of missingServices) {
                try {
                  const status = await this.checkServiceStatus(serviceName);
                  if (this._statusCache.get(serviceName) !== status) {
                    this._statusCache.set(serviceName, status);
                    this.updateServiceCard(serviceName, status);
                  }
                } catch (e) {
                  if (this._statusCache.get(serviceName) !== "unknown") {
                    this._statusCache.set(serviceName, "unknown");
                    this.updateServiceCard(serviceName, "unknown");
                  }
                }
              }
              return;
            }
          } catch (e) {
            // RPC parsing failed, fallback to exec mode
          }
        }

        // Fallback на exec-режим - используем последовательный опрос для снижения нагрузки
        this._useExecMode = true;
        mode = hasExec ? "exec" : hasRpc ? "rpc-empty" : "none";
        await this._updateStatusesSequentiallyNoLock();
      } finally {
        this._isUpdating = false;
        const elapsedMs = Date.now() - startedAt;
        this._logInfo("Check complete", { mode, elapsedMs });

        let runCount = 0;
        let stopCount = 0;
        let missingCount = 0;
        let errCount = 0;
        for (const st of this._statusCache.values()) {
          if (st === "running") runCount++;
          else if (st === "stopped") stopCount++;
          else if (st === "not-installed") missingCount++;
          else errCount++;
        }

        let statsStr = `${runCount} up, ${stopCount} down`;
        if (missingCount > 0) statsStr += `, ${missingCount} n/a`;
        if (errCount > 0) statsStr += `, ${errCount} err`;

        this._appendUiLogLine(
          `Check complete [${mode}]: ${statsStr} (${this._formatElapsedMs(elapsedMs)})`,
        );
      }
    }

    // Последовательное обновление статусов для снижения нагрузки на CPU
    async _updateStatusesSequentiallyNoLock() {
      for (const serviceName of this.services) {
        // Проверяем, не был ли виджет удален
        if (!this._mounted) break;
        if (!this._isValidServiceName(serviceName)) continue;

        this._logDebug("Checking service", serviceName);

        await this.updateServiceStatus(serviceName);

        this._logDebug("Checked service", serviceName);

        // Небольшая пауза между проверками для снижения нагрузки
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    async updateServiceStatus(serviceName) {
      try {
        const status = await this.checkServiceStatus(serviceName);
        if (this._statusCache.get(serviceName) !== status) {
          this._statusCache.set(serviceName, status);
          this.updateServiceCard(serviceName, status);
        }
      } catch (error) {
        if (this._statusCache.get(serviceName) !== "error") {
          this._statusCache.set(serviceName, "error");
          this.updateServiceCard(serviceName, "error");
        }
      }
    }

    // Deep check через ubus service list — получает полные данные включая data.*_status
    async _deepCheckService(serviceName) {
      if (!window.L || !L.resolveDefault || !L.rpc) return "stopped";

      try {
        if (!this._serviceListOne) {
          this._serviceListOne = L.rpc.declare({
            object: "service",
            method: "list",
            params: ["name"],
            expect: { "": {} },
          });
        }

        const result = await L.resolveDefault(
          this._serviceListOne(serviceName),
          null,
        );

        if (result && result[serviceName]) {
          const svc = result[serviceName];

          // Проверяем instances на running
          if (svc.instances && typeof svc.instances === "object") {
            const hasActive = Object.values(svc.instances).some(
              (inst) => inst && inst.running === true,
            );
            if (hasActive) return "running";
          }

          // Проверяем data на *_status поля
          if (svc.data && typeof svc.data === "object") {
            const activeIndicators = [
              "enabled",
              "running",
              "active",
              "started",
            ];
            for (const key of Object.keys(svc.data)) {
              if (key.endsWith("_status")) {
                const val = svc.data[key];
                if (
                  typeof val === "string" &&
                  activeIndicators.includes(val.toLowerCase())
                ) {
                  return "running";
                }
              }
            }
          }
        }
      } catch (e) {
        this._logDebug("Deep check failed for", serviceName, e);
      }

      // Fallback на init.d
      const initCheck = await this.checkViaInitScript(serviceName);
      if (initCheck === "running") return "running";
      if (initCheck === null) return "unknown";

      return "stopped";
    }

    async checkServiceStatus(serviceName) {
      try {
        if (!this._isValidServiceName(serviceName)) return "unknown";

        if (window.L && L.resolveDefault && L.rpc) {
          try {
            if (!this._rcListOne) {
              this._rcListOne = L.rpc.declare({
                object: "rc",
                method: "list",
                params: ["name"],
                expect: { "": {} },
              });
            }

            const result = await L.resolveDefault(
              this._rcListOne(serviceName),
              null,
            );

            if (result && result[serviceName]) {
              const svcData = result[serviceName];

              if (svcData.running === true) {
                return "running";
              }

              if (svcData.enabled === true) {
                // Deep mode: проверяем через service list
                if (this._deepCheck) {
                  return await this._deepCheckService(serviceName);
                }

                // Простой режим: init.d fallback
                const initCheck = await this.checkViaInitScript(serviceName);
                if (initCheck === "running") return "running";
                if (initCheck === null) return "unknown";
              }

              return "stopped";
            }
          } catch (e) {
            // RPC check failed, fallback to init script
          }
        }

        const initCheck = await this.checkViaInitScript(serviceName);
        if (initCheck !== null) return initCheck;

        // Последний fallback: проверяем через pidof (для ubus и подобных)
        const pidofCheck = await this.checkViaPidof(serviceName);
        if (pidofCheck !== null) return pidofCheck;

        // Сервис не найден ни в rc.list, ни в init.d, ни через pidof
        // — скорее всего пакет удалён с роутера
        return "not-installed";
      } catch (error) {
        return "error";
      }
    }

    // Проверка через pidof — используется как последний fallback
    // для сервисов вроде ubus, которые не видны в rc.list и init.d
    async checkViaPidof(serviceName) {
      if (!window.L || !L.fs || !L.fs.exec) return null;

      // Определяем имя процесса
      const processName = this._processNameMap[serviceName] || serviceName;

      try {
        const result = await L.fs.exec("/bin/pidof", [processName]);
        if (result && result.code === 0) return "running";
        if (result && typeof result.code === "number") return "stopped";
      } catch (e) {
        // pidof не доступен или ошибка
      }

      return null;
    }

    async checkViaInitScript(serviceName) {
      if (window.L && L.fs && L.fs.exec) {
        if (!this._isValidServiceName(serviceName)) return null;

        const path = "/etc/init.d/" + serviceName;
        const preferred = this._initActionCache.get(serviceName);

        const runAction = async (action) => {
          try {
            const result = await L.fs.exec(path, [action]);
            if (!result || typeof result.code !== "number") return null;
            if (result.code === 0) return "running";
            // 126/127 обычно означают "не удалось выполнить" / "не найдено".
            if (result.code === 126 || result.code === 127) return null;
            return "stopped";
          } catch (e) {
            return null;
          }
        };

        // Если уже знаем команду, которая ранее вернула "running" — используем её
        if (preferred === "running" || preferred === "status") {
          const res = await runAction(preferred);
          if (res === "running") return "running";
          // Не доверяем кэшу, перепроверим обе команды
          this._initActionCache.delete(serviceName);
        }

        // Пробуем обе команды: "running" и "status"
        // Кэшируем ту, которая вернула "running" (= сервис активен)
        // Некоторые сервисы (adblock, banip) возвращают exit 1 для "running",
        // но exit 0 для "status" — нужно проверить обе
        let sawStopped = false;
        for (const action of ["running", "status"]) {
          const res = await runAction(action);
          if (res === "running") {
            this._initActionCache.set(serviceName, action);
            return "running";
          }
          if (res === "stopped") {
            sawStopped = true;
          }
        }

        // Если не смогли выполнить ни один вариант — возвращаем null,
        // чтобы вызывающий код мог показать unknown/перейти к следующему fallback.
        return sawStopped ? "stopped" : null;
      }
      return null;
    }

    updateServiceCard(serviceName, status) {
      // Используем кэшированные элементы вместо querySelector
      const cached = this._serviceElements.get(serviceName);
      if (!cached || !cached.card) return;

      const { dot, text } = cached;

      dot.className = "proton-service-status-dot " + status;
      text.className = "proton-service-status-text " + status;

      const statusTexts = {
        running: this._t("Running"),
        stopped: this._t("Stopped"),
        "not-installed": this._t("Not installed"),
        error: this._t("Error"),
        unknown: this._t("Unknown"),
      };
      text.textContent = statusTexts[status] || status;
    }

    // ==================== Мониторинг ====================

    startStatusMonitoring() {
      if (!this._mounted) return;

      this._setupMutationObserver();
      // Таймерный опрос отключён по требованию: обновления происходят
      // при первичном рендере, при действиях пользователя и при возврате на вкладку.

      if (!this._onVisibilityChange) {
        let lastVisibleTime = Date.now();
        this._onVisibilityChange = () => {
          if (document.hidden) {
            lastVisibleTime = Date.now();
            return;
          }
          const elapsed = Date.now() - lastVisibleTime;
          if (elapsed > 3000) {
            this.updateAllStatuses();
          }
        };
        document.addEventListener("visibilitychange", this._onVisibilityChange);
      }
    }

    // Планируем следующее обновление с динамическим интервалом
    _scheduleNextUpdate() {
      if (this.checkInterval) {
        clearTimeout(this.checkInterval);
        this.checkInterval = null;
      }

      if (!this._mounted) return;

      // Используем увеличенный интервал в exec-режиме
      const interval = this._useExecMode
        ? this.pollIntervalExecMs
        : this.pollIntervalMs;

      this.checkInterval = setTimeout(() => {
        if (document.hidden) {
          this._scheduleNextUpdate();
          return;
        }
        this.updateAllStatuses().finally(() => {
          this._scheduleNextUpdate();
        });
      }, interval);
    }

    // MutationObserver для автоматической очистки при удалении виджета из DOM
    _setupMutationObserver() {
      if (this._mutationObserver) return;

      const widget = document.getElementById("proton-services-widget");
      if (!widget || !widget.parentNode) return;

      this._mutationObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const removed of mutation.removedNodes) {
            if (
              removed === widget ||
              (removed.contains && removed.contains(widget))
            ) {
              this.stop();
              return;
            }
          }
        }
      });

      this._mutationObserver.observe(widget.parentNode, {
        childList: true,
        subtree: true,
      });
    }

    stop() {
      this._mounted = false;

      this._clearBackendRetry();

      if (this.checkInterval) {
        clearTimeout(this.checkInterval);
        this.checkInterval = null;
      }

      if (this._onVisibilityChange) {
        document.removeEventListener(
          "visibilitychange",
          this._onVisibilityChange,
        );
        this._onVisibilityChange = null;
      }

      if (this._mutationObserver) {
        this._mutationObserver.disconnect();
        this._mutationObserver = null;
      }

      this._statusCache.clear();
      this._serviceElements.clear();
      this._initActionCache.clear();
      this._updateQueue = [];
      this._isUpdating = false;
    }
  }

  // =====================================================
  // Temperature Widget - Мониторинг температуры
  // =====================================================

  class ProtonTemperatureWidget {
    constructor() {
      this._mounted = false;
      this._pollInterval = null;
      this._pollIntervalMs = 5000; // Обновление каждые 5 секунд
      this._sensors = [];
      this._sensorElements = new Map();
      this._onVisibilityChange = null;
      this._rpcMethods = null;
      this._mutationObserver = null; // Для очистки при остановке
      this._waitTimeout = null; // Для очистки таймаута
      this._isFirstLoad = true; // Флаг первой загрузки
      this._emptyAttempts = 0; // Счетчик попыток без датчиков
      this._maxEmptyAttempts = 3; // Максимум попыток перед показом "Не найдены"

      // Debug mode: window.protonTempDebug = true
      this._debug = window.protonTempDebug === true;

      // Пороговые значения температуры (°C)
      this._thresholds = {
        warm: 50, // >= 50°C - тёплый
        hot: 70, // >= 70°C - горячий
        critical: 85, // >= 85°C - критический
      };
    }

    _log(...args) {
      if (this._debug) {
        console.log("[ProtonTemp]", ...args);
      }
    }

    _getRealtimeTemperatureUrl() {
      if (window.L && typeof L.url === "function") {
        return L.url("admin", "status", "realtime", "temperature");
      }

      return "/cgi-bin/luci/admin/status/realtime/temperature";
    }

    // Локализация
    _t(key) {
      if (window.protonT) {
        return window.protonT(key);
      }
      if (window.L && L.tr) {
        const translated = L.tr(key);
        if (translated !== key) return translated;
      }
      return key;
    }

    // Определение типа датчика по имени
    _getSensorType(name) {
      const lowerName = name.toLowerCase();
      if (lowerName.includes("cpu") || lowerName.includes("processor"))
        return "cpu";
      if (lowerName.includes("soc")) return "soc";
      if (
        lowerName.includes("wifi") ||
        lowerName.includes("wireless") ||
        lowerName.includes("wlan")
      )
        return "wifi";
      if (
        lowerName.includes("ddr") ||
        lowerName.includes("ram") ||
        lowerName.includes("memory")
      )
        return "ddr";
      if (lowerName.includes("board") || lowerName.includes("system"))
        return "board";
      return "default";
    }

    // Форматирование имени датчика
    _formatSensorName(name) {
      // Убираем технические префиксы/суффиксы
      let formatted = name
        .replace(/^thermal_zone\d+_/, "")
        .replace(/_temp$/, "")
        .replace(/_input$/, "")
        .replace(/[-_]/g, " ")
        .trim();

      // Капитализация первой буквы каждого слова
      formatted = formatted.replace(/\b\w/g, (c) => c.toUpperCase());

      // Локализация известных имён
      const translations = {
        Cpu: this._t("CPU"),
        Soc: this._t("SoC"),
        Wifi: this._t("WiFi"),
        Ddr: this._t("DDR"),
        Board: this._t("Board"),
      };

      for (const [key, value] of Object.entries(translations)) {
        formatted = formatted.replace(new RegExp(`\\b${key}\\b`, "gi"), value);
      }

      return formatted || this._t("Sensor");
    }

    // Определение уровня температуры
    _getTempLevel(temp) {
      if (temp >= this._thresholds.critical) return "critical";
      if (temp >= this._thresholds.hot) return "hot";
      if (temp >= this._thresholds.warm) return "warm";
      return "normal";
    }

    // Получение текста статуса
    _getTempStatusText(level) {
      const statusTexts = {
        normal: this._t("Normal"),
        warm: this._t("Warm"),
        hot: this._t("Hot"),
        critical: this._t("Critical"),
      };
      return statusTexts[level] || statusTexts.normal;
    }

    // Расчёт процента для прогресс-бара (динамический диапазон до 100°C)
    _getTempPercent(temp) {
      // Используем диапазон 0-100°C, но ограничиваем максимум 100%
      // Для температур выше 100°C показываем 100%
      const maxTemp = 100;
      return Math.min(Math.max((temp / maxTemp) * 100, 0), 100);
    }

    // Проверка, что мы на странице Overview
    isOverviewPage() {
      if (
        typeof L !== "undefined" &&
        L.env &&
        Array.isArray(L.env.dispatchpath)
      ) {
        const dp = L.env.dispatchpath;
        if (dp[0] === "admin" && dp[1] === "status" && dp[2] === "overview") {
          return true;
        }
      }
      return (
        document.body.dataset.page === "admin-status-overview" ||
        window.location.pathname.includes("/admin/status/overview")
      );
    }

    // Инициализация виджета
    init() {
      // Проверяем настройку отключения виджета
      try {
        if (localStorage.getItem("proton-temp-widget-enabled") === "false") {
          return;
        }
      } catch (e) {
        // localStorage may be unavailable in some contexts
      }

      if (!this.isOverviewPage()) return;

      // Ждём появления виджета сервисов, чтобы вставить температуру после него
      this._waitForServicesWidget();
    }

    _waitForServicesWidget() {
      const tryInject = () => {
        // Ищем общий контейнер виджетов или виджет сервисов
        const widgetsContainer = document.getElementById(
          "proton-widgets-container",
        );
        const servicesWidget = document.getElementById(
          "proton-services-widget",
        );

        if (widgetsContainer) {
          // Если контейнер есть, вставляем в него
          this._injectWidget(widgetsContainer);
          return true;
        } else if (servicesWidget) {
          // Если виджет сервисов есть, но контейнера нет - используем его родителя
          this._injectWidget(servicesWidget);
          return true;
        }
        return false;
      };

      if (tryInject()) return;

      // Наблюдаем за появлением виджета сервисов
      this._mutationObserver = new MutationObserver(() => {
        if (tryInject()) {
          this._mutationObserver.disconnect();
          this._mutationObserver = null;
        }
      });

      const maincontent = document.getElementById("maincontent");
      if (maincontent) {
        this._mutationObserver.observe(maincontent, {
          childList: true,
          subtree: true,
        });
      }

      // Таймаут на случай, если виджет сервисов отключен
      this._waitTimeout = setTimeout(() => {
        if (this._mutationObserver) {
          this._mutationObserver.disconnect();
          this._mutationObserver = null;
        }
        // Если виджет сервисов не появился, создаем контейнер и вставляем температуру
        if (!document.getElementById("proton-temp-widget")) {
          const maincontent = document.getElementById("maincontent");
          if (maincontent) {
            let widgetsContainer = document.getElementById(
              "proton-widgets-container",
            );
            if (!widgetsContainer) {
              const insertPoint =
                maincontent.querySelector("h2") ||
                maincontent.querySelector("h3") ||
                maincontent.querySelector(".cbi-map") ||
                maincontent.firstElementChild;
              if (insertPoint) {
                // Создаём секцию с заголовком "Виджеты"
                const widgetsSection = document.createElement("div");
                widgetsSection.className = "proton-widgets-section";

                const sectionHeader = document.createElement("div");
                sectionHeader.className = "proton-widgets-section-header";

                const sectionTitle = document.createElement("h2");
                sectionTitle.className = "proton-widgets-section-title";
                sectionTitle.textContent = this._t("Widgets");
                sectionHeader.appendChild(sectionTitle);

                widgetsSection.appendChild(sectionHeader);

                widgetsContainer = document.createElement("div");
                widgetsContainer.className = "proton-widgets-container";
                widgetsContainer.id = "proton-widgets-container";
                widgetsSection.appendChild(widgetsContainer);

                insertPoint.parentNode.insertBefore(
                  widgetsSection,
                  insertPoint,
                );
              }
            }
            if (widgetsContainer) {
              this._injectWidget(widgetsContainer);
            }
          }
        }
        this._waitTimeout = null;
      }, 2000);
    }

    _injectWidget(referenceElement, insertBefore = false) {
      if (!referenceElement) {
        this._log("Cannot inject widget: invalid reference element");
        return;
      }

      if (document.getElementById("proton-temp-widget")) {
        this._mounted = true;
        return;
      }

      const widget = document.createElement("div");
      widget.className = "proton-temp-widget";
      widget.id = "proton-temp-widget";
      widget.setAttribute("role", "link");
      widget.setAttribute("tabindex", "0");

      const realtimeUrl = this._getRealtimeTemperatureUrl();

      widget.innerHTML = `
        <div class="proton-temp-header">
          <h3 class="proton-temp-title">
            <a class="proton-temp-title-link" href="${realtimeUrl}">
              ${this._t("Temperature")}
            </a>
          </h3>
          <div class="proton-temp-info">?
            <div class="proton-temp-tooltip">
              <div class="proton-temp-tooltip-title">${this._t(
                "Temperature Monitor",
              )}</div>
              <div class="proton-temp-tooltip-text">
                ${this._t(
                  "Thermal sensors monitoring. Colors indicate: green - normal, yellow - warm, orange - hot, red - critical.",
                )}
              </div>
              <div class="proton-temp-tooltip-legend">
                <div class="proton-temp-tooltip-legend-item">
                  <span class="proton-temp-tooltip-legend-dot normal"></span>
                  <span>${this._t("Normal")} (&lt; ${
                    this._thresholds.warm
                  }°C)</span>
                </div>
                <div class="proton-temp-tooltip-legend-item">
                  <span class="proton-temp-tooltip-legend-dot warm"></span>
                  <span>${this._t("Warm")} (${this._thresholds.warm}-${
                    this._thresholds.hot - 1
                  }°C)</span>
                </div>
                <div class="proton-temp-tooltip-legend-item">
                  <span class="proton-temp-tooltip-legend-dot hot"></span>
                  <span>${this._t("Hot")} (${this._thresholds.hot}-${
                    this._thresholds.critical - 1
                  }°C)</span>
                </div>
                <div class="proton-temp-tooltip-legend-item">
                  <span class="proton-temp-tooltip-legend-dot critical"></span>
                  <span>${this._t("Critical")} (≥ ${
                    this._thresholds.critical
                  }°C)</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="proton-temp-grid" id="proton-temp-grid">
          <div class="proton-temp-empty">
            ${this._t("Checking...")}
          </div>
        </div>
      `;

      const shouldIgnoreNavigation = (target) => {
        return !!(
          target &&
          target.closest(
            ".proton-temp-info, .proton-temp-tooltip, .proton-temp-title-link, a, button",
          )
        );
      };

      widget.addEventListener("click", (event) => {
        if (shouldIgnoreNavigation(event.target)) return;
        window.location.href = realtimeUrl;
      });

      widget.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (shouldIgnoreNavigation(event.target)) return;
        event.preventDefault();
        window.location.href = realtimeUrl;
      });

      // Если referenceElement - это контейнер виджетов, добавляем в него
      if (referenceElement.id === "proton-widgets-container") {
        referenceElement.appendChild(widget);
      } else if (referenceElement.parentNode) {
        // Иначе вставляем после элемента
        if (insertBefore) {
          referenceElement.parentNode.insertBefore(widget, referenceElement);
        } else {
          referenceElement.parentNode.insertBefore(
            widget,
            referenceElement.nextSibling,
          );
        }
      }

      this._mounted = true;
      this._startMonitoring();
    }

    // Запуск мониторинга температуры
    _startMonitoring() {
      // При первой загрузке даем небольшую задержку для инициализации RPC
      if (this._isFirstLoad) {
        setTimeout(() => {
          if (this._mounted) {
            this._updateTemperatures();
          }
        }, 300); // 300ms задержка для первой загрузки
      } else {
        // Первоначальное обновление
        this._updateTemperatures();
      }

      // Периодическое обновление
      this._pollInterval = setInterval(() => {
        if (document.hidden) return;
        this._updateTemperatures();
      }, this._pollIntervalMs);

      // Обработка видимости вкладки
      this._onVisibilityChange = () => {
        if (!document.hidden && this._mounted) {
          this._updateTemperatures();
        }
      };
      document.addEventListener("visibilitychange", this._onVisibilityChange);
    }

    // Получение данных о температуре
    async _updateTemperatures() {
      if (!this._mounted) return;

      try {
        const sensors = await this._fetchSensorData();
        this._log("Fetched sensors:", sensors);

        if (!sensors || sensors.length === 0) {
          this._log("No sensors found, attempt:", this._emptyAttempts + 1);
          this._emptyAttempts++;

          // Если это первая загрузка или еще не достигли максимума попыток - показываем загрузку
          if (
            this._isFirstLoad ||
            this._emptyAttempts < this._maxEmptyAttempts
          ) {
            this._renderLoading();
            // Очищаем старые датчики только если это не первая попытка
            if (!this._isFirstLoad) {
              this._sensors = [];
            }
            return;
          }

          // После нескольких попыток показываем "Не найдены"
          this._log("No sensors found after", this._emptyAttempts, "attempts");
          this._renderEmpty();
          this._sensors = [];
          this._isFirstLoad = false;
          return;
        }

        // Датчики найдены - сбрасываем счетчики
        this._emptyAttempts = 0;
        this._isFirstLoad = false;

        // Обновляем список датчиков
        this._sensors = sensors;
        this._renderSensors();
      } catch (e) {
        console.debug("[ProtonTemperatureWidget] Error fetching temps:", e);
        this._emptyAttempts++;

        // При ошибке на первой загрузке показываем загрузку
        if (this._isFirstLoad || this._emptyAttempts < this._maxEmptyAttempts) {
          this._renderLoading();
          return;
        }

        // После нескольких ошибок показываем пустое состояние, но не очищаем существующие датчики
        // чтобы не было мерцания при временных ошибках сети
        if (this._sensors.length === 0) {
          this._renderEmpty();
        }
      }
    }

    // Кэшируем RPC-декларации для повторного использования
    _getRpcMethods() {
      if (!this._rpcMethods && window.L && L.rpc) {
        this._log("Initializing RPC methods");
        this._rpcMethods = {
          // Наш собственный RPC модуль (требует установки темы)
          getSensors: L.rpc.declare({
            object: "luci.proton-temp",
            method: "getSensors",
            expect: { sensors: [] },
          }),
          getThresholds: L.rpc.declare({
            object: "luci.proton-temp",
            method: "getThresholds",
            expect: { thresholds: {} },
          }),
          // Fallback: стандартный file.list для проверки директорий
          list: L.rpc.declare({
            object: "file",
            method: "list",
            params: ["path"],
          }),
        };
      }
      return this._rpcMethods;
    }

    // Нормализация ответа RPC list - может быть массив или объект с entries
    _normalizeEntries(result) {
      if (Array.isArray(result)) {
        return result;
      }
      if (result && Array.isArray(result.entries)) {
        return result.entries;
      }
      return [];
    }

    // Нормализация ответа RPC read - может быть строка или объект с data
    _normalizeData(result) {
      if (typeof result === "string") {
        return result;
      }
      if (result && typeof result.data === "string") {
        return result.data;
      }
      return "";
    }

    // Получение данных с датчиков через наш ucode RPC модуль
    async _fetchSensorData() {
      const sensors = [];
      this._log("Starting sensor scan...");
      const rpc = this._getRpcMethods();

      if (!rpc) {
        console.debug("[ProtonTemperatureWidget] RPC not available");
        return sensors;
      }

      try {
        try {
          const thresholdResult = await L.resolveDefault(
            rpc.getThresholds(),
            null,
          );
          const thresholds = thresholdResult && thresholdResult.thresholds;
          if (
            thresholds &&
            Number.isFinite(Number(thresholds.warm)) &&
            Number.isFinite(Number(thresholds.hot)) &&
            Number.isFinite(Number(thresholds.critical))
          ) {
            this._thresholds = {
              warm: Number(thresholds.warm),
              hot: Number(thresholds.hot),
              critical: Number(thresholds.critical),
            };
          }
        } catch (e) {
          this._log("Could not read temperature thresholds:", e);
        }

        // Используем наш RPC модуль luci.proton-temp
        // expect: { sensors: [] } автоматически извлекает поле sensors
        const result = await L.resolveDefault(rpc.getSensors(), []);
        this._log("RPC getSensors result:", result);

        // result уже является массивом sensors благодаря expect
        if (result && Array.isArray(result)) {
          for (const sensor of result) {
            if (sensor.temp !== undefined && !isNaN(sensor.temp)) {
              const tempC = Math.round(sensor.temp / 1000); // милли°C -> °C
              const peakC =
                sensor.peak !== undefined
                  ? Math.round(sensor.peak / 1000)
                  : tempC;
              sensors.push({
                name: sensor.name || "Sensor",
                temp: tempC,
                peak: peakC,
                path: sensor.path || "",
              });
            }
          }
        }

        // Если наш RPC не вернул данные, пробуем альтернативный метод
        if (sensors.length === 0) {
          this._log("No sensors from proton-temp RPC, trying alternative...");

          // Проверяем есть ли thermal zones через file.list
          const thermalResult = await L.resolveDefault(
            rpc.list("/sys/class/thermal"),
            [],
          );
          const thermalEntries = this._normalizeEntries(thermalResult);
          this._log("thermal entries (alt):", thermalEntries);

          // Если thermal zones есть но данных нет - значит RPC модуль не установлен
          if (
            thermalEntries.some(
              (e) => e.name && e.name.startsWith("thermal_zone"),
            )
          ) {
            this._log(
              "Thermal zones exist but RPC module not available. Please reinstall theme.",
            );
          }
        }
      } catch (e) {
        console.debug("[ProtonTemperatureWidget] RPC error:", e);
      }

      this._log("Final sensors:", sensors);
      return sensors;
    }

    // Рендеринг датчиков
    _renderSensors() {
      const grid = document.getElementById("proton-temp-grid");
      if (!grid) return;

      // Проверяем, нужно ли пересоздать карточки
      const needsRecreate =
        grid.querySelector(".proton-temp-empty") ||
        grid.children.length !== this._sensors.length ||
        // Проверяем, изменились ли пути датчиков (новые датчики или удаленные)
        Array.from(grid.children).some((child, index) => {
          const sensor = this._sensors[index];
          if (!sensor) return true;
          const cardSensor = child.dataset.sensor;
          return cardSensor !== (sensor.path || sensor.name);
        });

      if (needsRecreate) {
        grid.innerHTML = "";
        this._sensorElements.clear();

        for (const sensor of this._sensors) {
          const card = this._createSensorCard(sensor);
          grid.appendChild(card);
        }
      } else {
        // Обновляем существующие карточки
        for (const sensor of this._sensors) {
          this._updateSensorCard(sensor);
        }
      }
    }

    // Создание карточки датчика
    _createSensorCard(sensor) {
      const card = document.createElement("div");
      card.className = "proton-temp-card";
      card.dataset.sensor = sensor.path || sensor.name;

      const level = this._getTempLevel(sensor.temp);
      card.dataset.level = level;

      // Используем peak из ответа сервера (хранится на роутере)
      const peak = sensor.peak || sensor.temp;

      const formattedName = this._formatSensorName(sensor.name);
      const statusText = this._getTempStatusText(level);
      const percent = this._getTempPercent(sensor.temp);

      card.innerHTML = `
        <div class="proton-temp-value-container">
          <div class="proton-temp-value-wrapper">
            <span class="proton-temp-value">${sensor.temp}</span>
            <span class="proton-temp-unit">°C</span>
          </div>
          <h4 class="proton-temp-sensor-name" title="${
            sensor.name
          }">${formattedName}</h4>
        </div>
        <div class="proton-temp-bar-container">
          <div class="proton-temp-bar" style="width: ${percent}%"></div>
        </div>
        <div class="proton-temp-status">
          <span class="proton-temp-status-dot"></span>
          <span class="proton-temp-status-text">${statusText}</span>
          <span class="proton-temp-peak">${this._t("Peak")}: ${peak}°C</span>
        </div>
      `;

      // Кэшируем элементы для быстрого обновления
      this._sensorElements.set(sensor.path || sensor.name, {
        card: card,
        value: card.querySelector(".proton-temp-value"),
        bar: card.querySelector(".proton-temp-bar"),
        statusText: card.querySelector(".proton-temp-status-text"),
        peak: card.querySelector(".proton-temp-peak"),
      });

      return card;
    }

    // Обновление карточки датчика
    _updateSensorCard(sensor) {
      const elements = this._sensorElements.get(sensor.path || sensor.name);
      if (!elements) return;

      const level = this._getTempLevel(sensor.temp);
      const statusText = this._getTempStatusText(level);
      const percent = this._getTempPercent(sensor.temp);

      // Используем peak из ответа сервера
      const peak = sensor.peak || sensor.temp;

      elements.card.dataset.level = level;
      elements.value.textContent = sensor.temp;
      elements.bar.style.width = `${percent}%`;
      elements.statusText.textContent = statusText;
      elements.peak.textContent = `${this._t("Peak")}: ${peak}°C`;
    }

    // Рендеринг состояния загрузки
    _renderLoading() {
      const grid = document.getElementById("proton-temp-grid");
      if (!grid) return;

      // Не перерисовываем, если уже показываем загрузку
      if (grid.querySelector(".proton-temp-loading")) return;

      grid.innerHTML = `
        <div class="proton-temp-loading">
          ${this._t("Checking...")}
        </div>
      `;
    }

    // Рендеринг пустого состояния (датчики не найдены)
    _renderEmpty() {
      const grid = document.getElementById("proton-temp-grid");
      if (!grid) return;

      grid.innerHTML = `
        <div class="proton-temp-empty">
          ${this._t("No temperature sensors found")}
        </div>
      `;
    }

    // Остановка виджета
    stop() {
      this._mounted = false;

      if (this._pollInterval) {
        clearInterval(this._pollInterval);
        this._pollInterval = null;
      }

      if (this._onVisibilityChange) {
        document.removeEventListener(
          "visibilitychange",
          this._onVisibilityChange,
        );
        this._onVisibilityChange = null;
      }

      // Очищаем MutationObserver
      if (this._mutationObserver) {
        this._mutationObserver.disconnect();
        this._mutationObserver = null;
      }

      // Очищаем таймаут
      if (this._waitTimeout) {
        clearTimeout(this._waitTimeout);
        this._waitTimeout = null;
      }

      this._sensorElements.clear();
      // Очищаем пиковые температуры при остановке (опционально - можно оставить для истории)
      // this._peakTemps.clear();
    }
  }

  function initWidget() {
    // Avoid duplicate instances and timers
    if (window.protonServicesWidget && window.protonServicesWidget._mounted) {
      return;
    }
    if (
      window.protonServicesWidget &&
      typeof window.protonServicesWidget.stop === "function"
    ) {
      window.protonServicesWidget.stop();
    }
    window.protonServicesWidget = new ProtonServicesWidget();
    window.protonServicesWidget.init();
  }

  // Инициализация виджета температуры
  function initTemperatureWidget() {
    // Avoid duplicate instances
    if (
      window.protonTemperatureWidget &&
      window.protonTemperatureWidget._mounted
    ) {
      return;
    }
    if (
      window.protonTemperatureWidget &&
      typeof window.protonTemperatureWidget.stop === "function"
    ) {
      window.protonTemperatureWidget.stop();
    }
    window.protonTemperatureWidget = new ProtonTemperatureWidget();
    window.protonTemperatureWidget.init();
  }

  // Initialize only the legacy dashboard widgets.
  function initAllWidgets() {
    initWidget();
    initTemperatureWidget();
    setTimeout(updateWidgetsSectionVisibility, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAllWidgets);
  } else {
    if (document.getElementById("maincontent")) {
      initAllWidgets();
    } else {
      setTimeout(initAllWidgets, 100);
    }
  }
  
    // =====================================================
  // Public API for other dashboard widgets (dashboard-apps.js)
  // =====================================================
  window.ProtonServicesApi = {
    isValidServiceName(name) {
      const widget = window.protonServicesWidget;
      if (widget && typeof widget._isValidServiceName === "function") {
        return widget._isValidServiceName(name);
      }
      return typeof name === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(name);
    },

    async checkStatus(name) {
      const widget = window.protonServicesWidget;
      if (widget && typeof widget.checkServiceStatus === "function") {
        return widget.checkServiceStatus(name);
      }
      return "unknown";
    },

    getServiceInfo(name) {
      const widget = window.protonServicesWidget;
      if (widget && typeof widget.getServiceInfo === "function") {
        return widget.getServiceInfo(name);
      }
      return {
        name: name,
        displayName: name,
        description: "",
        category: "other",
        icon: "📦",
      };
    },

    getSelectedServices() {
      try {
        const raw = localStorage.getItem("proton-services-widget");
        if (raw === null || raw === undefined) return ["dnsmasq", "dropbear"];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : ["dnsmasq", "dropbear"];
      } catch (e) {
        return ["dnsmasq", "dropbear"];
      }
    },

    setSelectedServices(list) {
      try {
        localStorage.setItem("proton-services-widget", JSON.stringify(list));
        return true;
      } catch (e) {
        return false;
      }
    },

    async listAvailableServices() {
      const widget = window.protonServicesWidget;
      if (!widget) return [];
      if (!Array.isArray(widget.availableServices) || !widget.availableServices.length) {
        try {
          await widget.refreshAvailableServices();
        } catch (e) {}
      }
      return Array.isArray(widget.availableServices) ? widget.availableServices : [];
    },

    onChange(callback) {
      window.addEventListener("proton-services-widget-changed", callback);
      window.addEventListener("storage", (e) => {
        if (e.key === "proton-services-widget") callback();
      });
    },
  };
})();
