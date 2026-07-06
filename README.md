# Market Monitoring

一个用于 VS Code 的市场行情监控扩展，支持自定义标的、分组、排序、预警和状态栏摘要。

## 功能

- 自定义分组，默认包含“自选”，用户在具体分组底部搜索并添加标的。
- 新增标的支持按名称、简称、拼音、拼音首字母或代码搜索后选择。
- 同一标的可添加到多个分组；仅同一分组内会跳过重复标的。
- 分组支持折叠和展开。
- 在行情面板中添加标的，并通过分组标题的编辑按钮修改分组名称、删除分组及组内标的、上移、下移或删除标的。
- 支持中文、英文界面切换，也可跟随 VS Code 显示语言。
- 涨跌颜色模式可配置，默认无颜色。
- 支持按涨跌幅阈值给标的行添加低调的左侧色带标识。
- 自定义价格小数位。
- 标的表格列可配置，支持名称、别名、代码、价格、涨跌幅、涨跌额、成本、持仓、市值、仓位、净收益额。
- 表格列默认均分，最小宽度为 20px，支持拖动列名右侧边缘调整列宽。
- 成本和持仓可在表格中输入并修改，净收益额自动计算。
- 分组末尾展示当前总资产，并在填写成本和持仓后汇总今日收益。
- 支持从 CSV 导入标的，自动创建缺失分组，并跳过无效或同一分组内已存在的标的。
- 支持导出 CSV，包含所有标的列和分组末尾汇总数据。
- 表格支持点击列名排序，升序、降序、恢复默认三态切换。
- 分组统计上涨、下跌、平盘数量。
- 支持按配置顺序、涨跌幅、价格、名称、别名、代码排序。
- 支持价格和涨跌幅预警。
- 底部右下角提供指数下拉切换。
- Activity Bar 独立行情视图。
- 支持手动刷新、启动、暂停。

## 配置示例

在 VS Code `settings.json` 中配置：

```json
{
  "marketMonitoring.symbols": [
    {
      "code": "sz300308",
      "name": "中际旭创",
      "group": "观察"
    },
    {
      "code": "sh603986",
      "name": "兆易创新",
      "group": "自选"
    },
    {
      "code": "AAPL",
      "name": "Apple",
      "group": "美股"
    },
    {
      "code": "005930.KS",
      "name": "Samsung Electronics",
      "group": "韩股"
    }
  ],
  "marketMonitoring.groups": [
    "自选",
    "观察",
    "美股",
    "韩股"
  ],
  "marketMonitoring.sortBy": "changePercent",
  "marketMonitoring.sortDirection": "desc",
  "marketMonitoring.quoteColumns": [
    "name",
    "price",
    "changePercent"
  ],
  "marketMonitoring.groupSummaryMetrics": [],
  "marketMonitoring.priceDecimalPlaces": {
    "threshold": 10,
    "belowThreshold": 3,
    "fromThreshold": 2
  },
  "marketMonitoring.compactLargeAmounts": false,
  "marketMonitoring.enableGroupSummaryDrawdownAlert": false,
  "marketMonitoring.groupSummaryDrawdownThresholdPercent": 20,
  "marketMonitoring.showMarketBreadth": true,
  "marketMonitoring.marketBreadthRefreshIntervalSeconds": 300,
  "marketMonitoring.language": "auto",
  "marketMonitoring.colorMode": "none",
  "marketMonitoring.rowHighlightUpPercent": 5,
  "marketMonitoring.rowHighlightDownPercent": 5,
  "marketMonitoring.defaultMonitoringIndicators": [
    "movingAverageBelow",
    "movingAverageS",
    "intradayHighPullback"
  ],
  "marketMonitoring.refreshIntervalSeconds": 5,
  "marketMonitoring.onlyDuringTradingTime": true
}
```

当前数据源支持的常见代码格式包括：

- `sh600519`
- `sz000001`
- `600519`
- `510300`
- `159915`
- `600519.SH`
- `AAPL`
- `US:AAPL`
- `NASDAQ:MSFT`
- `BRK.B.US`
- `005930.KS`
- `035720.KQ`
- `ks005930`
- `kq035720`

无交易所前缀时，6 位数字会按 A 股规则自动推断，纯字母/美股 ticker 会按美股规则自动推断；韩国标的需要使用 `.KS`、`.KQ`、`ks` 或 `kq` 标明市场。

美股和韩股搜索使用 Yahoo Finance 数据源，通常支持英文名称和代码搜索，但不保证支持中文名称搜索。例如搜索 `SK hynix`、`000660.KS` 或 `ks000660` 可以添加海力士，直接搜索 `海力士` 可能无法返回结果。

## 预警配置

`marketMonitoring.alerts` 支持价格和涨跌幅阈值。一个规则可以同时配置多个阈值：

```json
{
  "marketMonitoring.alerts": [
    {
      "code": "sz300308",
      "name": "中际旭创",
      "changePercentAbove": 1.2,
      "changePercentBelow": -1.0
    },
    {
      "code": "sh603986",
      "name": "兆易创新",
      "priceAbove": 180,
      "priceBelow": 160
    },
    {
      "code": "sh600519",
      "name": "MA example",
      "movingAverageDays": [5, 10, 20, 60, 120],
      "movingAverageSDays": 20,
      "movingAverageSOffsetPercent": 4,
      "movingAverageHoldBelow": true,
      "movingAverageHoldBelowDays": [5, 10, 20, 60, 120]
    },
    {
      "code": "sh601318",
      "name": "MA support example",
      "movingAverageBelow": false,
      "movingAverageAbove": true,
      "movingAverageAboveDays": [5, 10, 20, 60, 120],
      "movingAverageHoldAbove": true,
      "movingAverageHoldAboveDays": [5, 10, 20, 60, 120]
    },
    {
      "code": "sh600519",
      "name": "EXPMA example",
      "movingAverageBelow": false,
      "movingAverageS": false,
      "expmaDeviation": true,
      "expmaDays": 13,
      "expmaDeviationAbovePercent": 4,
      "expmaDeviationBelowPercent": 4
    },
    {
      "code": "sz000001",
      "name": "trend risk example",
      "bearishMovingAverage": true,
      "macdDeathCross": true,
      "macdBelowZeroOnly": true,
      "volumeDrop": true,
      "volumeDropPercent": 2,
      "volumeDropMultiplier": 1.5,
      "reboundLowVolume": true,
      "reboundLowVolumeRatio": 0.8,
      "lowBreakDays": 20,
      "rsiWeak": true,
      "rsiBelow": 50,
      "bollingerBelow": "middle",
      "intradayHighPullback": true,
      "intradayHighPullbackPercent": 2,
      "intradayDowntrendConfirmTicks": 3,
      "intradayDowntrendSlopePoints": 5,
      "intradayVwapBelow": true
    }
  ],
  "marketMonitoring.enableAlerts": true,
  "marketMonitoring.enableAlertNotifications": false
}
```

When `marketMonitoring.enableAlerts` is enabled, symbols with `holding > 0` get the default monitoring indicators configured by `marketMonitoring.defaultMonitoringIndicators`. The default value is `["movingAverageBelow", "movingAverageS", "intradayHighPullback"]`; use an empty array to disable automatic default indicators. Symbols without a valid holding do not show these default monitoring indicators and are not added to the SQLite monitored-symbol pool by default. Explicit rules in `marketMonitoring.alerts` still run even when the symbol has no holding.

`movingAverageBelow` adds default `movingAverageBelow: true` alerts with `movingAverageDays: [5, 10, 20, 60, 120]`, and `movingAverageS` adds default `movingAverageS: true` alerts with `movingAverageSDays: 20` and `movingAverageSOffsetPercent: 4`. `movingAverageBelow` now means an intraday "跌破 N 日线" cross-down alert: the previous close was greater than or equal to the previous N-day moving average and the latest price is less than the current N-day moving average. Add an explicit alert rule with `movingAverageBelow: false` or `movingAverageS: false` to disable those moving-average alerts for a symbol.

`movingAverageS` triggers an "S预警" when the latest price is less than or equal to `MA(N) * (1 - X / 100)`. Use `movingAverageSDays` to configure N, and `movingAverageSOffsetPercent` to configure X.

`expmaDeviation` triggers an EXPMA deviation alert when the latest price is at least `expmaDeviationAbovePercent` above `EXPMA(expmaDays)` or at least `expmaDeviationBelowPercent` below it. The default EXPMA window is `13`, both default thresholds are `4`, and the quote row badge shows `E13` plus an up or down arrow.

Set `movingAverageHoldBelow: true` for close-confirmed "失守 N 日线" alerts using the same cross-down condition after market close. This downside confirmation alert is disabled by default; use `movingAverageHoldBelowDays` to choose its windows.

Set `movingAverageAbove: true` to trigger intraday "站上 N 日线" alerts when the previous close was below the previous N-day moving average and the latest price is greater than or equal to the current N-day moving average. Set `movingAverageHoldAbove: true` for close-confirmed "站稳 N 日线" alerts using the same cross-up condition after market close. These upside moving-average alerts are disabled by default; use `movingAverageAboveDays` or `movingAverageHoldAboveDays` to choose their windows. If downside and upside moving-average alerts are both active for a symbol, the panel shows separate green downside and red upside badges.

`intradayHighPullback` 会在标的当日最高价高于开盘价、当前涨跌幅转为负值，且从当日最高点回落幅度超过 `intradayHighPullbackPercent` 时触发。盘中会结合实时分时 VWAP（可用时）、最近刷新价格斜率和 `intradayDowntrendConfirmTicks` 连续确认来判断分时下跌趋势；收盘后会按当日日 K 收盘价继续展示预警。

预警触发后会：

- 默认不在 VS Code 右下角弹出通知；如需弹窗，将 `marketMonitoring.enableAlertNotifications` 设为 `true`。
- 在行情面板中给对应标的加预警标记。
- 在状态栏显示预警数量。

开启通知后，同一个标的每天最多弹出一次右下角通知；行情面板预警标记和状态栏预警数量仍会实时更新。

## 排序配置

行情面板里的上移、下移会调整 `marketMonitoring.symbols` 的配置顺序。每个分组底部提供添加标的和修改按钮；上移、下移、删除按钮默认隐藏，点击分组底部的修改按钮后显示。默认按持仓标的的市值排序，只有能根据实时价格和持仓数量计算出市值的标的参与市值排序，其余标的保持配置顺序并跟在后面。

当 `marketMonitoring.sortBy` 使用 `marketValue`、`changePercent`、`price`、`name`、`alias` 或 `code` 时，行情面板会按对应字段自动排序；上移、下移仍然只调整配置顺序。只有 `sortBy` 设为 `configured` 时，面板才严格按手动配置顺序展示。该说明保留在 README 和 CHANGELOG 中，插件界面不再展示额外提示文字。若希望面板严格按手动顺序展示，请使用：

```json
{
  "marketMonitoring.sortBy": "configured"
}
```

`marketMonitoring.sortBy` 可选值：

- `configured`：保持 `marketMonitoring.symbols` 中的配置顺序。
- `marketValue`：按市值排序，仅对有持仓且能计算市值的标的生效，其余标的保持配置顺序。
- `changePercent`：按涨跌幅排序。
- `price`：按最新价排序。
- `name`：按展示名称排序。
- `alias`：按拼音别名排序。
- `code`：按代码排序。

`marketMonitoring.sortDirection` 可选 `desc` 或 `asc`。

表格列名也支持点击排序：第一次点击升序，第二次点击降序，第三次恢复默认顺序。当前排序方向会显示在列名旁边。

## 价格小数位

`marketMonitoring.priceDecimalPlaces` 控制标的和指数价格的小数位数。默认按金额分档：绝对值低于 `10` 时显示 `3` 位小数，大于等于 `10` 时显示 `2` 位小数。

```json
{
  "marketMonitoring.priceDecimalPlaces": {
    "threshold": 10,
    "belowThreshold": 3,
    "fromThreshold": 2
  }
}
```

`threshold` 可自定义分档金额；`belowThreshold` 和 `fromThreshold` 支持 `0-6`。旧版数字配置仍可使用，例如 `2` 表示所有价格都按 `2` 位小数显示。

`marketMonitoring.compactLargeAmounts` 控制超过 `10000` 的金额是否以 `W` 为单位展示，默认 `false`，即展示完整数值。开启后会影响分组汇总和导出 CSV 中的汇总金额。

`marketMonitoring.enableGroupSummaryDrawdownAlert` 控制是否在分组总资产从当前运行期间最高点下跌超过阈值时显示回撤标记，默认 `false`。开启后，`marketMonitoring.groupSummaryDrawdownThresholdPercent` 控制下跌阈值，默认 `20`，即超过 `20%` 时在总资产右侧显示向下箭头和最高点下跌比例。

## 语言切换

`marketMonitoring.language` 控制行情面板显示语言，默认 `auto`，会跟随 VS Code 显示语言。可选值为 `auto`、`zh-CN`、`en-US`。请在 VS Code Settings 或 `settings.json` 中修改。

## 涨跌颜色

`marketMonitoring.colorMode` 控制涨跌指标颜色，默认 `none`。

可选值：

- `none`：无颜色，涨跌指标使用普通文字颜色。
- `redUpGreenDown`：上涨红、下跌绿。
- `greenUpRedDown`：上涨绿、下跌红。

## 行阈值标识

`marketMonitoring.rowHighlightUpPercent` 和 `marketMonitoring.rowHighlightDownPercent` 控制标的行左侧色带阈值，默认均为 `5`。下跌阈值使用正数，例如 `5` 表示涨跌幅 `<= -5%` 时标识；设置为 `0` 可关闭对应方向的行标识。

## 表格列配置

`marketMonitoring.quoteColumns` 控制标的表格展示哪些列，默认：

```json
{
  "marketMonitoring.quoteColumns": [
    "name",
    "price",
    "changePercent"
  ]
}
```

请在 VS Code Settings 或 `settings.json` 中修改该配置。数组顺序即表格列展示顺序。也可以运行 `Market Monitoring: Configure Quote Columns`，用上移、下移、隐藏和添加操作调整同一个配置项。

例如下面配置会按“名称、代码、价格、涨跌幅、持仓、市值、净收益额”的顺序展示：

```json
{
  "marketMonitoring.quoteColumns": [
    "name",
    "code",
    "price",
    "changePercent",
    "holding",
    "marketValue",
    "netProfit"
  ]
}
```

可选列：

- `name`：名称。
- `alias`：别名，按名称自动转换为拼音，拼音之间用 `'` 分隔。
- `code`：代码。
- `price`：价格。
- `changePercent`：涨跌幅。
- `change`：涨跌额。
- `cost`：成本，可在表格中编辑。
- `holding`：持仓，可在表格中编辑。
- `marketValue`：市值，按 `当前价 * 持仓` 自动计算，仅在填写持仓且有有效价格时展示。
- `position`：仓位，按当前标的市值占所在分组可计算总市值的比例自动计算，仅在填写持仓且有有效价格时展示。
- `netProfit`：净收益额，按 `(当前价 - 成本) * 持仓` 自动计算。

## 指数切换

行情面板底部右下角提供指数下拉列表，默认显示主指数。指数行情由扩展自动拉取，不需要添加到 `marketMonitoring.symbols`。

## 刷新时段

默认仅在内置活跃交易时段刷新。非交易时段会在缺少本地行情快照时拉取一次最新行情，并会在 15:00 后补拉一次收盘行情，用于显示收盘后的价格和预警；之后不会按高频间隔持续刷新。节假日不会自动识别。如果需要全天刷新，可将 `marketMonitoring.onlyDuringTradingTime` 设为 `false`。

行情数据优先来自新浪财经公开行情接口，失败后会自动切换到腾讯行情接口。扩展会在本机 VS Code 进程中直接请求接口。默认请求超时为 10 秒，可通过 `marketMonitoring.requestTimeoutMs` 调整。

## 开发

```bash
npm install
npm run check
```

然后在 VS Code 中按 F5 启动扩展开发宿主。

调试配置默认带有 `--disable-extensions`，这样 Extension Development Host 只加载当前开发中的扩展，避免其他本机扩展的日志干扰排查。

## 打包

```bash
npm install
npm run package
```
