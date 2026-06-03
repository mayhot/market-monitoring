# Market Monitoring

一个用于 VS Code 的市场行情监控扩展，支持自定义标的、分组、排序、预警和状态栏摘要。

## 功能

- 自定义分组，默认包含“自选”，用户在具体分组底部搜索并添加标的。
- 新增标的支持按名称、简称、拼音、拼音首字母或代码搜索后选择。
- 分组支持折叠和展开。
- 在行情面板中添加标的，并通过分组标题的编辑按钮修改名称、删除、上移、下移标的。
- 支持中文、英文界面切换，也可跟随 VS Code 显示语言。
- 涨跌颜色模式可配置，默认无颜色。
- 支持按涨跌幅阈值给标的行添加低调的左侧色带标识。
- 自定义价格小数位。
- 标的表格列可配置，支持名称、别名、代码、价格、涨跌幅、涨跌额、成本、持仓、净收益额。
- 表格列默认均分，最小宽度为 20px，支持拖动列名右侧边缘调整列宽。
- 成本和持仓可在表格中输入并修改，净收益额自动计算。
- 分组末尾展示当前总资产，并在填写成本和持仓后汇总今日收益。
- 支持从 CSV 导入标的，自动创建缺失分组，并跳过无效或已存在标的。
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
    }
  ],
  "marketMonitoring.groups": [
    "自选",
    "观察"
  ],
  "marketMonitoring.sortBy": "changePercent",
  "marketMonitoring.sortDirection": "desc",
  "marketMonitoring.quoteColumns": [
    "name",
    "price",
    "changePercent"
  ],
  "marketMonitoring.groupSummaryMetrics": [],
  "marketMonitoring.priceDecimalPlaces": 2,
  "marketMonitoring.compactLargeAmounts": false,
  "marketMonitoring.language": "auto",
  "marketMonitoring.colorMode": "none",
  "marketMonitoring.rowHighlightUpPercent": 5,
  "marketMonitoring.rowHighlightDownPercent": 5,
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

无交易所前缀时会按当前数据源的常见代码规则自动推断。

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
      "name": "MA20 example",
      "movingAverageDays": 20
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
      "bollingerBelow": "middle"
    }
  ],
  "marketMonitoring.enableAlerts": true,
  "marketMonitoring.enableAlertNotifications": false
}
```

When `marketMonitoring.enableAlerts` is enabled, every configured symbol gets a default `movingAverageBelow: true` alert with `movingAverageDays: 20`. Add an explicit alert rule with `movingAverageBelow: false` to disable it for a symbol.

预警触发后会：

- 默认不在 VS Code 右下角弹出通知；如需弹窗，将 `marketMonitoring.enableAlertNotifications` 设为 `true`。
- 在行情面板中给对应标的加预警标记。
- 在状态栏显示预警数量。

开启通知后，同一个标的每天最多弹出一次右下角通知；行情面板预警标记和状态栏预警数量仍会实时更新。

## 排序配置

行情面板里的上移、下移会调整 `marketMonitoring.symbols` 的配置顺序。每个分组底部提供添加标的和修改按钮；上移、下移、删除按钮默认隐藏，点击分组底部的修改按钮后显示。若希望面板严格按这个手动顺序展示，请使用：

```json
{
  "marketMonitoring.sortBy": "configured"
}
```

`marketMonitoring.sortBy` 可选值：

- `configured`：保持 `marketMonitoring.symbols` 中的配置顺序。
- `changePercent`：按涨跌幅排序。
- `price`：按最新价排序。
- `name`：按展示名称排序。
- `code`：按代码排序。

`marketMonitoring.sortDirection` 可选 `desc` 或 `asc`。

表格列名也支持点击排序：第一次点击升序，第二次点击降序，第三次恢复默认顺序。当前排序方向会显示在列名旁边。

## 价格小数位

`marketMonitoring.priceDecimalPlaces` 控制标的和指数价格的小数位数，默认 `2`，支持 `0-6`。

`marketMonitoring.compactLargeAmounts` 控制超过 `10000` 的金额是否以 `W` 为单位展示，默认 `false`，即展示完整数值。开启后会影响分组汇总和导出 CSV 中的汇总金额。

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

例如下面配置会按“名称、代码、价格、涨跌幅、持仓、净收益额”的顺序展示：

```json
{
  "marketMonitoring.quoteColumns": [
    "name",
    "code",
    "price",
    "changePercent",
    "holding",
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
- `position`：仓位，按当前标的市值占所在分组可计算总市值的比例自动计算，仅在填写持仓且有有效价格时展示。
- `netProfit`：净收益额，按 `(当前价 - 成本) * 持仓` 自动计算。

## 指数切换

行情面板底部右下角提供指数下拉列表，默认显示主指数。指数行情由扩展自动拉取，不需要添加到 `marketMonitoring.symbols`。

## 刷新时段

默认仅在内置活跃交易时段刷新。非交易时段会在缺少本地行情快照时拉取一次最新行情，用于显示收盘后的价格；之后不会按高频间隔持续刷新。节假日不会自动识别。如果需要全天刷新，可将 `marketMonitoring.onlyDuringTradingTime` 设为 `false`。

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
