/**
 * Proton2025 - Services History Graphs
 * Copyright 2025-2026 ChesterGoodiny
 * Licensed under the Apache License, Version 2.0
 * See LICENSE and NOTICE for details.
 *
 * Рендер SVG-графиков для карточки Приложения:
 *   - renderServiceGraph — полоса uptime сервиса (area chart по статусам)
 *   - renderHealthGraph — стек с зонами (running / user-stopped / crashed)
 *
 * Использует L.resolveDefault-стиль работы с RPC, идентичный services-history.js.
 * Не зависит от глобального ProtonServicesHistory — точки передаются снаружи.
 */

"use strict";

(function () {
  // --- Константы ---

  // Разрыв: если между точками gap > это значение — рисуем разрыв.
  // 3 × sampleInterval (10 сек) = 30 сек.
  const GAP_THRESHOLD_SEC = 30;

  // Цвета для статусов (полоса uptime сервиса)
  const STATUS_COLORS = {
    running: "#34d399",       // зелёный
    stoppedCrashed: "#ef4444", // красный
    stoppedClean: "#6b7280",  // серый (clean-exit)
    stoppedUser: "#6b7280",   // серый (user-stopped)
    healthFailed: "#f97316",  // оранжевый
    unknown: "#fbbf24",       // жёлтый
  };

  // Высоты графиков
  const SERVICE_GRAPH_HEIGHT = 70;
  const HEALTH_GRAPH_HEIGHT = 120;

  // Поля графика (padding)
  const PADDING_TOP = 4;
  const PADDING_BOTTOM = 4;
  const PADDING_LEFT = 0;
  const PADDING_RIGHT = 0;

  // --- Утилиты ---

  /**
   * Определяет CSS-класс и цвет для точки по status/hint.
   * status: 0=stopped, 1=running, 2=unknown, 3=health-failed
   * hint: 0=unknown, 1=restart, 2=clean-exit, 3=crashed, 4=user-stopped
   */
  function getStatusColor(status, hint) {
    if (status === 1) {
      if (hint === 1) return STATUS_COLORS.running; // restart-detected, всё равно зелёный
      return STATUS_COLORS.running;
    }
    if (status === 3) return STATUS_COLORS.healthFailed;
    if (status === 2) return STATUS_COLORS.unknown;
    if (status === 0) {
      if (hint === 4) return STATUS_COLORS.stoppedUser;
      if (hint === 2) return STATUS_COLORS.stoppedClean;
      return STATUS_COLORS.stoppedCrashed;
    }
    return STATUS_COLORS.unknown;
  }

  /**
   * Определяет CSS-класс для точки.
   */
  function getStatusClass(status, hint) {
    if (status === 1) return "proton-graph-status-running";
    if (status === 3) return "proton-graph-status-health-failed";
    if (status === 2) return "proton-graph-status-unknown";
    if (status === 0) {
      if (hint === 4) return "proton-graph-status-stopped-user";
      if (hint === 2) return "proton-graph-status-stopped-clean";
      return "proton-graph-status-stopped-crashed";
    }
    return "proton-graph-status-unknown";
  }

  /**
   * Проверяет, является ли точка "running".
   */
  function isRunning(point) {
    return Array.isArray(point) && Number(point[1]) === 1;
  }

  /**
   * Экранирование HTML (для текста в SVG).
   */
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // --- Расчёт геометрии ---

  /**
   * Разбивает точки на непрерывные сегменты.
   * Сегмент — это последовательность точек без разрывов > GAP_THRESHOLD_SEC.
   *
   * @param {Array} points
   * @returns {Array} — массив сегментов, каждый = массив точек
   */
  function splitIntoSegments(points) {
    if (!Array.isArray(points) || points.length === 0) return [];
    if (points.length === 1) return [points.slice()];

    const segments = [];
    let currentSegment = [points[0]];

    for (let i = 1; i < points.length; i++) {
      const prevT = Number(points[i - 1][0]);
      const currT = Number(points[i][0]);
      const gap = currT - prevT;

      if (gap > GAP_THRESHOLD_SEC) {
        // Разрыв — закрываем текущий сегмент
        segments.push(currentSegment);
        currentSegment = [points[i]];
      } else {
        currentSegment.push(points[i]);
      }
    }
    segments.push(currentSegment);
    return segments;
  }

  /**
   * Вычисляет диапазон времени в точках.
   * @returns {object} — { startTime, endTime, durationSec }
   */
  function getTimeRange(points) {
    if (!Array.isArray(points) || points.length === 0) {
      return { startTime: 0, endTime: 0, durationSec: 0 };
    }
    const startTime = Number(points[0][0]);
    const endTime = Number(points[points.length - 1][0]);
    return {
      startTime,
      endTime,
      durationSec: Math.max(1, endTime - startTime),
    };
  }

  // --- Рендер графика сервиса (полоса uptime) ---

  /**
   * Рисует полосу uptime сервиса.
   *
   * @param {HTMLElement} container — куда вставлять SVG
   * @param {Array} points — точки [t, status, pid, hint]
   * @param {object} options — { width, height, sampleInterval }
   * @returns {SVGElement|null}
   */
  function renderServiceGraph(container, points, options) {
      if (!container) return null;

      const opts = options || {};
      const width = opts.width || container.clientWidth || 400;
      const height = opts.height || SERVICE_GRAPH_HEIGHT;

      container.innerHTML = "";

      if (!Array.isArray(points) || points.length === 0) {
          const empty = document.createElement("div");
          empty.className = "proton-graph-empty";
          empty.textContent = "No data";
          container.appendChild(empty);
          return null;
      }

      const { startTime, endTime, durationSec } = getTimeRange(points);
      const innerWidth = width - PADDING_LEFT - PADDING_RIGHT;
      const innerHeight = height - PADDING_TOP - PADDING_BOTTOM;

      // === Привязка к правому краю ===
      // Если передан requestedWindowSec, рассчитываем, сколько ширины
      // должны занимать данные. Данные всегда прижаты к правому краю.
      // Левая часть — пустая область (нет данных).
      const requestedWindowSec = Number(opts.windowMs) ? Number(opts.windowMs) / 1000 : 0;
      const actualDurationSec = durationSec; // сколько данных по факту
      let dataWidthRatio = 1;

      if (requestedWindowSec > 0 && actualDurationSec < requestedWindowSec) {
          dataWidthRatio = actualDurationSec / requestedWindowSec;
          if (dataWidthRatio < 0.02) dataWidthRatio = 0.02; // не даём исчезнуть совсем
      }

      const dataWidth = innerWidth * dataWidthRatio;
      const dataLeftX = PADDING_LEFT + (innerWidth - dataWidth);

      // Обновляем функцию timeToX: привязываем к правому краю.
      const timeToX = (t) => {
          if (durationSec === 0) return dataLeftX + dataWidth / 2;
          const ratio = (t - startTime) / durationSec;
          return dataLeftX + ratio * dataWidth;
      };

      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("class", "proton-service-graph-svg");
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("aria-hidden", "true");

      // Фон
      const bg = document.createElementNS(svgNS, "rect");
      bg.setAttribute("x", PADDING_LEFT);
      bg.setAttribute("y", PADDING_TOP);
      bg.setAttribute("width", innerWidth);
      bg.setAttribute("height", innerHeight);
      bg.setAttribute("class", "proton-service-graph-bg");
      svg.appendChild(bg);

      // === Один проход по всем точкам (подход 2) ===
      // Каждый интервал [prev.t, curr.t] рисуем прямоугольником.
      // Если gap > GAP_THRESHOLD_SEC, поверх рисуем вертикальную серую
      // полоску, показывающую разрыв.
      for (let i = 1; i < points.length; i++) {
          const prev = points[i - 1];
          const curr = points[i];

          const prevT = Number(prev[0]);
          const currT = Number(curr[0]);
          const gap = currT - prevT;

          const x1 = timeToX(prevT);
          const x2 = timeToX(currT);
          const rectWidth = Math.max(1, x2 - x1);

          const prevStatus = Number(prev[1]);
          const currStatus = Number(curr[1]);

          const worstStatus = pickWorstStatus(prevStatus, currStatus, prev, curr);
          const color = getStatusColor(worstStatus, 0);
          const cls = getStatusClass(worstStatus, 0);

          // Основной прямоугольник статуса
          const rect = document.createElementNS(svgNS, "rect");
          rect.setAttribute("x", x1);
          rect.setAttribute("y", PADDING_TOP);
          rect.setAttribute("width", rectWidth);
          rect.setAttribute("height", innerHeight);
          rect.setAttribute("class", "proton-service-graph-segment " + cls);
          rect.setAttribute("fill", color);
          rect.setAttribute("opacity", 0.7);
          svg.appendChild(rect);

          // Разрыв — вертикальная метка поверх прямоугольника
          if (gap > GAP_THRESHOLD_SEC) {
              const gapMark = document.createElementNS(svgNS, "line");
              gapMark.setAttribute("x1", x1);
              gapMark.setAttribute("y1", PADDING_TOP);
              gapMark.setAttribute("x2", x1);
              gapMark.setAttribute("y2", PADDING_TOP + innerHeight);
              gapMark.setAttribute("class", "proton-service-graph-gap-mark");
              gapMark.setAttribute("stroke", "rgba(148, 163, 184, 0.5)");
              gapMark.setAttribute("stroke-width", 1);
              gapMark.setAttribute("stroke-dasharray", "2 2");
              svg.appendChild(gapMark);
          }

          // Рестарт-метка (если curr running + hint=1)
          const currHint = curr.length > 3 ? Number(curr[3]) || 0 : 0;
          if (currStatus === 1 && currHint === 1) {
              const restartMark = document.createElementNS(svgNS, "line");
              restartMark.setAttribute("x1", x2);
              restartMark.setAttribute("y1", PADDING_TOP);
              restartMark.setAttribute("x2", x2);
              restartMark.setAttribute("y2", PADDING_TOP + innerHeight);
              restartMark.setAttribute("class", "proton-service-graph-restart-mark");
              restartMark.setAttribute("stroke", "#ffffff");
              restartMark.setAttribute("stroke-width", 1);
              restartMark.setAttribute("opacity", 0.6);
              svg.appendChild(restartMark);
          }
      }

      // Обводка
      const border = document.createElementNS(svgNS, "rect");
      border.setAttribute("x", PADDING_LEFT);
      border.setAttribute("y", PADDING_TOP);
      border.setAttribute("width", innerWidth);
      border.setAttribute("height", innerHeight);
      border.setAttribute("class", "proton-service-graph-border");
      border.setAttribute("fill", "none");
      border.setAttribute("stroke", "rgba(255,255,255,0.06)");
      border.setAttribute("stroke-width", 1);
      svg.appendChild(border);

      container.appendChild(svg);
      return svg;
  }

  /**
   * Выбирает "наихудший" статус между двумя точками.
   * Приоритеты: crashed(0 с hint=0/3) > health-failed(3) > unknown(2) >
   *             running(1) > stopped-user(0 с hint=4) > stopped-clean(0 с hint=2)
   */
  function pickWorstStatus(a, b, aPoint, bPoint) {
    const rank = (status, point) => {
      const hint = point && point.length > 3 ? Number(point[3]) : 0;
      if (status === 0) {
        if (hint === 4) return 1;      // user-stopped — самый мягкий
        if (hint === 2) return 2;      // clean-exit
        return 10;                      // crashed / unknown — самый жёсткий
      }
      if (status === 3) return 9;       // health-failed
      if (status === 2) return 5;       // unknown
      if (status === 1) return 0;       // running
      return 5;
    };

    const ra = rank(a, aPoint);
    const rb = rank(b, bPoint);
    return ra >= rb ? a : b;
  }

  // --- Рендер health-графика (стек с зонами) ---

  /**
   * Рисует health-график — стек с зонами.
   * Пока данных только 2 зоны: running и "остальное".
   * На Этапе 6 расширим до 3 зон: running / user-stopped / crashed.
   *
   * @param {HTMLElement} container — куда вставлять SVG
   * @param {Array} points — health-точки [t, running, total, incidents]
   * @param {object} options — { width, height }
   * @returns {SVGElement|null}
   */
  function renderHealthGraph(container, points, options) {
      if (!container) return null;

      const opts = options || {};
      const width = opts.width || container.clientWidth || 400;
      const height = opts.height || HEALTH_GRAPH_HEIGHT;

      container.innerHTML = "";

      if (!Array.isArray(points) || points.length === 0) {
          const empty = document.createElement("div");
          empty.className = "proton-graph-empty";
          empty.textContent = "No data";
          container.appendChild(empty);
          return null;
      }

      const { startTime, endTime, durationSec } = getTimeRange(points);
      const innerWidth = width - PADDING_LEFT - PADDING_RIGHT;
      const innerHeight = height - PADDING_TOP - PADDING_BOTTOM;

      let maxTotal = 1;
      for (const p of points) {
          const total = Number(p[2]) || 0;
          if (total > maxTotal) maxTotal = total;
      }

      // === Привязка к правому краю (см. renderServiceGraph) ===
      const requestedWindowSec = Number(opts.windowMs) ? Number(opts.windowMs) / 1000 : 0;
      const actualDurationSec = durationSec;
      let dataWidthRatio = 1;

      if (requestedWindowSec > 0 && actualDurationSec < requestedWindowSec) {
          dataWidthRatio = actualDurationSec / requestedWindowSec;
          if (dataWidthRatio < 0.02) dataWidthRatio = 0.02;
      }

      const dataWidth = innerWidth * dataWidthRatio;
      const dataLeftX = PADDING_LEFT + (innerWidth - dataWidth);

      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("class", "proton-health-graph-svg");
      svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("aria-hidden", "true");

      const bg = document.createElementNS(svgNS, "rect");
      bg.setAttribute("x", PADDING_LEFT);
      bg.setAttribute("y", PADDING_TOP);
      bg.setAttribute("width", innerWidth);
      bg.setAttribute("height", innerHeight);
      bg.setAttribute("class", "proton-service-graph-bg");
      svg.appendChild(bg);

      // === Пустая область слева (нет данных) ===
      if (dataWidthRatio < 1) {
          const emptyRect = document.createElementNS(svgNS, "rect");
          emptyRect.setAttribute("x", PADDING_LEFT);
          emptyRect.setAttribute("y", PADDING_TOP);
          emptyRect.setAttribute("width", dataLeftX - PADDING_LEFT);
          emptyRect.setAttribute("height", innerHeight);
          emptyRect.setAttribute("class", "proton-health-graph-empty-area");
          emptyRect.setAttribute("fill", "rgba(148, 163, 184, 0.04)");
          emptyRect.setAttribute("stroke", "rgba(148, 163, 184, 0.08)");
          emptyRect.setAttribute("stroke-dasharray", "3 3");
          svg.appendChild(emptyRect);
      }

      // === Пустая область слева (нет данных) ===
      // Если данных меньше, чем запрошенное окно, рисуем явно "empty" зону.
      if (dataWidthRatio < 1) {
          const emptyRect = document.createElementNS(svgNS, "rect");
          emptyRect.setAttribute("x", PADDING_LEFT);
          emptyRect.setAttribute("y", PADDING_TOP);
          emptyRect.setAttribute("width", dataLeftX - PADDING_LEFT);
          emptyRect.setAttribute("height", innerHeight);
          emptyRect.setAttribute("class", "proton-service-graph-empty-area");
          emptyRect.setAttribute("fill", "rgba(148, 163, 184, 0.04)");
          emptyRect.setAttribute("stroke", "rgba(148, 163, 184, 0.08)");
          emptyRect.setAttribute("stroke-dasharray", "3 3");
          svg.appendChild(emptyRect);
      }

      bg.setAttribute("class", "proton-health-graph-bg");
      svg.appendChild(bg);

      const timeToX = (t) => {
          if (durationSec === 0) return dataLeftX + dataWidth / 2;
          const ratio = (t - startTime) / durationSec;
          return dataLeftX + ratio * dataWidth;
      };

      const valueToY = (value) => {
          const ratio = value / maxTotal;
          return PADDING_TOP + innerHeight * (1 - ratio);
      };

      // === Один проход по всем точкам (подход 2) ===
      for (let i = 1; i < points.length; i++) {
          const prev = points[i - 1];
          const curr = points[i];

          const prevT = Number(prev[0]);
          const currT = Number(curr[0]);
          const gap = currT - prevT;

          const x1 = timeToX(prevT);
          const x2 = timeToX(currT);
          const rectWidth = Math.max(1, x2 - x1);

          const prevRunning = Number(prev[1]) || 0;
          const currRunning = Number(curr[1]) || 0;
          const worstRunning = Math.min(prevRunning, currRunning);

          const prevTotal = Number(prev[2]) || maxTotal;
          const currTotal = Number(curr[2]) || maxTotal;
          const worstTotal = Math.max(prevTotal, currTotal);

          // Зелёная зона — running
          const greenTopY = valueToY(worstRunning);
          const greenHeight = PADDING_TOP + innerHeight - greenTopY;

          if (greenHeight > 0) {
              const greenRect = document.createElementNS(svgNS, "rect");
              greenRect.setAttribute("x", x1);
              greenRect.setAttribute("y", greenTopY);
              greenRect.setAttribute("width", rectWidth);
              greenRect.setAttribute("height", greenHeight);
              greenRect.setAttribute("class", "proton-health-graph-running");
              greenRect.setAttribute("fill", STATUS_COLORS.running);
              greenRect.setAttribute("opacity", 0.7);
              svg.appendChild(greenRect);
          }

          // Серая зона — остальное
          const grayTopY = valueToY(worstTotal);
          const grayHeight = greenTopY - grayTopY;

          if (grayHeight > 0) {
              const grayRect = document.createElementNS(svgNS, "rect");
              grayRect.setAttribute("x", x1);
              grayRect.setAttribute("y", grayTopY);
              grayRect.setAttribute("width", rectWidth);
              grayRect.setAttribute("height", grayHeight);
              grayRect.setAttribute("class", "proton-health-graph-remaining");
              grayRect.setAttribute("fill", STATUS_COLORS.stoppedClean);
              grayRect.setAttribute("opacity", 0.5);
              svg.appendChild(grayRect);
          }

          // Разрыв — вертикальная метка
          if (gap > GAP_THRESHOLD_SEC) {
              const gapMark = document.createElementNS(svgNS, "line");
              gapMark.setAttribute("x1", x1);
              gapMark.setAttribute("y1", PADDING_TOP);
              gapMark.setAttribute("x2", x1);
              gapMark.setAttribute("y2", PADDING_TOP + innerHeight);
              gapMark.setAttribute("class", "proton-health-graph-gap-mark");
              gapMark.setAttribute("stroke", "rgba(148, 163, 184, 0.5)");
              gapMark.setAttribute("stroke-width", 1);
              gapMark.setAttribute("stroke-dasharray", "2 2");
              svg.appendChild(gapMark);
          }
      }

      const border = document.createElementNS(svgNS, "rect");
      border.setAttribute("x", PADDING_LEFT);
      border.setAttribute("y", PADDING_TOP);
      border.setAttribute("width", innerWidth);
      border.setAttribute("height", innerHeight);
      border.setAttribute("class", "proton-health-graph-border");
      border.setAttribute("fill", "none");
      border.setAttribute("stroke", "rgba(255,255,255,0.06)");
      border.setAttribute("stroke-width", 1);
      svg.appendChild(border);

      container.appendChild(svg);
      return svg;
  }

  // --- Экспорт ---

  window.ProtonServicesGraph = {
    renderServiceGraph,
    renderHealthGraph,
    // Утилиты (для тестов и повторного использования)
    splitIntoSegments,
    getStatusColor,
    getStatusClass,
    // Константы (для тестов)
    GAP_THRESHOLD_SEC,
    SERVICE_GRAPH_HEIGHT,
    HEALTH_GRAPH_HEIGHT,
  };
})();
