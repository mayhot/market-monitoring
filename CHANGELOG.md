# Changelog

All notable changes to this extension are documented in this file.

## Release Notes Policy

- Update this file whenever the extension version changes.
- Add the newest version at the top.
- Keep entries grouped as Added, Changed, Fixed, and Removed when applicable.

## [0.4.1] - 2026-07-17

### Fixed

- 修复开盘时间行情不自动刷新的根因。webview 的瞬时编辑态（`editingGroups`/`addingGroups`）被持久化到 `vscode.getState()` 与 SQLite，并在下次启动时恢复；若上次会话遗留了 `true` 标志，webview 初始化即上报 `editing:true`，使扩展端 `editingRefreshPaused` 恒为真，`schedule()` 不再设定时器、`refresh(false)` 全部被跳过，自动刷新永久停摆（手动 `refresh(true)` 因 `force` 跳过暂停检查故仍可用）。现在这些瞬时态不再被持久化或恢复，webview 每次启动均以非编辑态开始。
- 加固自动刷新调度链的健壮性。`schedule()` 的定时回调现会捕获 `refresh(false)` 的 rejection 并重新调度；`refresh` 跳过分支中的告警/宽度评估改用 `try/catch` 包裹，保证 `schedule()` 执行，避免单次异步抛错中断调度链。

### Changed

- Bumped the extension version from `0.4.0` to `0.4.1`.

## [0.4.0] - 2026-07-16

### Removed

- Removed the daily profit bar (the row showing the total "today profit" summed across all groups) above the index dock in the market panel, along with the `marketMonitoring.showGroupDailyProfitBar` config option. The per-group `dailyProfit` / `dailyProfitPercent` summary metrics are still available via `groupSummaryMetrics`.
- Removed the refresh phase info bar (the row showing "Not started" / "Refreshing · Trading · <time>" etc.) above the index dock in the market panel. The refresh animation on the view title button and the refresh error status in the footer left cell are unchanged.

### Changed

- Bumped the extension version from `0.3.14` to `0.4.0`.

## [0.3.14] - 2026-07-16

### Added

- The view title refresh button now shows a spinning animation while a refresh is in progress. A `marketMonitoring.refreshing` command with a `$(refresh~spin)` icon is toggled via a `marketMonitoring.isRefreshing` context key during refresh start/end.
- New `marketMonitoring.indexSymbol` setting (enum: 中证全指/上证指数/深证成指/创业板指/科创50/北证50, default 上证指数) that selects which index is shown in the footer index dock. The previously user-selectable index dropdown was removed in favor of this configuration.
- Moved full-market rising, falling, and flat stock counts from the footer left status cell into the footer index quote tooltip; the footer left cell now only shows refresh errors.
- Added an Eastmoney `clist` fallback source for full-market breadth counts.

### Fixed

- Clicking the refresh button in the view title bar now always performs a refresh, regardless of pause state (view hidden/collapsed, editing, or configuration in progress). Previously a `force` refresh could be skipped when `isRefreshPaused()` was true; now only `notRunning` and `alreadyRefreshing` remain as skip conditions. The same fix applies to the market breadth refresh path.
- Fixed the AI assistant button remaining visible despite having the `hidden` attribute. The `.icon-button` CSS `display: inline-flex` was overriding the browser's default `[hidden] { display: none }` behavior; added a global `[hidden] { display: none !important }` rule.

### Changed

- Bumped the extension version from `0.3.13` to `0.3.14`.

## [0.3.13] - 2026-07-15

### Fixed

- Fixed the market panel failing to render (groups not shown, start button unresponsive) after installing 0.3.12. The `renderDailyProfitBar` webview function used `'\n'` inside the `getHtml` template literal, which was interpreted as a real newline and broke the embedded webview JavaScript. Changed to `'\\n'` to match the existing convention.

### Changed

- Bumped the extension version from `0.3.12` to `0.3.13`.

## [0.3.12] - 2026-07-15

### Changed

- Reworked the group daily profit display from a VS Code status bar item into a dedicated bar above the index dock in the market panel; renamed the config from `marketMonitoring.showGroupDailyProfitStatusBar` to `marketMonitoring.showGroupDailyProfitBar`.
- Bumped the extension version from `0.3.11` to `0.3.12`.

## [0.3.11] - 2026-07-15

### Added

- New optional VS Code status bar item showing the total daily profit (sum of change × holding across all groups) of all groups, controlled by `marketMonitoring.showGroupDailyProfitStatusBar` (default off); hover to view the per-group breakdown.

### Removed

- Disabled the AI assistant entry: removed the `marketMonitoring.openAiAssistant` command, its activation event, the view title and command palette menu entries, and hid the webview AI button so the entry is no longer visible regardless of the `ai.enabled` setting. The `ai.*` configuration options are retained for backward compatibility.

### Changed

- Bumped the extension version from `0.3.10` to `0.3.11`.

## [0.3.10] - 2026-07-14

### Fixed

- `defaultMonitoringIndicators` configuration schema now includes `expmaDeviation` in its default value and enum list so the VS Code settings UI correctly shows all four default indicators.

### Changed

- Bumped the extension version from `0.3.9` to `0.3.10`.

## [0.3.9] - 2026-07-14

### Added

- `expmaDeviation` is now enabled by default in `defaultMonitoringIndicators`; all held positions automatically receive EXPMA deviation alerts (E13, 4% threshold by default).

### Fixed

- `movingAverageS` (S alert) badge tooltip now shows the actual price-to-MA deviation percentage instead of the configured threshold value.

### Changed

- Bumped the extension version from `0.3.8` to `0.3.9`.

## [0.3.8] - 2026-07-14

### Changed

- EXPMA deviation E13 badge color now dynamically intensifies with deviation magnitude: deeper and brighter as the deviation ratio (actual deviation / configured threshold) increases, capped at 2x the threshold for maximum saturation.
- Bumped the extension version from `0.3.7` to `0.3.8`.

## [0.3.7] - 2026-07-08

### Fixed

- Paused all quote and market breadth refreshes while the VS Code Market Monitoring view is hidden or collapsed, then resumed refresh scheduling when the view becomes visible again.

### Changed

- Bumped the extension version from `0.3.6` to `0.3.7`.

## [0.3.6] - 2026-07-06

### Changed

- Changed the default EXPMA deviation window and quote-row badge from `E12` to `E13`.
- Bumped the extension version from `0.3.5` to `0.3.6`.

## [0.3.5] - 2026-07-06

### Added

- Added configurable default monitoring indicators for held symbols through `marketMonitoring.defaultMonitoringIndicators`.
- Added a group delete action in edit mode, with confirmation before removing the group and all symbols inside it.

### Changed

- Changed automatic default monitoring indicators and the SQLite monitored-symbol pool to include only symbols with `holding > 0`, while keeping explicit `marketMonitoring.alerts` rules active.
- Bumped the extension version from `0.3.4` to `0.3.5`.

## [0.3.4] - 2026-07-03

### Added

- Added configurable EXPMA deviation alerts with `E12` quote-row badges and up/down direction arrows.

### Changed

- Bumped the extension version from `0.3.3` to `0.3.4`.

## [0.3.3] - 2026-07-01

### Fixed

- Fixed the quote view failing to render after adding group summary drawdown tooltips.

### Changed

- Bumped the extension version from `0.3.2` to `0.3.3`.

## [0.3.2] - 2026-07-01

### Added

- Added tiered price decimal-place settings with a configurable price threshold.
- Added an optional group summary drawdown marker for total assets falling from the current high by a configurable threshold.

### Changed

- Bumped the extension version from `0.3.1` to `0.3.2`.

## [0.3.1] - 2026-06-29

### Added

- Added United States and Korea symbol support through Yahoo Finance search, quote, and daily K-line data.
- Added diagnostics logs for symbol search, symbol addition, refresh decisions, quote provider details, and malformed SQLite cache recovery.

### Changed

- Bumped the extension version from `0.2.20` to `0.3.1`.
- Route quote and direct-code search requests by market so China symbols use China data providers and US/Korea symbols use Yahoo Finance only.

### Fixed

- Fixed overseas symbols such as `000660.KS` being treated as empty rows when cached quotes were missing or unusable.
- Clarified the group summary row label so it is not mistaken for an empty symbol row.
- Allowed direct symbol-code entry such as `000660.KS` from the add-symbol box without selecting a search result first.
- Recreate malformed SQLite cache files automatically after backing them up.

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
