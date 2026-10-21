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
  
  // === Crossfade helpers ===
  function captureFade(container) {
    if (!container) return null;
    var reduce = window.matchMedia
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var old = container.firstElementChild;
    container.replaceChildren();
    if (reduce || !old) return null;
    var clone = old.cloneNode(true);
    clone.style.position = "absolute";
    clone.style.inset = "0";
    clone.style.pointerEvents = "none";
    clone.style.opacity = "1";
    clone.style.transition = "opacity 300ms ease";
    return clone;
  }

  function playFade(container, clone) {
    if (!container || !clone) return;
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    container.appendChild(clone);
    requestAnimationFrame(function () {
      clone.style.opacity = "0";
    });
    setTimeout(function () {
      if (clone.parentNode) clone.parentNode.removeChild(clone);
    }, 320);
  }

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

      var fadeClone = captureFade(container);

      if (!Array.isArray(points) || points.length === 0) {
          var fadeCloneEmpty = captureFade(container);
          const empty = document.createElement("div");
          empty.className = "proton-graph-empty";
          empty.textContent = "No data";
          container.appendChild(empty);
          playFade(container, fadeCloneEmpty);
          return null;
      }

      const requestedWindowSec = Number(opts.windowMs) ? Number(opts.windowMs) / 1000 : 0;

      // Если запрошено окно (windowMs), "дотягиваем" последнюю точку до текущего момента,
      // чтобы график не заканчивался раньше времени.
      if (requestedWindowSec > 0) {
          const nowSec = Math.floor(Date.now() / 1000);
          const lastT = Number(points[points.length - 1][0]);
          if (nowSec - lastT > 1 && nowSec - lastT < requestedWindowSec) {
              const lastStatus = Number(points[points.length - 1][1]);
              const lastPid = points[points.length - 1][2] || 0;
              const lastHint = points[points.length - 1][3] || 0;
              points = points.slice();
              points.push([nowSec, lastStatus, lastPid, lastHint]);
          }
          
          // Компенсируем погрешность тика демона (до 15 секунд).
          // Если первая точка отстает от края окна не больше чем на 15 секунд,
          // значит, история есть, но тик демона произошел чуть позже.
          // Если больше — значит, истории реально нет, и мы оставляем пустоту.
          const axisStartSec = nowSec - requestedWindowSec;
          const firstT = Number(points[0][0]);
          const gapLeft = firstT - axisStartSec;
          
          if (gapLeft > 1 && gapLeft <= 15) {
              const firstStatus = Number(points[0][1]);
              const firstPid = points[0][2] || 0;
              const firstHint = points[0][3] || 0;
              points = points.slice();
              points.unshift([axisStartSec, firstStatus, firstPid, firstHint]);
          }
      }

      const { startTime, endTime, durationSec } = getTimeRange(points);
      const innerWidth = width - PADDING_LEFT - PADDING_RIGHT;
      const innerHeight = height - PADDING_TOP - PADDING_BOTTOM;

      // Привязываем ось X к окну (right = now, left = now - windowSec),
      // а не к min/max точек. Иначе при добавлении новых точек график
      // масштабируется по X и «растягивается/сжимается».
      let axisStartTime = startTime;
      let axisDurationSec = durationSec;

      if (requestedWindowSec > 0) {
          const nowSec = Math.floor(Date.now() / 1000);
          axisStartTime = nowSec - requestedWindowSec;
          axisDurationSec = requestedWindowSec;
      }

      const dataWidth = innerWidth;
      const dataLeftX = PADDING_LEFT;

      const timeToX = (t) => {
          if (axisDurationSec === 0) return dataLeftX + dataWidth / 2;
          let ratio = (t - axisStartTime) / axisDurationSec;
          if (ratio < 0) ratio = 0;
          if (ratio > 1) ratio = 1;
          return dataLeftX + ratio * dataWidth;
      };

      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("class", "proton-service-graph-svg");
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

          const rect = document.createElementNS(svgNS, "rect");
          rect.setAttribute("x", x1);
          rect.setAttribute("y", PADDING_TOP);
          rect.setAttribute("width", rectWidth);
          rect.setAttribute("height", innerHeight);
          rect.setAttribute("class", "proton-service-graph-segment " + cls);
          rect.setAttribute("fill", color);
          rect.setAttribute("opacity", 0.7);
          svg.appendChild(rect);

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
      playFade(container, fadeClone);
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

      var fadeClone = captureFade(container);

      if (!Array.isArray(points) || points.length === 0) {
          var fadeCloneEmpty = captureFade(container);
          const empty = document.createElement("div");
          empty.className = "proton-graph-empty";
          empty.textContent = "No data";
          container.appendChild(empty);
          playFade(container, fadeCloneEmpty);
          return null;
      }

      const requestedWindowSec = Number(opts.windowMs) ? Number(opts.windowMs) / 1000 : 0;

      // Если запрошено окно (windowMs), "дотягиваем" последнюю точку до текущего момента,
      // чтобы график не заканчивался раньше времени.
      if (requestedWindowSec > 0) {
          const nowSec = Math.floor(Date.now() / 1000);
          const lastT = Number(points[points.length - 1][0]);
          if (nowSec - lastT > 1 && nowSec - lastT < requestedWindowSec) {
              const lastRunning = Number(points[points.length - 1][1]);
              const lastTotal = Number(points[points.length - 1][2]);
              const lastIncidents = Number(points[points.length - 1][3]);
              points = points.slice();
              points.push([nowSec, lastRunning, lastTotal, lastIncidents]);
          }
      }

      const { startTime, endTime, durationSec } = getTimeRange(points);
      const innerWidth = width - PADDING_LEFT - PADDING_RIGHT;
      const innerHeight = height - PADDING_TOP - PADDING_BOTTOM;

      let maxTotal = 1;
      for (const p of points) {
          const total = Number(p[2]) || 0;
          if (total > maxTotal) maxTotal = total;
      }

      // Привязываем ось X к окну (right = now, left = now - windowSec),
      // а не к min/max точек. См. renderServiceGraph.
      let axisStartTime = startTime;
      let axisDurationSec = durationSec;

      if (requestedWindowSec > 0) {
          const nowSec = Math.floor(Date.now() / 1000);
          axisStartTime = nowSec - requestedWindowSec;
          axisDurationSec = requestedWindowSec;
      }

      const dataWidth = innerWidth;
      const dataLeftX = PADDING_LEFT;

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
      playFade(container, fadeClone);
      return svg;
  }
  
    function renderWorstStatusGraph(container, points, options) {
    if (!container) return null;

    const opts = options || {};
    const width = opts.width || container.clientWidth || 400;
    const height = opts.height || HEALTH_GRAPH_HEIGHT;

    var fadeClone = captureFade(container);

    if (!Array.isArray(points) || points.length === 0) {
          var fadeCloneEmpty = captureFade(container);
          const empty = document.createElement("div");
          empty.className = "proton-graph-empty";
          empty.textContent = "No data";
          container.appendChild(empty);
          playFade(container, fadeCloneEmpty);
          return null;
      }

    const requestedWindowSec = Number(opts.windowMs) ? Number(opts.windowMs) / 1000 : 0;

    // Если запрошено окно (windowMs), "дотягиваем" последнюю точку до текущего момента,
    // чтобы график не заканчивался раньше времени.
    if (requestedWindowSec > 0) {
        const nowSec = Math.floor(Date.now() / 1000);
        const lastT = Number(points[points.length - 1][0]);
        if (nowSec - lastT > 1 && nowSec - lastT < requestedWindowSec) {
            const lastStatus = Number(points[points.length - 1][1]);
            points = points.slice();
            points.push([nowSec, lastStatus]);
        }
        
        // Компенсируем погрешность тика демона (до 15 секунд) для левого края.
        const axisStartSec = nowSec - requestedWindowSec;
        const firstT = Number(points[0][0]);
        const gapLeft = firstT - axisStartSec;
        if (gapLeft > 1 && gapLeft <= 15) {
            const firstStatus = Number(points[0][1]);
            points = points.slice();
            points.unshift([axisStartSec, firstStatus]);
        }
    }

    const { startTime, endTime, durationSec } = getTimeRange(points);
    const innerWidth = width - PADDING_LEFT - PADDING_RIGHT;
    const innerHeight = height - PADDING_TOP - PADDING_BOTTOM;

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "proton-worst-graph-svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");

    // Привязка оси X к окну (right = now, left = now - windowSec),
    // а не к min/max точек. См. renderServiceGraph.
    let axisStartTime = startTime;
    let axisDurationSec = durationSec;

    if (requestedWindowSec > 0) {
        const nowSec = Math.floor(Date.now() / 1000);
        axisStartTime = nowSec - requestedWindowSec;
        axisDurationSec = requestedWindowSec;
    }

    const dataWidth = innerWidth;
    const dataLeftX = PADDING_LEFT;

    const timeToX = (t) => {
        if (axisDurationSec === 0) return dataLeftX + dataWidth / 2;
        let ratio = (t - axisStartTime) / axisDurationSec;
        if (ratio < 0) ratio = 0;
        if (ratio > 1) ratio = 1;
        return dataLeftX + ratio * dataWidth;
    };

    // Уровни важности.
    // status 1 (running)        → priority 1 → y = 75% высоты (снизу)
    // status 2 (unknown)        → priority 2 → y = 50%
    // status 0 (crashed)        → priority 3 → y = 25%
    // status 3 (health-failed)  → priority 4 → y = 0% (верх)
    function statusToPriority(status) {
        if (status === 3) return 4;   // health-failed
        if (status === 0) return 3;   // crashed
        if (status === 2) return 2;   // unknown
        if (status === 1) return 1;   // running
        return 1;
    }

    function priorityToY(priority) {
        // priority 1 → bottom, priority 4 → top.
        const ratio = (priority - 1) / 3;   // 0 .. 1
        return PADDING_TOP + innerHeight * (1 - ratio);
    }

    function statusToClass(status) {
        if (status === 3) return "proton-worst-graph-level-health";
        if (status === 0) return "proton-worst-graph-level-crash";
        if (status === 2) return "proton-worst-graph-level-unknown";
        return "proton-worst-graph-level-running";
    }

    function statusToColor(status) {
        if (status === 3) return "#f97316";  // оранжевый
        if (status === 0) return "#ef4444";  // красный
        if (status === 2) return "#fbbf24";  // жёлтый
        return "#34d399";                    // зелёный
    }

        const baselineY = PADDING_TOP + innerHeight;
    const MIN_SEGMENT_HEIGHT = 4;
    const maxHeight = innerHeight - MIN_SEGMENT_HEIGHT;

    // Рисуем ступеньки.
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const t = Number(p[0]);
        const status = Number(p[1]);

        const nextT = i + 1 < points.length
            ? Number(points[i + 1][0])
            : endTime + (durationSec / Math.max(points.length, 1));

        const x1 = timeToX(t);
        const x2 = timeToX(nextT);
        const rectWidth = Math.max(1, x2 - x1);

        const priority = statusToPriority(status);
        const ratio = (priority - 1) / 3;  // 0 для running, 1 для health-failed
        const topY = baselineY - MIN_SEGMENT_HEIGHT - (ratio * maxHeight);
        const rectHeight = baselineY - topY;

        const rect = document.createElementNS(svgNS, "rect");
        rect.setAttribute("x", x1);
        rect.setAttribute("y", topY);
        rect.setAttribute("width", rectWidth);
        rect.setAttribute("height", rectHeight);
        rect.setAttribute("class", "proton-worst-graph-segment " + statusToClass(status));
        rect.setAttribute("fill", statusToColor(status));
        rect.setAttribute("opacity", 0.7);
        svg.appendChild(rect);
    }

      container.appendChild(svg);
      playFade(container, fadeClone);
      return svg;
}

  // --- Timeline событий (Этап 6.7) ----------------------------------------
  //
  // Рисует полосу вертикальных штрихов — по одному на событие.
  // Цвет и высота штриха зависят от типа события:
  //   crash       → красный,   полная высота
  //   health-fail → оранжевый, полная высота
  //   silent-death/unknown → жёлтый, средняя высота
  //   user-stop   → серый,     низкая высота
  //   clean-exit  → серый,     низкая высота
  //   restart     → зелёный,   низкая высота
  //
  // events: массив [ts, service, type, hint, details]
  // options: { width, height, windowMs }

  const EVENT_COLORS = {
    crash: "#ef4444",
    "health-fail": "#f97316",
    "silent-death": "#fbbf24",
    unknown: "#fbbf24",
    restart: "#34d399",
    "health-recovery": "#5eead4",
    "user-stop": "#6b7280",
    "clean-exit": "#9ca3af",
  };

  const EVENT_HEIGHT_RATIO = {
    crash: 1.0,
    "health-fail": 1.0,
    "silent-death": 0.6,
    unknown: 0.6,
    restart: 0.35,
    "health-recovery": 0.35,
    "user-stop": 0.35,
    "clean-exit": 0.35,
  };

  // Типы, которые считаются «реально проблемными» — они включают
  // индикатор плотности в стеке.
  const EVENT_PROBLEM_TYPES = {
    crash: true,
    "health-fail": true,
    "silent-death": true,
    unknown: true,
  };

  // Порядок полос в стеке — сверху вниз по критичности.
  const EVENT_STACK_RANK = {
    crash: 0,
    "health-fail": 1,
    "silent-death": 2,
    unknown: 3,
    restart: 4,
    "health-recovery": 5,
    "user-stop": 6,
    "clean-exit": 7,
  };

  function renderEventTimeline(container, events, options) {
    if (!container) return null;

    const opts = options || {};
    const width = opts.width || container.clientWidth || 400;
    const height = opts.height || 100;
    const selectedGroupKey = opts.selectedGroupKey || null;
    const onEventClick = typeof opts.onEventClick === "function"
      ? opts.onEventClick
      : null;

    container.style.height = height + "px";
    container.style.minHeight = height + "px";
    
    // --- Capture old state for crossfade ---
    var fadeClone = null;
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var oldSvg = container.querySelector(".proton-events-timeline-svg");
    
    if (oldSvg && !reduce) {
      fadeClone = oldSvg.cloneNode(true);
      fadeClone.style.position = "absolute";
      fadeClone.style.inset = "0";
      fadeClone.style.pointerEvents = "none";
      fadeClone.style.opacity = "1";
      fadeClone.style.transition = "opacity 300ms ease";
    }
    
    // Удаляем только старый SVG, оставляя кнопку легенды
    if (oldSvg) oldSvg.remove();
    var oldEmpty = container.querySelector(".proton-events-timeline-empty");
    if (oldEmpty) oldEmpty.remove();

    // Пустой набор событий — показываем placeholder.
    if (!Array.isArray(events) || events.length === 0) {
      const empty = document.createElement("div");
      empty.className = "proton-events-timeline-empty";
      empty.textContent =
        typeof window.protonT === "function"
          ? window.protonT("No incidents")
          : "No incidents";
      container.appendChild(empty);
      
      if (fadeClone) {
          if (getComputedStyle(container).position === "static") {
              container.style.position = "relative";
          }
          container.appendChild(fadeClone);
          requestAnimationFrame(function () { fadeClone.style.opacity = "0"; });
          setTimeout(function () { if (fadeClone.parentNode) fadeClone.parentNode.removeChild(fadeClone); }, 320);
      }
      return null;
    }

    // --- Фикс оси X (синхронизация с now) ---
    const nowSec = Math.floor(Date.now() / 1000);
    const windowMs = Number(opts.windowMs) || 0;
    let startSec, endSec;

    if (windowMs > 0) {
      endSec = nowSec;
      startSec = nowSec - Math.floor(windowMs / 1000);
    } else {
      let minT = Infinity;
      let maxT = -Infinity;
      for (const e of events) {
        const t = Number(e[0]);
        if (!Number.isFinite(t)) continue;
        if (t < minT) minT = t;
        if (t > maxT) maxT = t;
      }
      if (!Number.isFinite(minT) || !Number.isFinite(maxT)) {
        const empty = document.createElement("div");
        empty.className = "proton-events-timeline-empty";
        empty.textContent =
          typeof window.protonT === "function"
            ? window.protonT("No incidents")
            : "No incidents";
        container.appendChild(empty);
        return null;
      }
      // Если окно не задано, тоже привязываем к "сейчас", чтобы не дёргалось.
      endSec = nowSec;
      startSec = Math.min(minT, nowSec);
    }

    const durationSec = Math.max(1, endSec - startSec);

    const timeToX = (t) => {
      const ratio = (t - startSec) / durationSec;
      return Math.max(0, Math.min(width, ratio * width));
    };

    const groups = new Map();

    // Группируем события по временным бакетам (например, 5 секунд),
    // чтобы схлопнуть близкие события в один стек. Это не зависит от ширины в пикселях,
    // поэтому при сдвиге окна (now) стек не будет прыгать по экрану.
    const BUCKET_SEC = 5;
    for (const e of events) {
      if (!Array.isArray(e) || e.length < 3) continue;
      const t = Number(e[0]);
      if (!Number.isFinite(t)) continue;
      if (t < startSec || t > endSec) continue;

      const bucketTs = Math.floor(t / BUCKET_SEC) * BUCKET_SEC;
      if (!groups.has(bucketTs)) {
        groups.set(bucketTs, []);
      }
      groups.get(bucketTs).push(e);
    }

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "proton-events-timeline-svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");

    const baselineY = height;

    for (const [bucketTs, groupEvents] of groups) {
      const sorted = groupEvents.slice().sort((a, b) => {
        const ra = EVENT_STACK_RANK[String(a[2])] ?? 99;
        const rb = EVENT_STACK_RANK[String(b[2])] ?? 99;
        return ra - rb;
      });

      // Рисуем стек в центре временного бакета
      const x = timeToX(bucketTs + BUCKET_SEC / 2);
      const strokeWidth = 3;
      const stackHeight = height;

      const groupKey = String(bucketTs);
      const isSelected = selectedGroupKey === groupKey;

      const hasProblem = sorted.some(
        (e) => EVENT_PROBLEM_TYPES[String(e[2])] === true,
      );

      // Стек из нескольких событий — рисуем полосы.
      if (sorted.length > 1) {
        const segmentHeight = stackHeight / sorted.length;

        for (let i = 0; i < sorted.length; i++) {
          const e = sorted[i];
          const type = String(e[2] || "unknown");
          const color = EVENT_COLORS[type] || EVENT_COLORS.unknown;

          const y1 = baselineY - stackHeight + i * segmentHeight;
          const y2 = y1 + segmentHeight;

          const line = document.createElementNS(svgNS, "line");
          line.setAttribute("x1", x);
          line.setAttribute("y1", y1);
          line.setAttribute("x2", x);
          line.setAttribute("y2", y2);
          line.setAttribute("stroke", color);
          line.setAttribute("stroke-width", strokeWidth);
          line.setAttribute("stroke-linecap", "butt");
          line.setAttribute(
            "class",
            "proton-events-timeline-mark proton-events-timeline-" + type,
          );
          svg.appendChild(line);
        }

        // Индикатор плотности — красная обводка вокруг стека.
        if (sorted.length >= 3 && hasProblem) {
          const outline = document.createElementNS(svgNS, "rect");
          outline.setAttribute("x", x - strokeWidth / 2 - 1);
          outline.setAttribute("y", baselineY - stackHeight - 1);
          outline.setAttribute("width", strokeWidth + 2);
          outline.setAttribute("height", stackHeight + 2);
          outline.setAttribute("fill", "none");
          outline.setAttribute("stroke", "#ef4444");
          outline.setAttribute("stroke-width", 1);
          outline.setAttribute("stroke-opacity", 0.9);
          outline.setAttribute("class", "proton-events-timeline-outline");
          outline.setAttribute("pointer-events", "none");
          svg.appendChild(outline);
        }
      } else {
        // Одиночное событие — обычный штрих.
        const type = String(sorted[0][2] || "unknown");
        const color = EVENT_COLORS[type] || EVENT_COLORS.unknown;

        const line = document.createElementNS(svgNS, "line");
        line.setAttribute("x1", x);
        line.setAttribute("y1", baselineY - stackHeight);
        line.setAttribute("x2", x);
        line.setAttribute("y2", baselineY);
        line.setAttribute("stroke", color);
        line.setAttribute("stroke-width", strokeWidth);
        line.setAttribute("stroke-linecap", "round");
        line.setAttribute(
          "class",
          "proton-events-timeline-mark proton-events-timeline-" + type,
        );
        svg.appendChild(line);
      }

      // Подсветка выбранной группы.
      if (isSelected) {
        const highlight = document.createElementNS(svgNS, "rect");
        highlight.setAttribute("x", x - strokeWidth / 2 - 1);
        highlight.setAttribute("y", baselineY - stackHeight - 1);
        highlight.setAttribute("width", strokeWidth + 2);
        highlight.setAttribute("height", stackHeight + 2);
        highlight.setAttribute("fill", "none");
        highlight.setAttribute("stroke", "#ffffff");
        highlight.setAttribute("stroke-width", 1);
        highlight.setAttribute("stroke-opacity", 0.85);
        highlight.setAttribute("class", "proton-events-timeline-highlight");
        highlight.setAttribute("pointer-events", "none");
        svg.appendChild(highlight);
      }

      // Невидимая область клика — поверх штриха, шириной strokeWidth + 2.
      if (onEventClick) {
        const hitArea = document.createElementNS(svgNS, "rect");
        hitArea.setAttribute("x", x - strokeWidth / 2 - 1);
        hitArea.setAttribute("y", 0);
        hitArea.setAttribute("width", strokeWidth + 2);
        hitArea.setAttribute("height", stackHeight);
        hitArea.setAttribute("fill", "transparent");
        hitArea.setAttribute("class", "proton-events-timeline-hitarea");
        hitArea.setAttribute("cursor", "pointer");

        const capturedGroup = sorted.slice();
        hitArea.addEventListener("click", function (ev) {
          ev.stopPropagation();
          onEventClick(bucketTs, capturedGroup);
        });

        svg.appendChild(hitArea);
      }
    }

		container.appendChild(svg);
    
    // --- Play crossfade for timeline ---
    if (fadeClone) {
        if (getComputedStyle(container).position === "static") {
            container.style.position = "relative";
        }
        container.appendChild(fadeClone);
        requestAnimationFrame(function () { fadeClone.style.opacity = "0"; });
        setTimeout(function () { if (fadeClone.parentNode) fadeClone.parentNode.removeChild(fadeClone); }, 320);
    }

    // === Кнопка легенды в левом нижнем углу ===
    // position: absolute — задаётся через CSS (.proton-events-legend-btn).
    // Кнопка создаётся как HTML-элемент, а не SVG, чтобы работали
    // обычные CSS-стили и :hover.
    if (onEventClick !== null || true) {
      // Легенда нужна всегда, независимо от наличия колбэка.
    }
    attachLegendButton(container);

    return svg;
  }
  
  // Маппинг типа события → короткое имя (для бейджа в панели деталей).
  const EVENT_TYPE_LABEL = {
    crash: "CRASH",
    "health-fail": "H/F",
    "silent-death": "S/D",
    unknown: "UNKNOWN",
    restart: "R",
    "health-recovery": "H/R",
    "user-stop": "U/S",
    "clean-exit": "C/E",
  };

  // Человекочитаемые названия для легенды.
  const EVENT_TYPE_FULL = {
    crash: "Crash",
    "health-fail": "Health check failed",
    "silent-death": "Silent death",
    unknown: "Unknown",
    restart: "Restart",
    "health-recovery": "Health restored",
    "user-stop": "User stopped",
    "clean-exit": "Clean exit",
  };

  function t(key) {
    if (typeof window.protonT === "function") return window.protonT(key);
    return key;
  }

  function attachLegendButton(container) {
    // Если кнопка уже есть — не дублируем.
    let btn = container.querySelector(".proton-events-legend-btn");
    if (btn) return btn;

    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "proton-events-legend-btn";
    btn.setAttribute("aria-label", t("Event types"));
    btn.setAttribute("aria-expanded", "false");
    btn.textContent = "?";

    const popup = document.createElement("div");
    popup.className = "proton-events-legend-popup";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-hidden", "true");
    popup.hidden = true;

    let html = '<div class="proton-events-legend-title">' +
      escapeHtml(t("Event types")) + "</div>";

    // Порядок строк в легенде — по критичности.
    const order = [
      "crash",
      "health-fail",
      "silent-death",
      "unknown",
      "restart",
      "health-recovery",
      "user-stop",
      "clean-exit",
    ];

    for (const type of order) {
      const color = EVENT_COLORS[type] || EVENT_COLORS.unknown;
      const label = EVENT_TYPE_LABEL[type] || type;
      const full = t(EVENT_TYPE_FULL[type] || type);

      html +=
        '<div class="proton-events-legend-row">' +
        '<span class="proton-events-legend-swatch" style="background-color:' +
        escapeHtml(color) + '"></span>' +
        '<span class="proton-events-legend-label">' +
        escapeHtml(label) +
        "</span>" +
        '<span class="proton-events-legend-desc">' +
        escapeHtml(full) +
        "</span>" +
        "</div>";
    }
	
	// === Раздел 2: Сводка ===
    html += '<div class="proton-events-legend-title proton-events-legend-title-split">' +
        escapeHtml(t("Summary")) +
        "</div>";

    const summaryRows = [
        { symbol: "●", cls: "proton-events-legend-symbol-running", label: t("Running now") },
        { symbol: "⚠", cls: "proton-events-legend-symbol-warn",    label: t("Incidents") },
        { symbol: "⏸", cls: "proton-events-legend-symbol-userstop", label: t("Stopped by user") },
        { symbol: "⏹", cls: "proton-events-legend-symbol-cleanexit",label: t("Clean exits") },
        { symbol: "⟳", cls: "proton-events-legend-symbol-restart",  label: t("Restarts") },
        { symbol: "✓", cls: "proton-events-legend-symbol-recovery", label: t("Recoveries") },
    ];

    for (const row of summaryRows) {
        html +=
            '<div class="proton-events-legend-row proton-events-legend-row-summary">' +
            '<span class="proton-events-legend-symbol ' + row.cls + '">' +
            escapeHtml(row.symbol) +
            "</span>" +
            '<span class="proton-events-legend-desc proton-events-legend-desc-summary">' +
            escapeHtml(row.label) +
            "</span>" +
            "</div>";
    }

    popup.innerHTML = html;

    btn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      const nowOpen = popup.hidden;
      popup.hidden = !nowOpen;
      btn.setAttribute("aria-expanded", nowOpen ? "true" : "false");
      popup.setAttribute("aria-hidden", nowOpen ? "false" : "true");
      btn.classList.toggle("is-open", nowOpen);
    });

    // Клик вне окна — закрываем.
    const outsideClick = function (ev) {
      if (popup.hidden) return;
      if (btn.contains(ev.target)) return;
      if (popup.contains(ev.target)) return;
      popup.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      popup.setAttribute("aria-hidden", "true");
      btn.classList.remove("is-open");
    };
    document.addEventListener("click", outsideClick, true);

    // Слушаем удаление контейнера, чтобы снять глобальный обработчик.
    const detach = function () {
      if (document.body.contains(container)) return;
      document.removeEventListener("click", outsideClick, true);
      observer.disconnect();
    };
    const observer = new MutationObserver(detach);
    observer.observe(document.body, { childList: true, subtree: true });

    container.appendChild(btn);
    container.appendChild(popup);

    return btn;
}

  // --- Экспорт ---

   window.ProtonServicesGraph = {
    renderServiceGraph,
    renderHealthGraph,
    renderWorstStatusGraph,
    renderEventTimeline,
	EVENT_TYPE_LABEL,
    EVENT_TYPE_FULL,
    splitIntoSegments,
    getStatusColor,
    getStatusClass,
    GAP_THRESHOLD_SEC,
    SERVICE_GRAPH_HEIGHT,
    HEALTH_GRAPH_HEIGHT,
  };
})();
