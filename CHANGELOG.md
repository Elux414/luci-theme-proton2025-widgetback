# Changelog

All notable changes to `luci-theme-proton2025-expanded` are documented
in this file.

This project is based on Proton2025. Changes inherited from the upstream
theme are not listed as new features of this fork unless they were
specifically modified, restored, or extended here.

## [Unreleased]

### Fixed
- Continued fixing service history and graph rendering issues.
- Improved chart behavior and added chart animations.
- Fixed additional issues in the Applications widget.

### Improved
- Refined service polling and timer behavior.
- Continued optimizing service history updates and widget behavior.

These changes were committed after the `v1.0.5p` tag on October 21, 2026,

## [v1.0.5p] - 2026-10-20

### Added
- Integrated a background daemon into the service monitoring workflow.

### Fixed
- Fixed browser fallback issues affecting widget functionality.
- Fixed polling-related issues in the dashboard and Applications widget.
- Improved compatibility and reliability of service monitoring.

### Improved
- Optimized widget loading performance.
- Improved service history handling and synchronization.
- Updated the dashboard and service-related localization strings.
- Updated LuCI RPC access permissions and template integration for the
  expanded functionality.

## [v1.0.4p] - 2026-10-16

### Added
- Added a Monitoring tab to the Applications widget settings.
- Added configuration options for service monitoring and L7 health checks.
- Added health-check logs to service details.

### Fixed
- Fixed the L7 health-failure state when reloading the page.
- Improved the display and handling of health-check results.

### Improved
- Extended the service monitoring configuration workflow.
- Updated the related settings, RPC handlers, access permissions,
  and translations.

## [v1.0.3p] - 2026-10-10

### Added
- Expanded the System widget with a network interfaces card.
- Added cross-browser synchronization of theme and widget settings
  through UCI configuration.
- Added a shared visual style for the dashboard widgets.

### Improved
- Refined the System widget's interface information layout.
- Unified the appearance of dashboard cards for better visual consistency.
- Extended localization for the new dashboard functionality.

## [v1.0.2p] - 2026-10-08

### Added
- Added localization strings for the expanded dashboard widgets.

### Improved
- Continued preparing the System widget and its network information display.
- Updated the package version and localization files.

## [v1.0.1p] - 2026-10-08

### Fixed
- Fixed issues in the Applications widget.
- Improved integration between the dashboard and service widget.

### Improved
- Optimized widget behavior.
- Refined dashboard styling and service-related RPC integration.
- Updated the theme templates and access permissions required by
  the expanded functionality.

## [v1.0.0p] - 2026-10-06

### Added
- Introduced the expanded dashboard implementation.
- Added the Applications widget to the redesigned Overview page.
- Added the System widget with system information.
- Added the Connected Hosts widget.
- Added a dedicated dashboard layout module.
- Added the `luci.proton-nlbw` RPC backend for host-related information.
- Extended the `luci.proton-system` backend for system monitoring data.

### Improved
- Redesigned the LuCI Overview page to accommodate the expanded widgets.
- Integrated the new dashboard modules into the Proton2025 theme.
- Improved the presentation and styling of the Applications widget.

## [v1.4.2-r2] - 2026-09-29

### Added
- Backported the Applications/service widget to Proton2025 1.4.2.
- Restored the service widget integration in the theme templates.
- Added the initial service-widget implementation to the fork.

### Improved
- Adapted the widget styling to the Proton2025 1.4.2 codebase.
- Extended the existing temperature backend as part of the widget
  integration.
- Updated the package metadata and documentation for the backported build.

---

## Development history

### Service history and monitoring — October 11–16, 2026

The following milestones were developed across the `v1.0.3p` and
`v1.0.4p` development period:

- Added service history recording as a foundation for historical charts.
- Added historical charts to the Applications widget.
- Added a service event logger and event timeline chart.
- Reworked the history chart implementation to improve scalability.
- Added an interactive service history view with event grouping,
  a details panel, and a health summary.
- Added additional service event types.
- Implemented per-service health checks through ubus.
- Added configurable health-check methods and related monitoring settings.
- Added health-check logs to service details and fixed state restoration
  after page reloads.

### Dashboard foundation — October 2–10, 2026

- Expanded the dashboard chart and data modules.
- Redesigned the Overview page.
- Added the System and Connected Hosts widgets.
- Added a unified visual style for dashboard cards.
- Added synchronization of theme and widget settings through UCI.

---

[Unreleased]: https://github.com/Elux414/luci-theme-proton2025-widgetback/compare/v1.0.5p...HEAD
[v1.0.5p]: https://github.com/Elux414/luci-theme-proton2025-widgetback/releases/tag/v1.0.5p
[v1.0.4p]: https://github.com/Elux414/luci-theme-proton2025-widgetback/releases/tag/v1.0.4p
[v1.0.3p]: https://github.com/Elux414/luci-theme-proton2025-widgetback/releases/tag/v1.0.3p
[v1.0.2p]: https://github.com/Elux414/luci-theme-proton2025-widgetback/releases/tag/1.0.2p
[v1.0.1p]: https://github.com/Elux414/luci-theme-proton2025-widgetback/releases/tag/1.0.1p
[v1.0.0p]: https://github.com/Elux414/luci-theme-proton2025-widgetback/releases/tag/1.0.0p
[v1.4.2-r2]: https://github.com/Elux414/luci-theme-proton2025-widgetback/releases/tag/v1.4.2-r2
