# 计划：为分组中的 ETF 标的添加彩色圆点标记

## Summary

在 webview 的标的名称前添加一个蓝色小圆点，用于区分 A 股 ETF 与个股。仅 A 股 ETF 显示标记，个股及其它市场（美股/韩股/指数）不显示。检测基于代码前缀，零配置开箱即用，无需修改 symbol schema。

## Current State Analysis

- **Symbol 数据结构**（[package.json#L226-L254](file:///d:/Code/OpenSource/market-monitoring/package.json#L226-L254)）：`{ code, name, group, cost, holding }`，**无 `type` 字段**，类型隐含在 `code` 前缀中。
- **代码归一化**（[extension.js#L6546-L6586](file:///d:/Code/OpenSource/market-monitoring/src/extension.js#L6546-L6586)）：产出 `sh600519` / `sz159915` / `usAAPL` / `ks005930` / `bj899050` 等形式。`quote.code` 即归一化后的代码。
- **A 股代码判定**（[extension.js#L7325-L7327](file:///d:/Code/OpenSource/market-monitoring/src/extension.js#L7325-L7327)）：`isChinaCode` = `/^(sh|sz|bj)\d{6}$/`。
- **A 股 ETF 代码规律**（市场惯例，可靠）：
  - 上交所 ETF：`sh5[1-9]xxxx`（51x/52x/53x/55x/56x/58x 等，含跨境/黄金/科创 ETF；排除 `sh50xxxx` LOF）
  - 深交所 ETF：`sz159xxx`
  - LOF/分级（`sh501/502/506`、`sz16/150/184`）不计入 ETF，保持简洁。
- **名称单元格渲染**（[extension.js#L4810-L4823](file:///d:/Code/OpenSource/market-monitoring/src/extension.js#L4810-L4823)）：非编辑模式下 `.name` 结构为 `[holdingMarker][displayName][alertBadge]`；编辑模式只渲染可编辑文本，不显示圆点。此处为 webview 内联脚本作用域。
- **holding-dot 样式**（[extension.js#L2815-L2823](file:///d:/Code/OpenSource/market-monitoring/src/extension.js#L2815-L2823)）：4px 圆点，`color-mix(... foreground 78%, focus 22%)`，`vertical-align: 2px`。可作为 etf-dot 样式模板。
- **i18n 字典**：zh-CN 在 [extension.js#L3256](file:///d:/Code/OpenSource/market-monitoring/src/extension.js#L3256)，`moveToBottom` 在 L3283；en-US 在 [extension.js#L3346](file:///d:/Code/OpenSource/market-monitoring/src/extension.js#L3346)，`moveToBottom` 在 L3373。`t()` 取值见 [extension.js#L4049-L4051](file:///d:/Code/OpenSource/market-monitoring/src/extension.js#L4049-L4051)。
- **webview 内已有先例**：`hasHoldingQuantity` 在 webview 脚本（[extension.js#L5090-L5093](file:///d:/Code/OpenSource/market-monitoring/src/extension.js#L5090-L5093)）和扩展宿主（[extension.js#L9974-L9977](file:///d:/Code/OpenSource/market-monitoring/src/extension.js#L9974-L9977)）各有一份。因此把 `isChinaEtfCode` 直接放在 webview 脚本中是符合现有模式的局部改动，无需改动 snapshot 数据流。
- **搜索结果渲染**（[extension.js#L4708-L4713](file:///d:/Code/OpenSource/market-monitoring/src/extension.js#L4708-L4713)）：展示 `item.name` + `item.market item.code`。在此处同步加圆点，可在添加标的时预览类型，成本极低。

## 用户确认的决策

1. **视觉形式**：彩色圆点（复用 `.holding-dot` 模式）。
2. **检测范围**：仅 A 股自动检测（代码前缀判定），美股/韩股不显示标记。
3. **个股标记**：仅 ETF 显示标记，个股不显示任何标记（保持简洁）。

## Proposed Changes

所有改动集中在 `src/extension.js` 单文件。

### 1. 新增 webview 端 ETF 检测助手函数

**位置**：紧邻 [extension.js#L5090-L5093](file:///d:/Code/OpenSource/market-monitoring/src/extension.js#L5090-L5093) 的 `hasHoldingQuantity` 之后。

```js
function isChinaEtfCode(code) {
  return /^sh5[1-9]\d{4}$/.test(String(code || '')) || /^sz159\d{3}$/.test(String(code || ''));
}
```

**为什么**：webview 渲染名称时需就地判定；沿用 `hasHoldingQuantity` 的就近定义模式，避免改动 snapshot 数据流。正则排除 `sh50xxxx`（LOF）以确保只标记真正的 ETF。

### 2. 新增 i18n 键 `etfLabel`

- 在 zh-CN 字典 `moveToBottom: '置底',`（[extension.js#L3283](file:///d:/Code/OpenSource/market-monitoring/src/extension.js#L3283)）后追加：`etfLabel: 'ETF',`
- 在 en-US 字典 `moveToBottom: 'Move to bottom',`（[extension.js#L3373](file:///d:/Code/OpenSource/market-monitoring/src/extension.js#L3373)）后追加：`etfLabel: 'ETF',`

**为什么**：圆点需要 `title`/`aria-label` 悬浮提示，"ETF" 在中英文下通用，故两侧同值。

### 3. 新增 `.etf-dot` CSS 样式

**位置**：紧随 [extension.js#L2815-L2823](file:///d:/Code/OpenSource/market-monitoring/src/extension.js#L2815-L2823) `.holding-dot` 规则之后。

```css
.etf-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  margin-right: 4px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 82%, var(--vscode-foreground) 18%);
  vertical-align: 2px;
}
```

**为什么**：5px 蓝色圆点与 4px 灰色 holding-dot 在尺寸与颜色上均明显区分；使用 `--vscode-charts-blue` 主题变量以适配浅/深主题。`vertical-align` 与 holding-dot 对齐。

### 4. 在名称单元格注入 etf-dot（主显示位）

**位置**：[extension.js#L4810-L4823](file:///d:/Code/OpenSource/market-monitoring/src/extension.js#L4810-L4823) 名称列非编辑分支。

在 `holdingMarker` 定义之前插入 `etfMarker`，并将 `.name` 内部顺序改为 `[etfMarker][holdingMarker][displayName][alertBadge]`：

```js
if (column === 'name') {
  const displayName = quote.name || quote.code || '--';
  if (editing) {
    return '<div class="' + cellClass + '">' + renderEditableText({ ...quote, name: displayName }, 'name') + '</div>';
  }
  const hasAlert = Array.isArray(quote.alerts) && quote.alerts.length > 0;
  const alertText = hasAlert ? quote.alerts.map((alert) => alert.label).join(' / ') : '';
  const heldLabel = '\u6301\u6709';
  const holdingMarker = hasHoldingQuantity(quote)
    ? '<span class="holding-dot" role="img" title="' + heldLabel + '" aria-label="' + heldLabel + '"></span>'
    : '';
  const etfLabelText = t('etfLabel');
  const etfMarker = isChinaEtfCode(quote.code)
    ? '<span class="etf-dot" role="img" title="' + escapeHtml(etfLabelText) + '" aria-label="' + escapeHtml(etfLabelText) + '"></span>'
    : '';
  return '<div class="' + cellClass + '">' +
    '<div class="name" title="' + escapeHtml(displayName) + '">' + etfMarker + holdingMarker + escapeHtml(displayName) + renderAlertBadge(quote.alerts, alertText) + '</div>' +
  '</div>';
}
```

**为什么**：编辑模式不加圆点（与 holding-dot 行为一致，保持编辑单元格整洁）。ETF 同时被持有时显示两个圆点（蓝点 + 灰点），互不冲突。

### 5. 在搜索结果项同步显示 etf-dot（一致性扩展）

**位置**：[extension.js#L4710-L4712](file:///d:/Code/OpenSource/market-monitoring/src/extension.js#L4710-L4712) `renderSymbolResultsHtml` 的 `symbol-result-main` 渲染。

将 `'<span class="symbol-result-main">' + escapeHtml(item.name) + '</span>'` 改为在前注入 etf-dot：

```js
const etfDot = isChinaEtfCode(item.code)
  ? '<span class="etf-dot" role="img" title="' + escapeHtml(t('etfLabel')) + '" aria-label="' + escapeHtml(t('etfLabel')) + '"></span>'
  : '';
// ...
'<span class="symbol-result-main">' + etfDot + escapeHtml(item.name) + '</span>' +
```

**为什么**：添加标的时即可预判类型，与表格显示一致；改动量极小。（注：`renderSymbolResultsHtml` 内已有 `escapeHtml`/`t`/`isChinaEtfCode` 在同一 webview 作用域可用。）

> 同样模式亦适用于 [extension.js#L4042-L4044](file:///d:/Code/OpenSource/market-monitoring/src/extension.js#L4042-L4044) 的另一处搜索结果渲染（`symbol-result`），但该处位于 AI 助手搜索路径，非本次分组主流程，**本次不做改动**以保持范围聚焦。

## Assumptions & Decisions

- **A 股 ETF 判定正则**：`sh5[1-9]\d{4}`（排除 `sh50` LOF）+ `sz159\d{3}`。LOF/分级基金不计入 ETF，如后续需要可再扩展。
- **美股/韩股不标记**：代码无法可靠区分（`SPY` 与 `AAPL` 形式相同），按用户决策不显示标记。
- **指数不标记**：`sh000xxx`/`sz399xxx`/`bj899xxx` 不匹配 ETF 正则，自然不显示。
- **编辑模式不显示圆点**：与现有 holding-dot 行为保持一致。
- **不修改 symbol schema**：不加 `type` 字段，零配置开箱即用；保持 `package.json` 不变。
- **不改动扩展宿主逻辑**：检测函数与渲染均位于 webview 脚本内，沿用 `hasHoldingQuantity` 的双份定义先例。
- **颜色选择**：蓝色 `--vscode-charts-blue`，与 holding-dot 灰色形成清晰对比，且为 VS Code 主题感知变量。

## Verification

1. `npm run check`（即 `node --check src/extension.js`）确认语法无误。
2. 在 VS Code 中按 `F5` 启动扩展开发宿主：
   - 确认已配置 A 股 ETF（如 `sh510300`、`sz159915`）名称前出现蓝色圆点，悬浮显示 "ETF"。
   - 确认 A 股个股（如 `sh600519`）名称前无蓝点。
   - 确认 LOF（如 `sh501xxx`）不显示蓝点（验证正则排除）。
   - 确认美股（如 `usAAPL`）/韩股不显示蓝点。
   - 确认 ETF 同时设置 holding 时，蓝点与灰色 holding-dot 并存且对齐。
   - 进入编辑模式，确认名称单元格不显示圆点（与 holding-dot 一致）。
   - 在「添加标的」搜索结果中，ETF 项名称前应同样出现蓝点。
3. 切换浅色/深色主题，确认蓝点颜色均清晰可辨。
4. 按 AGENTS.md 规范执行 `npm run package`，产物为 `release/market-monitoring-0.4.8.vsix`。
