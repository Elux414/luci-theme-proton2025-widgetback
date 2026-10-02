/**
 * Proton2025 Dashboard - Lightweight SVG charts
 * No external charting library required.
 */

(function () {
  "use strict";

  function createPath(points, width, height, maxValue, padding) {
    if (!points.length) return "";

    const innerWidth = width - padding * 2;
    const innerHeight = height - padding * 2;
    const step =
      points.length > 1 ? innerWidth / (points.length - 1) : innerWidth;

    return points
      .map((value, index) => {
        const x = padding + index * step;
        const ratio = maxValue > 0 ? value / maxValue : 0;
        const y = padding + innerHeight - ratio * innerHeight;
        return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join(" ");
  }

  function createAreaPath(points, width, height, maxValue, padding) {
    if (!points.length) return "";

    const line = createPath(points, width, height, maxValue, padding);
    const innerWidth = width - padding * 2;
    const bottom = height - padding;

    return (
      line +
      ` L ${(padding + innerWidth).toFixed(2)} ${bottom.toFixed(2)}` +
      ` L ${padding.toFixed(2)} ${bottom.toFixed(2)} Z`
    );
  }

  function render(container, rxValues, txValues) {
    if (!container) return;

    const width = 600;
    const height = 150;
    const padding = 4;

    const count = Math.max(rxValues.length, txValues.length);
    if (!count) {
      container.innerHTML = "";
      return;
    }

    const rx = rxValues.slice(-count);
    const tx = txValues.slice(-count);
    const maxValue = Math.max(1, ...rx, ...tx);

    container.innerHTML = `
      <svg class="proton-dashboard-chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
        <g class="proton-dashboard-chart-grid">
          <line x1="0" y1="37.5" x2="600" y2="37.5"></line>
          <line x1="0" y1="75" x2="600" y2="75"></line>
          <line x1="0" y1="112.5" x2="600" y2="112.5"></line>
        </g>
        <path class="proton-dashboard-chart-area-rx" d="${createAreaPath(rx, width, height, maxValue, padding)}"></path>
        <path class="proton-dashboard-chart-area-tx" d="${createAreaPath(tx, width, height, maxValue, padding)}"></path>
        <path class="proton-dashboard-chart-line-rx" d="${createPath(rx, width, height, maxValue, padding)}"></path>
        <path class="proton-dashboard-chart-line-tx" d="${createPath(tx, width, height, maxValue, padding)}"></path>
      </svg>
    `;
  }

  window.ProtonDashboardCharts = {
    render,
  };
})();
