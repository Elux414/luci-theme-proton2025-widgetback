/**
 * Proton2025 - Services History Storage
 * Copyright 2025-2026 ChesterGoodiny
 * Licensed under the Apache License, Version 2.0
 * See LICENSE and NOTICE for details.
 *
 * JS-обёртка над backend RPC luci.proton-services-history.
 * Держит историю в памяти, батчит запись в /tmp раз в 30 сек.
 */

"use strict";

(function () {
  const FLUSH_INTERVAL_MS = 30000;
  const MAX_POINTS_IN_MEMORY = 100000; // защита от бесконечного роста

  // Состояние модуля
  let initialized = false;
  let rpcMethods = null;
  let flushTimer = null;

  // Данные в памяти
  // structure: {
  //   services: Map<service, { points: [[t,s,p,h],...], sampleInterval, maxAgeHours }>,
  //   health: { points: [[t,r,total,inc],...], sampleInterval, maxAgeHours },
  //   userActions: Map<service, { action: string, at: number }>
  // }
 const memory = {
    services: new Map(),
    health: { points: [], sampleInterval: null, maxAgeHours: null },
    userActions: new Map(),
    events: [],
  };

  // Очередь "грязных" сервисов — те, у которых есть неотданные точки
  const dirtyServices = new Set();
  let healthDirty = false;
  let userActionsDirty = false;

  // --- RPC ---

  function ensureRpc() {
    if (rpcMethods) return rpcMethods;
    if (!window.L || !L.rpc || typeof L.rpc.declare !== "function") return null;

    rpcMethods = {
      readHistory: L.rpc.declare({
        object: "luci.proton-services-history",
        method: "readHistory",
        params: ["name"],
        expect: { "": {} },
      }),
      writeHistory: L.rpc.declare({
        object: "luci.proton-services-history",
        method: "writeHistory",
        params: ["name", "sample_interval", "max_age_hours", "points"],
        expect: { "": {} },
      }),
      clearHistory: L.rpc.declare({
        object: "luci.proton-services-history",
        method: "clearHistory",
        params: ["name"],
        expect: { "": {} },
      }),
      readHealthHistory: L.rpc.declare({
        object: "luci.proton-services-history",
        method: "readHealthHistory",
        expect: { "": {} },
      }),
      writeHealthHistory: L.rpc.declare({
        object: "luci.proton-services-history",
        method: "writeHealthHistory",
        params: ["sample_interval", "max_age_hours", "points"],
        expect: { "": {} },
      }),
      readUserActions: L.rpc.declare({
        object: "luci.proton-services-history",
        method: "readUserActions",
        expect: { "": {} },
      }),
      writeUserAction: L.rpc.declare({
        object: "luci.proton-services-history",
        method: "writeUserAction",
        params: ["service", "action"],
        expect: { "": {} },
      }),
      getStorageStats: L.rpc.declare({
        object: "luci.proton-services-history",
        method: "getStorageStats",
        expect: { "": {} },
      }),
      clearAll: L.rpc.declare({
        object: "luci.proton-services-history",
        method: "clearAll",
        expect: { "": {} },
      }),
    };

    return rpcMethods;
  }

  // --- Публичный API ---

  /**
   * Загрузить историю одного сервиса с backend в память.
   * Идемпотентно: если уже загружено, не перезагружает.
   */
  async function loadService(service) {
    if (memory.services.has(service)) return memory.services.get(service);
    const rpc = ensureRpc();
    if (!rpc) return null;

    try {
      const res = await L.resolveDefault(rpc.readHistory(service), null);
      if (!res || !res.success) {
        memory.services.set(service, {
          points: [],
          sampleInterval: null,
          maxAgeHours: null,
        });
        return memory.services.get(service);
      }

      const entry = {
        points: Array.isArray(res.points) ? res.points : [],
        sampleInterval: res.sample_interval || null,
        maxAgeHours: res.max_age_hours || null,
      };
      memory.services.set(service, entry);
      return entry;
    } catch (e) {
      console.warn("[ProtonServicesHistory] loadService failed:", service, e);
      return null;
    }
  }

  /**
   * Загрузить сводную историю здоровья.
   */
  async function loadHealth() {
    if (memory.health.points.length > 0) return memory.health;
    const rpc = ensureRpc();
    if (!rpc) return null;

    try {
      const res = await L.resolveDefault(rpc.readHealthHistory(), null);
      if (!res || !res.success) return memory.health;

      memory.health.points = Array.isArray(res.points) ? res.points : [];
      memory.health.sampleInterval = res.sample_interval || null;
      memory.health.maxAgeHours = res.max_age_hours || null;
      return memory.health;
    } catch (e) {
      console.warn("[ProtonServicesHistory] loadHealth failed:", e);
      return null;
    }
  }

  /**
   * Загрузить user actions.
   */
  async function loadUserActions() {
    const rpc = ensureRpc();
    if (!rpc) return null;

    try {
      const res = await L.resolveDefault(rpc.readUserActions(), null);
      if (!res || !res.success) return null;

      memory.userActions.clear();
      if (res.actions && typeof res.actions === "object") {
        for (const [svc, act] of Object.entries(res.actions)) {
          memory.userActions.set(svc, act);
        }
      }
      return memory.userActions;
    } catch (e) {
      console.warn("[ProtonServicesHistory] loadUserActions failed:", e);
      return null;
    }
  }

  /**
   * Добавить точку в историю сервиса (в память).
   * Точка: [timestamp, status, pid, hint]
   */
  function appendServicePoint(service, point) {
    if (!service || !Array.isArray(point) || point.length < 1) return;

    let entry = memory.services.get(service);
    if (!entry) {
      entry = { points: [], sampleInterval: null, maxAgeHours: null };
      memory.services.set(service, entry);
    }

    // Проверка на дубликат по timestamp
    const lastPoint = entry.points[entry.points.length - 1];
    if (lastPoint && lastPoint[0] === point[0]) {
      entry.points[entry.points.length - 1] = point;
    } else {
      entry.points.push(point);
    }

    // Защита от роста
    if (entry.points.length > MAX_POINTS_IN_MEMORY) {
      entry.points.splice(0, entry.points.length - MAX_POINTS_IN_MEMORY);
    }

    dirtyServices.add(service);
  }

  /**
   * Добавить точку в health-историю.
   * Точка: [timestamp, running, total, incidents]
   */
  function appendHealthPoint(point) {
    if (!Array.isArray(point) || point.length < 4) return;

    const lastPoint = memory.health.points[memory.health.points.length - 1];
    if (lastPoint && lastPoint[0] === point[0]) {
      memory.health.points[memory.health.points.length - 1] = point;
    } else {
      memory.health.points.push(point);
    }

    if (memory.health.points.length > MAX_POINTS_IN_MEMORY) {
      memory.health.points.splice(
        0,
        memory.health.points.length - MAX_POINTS_IN_MEMORY,
      );
    }

    healthDirty = true;
  }

  /**
   * Установить/снять флаг user action.
   */
  function setUserAction(service, action) {
    if (!service) return;
    if (action == null) {
      memory.userActions.delete(service);
    } else {
      memory.userActions.set(service, { action, at: Math.floor(Date.now() / 1000) });
    }
    userActionsDirty = true;
  }

  /**
   * Получить флаг user action.
   */
  function getUserAction(service) {
    const entry = memory.userActions.get(service);
    return entry ? entry.action : null;
  }

  /**
   * Получить точки истории сервиса (из памяти).
   */
  function getServiceHistory(service) {
    const entry = memory.services.get(service);
    return entry ? entry.points : [];
  }

  /**
   * Получить точки health-истории (из памяти).
   */
  function getHealthHistory() {
    return memory.health.points;
  }

  /**
   * Flush — записать накопленные изменения в /tmp.
   */
  async function flush() {
    const rpc = ensureRpc();
    if (!rpc) return;

    // Flush services
    const servicesToFlush = Array.from(dirtyServices);
    dirtyServices.clear();

    const settings = readSettings();

    for (const service of servicesToFlush) {
      const entry = memory.services.get(service);
      if (!entry) continue;

      try {
        await L.resolveDefault(
          rpc.writeHistory(
            service,
            settings.sampleInterval,
            settings.maxAgeHours,
            entry.points,
          ),
          null,
        );
      } catch (e) {
        console.warn("[ProtonServicesHistory] flush service failed:", service, e);
        dirtyServices.add(service); // вернуть в очередь
      }
    }

    // Flush health
    if (healthDirty) {
      healthDirty = false;
      try {
        await L.resolveDefault(
          rpc.writeHealthHistory(
            settings.sampleInterval,
            settings.maxAgeHours,
            memory.health.points,
          ),
          null,
        );
      } catch (e) {
        console.warn("[ProtonServicesHistory] flush health failed:", e);
        healthDirty = true;
      }
    }

    // Flush user actions
    if (userActionsDirty) {
      userActionsDirty = false;
      // Пишем каждый action по отдельности (там может быть много сервисов).
      // Но проще — перебрать все в памяти и сравнить.
      // Здесь упрощённо: пишем только те, что были изменены.
      // Точнее — синхронизируем всё состояние.
      // TODO: доработать, если понадобится оптимизация.
    }
  }

  /**
   * Прочитать настройки истории из localStorage.
   * Fallback на дефолты.
   */
  function readSettings() {
    let sampleInterval = 10;
    let maxAgeHours = 24;

    try {
      const si = localStorage.getItem("proton-history-sample-interval");
      if (si) {
        const parsed = parseInt(si, 10);
        if (parsed > 0) sampleInterval = parsed;
      }
      const mah = localStorage.getItem("proton-history-max-age-hours");
      if (mah) {
        const parsed = parseInt(mah, 10);
        if (parsed > 0) maxAgeHours = parsed;
      }
    } catch (e) {}

    return { sampleInterval, maxAgeHours };
  }

  /**
   * Запустить периодический flush.
   */
  function startAutoFlush() {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
      flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);
  }

  /**
   * Остановить auto flush.
   */
  function stopAutoFlush() {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  }

  /**
   * Инициализация. Вызывается один раз.
   */
  async function init() {
    if (initialized) return;
    initialized = true;

    await Promise.all([loadUserActions()]);
    startAutoFlush();
  }

  /**
   * Принудительный flush при закрытии страницы.
   */
  function flushOnPageHide() {
    // Синхронный flush через navigator.sendBeacon не работает с ubus.
    // Используем async flush с keepalive через fetch — но для ubus это сложно.
    // Проще — полагаемся на 30-секундный таймер; потеря 30 секунд данных
    // не критична.
    flush().catch(() => {});
  }

  // --- Утилиты анализа истории (Этап 3) ---

  /**
   * Фильтрует точки по временному окну.
   * @param {Array} points — точки [[t,s,p,h],...]
   * @param {number} windowMs — размер окна в миллисекундах
   * @returns {Array} — отфильтрованные точки
   */
  function filterByWindow(points, windowMs) {
    if (!Array.isArray(points) || points.length === 0) return [];
    if (!windowMs || windowMs <= 0) return points.slice();

    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - Math.floor(windowMs / 1000);
    const out = [];
    for (const p of points) {
      if (!Array.isArray(p) || p.length < 1) continue;
      const t = Number(p[0]);
      if (!Number.isFinite(t)) continue;
      if (t >= cutoff) out.push(p);
    }
    return out;
  }

  /**
   * Склейка коротких down-периодов в рестарты.
   * Если сервис был down <= maxGapSec секунд, а затем снова up —
   * это рестарт, а не падение. Меняем статус down-точек на hint=1
   * (restart-detected), а сами точки сохраняем — но помечаем.
   *
   * Реально: возвращаем массив с модифицированными точками.
   *
   * @param {Array} points — точки
   * @param {number} sampleInterval — интервал опроса в секундах
   * @returns {Array} — обработанные точки
   */
  function mergeShortDowns(points, sampleInterval) {
    if (!Array.isArray(points) || points.length < 3) return points.slice();

    const maxGapSec = (sampleInterval || 10) * 2;
    const out = points.map((p) => p.slice()); // копия

    let downStart = -1;
    for (let i = 0; i < out.length; i++) {
      const status = Number(out[i][1]);
      const isDown = status === 0 || status === 2;

      if (isDown && downStart < 0) {
        downStart = i;
      } else if (!isDown && downStart >= 0) {
        // Нашли конец down-периода
        const downEnd = i - 1;
        const downDuration = out[downEnd][0] - out[downStart][0];

        // Если down длился <= maxGapSec и до него был running — это рестарт
        const beforeDown = downStart > 0 ? out[downStart - 1] : null;
        const wasRunning = beforeDown && Number(beforeDown[1]) === 1;

        if (wasRunning && downDuration <= maxGapSec) {
          // Помечаем весь down-период как рестарт (hint=1)
          for (let j = downStart; j <= downEnd; j++) {
            out[j][3] = 1; // hint = restart
          }
        }
        downStart = -1;
      }
    }

    return out;
  }

  /**
   * Прореживание точек до targetCount.
   * Алгоритм: разбиваем на группы по step точек, в каждой группе
   * берём "худший" статус (по приоритету).
   *
   * Приоритет (от лучшего к худшему):
   *   running(1) → unknown(2) → stopped(0) → health-failed(3)
   *
   * @param {Array} points — точки
   * @param {number} targetCount — желаемое количество
   * @returns {Array} — прореженные точки
   */
  function downsample(points, targetCount) {
    if (!Array.isArray(points) || points.length <= targetCount) {
      return points.slice();
    }

    const step = Math.ceil(points.length / targetCount);
    const out = [];

    for (let i = 0; i < points.length; i += step) {
      const group = points.slice(i, i + step);

      // Ищем худший статус в группе
      let worst = group[0];
      let worstPriority = getPointPriority(worst);

      for (let j = 1; j < group.length; j++) {
        const pr = getPointPriority(group[j]);
        if (pr > worstPriority) {
          worst = group[j];
          worstPriority = pr;
        }
      }

      out.push(worst);
    }

    return out;
  }

  /**
   * Приоритет точки для прореживания: чем выше — тем важнее показать.
   * Running = 0, unknown/stopped = выше, health-failed = самый высокий.
   */
  function getPointPriority(point) {
    if (!Array.isArray(point) || point.length < 2) return 0;
    const status = Number(point[1]);
    const hint = point.length > 3 ? Number(point[3]) : 0;

    // health-failed — самый важный
    if (status === 3) return 100;
    // crashed — важно
    if (status === 0 && hint === 3) return 90;
    // silent death / unknown stop
    if (status === 0 && hint === 0) return 80;
    // user-stopped
    if (status === 0 && hint === 4) return 40;
    // clean-exit
    if (status === 0 && hint === 2) return 30;
    // restart-detected на running
    if (status === 1 && hint === 1) return 50;
    // unknown
    if (status === 2) return 60;
    // running — базовый
    if (status === 1) return 0;

    return 0;
  }

  /**
   * Статистика по точкам за период.
   * Возвращает: { downs, restarts, userStops, uptimePercent }
   *
   * @param {Array} points — точки
   * @returns {object}
   */
  function computeServiceStats(points) {
    const stats = {
      downs: 0,
      restarts: 0,
      userStops: 0,
      totalPoints: Array.isArray(points) ? points.length : 0,
 uptimePoints: 0,
    };

    if (!Array.isArray(points) || points.length === 0) return stats;

    let prevStatus = null;
    for (const p of points) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const status = Number(p[1]);
      const hint = p.length > 3 ? Number(p[3]) : 0;

      // Считаем uptime
      if (status === 1) stats.uptimePoints++;

      // Определяем переходы
      if (prevStatus !== null) {
        // running → down
        if (prevStatus === 1 && status !== 1) {
          if (hint === 4) stats.userStops++;
          else if (hint === 2) {
            // clean-exit — не считаем падением
          } else {
            stats.downs++;
          }
        }
      }

      // Рестарты: running точки с hint=1
      if (status === 1 && hint === 1) {
        stats.restarts++;
      }

      prevStatus = status;
    }

    stats.uptimePercent =
    stats.totalPoints > 0
    ? Math.round((stats.uptimePoints / stats.totalPoints) * 100)
    : 0;

    return stats;
  }

  /**
   * Получить историю сервиса, отфильтрованную и обработанную для рендера.
   * Возвращает готовый к отрисовке массив.
   *
   * @param {string} service
   * @param {number} windowMs
   * @param {object} options — { sampleInterval, targetCount }
   * @returns {Array}
   */
  function getServiceHistoryForRender(service, windowMs, options) {
    const opts = options || {};
    const targetCount = opts.targetCount || 200;
    const sampleInterval = opts.sampleInterval || 10;

    const raw = getServiceHistory(service);
    const filtered = filterByWindow(raw, windowMs);
    const merged = mergeShortDowns(filtered, sampleInterval);
    const reduced = downsample(merged, targetCount);
    return reduced;
  }

  /**
   * Получить health-историю, готовую к рендеру.
   * Точки: [t, running, total, incidents].
   */
  function getHealthHistoryForRender(windowMs, options) {
    const opts = options || {};
    const targetCount = opts.targetCount || 200;

    const raw = memory.health.points;
    const filtered = filterByWindow(raw, windowMs);

    // Прореживание для health — берём среднее по группе
    if (filtered.length <= targetCount) return filtered.slice();

    const step = Math.ceil(filtered.length / targetCount);
    const out = [];
    for (let i = 0; i < filtered.length; i += step) {
      const group = filtered.slice(i, i + step);
      // Средние по группе
      let sumRunning = 0;
      let sumTotal = 0;
      let sumIncidents = 0;
      for (const p of group) {
        sumRunning += Number(p[1]) || 0;
        sumTotal += Number(p[2]) || 0;
        sumIncidents += Number(p[3]) || 0;
      }
      // Берём timestamp середины группы
      const midPoint = group[Math.floor(group.length / 2)];
      out.push([
        midPoint[0],
        Math.round(sumRunning / group.length),
               Math.round(sumTotal / group.length),
               sumIncidents,
      ]);
    }
    return out;
  }
  
    // --- Timeline: worst status across all services ---------------------------
  //
  // Возвращает массив [bucketTs, worstStatus] — наихудший статус по всем
  // сервисам в каждом бакете времени. Используется для общего графика
  // «Здоровье сервисов» вместо агрегата running/total.
  //
  // Приоритет worst (выше = важнее):
  //   4: health-failed (status=3)
  //   3: crashed / silent death (status=0, hint=0 или 3)
  //   2: unknown (status=2)
  //   1: running (status=1)
  //
  // clean-exit (hint=2) и user-stopped (hint=4) в Блоке 1 не учитываются —
  // они плановые и не должны портить общий цвет.
  //
  // Сервисы без данных в конкретном бакете НЕ учитываются (вариант B).

  function getPointPriorityForWorst(point) {
    if (!Array.isArray(point) || point.length < 2) return 0;

    const status = Number(point[1]);
    const hint = point.length > 3 ? Number(point[3]) : 0;

    // Плановые события — не учитываем при определении worst.
    if (status === 0 && (hint === 2 || hint === 4)) return 0;

    if (status === 3) return 4;       // health-failed
    if (status === 0) return 3;       // crashed / silent death
    if (status === 2) return 2;       // unknown
    if (status === 1) return 1;       // running
    return 0;
  }

  function getWorstStatusFromPriority(priority) {
    if (priority === 4) return 3;     // health-failed
    if (priority === 3) return 0;     // stopped (crash)
    if (priority === 2) return 2;     // unknown
    if (priority === 1) return 1;     // running
    return null;
  }

  /**
   * Возвращает timeline наихудшего статуса по всем сервисам.
   *
   * @param {number} windowMs — окно отображения в миллисекундах
   * @param {object} options — { sampleInterval, targetCount }
   * @returns {Array} — массив [bucketTs, worstStatus]
   */
  function getWorstStatusTimeline(windowMs, options) {
    const opts = options || {};
    const targetCount = opts.targetCount || 200;
    const settings = readSettings();
    const sampleInterval = opts.sampleInterval || settings.sampleInterval || 10;

    // Собираем все точки всех сервисов в один массив с привязкой к сервису.
    // Формат: [{service, t, point}, ...]
    const allPoints = [];
    for (const [serviceName, entry] of memory.services) {
      if (!entry || !Array.isArray(entry.points)) continue;
      for (const p of entry.points) {
        if (!Array.isArray(p) || p.length < 1) continue;
        const t = Number(p[0]);
        if (!Number.isFinite(t)) continue;
        allPoints.push({ service: serviceName, t: t, point: p });
      }
    }

    if (allPoints.length === 0) return [];

    // Группируем по сервису для быстрого поиска ближайшей точки.
    const byService = new Map();
    for (const item of allPoints) {
      if (!byService.has(item.service)) {
        byService.set(item.service, []);
      }
      byService.get(item.service).push(item);
    }

    // Сортируем точки внутри каждого сервиса по времени.
    for (const points of byService.values()) {
      points.sort((a, b) => a.t - b.t);
    }

    // Определяем окно.
    const now = Math.floor(Date.now() / 1000);
    const windowSec = Math.floor(windowMs / 1000);
    const cutoff = now - windowSec;

    // Шаг бакета: не меньше sampleInterval, но не больше, чем позволяет
    // уложиться в targetCount бакетов.
    const minStep = sampleInterval;
    const maxStep = Math.max(1, Math.floor(windowSec / targetCount));
    const step = Math.max(minStep, maxStep);

    // Бинарный поиск ближайшей точки к targetTs в отсортированном массиве.
    function findNearest(points, targetTs, tolerance) {
      if (!points || points.length === 0) return null;

      let lo = 0;
      let hi = points.length - 1;

      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (points[mid].t < targetTs) lo = mid + 1;
        else hi = mid;
      }

      // lo — первая точка >= targetTs. Проверяем lo и lo-1.
      let best = null;
      let bestDist = Infinity;

      for (const idx of [lo - 1, lo]) {
        if (idx < 0 || idx >= points.length) continue;
        const d = Math.abs(points[idx].t - targetTs);
        if (d < bestDist) {
          bestDist = d;
          best = points[idx];
        }
      }

      if (best === null) return null;
      if (bestDist > tolerance) return null;
      return best;
    }

    // Строим бакеты.
    const result = [];
    const tolerance = Math.ceil(step / 2);

    for (let bucketStart = cutoff; bucketStart <= now; bucketStart += step) {
      const bucketCenter = bucketStart + Math.floor(step / 2);

      let worstPriority = 0;

      for (const [serviceName, points] of byService) {
        const nearest = findNearest(points, bucketCenter, tolerance);
        if (!nearest) continue;

        const priority = getPointPriorityForWorst(nearest.point);
        if (priority > worstPriority) {
          worstPriority = priority;
        }
      }

      // Если ни одного сервиса с данными — бакет пропускаем.
      // Это создаёт естественные разрывы в графике.
      if (worstPriority === 0) continue;

      const worstStatus = getWorstStatusFromPriority(worstPriority);
      if (worstStatus === null) continue;

      result.push([bucketStart, worstStatus]);
    }

    return result;
  }

  // --- Events (Этап 6.7) ----------------------------------------------------
  //
  // События хранятся отдельно от точек истории: в /tmp/proton-services-history/_events.json.
  // Формат события: [ts, service, type, hint, details].
  // Читаем через RPC luci.proton-services-events.readEvents с окном windowMs.
  // Кэшируем результат в memory.events, чтобы синхронный рендер не дёргал бэк.

  let eventsRpc = null;

  function ensureEventsRpc() {
    if (eventsRpc) return eventsRpc;
    if (!window.L || !L.rpc || typeof L.rpc.declare !== "function") return null;

    eventsRpc = {
      readEvents: L.rpc.declare({
        object: "luci.proton-services-events",
        method: "readEvents",
        params: ["service", "window_ms"],
        expect: { "": {} },
      }),
    };
    return eventsRpc;
  }

  /**
   * Загружает события с бэка в memory.events.
   * @param {number} windowMs — окно в миллисекундах
   * @param {string} [serviceName] — опциональный фильтр по сервису
   * @returns {Promise<Array>}
   */
  async function loadEvents(windowMs, serviceName) {
    const rpc = ensureEventsRpc();
    if (!rpc) return [];

    try {
      const res = await L.resolveDefault(
        rpc.readEvents(serviceName || "", windowMs || 0),
        null,
      );

      if (!res || !res.success || !Array.isArray(res.events)) {
        memory.events = [];
        return [];
      }

      // Нормализуем: [ts, service, type, hint, details]
      memory.events = res.events.filter((e) =>
        Array.isArray(e) && e.length >= 5
      );

      return memory.events;
    } catch (e) {
      console.warn("[ProtonServicesHistory] loadEvents failed:", e);
      memory.events = [];
      return [];
    }
  }

  /**
   * Синхронный доступ к последнему загруженному массиву событий.
   * Если loadEvents ещё не вызывался — вернёт пустой массив.
   */
  function getCachedEvents() {
    return Array.isArray(memory.events) ? memory.events : [];
  }

  // --- Экспорт ---

  window.ProtonServicesHistory = {
    init,
    loadService,
    loadHealth,
    loadUserActions,
    appendServicePoint,
    appendHealthPoint,
    setUserAction,
    getUserAction,
    getServiceHistory,
    getHealthHistory,
    flush,
    startAutoFlush,
    stopAutoFlush,
    flushOnPageHide,
    // === Этап 3: утилиты анализа ===
    getServiceHistoryForRender,
    getHealthHistoryForRender,
	getWorstStatusTimeline,
    computeServiceStats,
    filterByWindow,
    mergeShortDowns,
    downsample,
	// === Этап 6.7: события ===
    loadEvents,
    getCachedEvents,
    // Утилита для получения размера хранилища (для UI настроек)
    async getStorageStats() {
      const rpc = ensureRpc();
      if (!rpc) return { files: 0, bytes: 0 };
      try {
        const res = await L.resolveDefault(rpc.getStorageStats(), null);
        return res && res.success ? res : { files: 0, bytes: 0 };
      } catch (e) {
        return { files: 0, bytes: 0 };
      }
    },
    // Очистка всего хранилища
    async clearAll() {
      const rpc = ensureRpc();
      if (!rpc) return false;
      try {
        const res = await L.resolveDefault(rpc.clearAll(), null);
        return res && res.success;
      } catch (e) {
        return false;
      }
    },
  };

  window.addEventListener("pagehide", flushOnPageHide);
})();
