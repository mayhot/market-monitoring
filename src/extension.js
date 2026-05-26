const http = require('http');
const https = require('https');
const vscode = require('vscode');

const CONFIG_SECTION = 'marketMonitoring';
const VIEW_ID = 'marketMonitoring.quotesView';
const DEFAULT_GROUP = '未分组';
const INDEX_SYMBOLS = [
  { code: 'sh000001', name: '上证指数', group: '指数' },
  { code: 'sz399001', name: '深证成指', group: '指数' },
  { code: 'sz399006', name: '创业板指', group: '指数' },
  { code: 'sh000688', name: '科创50', group: '指数' },
  { code: 'sh000985', name: '中证全指', group: '指数' },
  { code: 'bj899050', name: '北证50', group: '指数' }
];
const DEFAULT_INDEX_CODE = 'sh000001';

function activate(context) {
  const output = vscode.window.createOutputChannel('Market Monitoring');
  const provider = new QuotesViewProvider(context.extensionUri);
  const monitor = new MarketMonitor(context, provider, output);

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.commands.registerCommand('marketMonitoring.refresh', () => monitor.refresh(true)),
    vscode.commands.registerCommand('marketMonitoring.start', () => monitor.start(true)),
    vscode.commands.registerCommand('marketMonitoring.stop', () => monitor.stop(true)),
    vscode.commands.registerCommand('marketMonitoring.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${getExtensionId(context)}`);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        monitor.reloadConfiguration();
      }
    })
  );

  provider.onMessage((message) => {
    if (!message || typeof message.command !== 'string') {
      return;
    }

    if (message.command === 'refresh') {
      monitor.refresh(true);
    } else if (message.command === 'settings') {
      vscode.commands.executeCommand('marketMonitoring.openSettings');
    } else if (message.command === 'start') {
      monitor.start(true);
    } else if (message.command === 'stop') {
      monitor.stop(true);
    } else if (message.command === 'addSymbol') {
      monitor.addSymbol(message.symbol);
    } else if (message.command === 'removeSymbol') {
      monitor.removeSymbol(message.index);
    } else if (message.command === 'moveSymbol') {
      monitor.moveSymbol(message.index, message.direction);
    }
  });

  monitor.start(false);
}

function deactivate() {}

class MarketMonitor {
  constructor(context, provider, output) {
    this.context = context;
    this.provider = provider;
    this.output = output;
    this.timer = undefined;
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
    this.statusBarItem.command = 'marketMonitoring.refresh';
    this.context.subscriptions.push(this.statusBarItem);
    this.running = false;
    this.lastQuotes = [];
    this.triggeredAlerts = [];
    this.activeAlertKeys = new Set();
    this.lastError = '';
    this.lastUpdatedAt = '';
    this.isRefreshing = false;
    this.config = readConfig();
    this.provider.update(this.createSnapshot('未启动'));
  }

  start(showMessage) {
    this.running = true;
    this.schedule();
    this.refresh(false);
    if (showMessage) {
      vscode.window.showInformationMessage('Market Monitoring 已启动');
    }
  }

  stop(showMessage) {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.updateViews('已暂停');
    if (showMessage) {
      vscode.window.showInformationMessage('Market Monitoring 已暂停');
    }
  }

  reloadConfiguration() {
    this.config = readConfig();
    this.schedule();
    this.refresh(false);
  }

  async addSymbol(symbol) {
    const normalized = normalizeSymbolConfig(symbol);
    if (!normalized) {
      vscode.window.showWarningMessage('请输入有效的标的代码');
      return;
    }

    if (isBuiltInIndexCode(normalized.code)) {
      vscode.window.showInformationMessage(`${normalized.name} 已在右下角指数列表中`);
      return;
    }

    const exists = this.config.symbols.some((item) => item.code === normalized.code);
    if (exists) {
      vscode.window.showInformationMessage(`${normalized.name} 已在监控列表中`);
      return;
    }

    await updateConfiguredSymbols([...this.config.symbols, normalized]);
    vscode.window.showInformationMessage(`已添加 ${normalized.name}`);
  }

  async removeSymbol(index) {
    const parsedIndex = Number(index);
    if (!Number.isInteger(parsedIndex) || parsedIndex < 0 || parsedIndex >= this.config.symbols.length) {
      return;
    }

    const symbol = this.config.symbols[parsedIndex];
    await updateConfiguredSymbols(this.config.symbols.filter((_, currentIndex) => currentIndex !== parsedIndex));
    vscode.window.showInformationMessage(`已删除 ${symbol.name}`);
  }

  async moveSymbol(index, direction) {
    const parsedIndex = Number(index);
    const offset = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
    const nextIndex = parsedIndex + offset;

    if (!Number.isInteger(parsedIndex) || offset === 0 || parsedIndex < 0 || nextIndex < 0 || parsedIndex >= this.config.symbols.length || nextIndex >= this.config.symbols.length) {
      return;
    }

    const nextSymbols = [...this.config.symbols];
    const [symbol] = nextSymbols.splice(parsedIndex, 1);
    nextSymbols.splice(nextIndex, 0, symbol);
    await updateConfiguredSymbols(nextSymbols);
  }

  async refresh(force) {
    if (!this.running || this.isRefreshing) {
      return;
    }

    const phase = getMarketPhase();
    const quoteSymbols = mergeQuoteSymbols(this.config.symbols, INDEX_SYMBOLS);
    const shouldFetch = force || !this.config.onlyDuringTradingTime || phase.isActive || needsQuoteSnapshot(quoteSymbols, this.lastQuotes);

    if (!shouldFetch) {
      this.lastError = '';
      this.updateViews(phase.name);
      this.schedule();
      return;
    }

    this.isRefreshing = true;
    this.updateViews(phase.name, true);

    try {
      this.lastQuotes = await fetchQuotes(quoteSymbols, this.config.requestTimeoutMs);
      this.lastUpdatedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      this.triggeredAlerts = this.config.enableAlerts ? evaluateAlerts(this.lastQuotes, this.config.alerts, this.config.priceDecimalPlaces) : [];
      this.notifyAlerts(this.triggeredAlerts);
      this.lastError = '';
    } catch (error) {
      this.lastError = getErrorMessage(error);
      this.output.appendLine(`[${new Date().toISOString()}] ${this.lastError}`);
    } finally {
      this.isRefreshing = false;
      this.updateViews(getMarketPhase().name);
      this.schedule();
    }
  }

  schedule() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (!this.running) {
      return;
    }

    const interval = Math.max(2, this.config.refreshIntervalSeconds) * 1000;
    this.timer = setTimeout(() => this.refresh(false), interval);
  }

  updateViews(phaseName, loading = false) {
    const snapshot = this.createSnapshot(phaseName, loading);
    this.provider.update(snapshot);
    this.updateStatusBar(snapshot);
  }

  updateStatusBar(snapshot) {
    if (!this.config.showStatusBar) {
      this.statusBarItem.hide();
      return;
    }

    const pricedQuotes = snapshot.groups.flatMap((group) => group.items).filter((quote) => quote.changePercent !== null);
    const head = pricedQuotes.slice(0, 3);
    const alertCount = snapshot.alerts.length;

    if (!this.running) {
      this.statusBarItem.text = '$(graph-line) Market 已暂停';
      this.statusBarItem.tooltip = '点击刷新市场行情';
      this.statusBarItem.color = undefined;
      this.statusBarItem.show();
      return;
    }

    if (head.length === 0) {
      this.statusBarItem.text = alertCount > 0 ? `$(warning) Market ${alertCount}` : `$(graph-line) Market ${snapshot.phaseName}`;
      this.statusBarItem.tooltip = buildStatusTooltip(snapshot);
      this.statusBarItem.color = undefined;
      this.statusBarItem.show();
      return;
    }

    const average = head.reduce((sum, quote) => sum + quote.changePercent, 0) / head.length;
    const summary = head.map((quote) => `${quote.name} ${formatPercent(quote.changePercent)}`).join(' ');
    this.statusBarItem.text = alertCount > 0 ? `$(warning) ${alertCount} ${summary}` : `$(graph-line) ${summary}`;
    this.statusBarItem.tooltip = buildStatusTooltip(snapshot);
    this.statusBarItem.color = alertCount > 0 ? snapshot.colors.up : getTrendColor(average, snapshot.colors);
    this.statusBarItem.show();
  }

  notifyAlerts(alerts) {
    const nextKeys = new Set(alerts.map((alert) => alert.key));
    const freshAlerts = alerts.filter((alert) => !this.activeAlertKeys.has(alert.key));
    this.activeAlertKeys = nextKeys;

    if (!this.config.enableAlertNotifications || freshAlerts.length === 0) {
      return;
    }

    const visibleAlerts = freshAlerts.slice(0, 3);
    for (const alert of visibleAlerts) {
      vscode.window.showWarningMessage(alert.message);
    }

    if (freshAlerts.length > visibleAlerts.length) {
      vscode.window.showWarningMessage(`还有 ${freshAlerts.length - visibleAlerts.length} 条行情预警已触发`);
    }
  }

  createSnapshot(phaseName, loading = false) {
    return {
      running: this.running,
      loading,
      phaseName,
      updatedAt: this.lastUpdatedAt,
      error: this.lastError,
      colors: this.config.colors,
      alerts: this.triggeredAlerts,
      sortBy: this.config.sortBy,
      sortDirection: this.config.sortDirection,
      priceDecimalPlaces: this.config.priceDecimalPlaces,
      symbolCount: this.config.symbols.length,
      defaultIndexCode: DEFAULT_INDEX_CODE,
      indexes: buildIndexQuotes(this.lastQuotes),
      groups: groupQuotes(this.lastQuotes, this.config.symbols, this.triggeredAlerts, this.config.sortBy, this.config.sortDirection)
    };
  }
}

class QuotesViewProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = undefined;
    this.messageHandler = undefined;
    this.snapshot = {
      running: false,
      loading: false,
      phaseName: '未启动',
      updatedAt: '',
      error: '',
      colors: { up: '#e51400', down: '#16a34a', flat: '#8b949e' },
      alerts: [],
      sortBy: 'configured',
      sortDirection: 'desc',
      priceDecimalPlaces: 2,
      symbolCount: 0,
      defaultIndexCode: DEFAULT_INDEX_CODE,
      indexes: INDEX_SYMBOLS.map((symbol) => ({
        ...symbol,
        price: null,
        previousClose: null,
        change: null,
        changePercent: null,
        time: '',
        status: '等待刷新'
      })),
      groups: []
    };
  }

  onMessage(handler) {
    this.messageHandler = handler;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message) => {
      if (this.messageHandler) {
        this.messageHandler(message);
      }
    });
    this.update(this.snapshot);
  }

  update(snapshot) {
    this.snapshot = snapshot;
    if (this.view) {
      this.view.webview.postMessage({ type: 'snapshot', snapshot });
    }
  }

  getHtml(webview) {
    const nonce = createNonce();
    const cspSource = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    :root {
      --up: #e51400;
      --down: #16a34a;
      --flat: #8b949e;
      --surface: var(--vscode-sideBar-background);
      --surface-soft: var(--vscode-sideBarSectionHeader-background);
      --surface-hover: var(--vscode-list-hoverBackground);
      --border: var(--vscode-panel-border);
      --muted: var(--vscode-descriptionForeground);
      --focus: var(--vscode-focusBorder);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 12px;
      min-height: 100vh;
      color: var(--vscode-foreground);
      background: var(--surface);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      display: flex;
      flex-direction: column;
      line-height: 1.35;
    }

    button {
      border: 1px solid var(--vscode-button-border, transparent);
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-radius: 5px;
      padding: 5px 9px;
      cursor: pointer;
      font: inherit;
      min-height: 28px;
    }

    button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    button:disabled {
      opacity: 0.45;
      cursor: default;
    }

    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .icon-button {
      min-width: 28px;
      height: 26px;
      padding: 0;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .toolbar .icon-button {
      flex: 0 0 auto;
    }

    .toolbar {
      display: flex;
      gap: 5px;
      align-items: center;
      margin-bottom: 12px;
    }

    .phase {
      flex: 1;
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .symbol-form {
      display: grid;
      grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr);
      gap: 6px;
      margin-bottom: 10px;
      padding: 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: color-mix(in srgb, var(--surface-soft) 52%, transparent);
    }

    .symbol-form-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 6px;
      grid-column: 1 / -1;
    }

    .symbol-form > button {
      grid-column: 2;
      grid-row: 1;
      white-space: nowrap;
    }

    .add-button {
      width: 100%;
    }

    @media (max-width: 280px) {
      .symbol-form {
        grid-template-columns: 1fr;
      }

      .symbol-form > button {
        grid-column: 1;
        grid-row: auto;
      }
    }

    input {
      width: 100%;
      min-width: 0;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 5px;
      padding: 5px 7px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font: inherit;
      min-height: 28px;
      outline: none;
    }

    input:focus,
    select:focus,
    button:focus {
      border-color: var(--focus);
      outline: 1px solid transparent;
    }

    input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    select {
      border: 1px solid var(--vscode-dropdown-border, transparent);
      border-radius: 5px;
      padding: 4px 7px;
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      font: inherit;
      min-height: 28px;
    }

    .hint {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.4;
    }

    .group {
      margin: 0 0 10px;
      border: 1px solid var(--border);
      border-radius: 7px;
      overflow: hidden;
      background: var(--surface);
    }

    .group.editing {
      border-color: var(--focus);
    }

    #app {
      flex: 1;
      min-height: 0;
      padding-bottom: 10px;
    }

    .group-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      padding: 8px 8px;
      color: var(--vscode-sideBarTitle-foreground);
      background: color-mix(in srgb, var(--surface-soft) 72%, transparent);
      font-weight: 400;
    }

    .group-title-actions {
      display: flex;
      gap: 6px;
      align-items: center;
      min-width: 0;
    }

    .group-title-main {
      display: flex;
      gap: 6px;
      align-items: center;
      min-width: 0;
    }

    .group-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .group-stats {
      display: flex;
      gap: 6px;
      align-items: center;
      color: var(--muted);
      font-size: 11px;
      font-weight: 400;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .count {
      color: var(--muted);
      font-weight: 400;
    }

    .quote {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px 10px;
      padding: 9px 8px;
      border-top: 1px solid var(--border);
      background: transparent;
      transition: background 120ms ease;
    }

    .quote:hover {
      background: var(--surface-hover);
    }

    .quote.editing {
      grid-template-columns: minmax(0, 1fr) auto auto;
    }

    .quote.alert {
      border-left: 3px solid var(--vscode-notificationsWarningIcon-foreground, var(--up));
      padding-left: 5px;
      background: color-mix(in srgb, var(--vscode-notificationsWarningIcon-foreground, var(--up)) 8%, transparent);
    }

    .main {
      min-width: 0;
    }

    .name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 400;
    }

    .alert-badge {
      display: inline-block;
      margin-left: 6px;
      color: var(--vscode-notificationsWarningIcon-foreground, var(--up));
      font-size: 11px;
      font-weight: 700;
    }

    .code,
    .time,
    .meta {
      color: var(--muted);
      font-size: 11px;
    }

    .numbers {
      text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .quote-change {
      color: var(--flat);
    }

    .quote-change.up {
      color: var(--up);
    }

    .quote-change.down {
      color: var(--down);
    }

    .quote-actions {
      display: flex;
      gap: 3px;
      align-items: center;
    }

    .index-dock {
      position: sticky;
      bottom: 0;
      display: flex;
      justify-content: flex-end;
      padding-top: 8px;
      background: linear-gradient(to bottom, transparent, var(--surface) 30%);
      border-top: 1px solid var(--border);
    }

    .index-widget {
      display: grid;
      grid-template-columns: minmax(82px, auto) auto;
      gap: 8px;
      align-items: center;
      max-width: 100%;
      padding: 6px 0 0;
    }

    .index-quote {
      text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .index-price {
      font-weight: 700;
    }

    .price {
      font-weight: 700;
    }

    .up {
      color: var(--up);
    }

    .down {
      color: var(--down);
    }

    .flat {
      color: var(--flat);
    }

    .empty,
    .error {
      color: var(--vscode-descriptionForeground);
      padding: 14px 4px;
      line-height: 1.5;
    }

    .error {
      color: var(--vscode-errorForeground);
    }
  </style>
  <style nonce="${nonce}" id="dynamic-colors"></style>
</head>
<body>
  <div class="toolbar">
    <div class="phase" id="phase">未启动</div>
    <button class="icon-button" id="toggle" title="启动" aria-label="启动">▶</button>
    <button class="secondary icon-button" id="refresh" title="刷新" aria-label="刷新">↻</button>
    <button class="secondary icon-button" id="settings" title="设置" aria-label="设置">⚙</button>
  </div>
  <form class="symbol-form" id="symbol-form">
    <input id="symbol-code" name="code" placeholder="代码，如 sh510300" autocomplete="off">
    <div class="symbol-form-row">
      <input id="symbol-name" name="name" placeholder="名称，可选" autocomplete="off">
      <input id="symbol-group" name="group" placeholder="分组，可选" autocomplete="off">
    </div>
    <button class="secondary icon-button add-button" type="submit" title="添加标的" aria-label="添加标的">＋</button>
  </form>
  <div class="hint" id="sort-hint"></div>
  <main id="app"></main>
  <footer class="index-dock">
    <div class="index-widget">
      <select id="index-select" title="切换指数"></select>
      <div id="index-quote" class="index-quote flat">--</div>
    </div>
  </footer>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let viewState = vscode.getState() || {};
    const app = document.getElementById('app');
    const phase = document.getElementById('phase');
    const toggle = document.getElementById('toggle');
    const refresh = document.getElementById('refresh');
    const settings = document.getElementById('settings');
    const symbolForm = document.getElementById('symbol-form');
    const symbolCode = document.getElementById('symbol-code');
    const symbolName = document.getElementById('symbol-name');
    const symbolGroup = document.getElementById('symbol-group');
    const sortHint = document.getElementById('sort-hint');
    const indexSelect = document.getElementById('index-select');
    const indexQuote = document.getElementById('index-quote');
    const dynamicColors = document.getElementById('dynamic-colors');
    let selectedIndexCode = viewState.selectedIndexCode || 'sh000001';
    let editingGroups = viewState.editingGroups || {};
    let collapsedGroups = viewState.collapsedGroups || {};
    let latestSnapshot;

    refresh.addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    settings.addEventListener('click', () => vscode.postMessage({ command: 'settings' }));
    toggle.addEventListener('click', () => {
      const running = toggle.dataset.running === 'true';
      vscode.postMessage({ command: running ? 'stop' : 'start' });
    });
    symbolForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const code = symbolCode.value.trim();
      if (!code) {
        symbolCode.focus();
        return;
      }
      vscode.postMessage({
        command: 'addSymbol',
        symbol: {
          code,
          name: symbolName.value.trim(),
          group: symbolGroup.value.trim()
        }
      });
      symbolCode.value = '';
      symbolName.value = '';
      symbolGroup.value = '';
      symbolCode.focus();
    });
    app.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) {
        return;
      }
      const index = Number(button.dataset.index);
      const action = button.dataset.action;
      if (action === 'remove') {
        vscode.postMessage({ command: 'removeSymbol', index });
      } else if (action === 'up' || action === 'down') {
        vscode.postMessage({ command: 'moveSymbol', index, direction: action });
      } else if (action === 'editGroup') {
        const group = button.dataset.group || '';
        editingGroups = {
          ...editingGroups,
          [group]: !editingGroups[group]
        };
        persistViewState();
        if (latestSnapshot) {
          app.innerHTML = renderGroups(latestSnapshot.groups, latestSnapshot);
        }
      } else if (action === 'toggleGroup') {
        const group = button.dataset.group || '';
        collapsedGroups = {
          ...collapsedGroups,
          [group]: !collapsedGroups[group]
        };
        persistViewState();
        if (latestSnapshot) {
          app.innerHTML = renderGroups(latestSnapshot.groups, latestSnapshot);
        }
      }
    });
    indexSelect.addEventListener('change', () => {
      selectedIndexCode = indexSelect.value || 'sh000001';
      persistViewState();
      renderIndex(latestSnapshot);
    });

    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'snapshot') {
        render(event.data.snapshot);
      }
    });

    function render(snapshot) {
      latestSnapshot = snapshot;
      dynamicColors.textContent = ':root{--up:' + snapshot.colors.up + ';--down:' + snapshot.colors.down + ';--flat:' + snapshot.colors.flat + ';}';
      toggle.dataset.running = String(snapshot.running);
      toggle.textContent = snapshot.running ? '⏸' : '▶';
      toggle.title = snapshot.running ? '暂停' : '启动';
      toggle.setAttribute('aria-label', toggle.title);

      const extra = snapshot.updatedAt ? ' · ' + snapshot.updatedAt : '';
      phase.textContent = (snapshot.loading ? '刷新中 · ' : '') + snapshot.phaseName + extra;
      sortHint.textContent = snapshot.sortBy === 'configured'
        ? ''
        : '当前按行情字段自动排序；上移/下移会调整配置顺序，在 sortBy 设为 configured 时按该顺序显示。';

      if (snapshot.error) {
        app.innerHTML = '<div class="error">' + escapeHtml(snapshot.error) + '</div>' + renderGroups(snapshot.groups, snapshot);
        renderIndex(snapshot);
        return;
      }

      app.innerHTML = renderGroups(snapshot.groups, snapshot);
      renderIndex(snapshot);
    }

    function renderIndex(snapshot) {
      const indexes = snapshot && Array.isArray(snapshot.indexes) ? snapshot.indexes : [];
      if (!indexes.some((item) => item.code === selectedIndexCode)) {
        selectedIndexCode = snapshot.defaultIndexCode || 'sh000001';
      }

      indexSelect.innerHTML = indexes.map((item) => {
        return '<option value="' + escapeHtml(item.code) + '"' + (item.code === selectedIndexCode ? ' selected' : '') + '>' + escapeHtml(item.name) + '</option>';
      }).join('');

      const selected = indexes.find((item) => item.code === selectedIndexCode);
      if (!selected) {
        indexQuote.className = 'index-quote flat';
        indexQuote.textContent = '--';
        return;
      }

      const trend = selected.changePercent > 0 ? 'up' : selected.changePercent < 0 ? 'down' : 'flat';
      const price = selected.price === null ? '--' : selected.price.toFixed(snapshot.priceDecimalPlaces);
      const percent = selected.changePercent === null ? '--' : formatSigned(selected.changePercent, 2) + '%';
      indexQuote.className = 'index-quote';
      indexQuote.innerHTML = '<span class="index-price">' + price + '</span> <span class="quote-change ' + trend + '">' + percent + '</span>';
    }

    function renderGroups(groups, snapshot) {
      if (!groups || groups.length === 0) {
        return '<div class="empty">暂无标的，请在设置中配置 marketMonitoring.symbols。</div>';
      }

      return groups.map((group) => {
        const editing = Boolean(editingGroups[group.name]);
        const collapsed = Boolean(collapsedGroups[group.name]);
        const items = collapsed ? '' : group.items.map((quote) => renderQuote(quote, snapshot, editing)).join('');
        const stats = group.stats || { up: 0, down: 0, flat: 0, averageChangePercent: null };
        const average = stats.averageChangePercent === null ? '--' : formatSigned(stats.averageChangePercent, 2) + '%';
        return '<section class="group' + (editing ? ' editing' : '') + '">' +
          '<div class="group-title">' +
            '<span class="group-title-main">' +
              '<button class="secondary icon-button" data-action="toggleGroup" data-group="' + escapeHtml(group.name) + '" title="' + (collapsed ? '展开' : '折叠') + '" aria-label="' + (collapsed ? '展开' : '折叠') + '">' + (collapsed ? '›' : '⌄') + '</button>' +
              '<span class="group-name">' + escapeHtml(group.name) + '</span>' +
            '</span>' +
            '<span class="group-title-actions">' +
              '<span class="group-stats">' +
                '<span class="up">↑' + stats.up + '</span>' +
                '<span class="down">↓' + stats.down + '</span>' +
                '<span class="flat">- ' + stats.flat + '</span>' +
                '<span title="平均涨跌幅">' + average + '</span>' +
                '<span class="count">' + group.items.length + '</span>' +
              '</span>' +
              '<button class="secondary icon-button" data-action="editGroup" data-group="' + escapeHtml(group.name) + '" title="' + (editing ? '完成' : '编辑') + '">' + (editing ? '✓' : '✎') + '</button>' +
            '</span>' +
          '</div>' +
          items +
          '</section>';
      }).join('');
    }

    function renderQuote(quote, snapshot, editing) {
      const trend = quote.changePercent > 0 ? 'up' : quote.changePercent < 0 ? 'down' : 'flat';
      const percent = quote.changePercent === null ? '--' : formatSigned(quote.changePercent, 2) + '%';
      const change = quote.change === null ? '--' : formatSigned(quote.change, 3);
      const price = quote.price === null ? '--' : quote.price.toFixed(snapshot.priceDecimalPlaces);
      const time = quote.time || quote.status || '';
      const hasAlert = Array.isArray(quote.alerts) && quote.alerts.length > 0;
      const alertText = hasAlert ? quote.alerts.map((alert) => alert.label).join(' / ') : '';
      const index = Number(quote.index);
      const first = index <= 0;
      const last = index >= snapshot.symbolCount - 1;

      return '<article class="quote' + (hasAlert ? ' alert' : '') + (editing ? ' editing' : '') + '">' +
        '<div class="main">' +
          '<div class="name" title="' + escapeHtml(quote.name) + '">' + escapeHtml(quote.name) + (hasAlert ? '<span class="alert-badge" title="' + escapeHtml(alertText) + '">预警</span>' : '') + '</div>' +
          '<div class="code">' + escapeHtml(quote.code) + '</div>' +
        '</div>' +
        '<div class="numbers">' +
          '<div class="price">' + price + '</div>' +
          '<div class="meta quote-change ' + trend + '">' + change + ' / ' + percent + '</div>' +
          '<div class="time">' + escapeHtml(time) + '</div>' +
        '</div>' +
        (editing ? '<div class="quote-actions">' +
          '<button class="secondary icon-button" data-action="up" data-index="' + index + '" title="上移" ' + (first ? 'disabled' : '') + '>↑</button>' +
          '<button class="secondary icon-button" data-action="down" data-index="' + index + '" title="下移" ' + (last ? 'disabled' : '') + '>↓</button>' +
          '<button class="secondary icon-button" data-action="remove" data-index="' + index + '" title="删除">×</button>' +
        '</div>' : '') +
      '</article>';
    }

    function persistViewState() {
      viewState = {
        selectedIndexCode,
        editingGroups,
        collapsedGroups
      };
      vscode.setState(viewState);
    }

    function formatSigned(value, digits) {
      const formatted = Number(value).toFixed(digits);
      return value > 0 ? '+' + formatted : formatted;
    }

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
  </script>
</body>
</html>`;
  }
}

function readConfig() {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const symbols = config.get('symbols', [])
    .map(normalizeSymbolConfig)
    .filter(Boolean)
    .filter((symbol) => !isBuiltInIndexCode(symbol.code));
  const alerts = config.get('alerts', [])
    .map(normalizeAlertRule)
    .filter(Boolean);

  return {
    symbols,
    alerts,
    enableAlerts: config.get('enableAlerts', true),
    enableAlertNotifications: config.get('enableAlertNotifications', true),
    refreshIntervalSeconds: config.get('refreshIntervalSeconds', 5),
    onlyDuringTradingTime: config.get('onlyDuringTradingTime', true),
    showStatusBar: config.get('showStatusBar', true),
    sortBy: sanitizeSortBy(config.get('sortBy', 'configured')),
    sortDirection: config.get('sortDirection', 'desc') === 'asc' ? 'asc' : 'desc',
    priceDecimalPlaces: sanitizeDecimalPlaces(config.get('priceDecimalPlaces', 2)),
    requestTimeoutMs: config.get('requestTimeoutMs', 10000),
    colors: {
      up: sanitizeColor(config.get('colors.up', '#e51400'), '#e51400'),
      down: sanitizeColor(config.get('colors.down', '#16a34a'), '#16a34a'),
      flat: sanitizeColor(config.get('colors.flat', '#8b949e'), '#8b949e')
    }
  };
}

async function updateConfiguredSymbols(symbols) {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const inspect = config.inspect('symbols');
  const target = inspect && inspect.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;

  await config.update('symbols', symbols.map(toConfigSymbol), target);
}

function toConfigSymbol(symbol) {
  return {
    code: symbol.code,
    name: symbol.name,
    group: symbol.group
  };
}

function normalizeSymbolConfig(item) {
  if (!item || typeof item !== 'object' || !item.code) {
    return undefined;
  }

  const code = normalizeCode(String(item.code));
  if (!code) {
    return undefined;
  }

  return {
    code,
    name: String(item.name || code).trim() || code,
    group: String(item.group || DEFAULT_GROUP).trim() || DEFAULT_GROUP
  };
}

function normalizeAlertRule(item) {
  if (!item || typeof item !== 'object' || !item.code) {
    return undefined;
  }

  const code = normalizeCode(String(item.code));
  if (!code || item.enabled === false) {
    return undefined;
  }

  const thresholds = {
    priceAbove: optionalNumber(item.priceAbove),
    priceBelow: optionalNumber(item.priceBelow),
    changePercentAbove: optionalNumber(item.changePercentAbove),
    changePercentBelow: optionalNumber(item.changePercentBelow)
  };

  if (Object.values(thresholds).every((value) => value === null)) {
    return undefined;
  }

  return {
    code,
    name: String(item.name || '').trim(),
    ...thresholds
  };
}

function normalizeCode(value) {
  const cleaned = value.trim().toLowerCase().replace(/\s+/g, '');
  const prefixed = cleaned.match(/^(sh|sz|bj)(\d{6})$/);
  if (prefixed) {
    return `${prefixed[1]}${prefixed[2]}`;
  }

  const suffix = cleaned.match(/^(\d{6})\.(ss|sh|sz|bj)$/);
  if (suffix) {
    const exchange = suffix[2] === 'ss' ? 'sh' : suffix[2];
    return `${exchange}${suffix[1]}`;
  }

  if (!/^\d{6}$/.test(cleaned)) {
    return '';
  }

  if (/^[659]/.test(cleaned)) {
    return `sh${cleaned}`;
  }

  if (/^[0123]/.test(cleaned)) {
    return `sz${cleaned}`;
  }

  if (/^[48]/.test(cleaned)) {
    return `bj${cleaned}`;
  }

  return '';
}

function isBuiltInIndexCode(code) {
  return INDEX_SYMBOLS.some((symbol) => symbol.code === code);
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchQuotes(symbols, timeoutMs) {
  const uniqueCodes = Array.from(new Set(symbols.map((symbol) => symbol.code)));
  const query = uniqueCodes.join(',');
  const rawQuotes = await fetchRawQuotes(query, timeoutMs);

  return symbols.map((symbol) => {
    const raw = rawQuotes.get(symbol.code);
    if (!raw) {
      return {
        ...symbol,
        price: null,
        previousClose: null,
        change: null,
        changePercent: null,
        time: '',
        status: '无报价'
      };
    }

    return {
      ...symbol,
      ...raw
    };
  });
}

async function fetchRawQuotes(query, timeoutMs) {
  const providers = [
    {
      name: '新浪',
      url: `https://hq.sinajs.cn/list=${query}`,
      headers: {
        Referer: 'https://finance.sina.com.cn/',
        'User-Agent': 'Mozilla/5.0 VSCode Market Monitoring'
      },
      parse: parseSinaResponse
    },
    {
      name: '腾讯',
      url: `https://qt.gtimg.cn/q=${query}`,
      headers: {
        Referer: 'https://gu.qq.com/',
        'User-Agent': 'Mozilla/5.0 VSCode Market Monitoring'
      },
      parse: parseTencentResponse
    }
  ];
  const errors = [];

  for (const provider of providers) {
    try {
      const body = await requestText(provider.url, timeoutMs, provider.headers);
      const quotes = provider.parse(body);
      if (quotes.size > 0) {
        return quotes;
      }
      errors.push(`${provider.name}: 未返回有效行情`);
    } catch (error) {
      errors.push(`${provider.name}: ${getErrorMessage(error)}`);
    }
  }

  throw new Error(`行情请求失败：${errors.join('；')}`);
}

function evaluateAlerts(quotes, rules, priceDecimalPlaces) {
  if (!rules || rules.length === 0) {
    return [];
  }

  const alerts = [];
  const quotesByCode = new Map(quotes.map((quote) => [quote.code, quote]));

  for (const rule of rules) {
    const quote = quotesByCode.get(rule.code);
    if (!quote) {
      continue;
    }

    const displayName = rule.name || quote.name || quote.code;
    addAlertIfMet(alerts, quote, displayName, 'priceAbove', rule.priceAbove, quote.price, '价格 >=', priceDecimalPlaces);
    addAlertIfMet(alerts, quote, displayName, 'priceBelow', rule.priceBelow, quote.price, '价格 <=', priceDecimalPlaces);
    addAlertIfMet(alerts, quote, displayName, 'changePercentAbove', rule.changePercentAbove, quote.changePercent, '涨跌幅 >=', 2, '%');
    addAlertIfMet(alerts, quote, displayName, 'changePercentBelow', rule.changePercentBelow, quote.changePercent, '涨跌幅 <=', 2, '%');
  }

  return alerts;
}

function addAlertIfMet(alerts, quote, displayName, field, threshold, value, label, digits, suffix = '') {
  if (threshold === null || value === null) {
    return;
  }

  const matched = field.endsWith('Above') ? value >= threshold : value <= threshold;
  if (!matched) {
    return;
  }

  const formattedValue = `${value.toFixed(digits)}${suffix}`;
  const formattedThreshold = `${threshold.toFixed(digits)}${suffix}`;
  const alertLabel = `${label} ${formattedThreshold}`;

  alerts.push({
    key: `${quote.code}:${field}:${formattedThreshold}`,
    code: quote.code,
    name: displayName,
    label: alertLabel,
    message: `${displayName} ${alertLabel}，当前 ${formattedValue}`
  });
}

function requestText(url, timeoutMs, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http:') ? http : https;
    const request = client.get(url, { headers }, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`行情接口返回 HTTP ${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('行情请求超时'));
    });
  });
}

function parseSinaResponse(body) {
  const quotes = new Map();
  const regex = /var hq_str_([a-z]{2}\d{6})="([^"]*)"/g;
  let match;

  while ((match = regex.exec(body)) !== null) {
    const code = match[1];
    const fields = match[2].split(',');
    if (fields.length < 4 || fields.every((field) => field === '')) {
      continue;
    }

    const open = parseNumber(fields[1]);
    const previousClose = parseNumber(fields[2]);
    const latest = parseNumber(fields[3]);
    const price = latest > 0 ? latest : open > 0 ? open : null;
    const change = price !== null && previousClose > 0 ? price - previousClose : null;
    const changePercent = change !== null ? (change / previousClose) * 100 : null;
    const date = fields[30] || '';
    const time = fields[31] || '';

    quotes.set(code, {
      price,
      previousClose: previousClose > 0 ? previousClose : null,
      change,
      changePercent,
      time: date && time ? `${time}` : time,
      status: price === null ? '无成交' : ''
    });
  }

  return quotes;
}

function parseTencentResponse(body) {
  const quotes = new Map();
  const regex = /v_([a-z]{2}\d{6})="([^"]*)"/g;
  let match;

  while ((match = regex.exec(body)) !== null) {
    const code = match[1];
    const fields = match[2].split('~');
    if (fields.length < 6 || fields.every((field) => field === '')) {
      continue;
    }

    const latest = parseNumber(fields[3]);
    const previousClose = parseNumber(fields[4]);
    const open = parseNumber(fields[5]);
    const price = latest > 0 ? latest : open > 0 ? open : null;
    const fieldChange = optionalNumber(fields[31]);
    const fieldChangePercent = optionalNumber(fields[32]);
    const change = fieldChange !== null
      ? fieldChange
      : price !== null && previousClose > 0
        ? price - previousClose
        : null;
    const changePercent = fieldChangePercent !== null
      ? fieldChangePercent
      : change !== null && previousClose > 0
        ? (change / previousClose) * 100
        : null;
    const datetime = fields[30] || '';
    const time = datetime.length >= 14 ? `${datetime.slice(8, 10)}:${datetime.slice(10, 12)}:${datetime.slice(12, 14)}` : '';

    quotes.set(code, {
      price,
      previousClose: previousClose > 0 ? previousClose : null,
      change,
      changePercent,
      time,
      status: price === null ? '无成交' : ''
    });
  }

  return quotes;
}

function mergeQuoteSymbols(symbols, indexSymbols) {
  const merged = [];
  const seen = new Set();

  for (const symbol of [...symbols, ...indexSymbols]) {
    if (seen.has(symbol.code)) {
      continue;
    }
    seen.add(symbol.code);
    merged.push(symbol);
  }

  return merged;
}

function needsQuoteSnapshot(symbols, quotes) {
  if (symbols.length === 0) {
    return false;
  }

  const quotedCodes = new Set(quotes.map((quote) => quote.code));
  return symbols.some((symbol) => !quotedCodes.has(symbol.code));
}

function buildIndexQuotes(quotes) {
  const quoteByCode = new Map(quotes.map((quote) => [quote.code, quote]));
  return INDEX_SYMBOLS.map((symbol) => {
    const quote = quoteByCode.get(symbol.code);
    if (quote) {
      return {
        ...symbol,
        price: quote.price,
        previousClose: quote.previousClose,
        change: quote.change,
        changePercent: quote.changePercent,
        time: quote.time,
        status: quote.status
      };
    }

    return {
      ...symbol,
      price: null,
      previousClose: null,
      change: null,
      changePercent: null,
      time: '',
      status: '等待刷新'
    };
  });
}

function groupQuotes(quotes, configuredSymbols, alerts, sortBy, sortDirection) {
  const order = [];
  const groups = new Map();
  const quoteByCodeAndName = new Map(quotes.map((quote) => [`${quote.code}\n${quote.name}\n${quote.group}`, quote]));
  const alertsByCode = groupAlertsByCode(alerts);

  for (const [index, symbol] of configuredSymbols.entries()) {
    const key = symbol.group || DEFAULT_GROUP;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }

    const quote = quoteByCodeAndName.get(`${symbol.code}\n${symbol.name}\n${symbol.group}`);
    const item = quote || {
      ...symbol,
      price: null,
      previousClose: null,
      change: null,
      changePercent: null,
      time: '',
      status: '等待刷新'
    };
    groups.get(key).push({
      ...item,
      index,
      alerts: alertsByCode.get(symbol.code) || []
    });
  }

  return order.map((name) => ({
    name,
    stats: calculateGroupStats(groups.get(name)),
    items: sortQuotes(groups.get(name), sortBy, sortDirection)
  }));
}

function groupAlertsByCode(alerts) {
  const groups = new Map();
  for (const alert of alerts) {
    if (!groups.has(alert.code)) {
      groups.set(alert.code, []);
    }
    groups.get(alert.code).push(alert);
  }
  return groups;
}

function calculateGroupStats(items) {
  const pricedItems = items.filter((item) => item.changePercent !== null);
  const totalChange = pricedItems.reduce((sum, item) => sum + item.changePercent, 0);

  return {
    up: pricedItems.filter((item) => item.changePercent > 0).length,
    down: pricedItems.filter((item) => item.changePercent < 0).length,
    flat: pricedItems.filter((item) => item.changePercent === 0).length,
    averageChangePercent: pricedItems.length > 0 ? totalChange / pricedItems.length : null
  };
}

function sortQuotes(items, sortBy, sortDirection) {
  if (sortBy === 'configured') {
    return items;
  }

  const direction = sortDirection === 'asc' ? 1 : -1;
  return [...items].sort((left, right) => {
    const comparison = compareQuote(left, right, sortBy);
    if (comparison !== 0) {
      return comparison * direction;
    }
    return left.name.localeCompare(right.name, 'zh-CN');
  });
}

function compareQuote(left, right, sortBy) {
  if (sortBy === 'name') {
    return left.name.localeCompare(right.name, 'zh-CN');
  }
  if (sortBy === 'code') {
    return left.code.localeCompare(right.code);
  }

  const leftValue = numericSortValue(left, sortBy);
  const rightValue = numericSortValue(right, sortBy);
  if (leftValue === rightValue) {
    return 0;
  }
  return leftValue > rightValue ? 1 : -1;
}

function numericSortValue(quote, sortBy) {
  const value = sortBy === 'price' ? quote.price : quote.changePercent;
  return value === null ? Number.NEGATIVE_INFINITY : value;
}

function getMarketPhase() {
  const now = getShanghaiTimeParts();
  if (now.weekday === 6 || now.weekday === 7) {
    return { name: '休市', isActive: false };
  }

  const minutes = now.hour * 60 + now.minute;
  if (minutes >= 9 * 60 + 15 && minutes < 9 * 60 + 25) {
    return { name: '开盘集合竞价', isActive: true };
  }
  if (minutes >= 9 * 60 + 25 && minutes < 9 * 60 + 30) {
    return { name: '竞价撮合', isActive: true };
  }
  if (minutes >= 9 * 60 + 30 && minutes < 11 * 60 + 30) {
    return { name: '上午连续竞价', isActive: true };
  }
  if (minutes >= 11 * 60 + 30 && minutes < 13 * 60) {
    return { name: '午间休市', isActive: false };
  }
  if (minutes >= 13 * 60 && minutes < 14 * 60 + 57) {
    return { name: '下午连续竞价', isActive: true };
  }
  if (minutes >= 14 * 60 + 57 && minutes <= 15 * 60) {
    return { name: '收盘集合竞价', isActive: true };
  }

  return { name: '非交易时段', isActive: false };
}

function getShanghaiTimeParts() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdays = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7
  };

  return {
    weekday: weekdays[values.weekday] || 7,
    hour: Number(values.hour),
    minute: Number(values.minute)
  };
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatPercent(value) {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function getTrendColor(value, colors) {
  if (value > 0) {
    return colors.up;
  }
  if (value < 0) {
    return colors.down;
  }
  return colors.flat;
}

function buildStatusTooltip(snapshot) {
  const lines = [`Market Monitoring ${snapshot.phaseName}`];
  if (snapshot.error) {
    lines.push(snapshot.error);
  }
  if (snapshot.alerts.length > 0) {
    lines.push('', '预警');
    for (const alert of snapshot.alerts.slice(0, 8)) {
      lines.push(`${alert.name}: ${alert.label}`);
    }
    if (snapshot.alerts.length > 8) {
      lines.push(`还有 ${snapshot.alerts.length - 8} 条`);
    }
  }
  return lines.join('\n');
}

function sanitizeSortBy(value) {
  const allowed = new Set(['configured', 'changePercent', 'price', 'name', 'code']);
  return allowed.has(value) ? value : 'configured';
}

function sanitizeDecimalPlaces(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return 2;
  }
  return Math.min(6, Math.max(0, parsed));
}

function sanitizeColor(value, fallback) {
  const color = String(value || '').trim();
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color) || /^var\(--vscode-[a-zA-Z0-9-]+\)$/.test(color)) {
    return color;
  }
  return fallback;
}

function createNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getExtensionId(context) {
  const packageJson = context.extension && context.extension.packageJSON;
  if (packageJson && packageJson.publisher && packageJson.name) {
    return `${packageJson.publisher}.${packageJson.name}`;
  }
  return 'local.market-monitoring';
}

module.exports = {
  activate,
  deactivate
};
