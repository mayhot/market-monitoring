# Changelog

All notable changes to this extension are documented in this file.

## Release Notes Policy

- Update this file whenever the extension version changes.
- Add the newest version at the top.
- Keep entries grouped as Added, Changed, Fixed, and Removed when applicable.

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
