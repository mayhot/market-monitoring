# Changelog

All notable changes to this extension are documented in this file.

## Release Notes Policy

- Update this file whenever the extension version changes.
- Add the newest version at the top.
- Keep entries grouped as Added, Changed, Fixed, and Removed when applicable.

## [0.2.20] - 2026-06-29

### Added

- Added configurable `movingAverageS` alerts for prices falling below an N-day moving average by a configured downside offset.

### Changed

- Bumped the extension version from `0.2.19` to `0.2.20`.

## [0.2.19] - 2026-06-26

### Added

- Added a small solid marker before held symbol names in the quote view, while leaving watch-only symbols unmarked.

### Changed

- Bumped the extension version from `0.2.18` to `0.2.19`.

## [0.2.18] - 2026-06-24

### Added

- Added a configurable full-market breadth refresh interval, defaulting to 5 minutes.

### Changed

- Bumped the extension version from `0.2.17` to `0.2.18`.
- Reused the index footer's left status area for full-market breadth counts, with refresh messages taking priority.

## [0.2.17] - 2026-06-22

### Changed

- Bumped the extension version from `0.2.16` to `0.2.17`.

### Fixed

- Aligned the full-market breadth label and rising/falling counts with the configured quote color palette.

## [0.2.16] - 2026-06-22

### Changed

- Removed the inline quote-view sort hint from the webview and documented the configured-order behavior in README instead.
- Bumped the extension version from `0.2.15` to `0.2.16`.

## [0.2.15] - 2026-06-22

### Added

- Added configurable full-market breadth counts in the quote view footer, showing rising, falling, and flat stock counts above the index selector.
- Added direct aggregate market breadth providers with retries, using Eastmoney first and Tonghuashun as a fallback.

### Changed

- Bumped the extension version from `0.2.14` to `0.2.15`.

### Fixed

- Escaped market breadth tooltip newlines so the webview script remains valid.

## [0.2.14] - 2026-06-22

### Added

- Added the `marketValue` table column, calculated from latest price multiplied by holding quantity.

### Changed

- Bumped the extension version from `0.2.13` to `0.2.14`.
- Changed the default quote sorting to order symbols with calculable holdings by market value while keeping other symbols in configured order.

## [0.2.13] - 2026-06-17

### Added

- Added `movingAverageHoldBelow` alerts for close-confirmed "失守 N 日线" checks.
- Added explicit `movingAverageAbove` alerts for intraday "站上 N 日线" cross-up checks and `movingAverageHoldAbove` alerts for close-confirmed "站稳 N 日线" checks, both with separate red moving-average badges.

### Changed

- Bumped the extension version from `0.2.12` to `0.2.13`.
- Changed `movingAverageBelow` to use intraday "跌破 N 日线" cross-down checks.

## [0.2.12] - 2026-06-15

### Changed

- Bumped the extension version from `0.2.11` to `0.2.12`.
- Allow the same symbol to be added to multiple groups while still preventing duplicates inside the same group.
- Updated the SQLite monitored symbol cache to key configured symbols by code and group.

## [0.2.11] - 2026-06-12

### Changed

- Bumped the extension version from `0.2.10` to `0.2.11`.

### Fixed

- Restored quote row change columns to display the symbol's intraday change and change percentage relative to previous close.
- Kept expanded groups from showing stale zero change values after they were collapsed while group-level quote snapshots continued refreshing.

## [0.2.10] - 2026-06-11

### Added

- Added SQLite persistence for market view state, including the selected index, collapsed groups, per-group table sorting, column widths, and AI panel draft state.

### Changed

- Bumped the extension version from `0.2.9` to `0.2.10`.

### Fixed

- Fell back to the latest SQLite quote snapshot when live quote refresh fails so cached market data remains available offline.

## [0.2.9] - 2026-06-11

### Changed

- Bumped the extension version from `0.2.8` to `0.2.9`.
- Changed quote rows to display minute-level change values while keeping group title rise/fall counts on the intraday previous-close basis.

### Fixed

- Prevented one-off minute price jumps from immediately flipping quote row rise/fall direction by requiring same-direction minute slope confirmation.

## [0.2.8] - 2026-06-11

### Changed

- Bumped the extension version from `0.2.7` to `0.2.8`.
- Changed moving-average alert badge colors to an independent severity scale for 5, 10, 20, and 60 day alerts.

## [0.2.7] - 2026-06-11

### Changed

- Bumped the extension version from `0.2.6` to `0.2.7`.

### Fixed

- Allowed alert badges and rising/falling direction badges to display together in quote rows.

## [0.2.6] - 2026-06-09

### Changed

- Bumped the extension version from `0.2.5` to `0.2.6`.

### Fixed

- Kept collapsed group quote rows from refreshing while still updating the group rise/fall counts.
- Paused all quote refreshes while editing groups, editing group symbols, or changing quote-column configuration, then resumed with a deferred refresh after editing ends.

## [0.2.5] - 2026-06-05

### Added

- Added default intraday high-pullback alerts for configured symbols.
- Added intraday downtrend confirmation using realtime VWAP, recent refresh-price slope, and consecutive confirmation ticks.
- Added alert evaluation logs with rule-type summaries for easier diagnostics.

### Changed

- Bumped the extension version from `0.2.4` to `0.2.5`.
- Kept intraday high-pullback alerts visible after close by evaluating cached closing snapshots without requiring live tick confirmation.
- Used realtime quote open/high/VWAP fields for intraday pullback checks instead of requiring daily K-line history.
- Changed the intraday high-pullback badge to a lighter downward arrow.
- Limited and summarized K-line alert data request failures to reduce noisy logs.

### Fixed

- Evaluated alert rules against cached snapshots when refreshes are skipped outside trading hours.
- Prevented overlapping alert evaluations for the same cached quote snapshot.
- Forced a realtime quote refresh when cached quotes are missing fields required by intraday alert rules.

## [0.2.4] - 2026-06-05

### Changed

- Bumped the extension version from `0.2.3` to `0.2.4`.
- Changed in-panel alert badges from an exclamation marker to a compact alarm-style icon.
- Tightened quote rows and group summary spacing for a denser group list.

## [0.2.3] - 2026-06-04

### Changed

- Bumped the extension version from `0.2.2` to `0.2.3`.
- Moved group rise/fall counts next to the group name and tightened group header action buttons.
- Aligned group rise/fall count colors and quote change colors with the configured Color Mode.
- Shortened row highlight bars to 61.8% of the quote row height.

## [0.2.2] - 2026-06-03

### Changed

- Bumped the extension version from `0.2.1` to `0.2.2`.
- Disabled VS Code alert popup notifications by default while keeping in-panel alert markers and status bar counts active.

### Fixed

- Limited enabled VS Code alert popup notifications to one notification per symbol per Shanghai trading day.

## [0.2.1] - 2026-06-02

### Changed

- Bumped the extension version from `0.2.0` to `0.2.1`.

### Fixed

- Kept the bottom index dock anchored below the scrollable group list when a group contains many symbols.

## [0.2.0] - 2026-06-02

### Added

- Added default MA20 downside alerts for all configured symbols when quote alerts are enabled.
- Added configurable moving-average downside alerts with custom `movingAverageDays`.
- Added trend-risk alert indicators for bearish moving-average alignment, MACD death crosses, volume-backed drops, low-volume rebounds, recent-low breakdowns, RSI weakness, and Bollinger band breakdowns.
- Added daily K-line fetching and in-session caching for technical alert evaluation.

### Changed

- Bumped the extension version from `0.1.9` to `0.2.0`.
- Extended alert settings schema and README examples for the new technical indicators.

## [0.1.9] - 2026-06-02

### Added

- Added an optional AI assistant entry for natural-language group and symbol management.
- Added AI provider settings for OpenAI-compatible, Azure OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, Ollama, LM Studio, and custom endpoints.
- Added `Market Monitoring: Configure Quote Columns` for ordering, showing, and hiding quote table columns through VS Code commands.

### Changed

- Bumped the extension version from `0.1.8` to `0.1.9`.
- Moved quote column and language configuration guidance toward VS Code Settings and command-based configuration.

## [0.1.8] - 2026-05-29

### Changed

- Bumped the extension version from `0.1.7` to `0.1.8`.
- Kept group edit and add actions available in the sticky group header for long symbol lists.
- Moved group rename and symbol search panels below the group header so they remain accessible while scrolling.

## [0.1.7] - 2026-05-28

### Added

- Added the `position` table column, calculated from each symbol's market value within its group.
- Included `position` in table column configuration, sorting, and CSV export.

### Changed

- Bumped the extension version from `0.1.6` to `0.1.7`.
- Recalculate position, net profit, and group summaries immediately after editable holdings change.
- Trim trailing zeros from signed decimal displays so change values follow the same formatting as other decimal columns.

## [0.1.6] - 2026-05-28

### Fixed

- Improved quote refresh diagnostics and provider timing logs.
- Preserved the last valid quote snapshot when refreshes fail or timeout.
- Moved refresh errors into the bottom status bar and kept index information visible.
- Improved amount readability with thousands separators.

## [0.1.5] - 2026-05-28

### Added

- Added a setting to control whether large amounts are compacted with the `W` unit.

### Changed

- Changed group refresh feedback to flash the group name after a successful refresh instead of flashing individual symbol rows.

## [0.1.4] - 2026-05-28

### Fixed

- Right-aligned a single visible group summary metric.

## [0.1.3] - 2026-05-28

### Added

- Added configurable visibility for group summary metrics.

## [0.1.2] - 2026-05-28

### Added

- Added Chinese and English UI language switching.

## [0.1.1] - 2026-05-27

### Added

- Added alias column support backed by pinyin conversion.
- Added CSV import and export improvements.
- Included the pinyin runtime dependency in packaged VSIX output.

## [0.1.0] - 2026-05-27

### Added

- Initial market monitoring extension release.
