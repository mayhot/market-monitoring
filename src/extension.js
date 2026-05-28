const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { pinyin } = require('pinyin-pro');
const vscode = require('vscode');

const CONFIG_SECTION = 'marketMonitoring';
const VIEW_ID = 'marketMonitoring.quotesView';
const QUOTE_CACHE_KEY = 'quoteCache.v1';
const DEFAULT_GROUP = '自选';
const DEFAULT_LANGUAGE = 'auto';
const DEFAULT_QUOTE_COLUMNS = ['name', 'price', 'changePercent'];
const AVAILABLE_QUOTE_COLUMNS = ['name', 'alias', 'code', 'price', 'changePercent', 'change', 'cost', 'holding', 'position', 'netProfit'];
const DEFAULT_GROUP_SUMMARY_METRICS = [];
const AVAILABLE_GROUP_SUMMARY_METRICS = ['totalAssets', 'dailyProfit', 'dailyProfitPercent'];
const LANGUAGE_LABELS = {
  auto: 'Auto',
  'zh-CN': '中文',
  'en-US': 'English'
};
const INDEX_SYMBOLS = [
  { code: 'sh000985', name: '中证全指', group: '指数' },
  { code: 'sh000001', name: '上证指数', group: '指数' },
  { code: 'sz399001', name: '深证成指', group: '指数' },
  { code: 'sz399006', name: '创业板指', group: '指数' },
  { code: 'sh000688', name: '科创50', group: '指数' },
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
    vscode.commands.registerCommand('marketMonitoring.importCsv', () => monitor.importCsv()),
    vscode.commands.registerCommand('marketMonitoring.exportCsv', () => monitor.exportCsv()),
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
    } else if (message.command === 'importCsv') {
      monitor.importCsv();
    } else if (message.command === 'exportCsv') {
      monitor.exportCsv();
    } else if (message.command === 'settings') {
      vscode.commands.executeCommand('marketMonitoring.openSettings');
    } else if (message.command === 'webviewReady') {
      monitor.webviewReady();
    } else if (message.command === 'webviewError') {
      monitor.logError('Webview error', {
        message: message.message || '',
        source: message.source || '',
        line: message.line || 0,
        column: message.column || 0
      });
    } else if (message.command === 'updateQuoteColumns') {
      monitor.updateQuoteColumns(message.columns);
    } else if (message.command === 'updateGroupSummaryMetrics') {
      monitor.updateGroupSummaryMetrics(message.metrics);
    } else if (message.command === 'updateLanguage') {
      monitor.updateLanguage(message.language);
    } else if (message.command === 'start') {
      monitor.start(true);
    } else if (message.command === 'stop') {
      monitor.stop(true);
    } else if (message.command === 'addSymbol') {
      monitor.addSymbol(message.symbol);
    } else if (message.command === 'searchSymbols') {
      monitor.searchSymbols(message.query, message.requestId);
    } else if (message.command === 'addGroup') {
      monitor.addGroup(message.name);
    } else if (message.command === 'renameGroup') {
      monitor.renameGroup(message.oldName, message.newName);
    } else if (message.command === 'removeSymbol') {
      monitor.removeSymbol(message.index);
    } else if (message.command === 'moveSymbol') {
      monitor.moveSymbol(message.index, message.direction);
    } else if (message.command === 'refreshIndex') {
      monitor.refresh(true);
    } else if (message.command === 'updateSymbolField') {
      monitor.updateSymbolField(message.index, message.field, message.value);
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
    const cachedSnapshot = readCachedQuoteSnapshot(this.context.globalState);
    this.lastQuotes = cachedSnapshot.quotes;
    this.triggeredAlerts = [];
    this.activeAlertKeys = new Set();
    this.lastError = '';
    this.lastUpdatedAt = cachedSnapshot.updatedAt;
    this.lastUpdatedDate = cachedSnapshot.updatedDate;
    this.isRefreshing = false;
    this.config = readConfig();
    this.logInfo('Activated', {
      extensionId: getExtensionId(context),
      symbols: this.config.symbols.length,
      groups: this.config.groups.length,
      cachedQuotes: this.lastQuotes.length,
      cachedAt: this.lastUpdatedAt || ''
    });
    this.provider.update(this.createSnapshot('未启动'));
  }

  start(showMessage) {
    this.running = true;
    this.logInfo('Started');
    this.schedule();
    this.refresh(false);
    if (showMessage) {
      vscode.window.showInformationMessage('Market Monitoring 已启动');
    }
  }

  stop(showMessage) {
    this.running = false;
    this.logInfo('Stopped');
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.updateViews('已暂停');
    if (showMessage) {
      vscode.window.showInformationMessage('Market Monitoring 已暂停');
    }
  }

  reloadConfiguration(reason = 'configurationChanged') {
    this.config = readConfig();
    this.logInfo('Configuration reloaded', {
      reason,
      symbols: this.config.symbols.length,
      groups: this.config.groups.length,
      intervalSeconds: this.config.refreshIntervalSeconds,
      onlyDuringTradingTime: this.config.onlyDuringTradingTime
    });
    this.updateViews(getMarketPhase().name, this.isRefreshing);
    this.schedule();
    this.refresh(false);
  }

  webviewReady() {
    this.logInfo('Webview ready');
    this.reloadConfiguration('webviewReady');
  }

  logInfo(message, details) {
    this.output.appendLine(formatLogLine('INFO', message, details));
  }

  logWarn(message, details) {
    this.output.appendLine(formatLogLine('WARN', message, details));
  }

  logError(message, details) {
    this.output.appendLine(formatLogLine('ERROR', message, details));
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

    const insertIndex = findGroupInsertIndex(this.config.symbols, normalized.group);
    const nextSymbols = [...this.config.symbols];
    nextSymbols.splice(insertIndex, 0, normalized);
    await updateConfiguredSymbols(nextSymbols);
    vscode.window.showInformationMessage(`已添加 ${normalized.name}`);
    this.refresh(true);
  }

  async searchSymbols(query, requestId) {
    const keyword = String(query || '').trim();
    if (!keyword) {
      this.provider.postSymbolSearchResults(requestId, keyword, []);
      return;
    }

    try {
      const results = await fetchSymbolSearchResults(keyword, this.config.requestTimeoutMs);
      this.provider.postSymbolSearchResults(requestId, keyword, results);
    } catch (error) {
      const message = getErrorMessage(error);
      this.output.appendLine(`[${new Date().toISOString()}] 标的搜索失败: ${message}`);
      this.provider.postSymbolSearchResults(requestId, keyword, [], message);
    }
  }

  async addGroup(name) {
    const normalizedName = normalizeGroupName(name);
    if (!normalizedName) {
      vscode.window.showWarningMessage('请输入有效的分组名称');
      return;
    }

    if (this.config.groups.includes(normalizedName)) {
      vscode.window.showInformationMessage(`${normalizedName} 分组已存在`);
      return;
    }

    await updateConfiguredGroups([...this.config.groups, normalizedName]);
    vscode.window.showInformationMessage(`已添加分组 ${normalizedName}`);
  }

  async renameGroup(oldName, newName) {
    const currentName = normalizeGroupName(oldName);
    const nextName = normalizeGroupName(newName);
    if (!currentName || !nextName || currentName === nextName) {
      return;
    }

    const nextGroups = this.config.groups
      .map((group) => group === currentName ? nextName : group)
      .filter((group, index, groups) => groups.indexOf(group) === index);
    const nextSymbols = this.config.symbols.map((symbol) => {
      if (symbol.group !== currentName) {
        return symbol;
      }
      return {
        ...symbol,
        group: nextName
      };
    });

    await updateConfiguredGroups(nextGroups.length > 0 ? nextGroups : [DEFAULT_GROUP]);
    await updateConfiguredSymbols(nextSymbols);
    vscode.window.showInformationMessage(`已修改分组 ${currentName} -> ${nextName}`);
  }

  async removeSymbol(index) {
    const parsedIndex = Number(index);
    if (!Number.isInteger(parsedIndex) || parsedIndex < 0 || parsedIndex >= this.config.symbols.length) {
      return;
    }

    const symbol = this.config.symbols[parsedIndex];
    const choice = await vscode.window.showWarningMessage(
      `确认删除 ${symbol.name}？`,
      { modal: true },
      '删除'
    );
    if (choice !== '删除') {
      return;
    }

    await updateConfiguredSymbols(this.config.symbols.filter((_, currentIndex) => currentIndex !== parsedIndex));
    vscode.window.showInformationMessage(`已删除 ${symbol.name}`);
  }

  async moveSymbol(index, direction) {
    const parsedIndex = Number(index);
    const offset = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;

    if (!Number.isInteger(parsedIndex) || offset === 0 || parsedIndex < 0 || parsedIndex >= this.config.symbols.length) {
      return;
    }

    const symbol = this.config.symbols[parsedIndex];
    const groupIndexes = this.config.symbols
      .map((item, currentIndex) => item.group === symbol.group ? currentIndex : -1)
      .filter((currentIndex) => currentIndex >= 0);
    const groupPosition = groupIndexes.indexOf(parsedIndex);
    const nextGroupPosition = groupPosition + offset;

    if (groupPosition < 0 || nextGroupPosition < 0 || nextGroupPosition >= groupIndexes.length) {
      return;
    }

    const nextIndex = groupIndexes[nextGroupPosition];
    const nextSymbols = [...this.config.symbols];
    [nextSymbols[parsedIndex], nextSymbols[nextIndex]] = [nextSymbols[nextIndex], nextSymbols[parsedIndex]];
    await updateConfiguredSymbols(nextSymbols);
  }

  async updateSymbolField(index, field, value) {
    const parsedIndex = Number(index);
    if (!Number.isInteger(parsedIndex) || parsedIndex < 0 || parsedIndex >= this.config.symbols.length || !['name', 'cost', 'holding'].includes(field)) {
      return;
    }

    const parsedValue = field === 'name'
      ? String(value || '').trim()
      : field === 'holding'
        ? optionalInteger(value)
        : optionalNumber(value);
    const nextSymbols = this.config.symbols.map((symbol, currentIndex) => {
      if (currentIndex !== parsedIndex) {
        return symbol;
      }

      return {
        ...symbol,
        [field]: field === 'name' ? (parsedValue || symbol.code) : parsedValue
      };
    });

    await updateConfiguredSymbols(nextSymbols);
    this.config = {
      ...this.config,
      symbols: nextSymbols
    };
    this.updateViews(getMarketPhase().name);
  }

  async updateQuoteColumns(columns) {
    const nextColumns = sanitizeQuoteColumns(columns);
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update('quoteColumns', nextColumns, getConfigTarget(config, 'quoteColumns'));
    this.config = {
      ...this.config,
      quoteColumns: nextColumns
    };
    this.updateViews(getMarketPhase().name);
  }

  async updateGroupSummaryMetrics(metrics) {
    const nextMetrics = sanitizeGroupSummaryMetrics(metrics);
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update('groupSummaryMetrics', nextMetrics, getConfigTarget(config, 'groupSummaryMetrics'));
    this.config = {
      ...this.config,
      groupSummaryMetrics: nextMetrics
    };
    this.updateViews(getMarketPhase().name);
  }

  async updateLanguage(language) {
    const nextLanguage = sanitizeLanguage(language);
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update('language', nextLanguage, getConfigTarget(config, 'language'));
    this.config = {
      ...this.config,
      language: nextLanguage,
      locale: resolveLanguage(nextLanguage)
    };
    this.updateViews(getMarketPhase().name);
  }

  async importCsv() {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        CSV: ['csv']
      },
      openLabel: '导入 CSV'
    });
    if (!uris || uris.length === 0) {
      return;
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uris[0]);
      const rows = parseCsvImportRows(decodeCsvImportText(bytes));
      const importResult = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '正在导入 CSV 标的',
        cancellable: false
      }, (progress) => resolveImportRows(rows, this.config, this.output, progress));

      if (importResult.symbols.length === 0) {
        vscode.window.showWarningMessage(`未导入标的：有效 ${importResult.validated} 条，跳过 ${importResult.skipped} 条`);
        return;
      }

      let nextSymbols = [...this.config.symbols];
      for (const symbol of importResult.symbols) {
        const insertIndex = findGroupInsertIndex(nextSymbols, symbol.group);
        nextSymbols.splice(insertIndex, 0, symbol);
      }

      const nextGroups = [...this.config.groups];
      for (const group of importResult.groups) {
        if (!nextGroups.includes(group)) {
          nextGroups.push(group);
        }
      }

      await updateConfiguredGroups(nextGroups);
      await updateConfiguredSymbols(nextSymbols);
      this.config = {
        ...this.config,
        groups: normalizeGroups(nextGroups, nextSymbols),
        symbols: nextSymbols
      };
      vscode.window.showInformationMessage(`已导入 ${importResult.symbols.length} 个标的，跳过 ${importResult.skipped} 条`);
      this.refresh(true);
    } catch (error) {
      const message = getErrorMessage(error);
      this.output.appendLine(`[${new Date().toISOString()}] CSV 导入失败: ${message}`);
      vscode.window.showErrorMessage(`CSV 导入失败: ${message}`);
    }
  }

  async exportCsv() {
    const groups = groupQuotes(this.lastQuotes, this.config.groups, this.config.symbols, this.triggeredAlerts, 'configured', 'asc');
    const rows = buildCsvRows(groups, this.config.priceDecimalPlaces, this.config.compactLargeAmounts);
    if (rows.length <= 1) {
      vscode.window.showInformationMessage('暂无可导出的标的数据');
      return;
    }

    const defaultUri = vscode.Uri.file(path.join(os.homedir(), `market-monitoring-${formatFileTimestamp(new Date())}.csv`));
    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: {
        CSV: ['csv']
      },
      saveLabel: '导出 CSV'
    });
    if (!uri) {
      return;
    }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(toCsv(rows), 'utf8'));
    vscode.window.showInformationMessage(`已导出 CSV: ${uri.fsPath}`);
  }

  async refresh(force) {
    if (!this.running || this.isRefreshing) {
      if (force) {
        this.logWarn('Refresh skipped', {
          reason: !this.running ? 'notRunning' : 'alreadyRefreshing',
          force
        });
      }
      return;
    }

    const phase = getMarketPhase();
    const quoteSymbols = mergeQuoteSymbols(this.config.symbols, INDEX_SYMBOLS);
    const shouldRefreshCachedSnapshot = this.config.onlyDuringTradingTime
      && !phase.isActive
      && quoteSymbols.length > 0
      && this.lastUpdatedDate !== getShanghaiDateString();
    const shouldFetch = force || !this.config.onlyDuringTradingTime || phase.isActive || needsQuoteSnapshot(quoteSymbols, this.lastQuotes) || shouldRefreshCachedSnapshot;

    if (!shouldFetch) {
      this.lastError = '';
      if (force) {
        this.logInfo('Refresh skipped', {
          reason: 'notNeeded',
          phase: phase.name,
          quotes: this.lastQuotes.length
        });
      }
      this.updateViews(phase.name);
      this.schedule();
      return;
    }

    this.isRefreshing = true;
    this.logInfo('Refresh started', {
      force,
      phase: phase.name,
      symbols: this.config.symbols.length,
      totalCodes: quoteSymbols.length,
      cachedQuotes: this.lastQuotes.length
    });
    this.updateViews(phase.name, true);

    try {
      const fetchedQuotes = await fetchQuotes(quoteSymbols, this.config.requestTimeoutMs, (message, details) => this.logInfo(message, details));
      this.lastQuotes = mergeWithPreviousQuotes(fetchedQuotes, this.lastQuotes);
      this.lastUpdatedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      this.lastUpdatedDate = getShanghaiDateString();
      this.triggeredAlerts = this.config.enableAlerts ? evaluateAlerts(this.lastQuotes, this.config.alerts, this.config.priceDecimalPlaces) : [];
      this.notifyAlerts(this.triggeredAlerts);
      this.lastError = '';
      await writeCachedQuoteSnapshot(this.context.globalState, this.lastQuotes, this.lastUpdatedAt, this.lastUpdatedDate);
      this.logInfo('Refresh succeeded', {
        quotes: this.lastQuotes.length,
        usableQuotes: countUsableQuotes(this.lastQuotes),
        usableSymbols: countUsableCodes(this.lastQuotes, this.config.symbols.map((symbol) => symbol.code)),
        updatedAt: this.lastUpdatedAt
      });
    } catch (error) {
      this.lastError = getErrorMessage(error);
      this.logError('Refresh failed', {
        error: this.lastError
      });
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
    this.statusBarItem.color = snapshot.colors.mode === 'none'
      ? undefined
      : alertCount > 0
        ? snapshot.colors.up
        : getTrendColor(average, snapshot.colors);
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
      language: this.config.language,
      locale: this.config.locale,
      colors: this.config.colors,
      alerts: this.triggeredAlerts,
      sortBy: this.config.sortBy,
      sortDirection: this.config.sortDirection,
      priceDecimalPlaces: this.config.priceDecimalPlaces,
      compactLargeAmounts: this.config.compactLargeAmounts,
      rowHighlight: this.config.rowHighlight,
      quoteColumns: this.config.quoteColumns,
      groupSummaryMetrics: this.config.groupSummaryMetrics,
      symbolCount: this.config.symbols.length,
      configuredGroups: this.config.groups,
      configuredSymbols: this.config.symbols,
      defaultIndexCode: DEFAULT_INDEX_CODE,
      indexes: buildIndexQuotes(this.lastQuotes),
      groups: groupQuotes(this.lastQuotes, this.config.groups, this.config.symbols, this.triggeredAlerts, this.config.sortBy, this.config.sortDirection)
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
      language: DEFAULT_LANGUAGE,
      locale: resolveLanguage(DEFAULT_LANGUAGE),
      colors: getColorPalette('none'),
      alerts: [],
      sortBy: 'configured',
      sortDirection: 'desc',
      priceDecimalPlaces: 2,
      compactLargeAmounts: false,
      rowHighlight: {
        upPercent: 5,
        downPercent: 5
      },
      quoteColumns: DEFAULT_QUOTE_COLUMNS,
      groupSummaryMetrics: DEFAULT_GROUP_SUMMARY_METRICS,
      symbolCount: 0,
      configuredGroups: [DEFAULT_GROUP],
      configuredSymbols: [],
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

  postSymbolSearchResults(requestId, query, results, error = '') {
    if (this.view) {
      this.view.webview.postMessage({
        type: 'symbolSearchResults',
        requestId,
        query,
        results,
        error
      });
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

    html {
      width: 100%;
    }

    body {
      margin: 0;
      padding: 12px;
      width: 100%;
      max-width: 100%;
      min-height: 100vh;
      max-height: 100vh;
      overflow-y: auto;
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

    button.danger {
      color: var(--vscode-errorForeground);
      border-color: color-mix(in srgb, var(--vscode-errorForeground) 55%, transparent);
    }

    button.danger:hover {
      color: var(--vscode-errorForeground);
      background: color-mix(in srgb, var(--vscode-errorForeground) 14%, transparent);
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
      min-width: 0;
      max-width: 100%;
      margin-bottom: 12px;
    }

    .phase {
      flex: 1;
      min-width: 0;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .group-form,
    .symbol-form {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 6px;
      min-width: 0;
      max-width: 100%;
      margin-bottom: 10px;
      padding: 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: color-mix(in srgb, var(--surface-soft) 52%, transparent);
    }

    .group-form {
      grid-template-columns: minmax(0, 1fr) 30px;
    }

    .config-panel {
      display: grid;
      gap: 8px;
      margin-bottom: 10px;
      padding: 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: color-mix(in srgb, var(--surface-soft) 52%, transparent);
    }

    .config-panel[hidden] {
      display: none;
    }

    .config-panel-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      color: var(--vscode-sideBarTitle-foreground);
    }

    .column-config-list {
      display: grid;
      gap: 5px;
    }

    .summary-config-list {
      display: grid;
      gap: 5px;
    }

    .config-select-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, auto);
      gap: 8px;
      align-items: center;
      min-width: 0;
    }

    .column-config-item {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr) 28px 28px;
      gap: 5px;
      align-items: center;
      min-width: 0;
      padding: 4px;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: color-mix(in srgb, var(--surface) 72%, transparent);
    }

    .column-config-item label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .column-config-item input {
      min-height: 0;
      width: auto;
      margin: 0;
    }

    .summary-config-item {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      gap: 5px;
      align-items: center;
      min-width: 0;
      padding: 4px;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: color-mix(in srgb, var(--surface) 72%, transparent);
    }

    .summary-config-item label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .summary-config-item input {
      min-height: 0;
      width: auto;
      margin: 0;
    }

    .config-actions {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
    }

    .symbol-search-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 30px;
      gap: 6px;
    }

    .add-button {
      width: 100%;
    }

    .symbol-results {
      display: grid;
      gap: 4px;
      max-height: 168px;
      overflow-y: auto;
    }

    .symbol-result {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      width: 100%;
      min-height: 30px;
      padding: 5px 7px;
      border: 1px solid var(--border);
      border-radius: 5px;
      color: var(--vscode-foreground);
      background: transparent;
      text-align: left;
    }

    .symbol-result:hover,
    .symbol-result.selected {
      border-color: var(--focus);
      background: var(--surface-hover);
    }

    .symbol-result-main {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .symbol-result-code,
    .symbol-result-empty {
      color: var(--muted);
    }

    .symbol-result-empty {
      padding: 3px 1px;
    }

    .group-footer {
      display: grid;
      gap: 7px;
      padding: 8px;
      border-top: 1px solid var(--border);
      background: color-mix(in srgb, var(--surface-soft) 38%, transparent);
    }

    .group-footer-actions,
    .group-rename-row {
      display: flex;
      gap: 6px;
      align-items: center;
      justify-content: center;
      min-width: 0;
    }

    .group-rename-row input {
      flex: 1;
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
      line-height: 1.4;
    }

    .group {
      margin: 0 0 10px;
      border: 1px solid var(--border);
      border-radius: 7px;
      overflow: hidden;
      min-width: 0;
      max-width: 100%;
      background: var(--surface);
    }

    .quote-table {
      overflow-x: auto;
      overflow-y: hidden;
    }

    .group.editing {
      border-color: var(--focus);
    }

    #app {
      flex: 1;
      min-height: 0;
      min-width: 0;
      max-width: 100%;
      padding-bottom: 10px;
    }

    .group-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 8px 8px;
      color: var(--vscode-sideBarTitle-foreground);
      background: color-mix(in srgb, var(--surface-soft) 72%, transparent);
    }

    .group-title-actions {
      display: flex;
      gap: 6px;
      align-items: center;
      flex: 0 1 auto;
      min-width: 0;
    }

    .group-title-main {
      display: flex;
      gap: 6px;
      align-items: center;
      flex: 1;
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
      min-width: 0;
      overflow: hidden;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .count {
      color: var(--muted);
    }

    .quote {
      display: grid;
      position: relative;
      gap: 6px;
      align-items: center;
      min-width: 0;
      padding: 7px 8px;
      border-top: 1px solid var(--border);
      background: transparent;
      transition: background 120ms ease;
    }

    .quote:hover {
      background: var(--surface-hover);
    }

    .quote.highlight-up::before,
    .quote.highlight-down::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 2px;
      border-radius: 0;
      opacity: 0.46;
      pointer-events: none;
    }

    .quote.highlight-up::before {
      background: var(--row-highlight-up);
    }

    .quote.highlight-down::before {
      background: var(--row-highlight-down);
    }

    .quote.cols-1 {
      grid-template-columns: minmax(20px, 1fr);
    }

    .quote.cols-2 {
      grid-template-columns: repeat(2, minmax(20px, 1fr));
    }

    .quote.cols-3 {
      grid-template-columns: repeat(3, minmax(20px, 1fr));
    }

    .quote.cols-4 {
      grid-template-columns: repeat(4, minmax(20px, 1fr));
    }

    .quote.cols-5 {
      grid-template-columns: repeat(5, minmax(20px, 1fr));
    }

    .quote.cols-6 {
      grid-template-columns: repeat(6, minmax(20px, 1fr));
    }

    .quote.cols-7 {
      grid-template-columns: repeat(7, minmax(20px, 1fr));
    }

    .quote.cols-8 {
      grid-template-columns: repeat(8, minmax(20px, 1fr));
    }

    .quote.cols-9 {
      grid-template-columns: repeat(9, minmax(20px, 1fr));
    }

    .quote.cols-10 {
      grid-template-columns: repeat(10, minmax(20px, 1fr));
    }

    .quote.editing.cols-1 {
      grid-template-columns: minmax(20px, 1fr) max-content;
    }

    .quote.editing.cols-2 {
      grid-template-columns: repeat(2, minmax(20px, 1fr)) max-content;
    }

    .quote.editing.cols-3 {
      grid-template-columns: repeat(3, minmax(20px, 1fr)) max-content;
    }

    .quote.editing.cols-4 {
      grid-template-columns: repeat(4, minmax(20px, 1fr)) max-content;
    }

    .quote.editing.cols-5 {
      grid-template-columns: repeat(5, minmax(20px, 1fr)) max-content;
    }

    .quote.editing.cols-6 {
      grid-template-columns: repeat(6, minmax(20px, 1fr)) max-content;
    }

    .quote.editing.cols-7 {
      grid-template-columns: repeat(7, minmax(20px, 1fr)) max-content;
    }

    .quote.editing.cols-8 {
      grid-template-columns: repeat(8, minmax(20px, 1fr)) max-content;
    }

    .quote.editing.cols-9 {
      grid-template-columns: repeat(9, minmax(20px, 1fr)) max-content;
    }

    .quote.editing.cols-10 {
      grid-template-columns: repeat(10, minmax(20px, 1fr)) max-content;
    }

    .quote-header {
      color: var(--muted);
      background: color-mix(in srgb, var(--surface-soft) 42%, transparent);
    }

    .group-summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
      gap: 10px;
      padding: 7px 8px;
      border-top: 1px solid var(--border);
      color: var(--vscode-foreground);
      font-variant-numeric: tabular-nums;
    }

    .group-summary > span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: right;
    }

    .group-summary:not(.metrics-1) > span:first-child {
      text-align: left;
    }

    .sort-button {
      width: 100%;
      min-height: 0;
      padding: 0;
      border: 0;
      color: inherit;
      background: transparent;
      text-align: inherit;
      justify-content: inherit;
    }

    .sort-button:hover {
      background: transparent;
      color: var(--vscode-foreground);
    }

    .quote-cell {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .quote-header .quote-cell {
      position: relative;
      padding-right: 7px;
    }

    .column-resizer {
      position: absolute;
      top: -5px;
      right: -4px;
      width: 8px;
      height: calc(100% + 10px);
      border: 0;
      padding: 0;
      background: transparent;
      cursor: col-resize;
    }

    .column-resizer::after {
      content: "";
      position: absolute;
      top: 5px;
      right: 3px;
      width: 1px;
      height: calc(100% - 10px);
      background: transparent;
    }

    .column-resizer:hover::after {
      background: var(--focus);
    }

    body.resizing-columns {
      cursor: col-resize;
      user-select: none;
    }

    .quote-cell.numeric {
      text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
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
    }

    .alert-badge {
      display: inline-block;
      margin-left: 6px;
      color: var(--vscode-notificationsWarningIcon-foreground, var(--up));
    }

    .code,
    .meta {
      color: var(--muted);
    }

    .numbers {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
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
      min-width: 0;
      justify-content: flex-end;
    }

    .cell-input {
      width: 100%;
      min-width: 0;
      max-width: 86px;
      text-align: right;
      font-variant-numeric: tabular-nums;
      padding: 3px 5px;
      min-height: 24px;
    }

    .cell-input.text-input {
      min-width: 0;
      max-width: none;
      text-align: left;
      font-variant-numeric: normal;
    }

    .cell-input[type="number"] {
      appearance: textfield;
      -moz-appearance: textfield;
    }

    .cell-input[type="number"]::-webkit-outer-spin-button,
    .cell-input[type="number"]::-webkit-inner-spin-button {
      appearance: none;
      -webkit-appearance: none;
      margin: 0;
    }

    .cell-input[data-field="holding"] {
      ime-mode: disabled;
    }

    .index-dock {
      position: sticky;
      bottom: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) max-content;
      gap: 8px;
      align-items: flex-end;
      min-width: 0;
      max-width: 100%;
      padding-top: 8px;
      background: linear-gradient(to bottom, transparent, var(--surface) 30%);
      border-top: 1px solid var(--border);
    }

    .index-widget {
      display: grid;
      grid-template-columns: minmax(0, auto) auto;
      gap: 8px;
      align-items: center;
      min-width: 0;
      max-width: 100%;
      padding: 6px 0 0;
      justify-self: end;
    }

    .index-quote {
      min-width: 0;
      max-width: 45vw;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .refresh-error {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      padding: 6px 0 0;
      color: var(--vscode-errorForeground);
      white-space: nowrap;
    }

    .refresh-error-text {
      display: inline-block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      vertical-align: bottom;
    }

    .refresh-error.scrolling .refresh-error-text {
      max-width: none;
      padding-left: 100%;
      animation: market-monitoring-error-scroll 12s linear infinite;
    }

    .refreshing-index {
      animation: market-monitoring-breathe 1.25s ease-in-out infinite;
    }

    .group-name.refresh-succeeded {
      animation: market-monitoring-group-flash 900ms ease-out 1;
    }

    @keyframes market-monitoring-breathe {
      0%,
      100% {
        opacity: 1;
      }

      50% {
        opacity: 0.62;
      }
    }

    @keyframes market-monitoring-group-flash {
      0% {
        color: var(--vscode-sideBarTitle-foreground);
        text-shadow: none;
      }

      35% {
        color: var(--focus);
        text-shadow: 0 0 8px color-mix(in srgb, var(--focus) 42%, transparent);
      }

      100% {
        color: var(--vscode-sideBarTitle-foreground);
        text-shadow: none;
      }
    }

    @keyframes market-monitoring-error-scroll {
      0% {
        transform: translateX(0);
      }

      100% {
        transform: translateX(-100%);
      }
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
    <button class="secondary icon-button" id="import-csv" title="导入 CSV" aria-label="导入 CSV">⇧</button>
    <button class="secondary icon-button" id="export-csv" title="导出 CSV" aria-label="导出 CSV">⇩</button>
    <button class="secondary icon-button" id="settings" title="设置" aria-label="设置">⚙</button>
  </div>
  <form class="group-form" id="group-form">
    <input id="group-name" name="group" placeholder="新增分组" autocomplete="off">
    <button class="secondary icon-button" type="submit" title="新增分组" aria-label="新增分组">＋</button>
  </form>
  <section class="config-panel" id="config-panel" hidden></section>
  <div class="hint" id="sort-hint"></div>
  <main id="app"></main>
  <footer class="index-dock">
    <div id="refresh-error" class="refresh-error" hidden></div>
    <div class="index-widget">
      <select id="index-select" title="切换指数"></select>
      <div id="index-quote" class="index-quote flat">--</div>
    </div>
  </footer>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const defaultGroupName = ${JSON.stringify(DEFAULT_GROUP)};
    const availableQuoteColumns = ${JSON.stringify(AVAILABLE_QUOTE_COLUMNS)};
    const availableGroupSummaryMetrics = ${JSON.stringify(AVAILABLE_GROUP_SUMMARY_METRICS)};
    const languageLabels = ${JSON.stringify(LANGUAGE_LABELS)};
    const i18n = {
      'zh-CN': {
        notStarted: '未启动',
        start: '启动',
        pause: '暂停',
        refresh: '刷新',
        importCsv: '导入 CSV',
        exportCsv: '导出 CSV',
        settings: '设置',
        addGroup: '新增分组',
        switchIndex: '切换指数',
        refreshing: '刷新中',
        sortHint: '当前按行情字段自动排序；上移/下移会调整配置顺序，在 sortBy 设为 configured 时按该顺序显示。',
        noSymbols: '暂无标的，请在设置中配置 marketMonitoring.symbols。',
        tableColumns: '表格列',
        language: '语言',
        openNativeSettings: '打开 VS Code 设置',
        resetColumns: '恢复默认列',
        showColumn: '显示',
        moveUp: '上移',
        moveDown: '下移',
        expand: '展开',
        collapse: '折叠',
        currentAssets: '当前总资产',
        dailyProfitSummary: '按涨跌额 * 持仓汇总',
        groupSummary: '分组汇总',
        showMetric: '显示',
        totalAssets: '总资产',
        dailyProfit: '今日收益',
        dailyProfitPercent: '今日收益率',
        groupName: '分组名称',
        saveGroupName: '保存分组名称',
        collapseAdd: '收起添加',
        addSymbol: '添加标的',
        doneEditing: '完成修改',
        editGroup: '修改分组',
        searchPlaceholder: '搜索名称、代码或拼音',
        addToGroup: '添加到该分组',
        searchPending: '搜索中...',
        noMatches: '没有找到匹配标的',
        choose: '选择',
        selectFromResults: '请先从搜索结果中选择标的',
        sortByColumn: '排序',
        dragColumnWidth: '拖动调整列宽',
        action: '操作',
        deleteSymbol: '删除标的',
        alert: '预警',
        name: '名称',
        alias: '别名',
        code: '代码',
        price: '价格',
        changePercent: '涨跌幅',
        change: '涨跌额',
        cost: '成本',
        holding: '持仓',
        position: '仓位',
        netProfit: '净收益额'
      },
      'en-US': {
        notStarted: 'Not started',
        start: 'Start',
        pause: 'Pause',
        refresh: 'Refresh',
        importCsv: 'Import CSV',
        exportCsv: 'Export CSV',
        settings: 'Settings',
        addGroup: 'Add group',
        switchIndex: 'Switch index',
        refreshing: 'Refreshing',
        sortHint: 'Currently sorted by quote fields. Up/down changes the configured order, shown when sortBy is configured.',
        noSymbols: 'No symbols yet. Configure marketMonitoring.symbols in settings.',
        tableColumns: 'Table columns',
        language: 'Language',
        openNativeSettings: 'Open VS Code Settings',
        resetColumns: 'Reset columns',
        showColumn: 'Show',
        moveUp: 'Move up',
        moveDown: 'Move down',
        expand: 'Expand',
        collapse: 'Collapse',
        currentAssets: 'Current assets',
        dailyProfitSummary: 'Summary by price change * holding',
        groupSummary: 'Group summary',
        showMetric: 'Show',
        totalAssets: 'Total assets',
        dailyProfit: 'Today profit',
        dailyProfitPercent: 'Today profit %',
        groupName: 'Group name',
        saveGroupName: 'Save group name',
        collapseAdd: 'Collapse add form',
        addSymbol: 'Add symbol',
        doneEditing: 'Done',
        editGroup: 'Edit group',
        searchPlaceholder: 'Search name, code, or pinyin',
        addToGroup: 'Add to this group',
        searchPending: 'Searching...',
        noMatches: 'No matching symbols',
        choose: 'Choose',
        selectFromResults: 'Choose a symbol from search results first',
        sortByColumn: 'Sort',
        dragColumnWidth: 'Drag to resize column',
        action: 'Action',
        deleteSymbol: 'Delete symbol',
        alert: 'Alert',
        name: 'Name',
        alias: 'Alias',
        code: 'Code',
        price: 'Price',
        changePercent: 'Change %',
        change: 'Change',
        cost: 'Cost',
        holding: 'Holding',
        position: 'Position',
        netProfit: 'Net profit'
      }
    };
    let viewState = vscode.getState() || {};
    const app = document.getElementById('app');
    const phase = document.getElementById('phase');
    const toggle = document.getElementById('toggle');
    const refresh = document.getElementById('refresh');
    const importCsv = document.getElementById('import-csv');
    const exportCsv = document.getElementById('export-csv');
    const settings = document.getElementById('settings');
    const groupForm = document.getElementById('group-form');
    const groupName = document.getElementById('group-name');
    const configPanel = document.getElementById('config-panel');
    const sortHint = document.getElementById('sort-hint');
    const indexSelect = document.getElementById('index-select');
    const indexQuote = document.getElementById('index-quote');
    const refreshError = document.getElementById('refresh-error');
    const dynamicColors = document.getElementById('dynamic-colors');
    let locale = 'zh-CN';
    let selectedIndexCode = viewState.selectedIndexCode || 'sh000001';
    let editingGroups = viewState.editingGroups || {};
    let collapsedGroups = viewState.collapsedGroups || {};
    let addingGroups = viewState.addingGroups || {};
    let settingsOpen = Boolean(viewState.settingsOpen);
    let tableSort = viewState.tableSort || {};
    let columnWidths = viewState.columnWidths || {};
    let resizingColumn;
    let symbolSearchTimer;
    let symbolSearchRequestId = 0;
    let activeSymbolSearchRequestId = 0;
    let activeSymbolGroup = '';
    let symbolSearchQuery = '';
    let symbolSearchResults = [];
    let selectedSymbol;
    let symbolSearchLoading = false;
    let symbolSearchError = '';
    let latestSnapshot;
    let lastFlashedUpdatedAt = viewState.lastFlashedUpdatedAt || '';

    refresh.addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    importCsv.addEventListener('click', () => vscode.postMessage({ command: 'importCsv' }));
    exportCsv.addEventListener('click', () => vscode.postMessage({ command: 'exportCsv' }));
    settings.addEventListener('click', () => {
      settingsOpen = !settingsOpen;
      persistViewState();
      renderConfigPanel(latestSnapshot);
    });
    toggle.addEventListener('click', () => {
      const running = toggle.dataset.running === 'true';
      vscode.postMessage({ command: running ? 'stop' : 'start' });
    });
    groupForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = groupName.value.trim();
      if (!name) {
        groupName.focus();
        return;
      }

      vscode.postMessage({
        command: 'addGroup',
        name
      });
      groupName.value = '';
      groupName.focus();
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
        const nextEditing = !editingGroups[group];
        editingGroups = {
          ...editingGroups,
          [group]: nextEditing
        };
        persistViewState();
        if (!nextEditing && document.activeElement && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur();
        }
        if (latestSnapshot) {
          app.innerHTML = renderGroups(latestSnapshot.groups, latestSnapshot);
          applyColumnWidths();
        }
      } else if (action === 'addToGroup') {
        const group = button.dataset.group || '';
        const opening = !addingGroups[group];
        addingGroups = {
          ...addingGroups,
          [group]: opening
        };
        activeSymbolGroup = opening ? group : '';
        symbolSearchQuery = '';
        symbolSearchResults = [];
        selectedSymbol = undefined;
        symbolSearchError = '';
        symbolSearchLoading = false;
        persistViewState();
        if (latestSnapshot) {
          app.innerHTML = renderGroups(latestSnapshot.groups, latestSnapshot);
          focusGroupSearch(group);
        }
      } else if (action === 'selectSymbol') {
        selectedSymbol = {
          code: button.dataset.code,
          name: button.dataset.name
        };
        symbolSearchQuery = selectedSymbol.name + ' ' + selectedSymbol.code;
        renderActiveSymbolResults();
      } else if (action === 'confirmAddSymbol') {
        const group = button.dataset.group || activeSymbolGroup || defaultGroupName;
        if (!selectedSymbol && symbolSearchResults.length === 1) {
          selectedSymbol = symbolSearchResults[0];
        }

        if (!selectedSymbol) {
          symbolSearchError = t('selectFromResults');
          renderActiveSymbolResults();
          focusGroupSearch(group);
          return;
        }

        vscode.postMessage({
          command: 'addSymbol',
          symbol: {
            code: selectedSymbol.code,
            name: selectedSymbol.name,
            group
          }
        });
        addingGroups = {
          ...addingGroups,
          [group]: false
        };
        activeSymbolGroup = '';
        symbolSearchQuery = '';
        symbolSearchResults = [];
        selectedSymbol = undefined;
        symbolSearchError = '';
        persistViewState();
        if (latestSnapshot) {
          app.innerHTML = renderGroups(latestSnapshot.groups, latestSnapshot);
          applyColumnWidths();
        }
      } else if (action === 'renameGroup') {
        const oldName = button.dataset.group || '';
        const section = button.closest('section');
        const input = section ? section.querySelector('input[data-group-name]') : undefined;
        const newName = input ? input.value.trim() : '';
        if (newName) {
          vscode.postMessage({
            command: 'renameGroup',
            oldName,
            newName
          });
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
      } else if (action === 'sortColumn') {
        const group = button.dataset.group || '';
        const column = button.dataset.column || '';
        const current = tableSort[group];
        let nextSort;
        if (!current || current.column !== column) {
          nextSort = { column, direction: 'asc' };
        } else if (current.direction === 'asc') {
          nextSort = { column, direction: 'desc' };
        } else {
          nextSort = undefined;
        }

        tableSort = { ...tableSort };
        if (nextSort) {
          tableSort[group] = nextSort;
        } else {
          delete tableSort[group];
        }
        persistViewState();
        if (latestSnapshot) {
          app.innerHTML = renderGroups(latestSnapshot.groups, latestSnapshot);
        }
      } else if (action === 'moveQuoteColumn') {
        const column = button.dataset.column || '';
        const direction = button.dataset.direction === 'up' ? -1 : 1;
        updateQuoteColumns(moveQuoteColumn(latestSnapshot && latestSnapshot.quoteColumns, column, direction));
      } else if (action === 'resetQuoteColumns') {
        updateQuoteColumns(['name', 'price', 'changePercent']);
      } else if (action === 'openNativeSettings') {
        vscode.postMessage({ command: 'settings' });
      }
    });
    configPanel.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) {
        return;
      }
      const action = button.dataset.action;
      if (action === 'moveQuoteColumn') {
        const column = button.dataset.column || '';
        const direction = button.dataset.direction === 'up' ? -1 : 1;
        updateQuoteColumns(moveQuoteColumn(latestSnapshot && latestSnapshot.quoteColumns, column, direction));
      } else if (action === 'resetQuoteColumns') {
        updateQuoteColumns(['name', 'price', 'changePercent']);
      } else if (action === 'resetGroupSummaryMetrics') {
        updateGroupSummaryMetrics([]);
      } else if (action === 'openNativeSettings') {
        vscode.postMessage({ command: 'settings' });
      }
    });
    configPanel.addEventListener('change', (event) => {
      const select = event.target.closest('select[data-setting="language"]');
      if (select) {
        updateLanguage(select.value);
        return;
      }
      const input = event.target.closest('input[data-column]');
      if (input) {
        updateQuoteColumns(toggleQuoteColumn(latestSnapshot && latestSnapshot.quoteColumns, input.dataset.column, input.checked));
        return;
      }

      const metricInput = event.target.closest('input[data-summary-metric]');
      if (metricInput) {
        updateGroupSummaryMetrics(toggleGroupSummaryMetric(latestSnapshot && latestSnapshot.groupSummaryMetrics, metricInput.dataset.summaryMetric, metricInput.checked));
      }
    });
    app.addEventListener('pointerdown', (event) => {
      const handle = event.target.closest('.column-resizer');
      if (!handle) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const cell = handle.closest('.quote-cell');
      if (!cell) {
        return;
      }

      resizingColumn = {
        column: handle.dataset.column,
        startX: event.clientX,
        startWidth: cell.getBoundingClientRect().width
      };
      document.body.classList.add('resizing-columns');
    });
    window.addEventListener('pointermove', (event) => {
      if (!resizingColumn) {
        return;
      }

      const width = Math.max(20, Math.round(resizingColumn.startWidth + event.clientX - resizingColumn.startX));
      columnWidths = {
        ...columnWidths,
        [resizingColumn.column]: width
      };
      applyColumnWidths();
    });
    window.addEventListener('pointerup', () => {
      if (!resizingColumn) {
        return;
      }

      resizingColumn = undefined;
      document.body.classList.remove('resizing-columns');
      persistViewState();
    });
    app.addEventListener('input', (event) => {
      const input = event.target.closest('input[data-symbol-query]');
      if (!input) {
        return;
      }

      activeSymbolGroup = input.dataset.group || '';
      symbolSearchQuery = input.value.trim();
      selectedSymbol = undefined;
      symbolSearchError = '';
      window.clearTimeout(symbolSearchTimer);

      if (!symbolSearchQuery) {
        activeSymbolSearchRequestId = ++symbolSearchRequestId;
        symbolSearchResults = [];
        symbolSearchLoading = false;
        renderActiveSymbolResults();
        return;
      }

      symbolSearchLoading = true;
      renderActiveSymbolResults();
      const requestId = ++symbolSearchRequestId;
      activeSymbolSearchRequestId = requestId;
      symbolSearchTimer = window.setTimeout(() => {
        vscode.postMessage({
          command: 'searchSymbols',
          requestId,
          query: symbolSearchQuery
        });
      }, 260);
    });
    app.addEventListener('change', (event) => {
      const input = event.target.closest('input[data-field]');
      if (!input) {
        return;
      }

      const index = Number(input.dataset.index);
      const field = input.dataset.field;
      const value = input.value.trim();
      vscode.postMessage({
        command: 'updateSymbolField',
        index,
        field,
        value
      });
      updateLocalSymbolField(index, field, value);
    });
    app.addEventListener('keydown', (event) => {
      const searchInput = event.target.closest('input[data-symbol-query]');
      if (searchInput && event.key === 'Enter') {
        event.preventDefault();
        const group = searchInput.dataset.group || activeSymbolGroup || defaultGroupName;
        const button = Array.from(app.querySelectorAll('button[data-action="confirmAddSymbol"]')).find((item) => item.dataset.group === group);
        if (button && !button.disabled) {
          button.click();
        }
        return;
      }

      const groupNameInput = event.target.closest('input[data-group-name]');
      if (groupNameInput && event.key === 'Enter') {
        event.preventDefault();
        const section = groupNameInput.closest('section');
        const button = section ? section.querySelector('button[data-action="renameGroup"]') : undefined;
        if (button) {
          button.click();
        }
        return;
      }

      const input = event.target.closest('input[data-field]');
      if (!input || event.key !== 'Enter') {
        return;
      }

      event.preventDefault();
      input.blur();
    });
    indexSelect.addEventListener('change', () => {
      selectedIndexCode = indexSelect.value || 'sh000001';
      persistViewState();
      renderIndex(latestSnapshot);
      vscode.postMessage({ command: 'refreshIndex' });
    });

    window.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'snapshot') {
        safeRender(event.data.snapshot);
      } else if (event.data && event.data.type === 'symbolSearchResults') {
        if (event.data.requestId !== activeSymbolSearchRequestId) {
          return;
        }

        symbolSearchLoading = false;
        symbolSearchResults = Array.isArray(event.data.results) ? event.data.results : [];
        symbolSearchError = event.data.error || '';
        renderActiveSymbolResults();
      }
    });

    window.addEventListener('error', (event) => {
      reportWebviewError(event.message, event.filename, event.lineno, event.colno);
    });

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      const message = reason && reason.message ? reason.message : String(reason || 'Unhandled promise rejection');
      reportWebviewError(message, '', 0, 0);
    });

    function renderActiveSymbolResults() {
      const container = Array.from(app.querySelectorAll('[data-symbol-results-group]')).find((item) => item.dataset.symbolResultsGroup === activeSymbolGroup);
      const addButton = Array.from(app.querySelectorAll('button[data-action="confirmAddSymbol"]')).find((item) => item.dataset.group === activeSymbolGroup);
      const queryInput = Array.from(app.querySelectorAll('input[data-symbol-query]')).find((item) => item.dataset.group === activeSymbolGroup);
      if (queryInput && queryInput.value !== symbolSearchQuery) {
        queryInput.value = symbolSearchQuery;
      }
      if (addButton) {
        addButton.disabled = !selectedSymbol;
      }
      if (!container) {
        return;
      }
      if (!symbolSearchQuery) {
        container.innerHTML = '';
        return;
      }

      if (symbolSearchLoading) {
        container.innerHTML = '<div class="symbol-result-empty">' + escapeHtml(t('searchPending')) + '</div>';
        return;
      }

      if (symbolSearchError) {
        container.innerHTML = '<div class="symbol-result-empty">' + escapeHtml(symbolSearchError) + '</div>';
        return;
      }

      if (symbolSearchResults.length === 0) {
        container.innerHTML = '<div class="symbol-result-empty">' + escapeHtml(t('noMatches')) + '</div>';
        return;
      }

      container.innerHTML = symbolSearchResults.map((item) => {
        const selected = selectedSymbol && selectedSymbol.code === item.code;
        return '<button type="button" class="symbol-result' + (selected ? ' selected' : '') + '" data-action="selectSymbol" data-code="' + escapeHtml(item.code) + '" data-name="' + escapeHtml(item.name) + '" title="' + escapeHtml(t('choose') + ' ' + item.name) + '">' +
          '<span class="symbol-result-main">' + escapeHtml(item.name) + '</span>' +
          '<span class="symbol-result-code">' + escapeHtml(item.market || '') + ' ' + escapeHtml(item.code) + '</span>' +
        '</button>';
      }).join('');
    }

    function t(key) {
      const dict = i18n[locale] || i18n['zh-CN'];
      return dict[key] || i18n['zh-CN'][key] || key;
    }

    function getLanguageLabel(language) {
      return languageLabels[language] || language;
    }

    function applyColumnWidths() {
      for (const row of app.querySelectorAll('.quote[data-columns]')) {
        const columns = row.dataset.columns.split(',');
        const template = getGridTemplate(columns, row.classList.contains('editing'));
        if (template) {
          row.style.gridTemplateColumns = template;
        } else {
          row.style.removeProperty('grid-template-columns');
        }
      }
    }

    function safeRender(snapshot) {
      try {
        render(snapshot);
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        reportWebviewError(message, '', 0, 0);
        renderRefreshError(message);
      }
    }

    function render(snapshot) {
      const flashGroupNames = Boolean(latestSnapshot)
        && !snapshot.loading
        && !snapshot.error
        && snapshot.updatedAt
        && snapshot.updatedAt !== lastFlashedUpdatedAt;
      latestSnapshot = snapshot;
      locale = snapshot.locale || 'zh-CN';
      document.documentElement.lang = locale;
      updateStaticLabels();
      const rowHighlightUp = snapshot.colors.mode === 'none' ? '#d73a49' : snapshot.colors.up;
      const rowHighlightDown = snapshot.colors.mode === 'none' ? '#16a34a' : snapshot.colors.down;
      dynamicColors.textContent = ':root{--up:' + snapshot.colors.up + ';--down:' + snapshot.colors.down + ';--flat:' + snapshot.colors.flat + ';--row-highlight-up:' + rowHighlightUp + ';--row-highlight-down:' + rowHighlightDown + ';}';
      toggle.dataset.running = String(snapshot.running);
      toggle.textContent = snapshot.running ? '⏸' : '▶';
      toggle.title = snapshot.running ? t('pause') : t('start');
      toggle.setAttribute('aria-label', toggle.title);
      renderConfigPanel(snapshot);

      const extra = snapshot.updatedAt ? ' · ' + snapshot.updatedAt : '';
      phase.textContent = (snapshot.loading ? t('refreshing') + ' · ' : '') + localizePhase(snapshot.phaseName) + extra;
      app.classList.toggle('refreshing', Boolean(snapshot.loading));
      renderRefreshError(snapshot.error);
      sortHint.textContent = snapshot.sortBy === 'configured'
        ? ''
        : t('sortHint');

      if (shouldFreezeQuoteRender()) {
        renderIndex(snapshot);
        if (flashGroupNames) {
          lastFlashedUpdatedAt = snapshot.updatedAt;
          persistViewState();
        }
        return;
      }

      if (snapshot.error) {
        app.innerHTML = renderGroups(snapshot.groups, snapshot);
        applyColumnWidths();
        renderIndex(snapshot);
        return;
      }

      app.innerHTML = renderGroups(snapshot.groups, snapshot, flashGroupNames);
      applyColumnWidths();
      renderIndex(snapshot);
      if (flashGroupNames) {
        lastFlashedUpdatedAt = snapshot.updatedAt;
        persistViewState();
      }
    }

    function shouldFreezeQuoteRender() {
      const activeElement = document.activeElement;
      return app.innerHTML.trim() !== ''
        && activeElement
        && app.contains(activeElement)
        && Boolean(activeElement.closest('input[data-field], input[data-group-name], input[data-symbol-query], .group-symbol-form'));
    }

    function renderRefreshError(error) {
      const message = String(error || '').trim();
      refreshError.hidden = !message;
      refreshError.innerHTML = message ? '<span class="refresh-error-text">' + escapeHtml(message) + '</span>' : '';
      refreshError.title = message;
      window.requestAnimationFrame(() => {
        const text = refreshError.querySelector('.refresh-error-text');
        refreshError.classList.toggle('scrolling', Boolean(text && text.scrollWidth > refreshError.clientWidth));
      });
    }

    function updateStaticLabels() {
      refresh.title = t('refresh');
      refresh.setAttribute('aria-label', t('refresh'));
      importCsv.title = t('importCsv');
      importCsv.setAttribute('aria-label', t('importCsv'));
      exportCsv.title = t('exportCsv');
      exportCsv.setAttribute('aria-label', t('exportCsv'));
      settings.title = t('settings');
      settings.setAttribute('aria-label', t('settings'));
      groupName.placeholder = t('addGroup');
      const addGroupButton = groupForm.querySelector('button[type="submit"]');
      if (addGroupButton) {
        addGroupButton.title = t('addGroup');
        addGroupButton.setAttribute('aria-label', t('addGroup'));
      }
      indexSelect.title = t('switchIndex');
    }

    function localizePhase(value) {
      const phaseMap = {
        '未启动': { 'zh-CN': '未启动', 'en-US': 'Not started' },
        '已暂停': { 'zh-CN': '已暂停', 'en-US': 'Paused' },
        '休市': { 'zh-CN': '休市', 'en-US': 'Closed' },
        '开盘集合竞价': { 'zh-CN': '开盘集合竞价', 'en-US': 'Opening call auction' },
        '竞价撮合': { 'zh-CN': '竞价撮合', 'en-US': 'Auction matching' },
        '上午连续竞价': { 'zh-CN': '上午连续竞价', 'en-US': 'Morning continuous auction' },
        '午间休市': { 'zh-CN': '午间休市', 'en-US': 'Midday break' },
        '下午连续竞价': { 'zh-CN': '下午连续竞价', 'en-US': 'Afternoon continuous auction' },
        '收盘集合竞价': { 'zh-CN': '收盘集合竞价', 'en-US': 'Closing call auction' },
        '非交易时段': { 'zh-CN': '非交易时段', 'en-US': 'Non-trading session' }
      };
      const translated = phaseMap[value];
      return translated ? translated[locale] || translated['zh-CN'] : value;
    }

    function renderConfigPanel(snapshot) {
      configPanel.hidden = !settingsOpen;
      if (!settingsOpen) {
        configPanel.innerHTML = '';
        return;
      }

      const columns = normalizeQuoteColumns(snapshot && snapshot.quoteColumns);
      const orderedColumns = getConfigPanelColumns(columns);
      const groupSummaryMetrics = normalizeGroupSummaryMetrics(snapshot && snapshot.groupSummaryMetrics);
      const selectedLanguage = snapshot && snapshot.language ? snapshot.language : 'auto';
      configPanel.innerHTML = '<div class="config-panel-title">' +
          '<span>' + escapeHtml(t('tableColumns')) + '</span>' +
          '<button class="secondary icon-button" data-action="openNativeSettings" title="' + escapeHtml(t('openNativeSettings')) + '" aria-label="' + escapeHtml(t('openNativeSettings')) + '">⚙</button>' +
        '</div>' +
        '<label class="config-select-row">' +
          '<span>' + escapeHtml(t('language')) + '</span>' +
          '<select data-setting="language">' +
            ['auto', 'zh-CN', 'en-US'].map((language) => '<option value="' + language + '"' + (language === selectedLanguage ? ' selected' : '') + '>' + escapeHtml(getLanguageLabel(language)) + '</option>').join('') +
          '</select>' +
        '</label>' +
        '<div class="config-panel-title">' +
          '<span>' + escapeHtml(t('groupSummary')) + '</span>' +
        '</div>' +
        '<div class="summary-config-list">' +
          availableGroupSummaryMetrics.map((metric) => renderGroupSummaryMetricItem(metric, groupSummaryMetrics)).join('') +
        '</div>' +
        '<div class="config-panel-title">' +
          '<span>' + escapeHtml(t('tableColumns')) + '</span>' +
        '</div>' +
        '<div class="column-config-list">' +
          orderedColumns.map((column) => renderColumnConfigItem(column, columns)).join('') +
        '</div>' +
        '<div class="config-actions">' +
          '<button class="secondary icon-button" data-action="resetQuoteColumns" title="' + escapeHtml(t('resetColumns')) + '" aria-label="' + escapeHtml(t('resetColumns')) + '">↺</button>' +
        '</div>';
    }

    function getConfigPanelColumns(columns) {
      const visible = normalizeQuoteColumns(columns);
      const hidden = availableQuoteColumns.filter((column) => !visible.includes(column));
      return [...visible, ...hidden];
    }

    function renderColumnConfigItem(column, columns) {
      const visible = columns.includes(column);
      const visibleIndex = columns.indexOf(column);
      const canMoveUp = visible && visibleIndex > 0;
      const canMoveDown = visible && visibleIndex >= 0 && visibleIndex < columns.length - 1;
      const canHide = !visible || columns.length > 1;
      return '<div class="column-config-item">' +
        '<input type="checkbox" data-column="' + escapeHtml(column) + '" title="' + escapeHtml(t('showColumn') + ' ' + getColumnLabel(column)) + '" aria-label="' + escapeHtml(t('showColumn') + ' ' + getColumnLabel(column)) + '" ' + (visible ? 'checked ' : '') + (canHide ? '' : 'disabled') + '>' +
        '<label>' + escapeHtml(getColumnLabel(column)) + '</label>' +
        '<button class="secondary icon-button" data-action="moveQuoteColumn" data-column="' + escapeHtml(column) + '" data-direction="up" title="' + escapeHtml(t('moveUp')) + '" aria-label="' + escapeHtml(t('moveUp')) + '" ' + (canMoveUp ? '' : 'disabled') + '>↑</button>' +
        '<button class="secondary icon-button" data-action="moveQuoteColumn" data-column="' + escapeHtml(column) + '" data-direction="down" title="' + escapeHtml(t('moveDown')) + '" aria-label="' + escapeHtml(t('moveDown')) + '" ' + (canMoveDown ? '' : 'disabled') + '>↓</button>' +
      '</div>';
    }

    function renderGroupSummaryMetricItem(metric, metrics) {
      const visible = metrics.includes(metric);
      return '<div class="summary-config-item">' +
        '<input type="checkbox" data-summary-metric="' + escapeHtml(metric) + '" title="' + escapeHtml(t('showMetric') + ' ' + getGroupSummaryMetricLabel(metric)) + '" aria-label="' + escapeHtml(t('showMetric') + ' ' + getGroupSummaryMetricLabel(metric)) + '" ' + (visible ? 'checked ' : '') + '>' +
        '<label>' + escapeHtml(getGroupSummaryMetricLabel(metric)) + '</label>' +
      '</div>';
    }

    function updateQuoteColumns(columns) {
      const normalized = normalizeQuoteColumns(columns);
      vscode.postMessage({
        command: 'updateQuoteColumns',
        columns: normalized
      });
      if (latestSnapshot) {
        latestSnapshot = {
          ...latestSnapshot,
          quoteColumns: normalized
        };
        renderConfigPanel(latestSnapshot);
        if (!shouldFreezeQuoteRender()) {
          app.innerHTML = renderGroups(latestSnapshot.groups, latestSnapshot);
          applyColumnWidths();
        }
      }
    }

    function updateGroupSummaryMetrics(metrics) {
      const normalized = normalizeGroupSummaryMetrics(metrics);
      vscode.postMessage({
        command: 'updateGroupSummaryMetrics',
        metrics: normalized
      });
      if (latestSnapshot) {
        latestSnapshot = {
          ...latestSnapshot,
          groupSummaryMetrics: normalized
        };
        renderConfigPanel(latestSnapshot);
        if (!shouldFreezeQuoteRender()) {
          app.innerHTML = renderGroups(latestSnapshot.groups, latestSnapshot);
          applyColumnWidths();
        }
      }
    }

    function updateLanguage(language) {
      vscode.postMessage({
        command: 'updateLanguage',
        language
      });
      if (latestSnapshot) {
        latestSnapshot = {
          ...latestSnapshot,
          language,
          locale: language === 'auto' ? latestSnapshot.locale : language
        };
        render(latestSnapshot);
      }
    }

    function updateLocalSymbolField(index, field, value) {
      if (!latestSnapshot || !Number.isInteger(index) || !['name', 'cost', 'holding'].includes(field)) {
        return;
      }

      const parsedValue = parseLocalSymbolFieldValue(index, field, value);
      const updateSymbol = (symbol, currentIndex) => {
        if (currentIndex !== index) {
          return symbol;
        }
        return {
          ...symbol,
          [field]: parsedValue
        };
      };
      const updateQuote = (quote) => {
        if (quote.index !== index) {
          return quote;
        }
        return {
          ...quote,
          [field]: parsedValue
        };
      };

      latestSnapshot = {
        ...latestSnapshot,
        configuredSymbols: Array.isArray(latestSnapshot.configuredSymbols)
          ? latestSnapshot.configuredSymbols.map(updateSymbol)
          : latestSnapshot.configuredSymbols,
        groups: Array.isArray(latestSnapshot.groups)
          ? latestSnapshot.groups.map((group) => ({
              ...group,
              items: Array.isArray(group.items) ? group.items.map(updateQuote) : group.items
            }))
          : latestSnapshot.groups
      };

      window.setTimeout(() => {
        if (latestSnapshot && !shouldFreezeQuoteRender()) {
          app.innerHTML = renderGroups(latestSnapshot.groups, latestSnapshot);
          applyColumnWidths();
        }
      }, 0);
    }

    function parseLocalSymbolFieldValue(index, field, value) {
      if (field === 'name') {
        const trimmed = String(value || '').trim();
        const configured = Array.isArray(latestSnapshot.configuredSymbols) ? latestSnapshot.configuredSymbols[index] : undefined;
        return trimmed || (configured && configured.code) || '';
      }
      if (value === '') {
        return null;
      }

      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        return null;
      }
      return field === 'holding' ? Math.trunc(parsed) : parsed;
    }

    function toggleQuoteColumn(currentColumns, column, checked) {
      const columns = normalizeQuoteColumns(currentColumns);
      if (checked) {
        return columns.includes(column) ? columns : [...columns, column];
      }
      if (columns.length <= 1) {
        return columns;
      }
      return columns.filter((item) => item !== column);
    }

    function moveQuoteColumn(currentColumns, column, direction) {
      const columns = normalizeQuoteColumns(currentColumns);
      const index = columns.indexOf(column);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= columns.length) {
        return columns;
      }
      const nextColumns = [...columns];
      [nextColumns[index], nextColumns[nextIndex]] = [nextColumns[nextIndex], nextColumns[index]];
      return nextColumns;
    }

    function toggleGroupSummaryMetric(currentMetrics, metric, checked) {
      const metrics = normalizeGroupSummaryMetrics(currentMetrics);
      if (checked) {
        return metrics.includes(metric) ? metrics : [...metrics, metric];
      }
      return metrics.filter((item) => item !== metric);
    }

    function normalizeQuoteColumns(columns) {
      const source = Array.isArray(columns) && columns.length > 0 ? columns : ['name', 'price', 'changePercent'];
      const normalized = source.filter((column, index) => availableQuoteColumns.includes(column) && source.indexOf(column) === index);
      return normalized.length > 0 ? normalized : ['name', 'price', 'changePercent'];
    }

    function normalizeGroupSummaryMetrics(metrics) {
      if (!Array.isArray(metrics)) {
        return [];
      }
      return metrics.filter((metric, index) => availableGroupSummaryMetrics.includes(metric) && metrics.indexOf(metric) === index);
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
        indexQuote.className = snapshot.loading ? 'index-quote refreshing-index' : 'index-quote';
        indexQuote.textContent = '--';
        return;
      }

      const trend = selected.changePercent > 0 ? 'up' : selected.changePercent < 0 ? 'down' : 'flat';
      const price = selected.price === null ? '--' : formatDecimal(selected.price, snapshot.priceDecimalPlaces);
      const percent = selected.changePercent === null ? '--' : formatSigned(selected.changePercent, 2) + '%';
      indexQuote.className = snapshot.loading ? 'index-quote refreshing-index' : 'index-quote';
      indexQuote.innerHTML = '<span class="index-price">' + price + '</span> <span class="quote-change ' + trend + '">' + percent + '</span>';
    }

    function renderGroups(groups, snapshot, flashGroupNames = false) {
      const visibleGroups = Array.isArray(groups) && groups.length > 0
        ? groups
        : buildFallbackGroups(snapshot);

      if (!visibleGroups || visibleGroups.length === 0) {
        return '<div class="empty">' + escapeHtml(t('noSymbols')) + '</div>';
      }

      return visibleGroups.map((group) => {
        const editing = Boolean(editingGroups[group.name]);
        const collapsed = Boolean(collapsedGroups[group.name]);
        const columns = snapshot.quoteColumns || ['name', 'price', 'changePercent'];
        const sort = tableSort[group.name];
        const adding = Boolean(addingGroups[group.name]);
        const positionTotal = calculateGroupPositionTotal(group.items);
        const itemsWithPosition = group.items.map((item) => ({
          ...item,
          position: calculatePosition(item, positionTotal)
        }));
        const sortedItems = editing ? itemsWithPosition : sort ? sortQuotesForColumn(itemsWithPosition, sort.column, sort.direction) : itemsWithPosition;
        const gridClass = getQuoteGridClass(columns);
        const header = collapsed ? '' : renderQuoteHeader(group.name, columns, editing, gridClass, sort);
        const items = collapsed ? '' : sortedItems.map((quote, itemIndex) => renderQuote(quote, snapshot, editing, columns, gridClass, itemIndex, sortedItems.length)).join('');
        const summary = collapsed ? '' : renderGroupSummary(group.items, snapshot.groupSummaryMetrics, snapshot.compactLargeAmounts);
        const table = collapsed ? '' : '<div class="quote-table">' + header + items + summary + '</div>';
        const footer = collapsed ? '' : renderGroupFooter(group.name, editing, adding);
        const stats = group.stats || { up: 0, down: 0, flat: 0, averageChangePercent: null };
        const upStat = stats.up > 0 ? '<span class="up">↑' + stats.up + '</span>' : '';
        const downStat = stats.down > 0 ? '<span class="down">↓' + stats.down + '</span>' : '';
        const flatStat = stats.flat > 0 ? '<span class="flat">=' + stats.flat + '</span>' : '';
        return '<section class="group' + (editing ? ' editing' : '') + '">' +
          '<div class="group-title">' +
            '<span class="group-title-main">' +
              '<button class="secondary icon-button" data-action="toggleGroup" data-group="' + escapeHtml(group.name) + '" title="' + (collapsed ? escapeHtml(t('expand')) : escapeHtml(t('collapse'))) + '" aria-label="' + (collapsed ? escapeHtml(t('expand')) : escapeHtml(t('collapse'))) + '">' + (collapsed ? '›' : '⌄') + '</button>' +
              '<span class="group-name' + (flashGroupNames ? ' refresh-succeeded' : '') + '">' + escapeHtml(group.name) + '</span>' +
            '</span>' +
            '<span class="group-title-actions">' +
              '<span class="group-stats">' +
                upStat +
                downStat +
                flatStat +
              '</span>' +
            '</span>' +
          '</div>' +
          table +
          footer +
          '</section>';
      }).join('');
    }

    function buildFallbackGroups(snapshot) {
      const symbols = Array.isArray(snapshot.configuredSymbols) ? snapshot.configuredSymbols : [];
      const groupNames = Array.isArray(snapshot.configuredGroups) && snapshot.configuredGroups.length > 0
        ? snapshot.configuredGroups
        : symbols.reduce((names, symbol) => {
            const groupName = symbol.group || defaultGroupName;
            return names.includes(groupName) ? names : [...names, groupName];
          }, []);

      if (symbols.length === 0 && groupNames.length === 0) {
        return [];
      }

      return groupNames.map((groupName) => ({
        name: groupName,
        stats: { up: 0, down: 0, flat: 0, averageChangePercent: null },
        items: symbols
          .map((symbol, index) => ({
            ...symbol,
            alias: symbol.alias || '',
            index,
            alerts: [],
            price: null,
            previousClose: null,
            change: null,
            changePercent: null,
            time: '',
            status: ''
          }))
          .filter((symbol) => (symbol.group || defaultGroupName) === groupName)
      }));
    }

    function renderGroupSummary(items, metrics, compactLargeAmounts) {
      const visibleMetrics = normalizeGroupSummaryMetrics(metrics);
      if (visibleMetrics.length === 0) {
        return '';
      }

      const summary = calculateGroupPortfolioSummary(items);
      const profitTrend = summary.dailyProfit > 0 ? 'up' : summary.dailyProfit < 0 ? 'down' : 'flat';
      const cells = visibleMetrics.map((metric) => {
        if (metric === 'totalAssets') {
          const assets = summary.totalAssets === null ? '--' : formatLargeAmount(summary.totalAssets, compactLargeAmounts);
          return '<span title="' + escapeHtml(t('totalAssets')) + '">' + escapeHtml(assets) + '</span>';
        }
        if (metric === 'dailyProfit') {
          const profit = summary.dailyProfit === null ? '--' : formatSignedLargeAmount(summary.dailyProfit, compactLargeAmounts);
          return '<span class="quote-change ' + profitTrend + '" title="' + escapeHtml(t('dailyProfit')) + '">' + escapeHtml(profit) + '</span>';
        }
        if (metric === 'dailyProfitPercent') {
          const percent = summary.dailyProfitPercent === null ? '--' : formatSigned(summary.dailyProfitPercent, 2) + '%';
          return '<span class="quote-change ' + profitTrend + '" title="' + escapeHtml(t('dailyProfitPercent')) + '">' + escapeHtml(percent) + '</span>';
        }
        return '';
      }).join('');

      return '<div class="group-summary metrics-' + visibleMetrics.length + '">' +
        cells +
      '</div>';
    }

    function calculateGroupPortfolioSummary(items) {
      let totalAssets = 0;
      let dailyProfit = 0;
      let previousAssets = 0;
      let assetCount = 0;
      let profitCount = 0;

      for (const item of items) {
        if (item.cost === null || item.cost === undefined || item.holding === null || item.holding === undefined || item.price === null || item.price === undefined) {
          continue;
        }

        const holding = Number(item.holding);
        if (!Number.isFinite(holding) || holding <= 0) {
          continue;
        }

        totalAssets += item.price * holding;
        assetCount += 1;

        if (item.change !== null && item.change !== undefined) {
          dailyProfit += item.change * holding;
          profitCount += 1;
        }
        if (item.previousClose !== null && item.previousClose !== undefined) {
          previousAssets += item.previousClose * holding;
        }
      }

      return {
        totalAssets: assetCount > 0 ? totalAssets : null,
        dailyProfit: profitCount > 0 ? dailyProfit : null,
        dailyProfitPercent: profitCount > 0 && previousAssets > 0 ? (dailyProfit / previousAssets) * 100 : null
      };
    }

    function formatLargeAmount(value, compact) {
      const amount = Number(value);
      if (!Number.isFinite(amount)) {
        return '--';
      }
      if (compact && Math.abs(amount) > 10000) {
        return formatAmountDecimal(amount / 10000, 2) + 'W';
      }
      return formatAmountDecimal(amount, 2);
    }

    function formatSignedLargeAmount(value, compact) {
      const amount = Number(value);
      if (!Number.isFinite(amount)) {
        return '--';
      }
      const formatted = formatLargeAmount(Math.abs(amount), compact);
      if (amount > 0) {
        return '+' + formatted;
      }
      if (amount < 0) {
        return '-' + formatted;
      }
      return formatted;
    }

    function renderGroupFooter(groupName, editing, adding) {
      return '<div class="group-footer">' +
        (adding ? renderGroupSymbolSearch(groupName) : '') +
        (editing ? '<div class="group-rename-row">' +
          '<input data-group-name="' + escapeHtml(groupName) + '" value="' + escapeHtml(groupName) + '" title="' + escapeHtml(t('groupName')) + '">' +
          '<button class="secondary icon-button" data-action="renameGroup" data-group="' + escapeHtml(groupName) + '" title="' + escapeHtml(t('saveGroupName')) + '" aria-label="' + escapeHtml(t('saveGroupName')) + '">✓</button>' +
        '</div>' : '') +
        '<div class="group-footer-actions">' +
          '<button class="secondary icon-button" data-action="addToGroup" data-group="' + escapeHtml(groupName) + '" title="' + (adding ? escapeHtml(t('collapseAdd')) : escapeHtml(t('addSymbol'))) + '" aria-label="' + (adding ? escapeHtml(t('collapseAdd')) : escapeHtml(t('addSymbol'))) + '">' + (adding ? '−' : '＋') + '</button>' +
          '<button class="secondary icon-button" data-action="editGroup" data-group="' + escapeHtml(groupName) + '" title="' + (editing ? escapeHtml(t('doneEditing')) : escapeHtml(t('editGroup'))) + '" aria-label="' + (editing ? escapeHtml(t('doneEditing')) : escapeHtml(t('editGroup'))) + '">' + (editing ? '✓' : '✎') + '</button>' +
        '</div>' +
      '</div>';
    }

    function renderGroupSymbolSearch(groupName) {
      const isActive = activeSymbolGroup === groupName;
      const query = isActive ? symbolSearchQuery : '';
      return '<div class="symbol-form group-symbol-form">' +
        '<div class="symbol-search-row">' +
          '<input data-symbol-query="true" data-group="' + escapeHtml(groupName) + '" value="' + escapeHtml(query) + '" placeholder="' + escapeHtml(t('searchPlaceholder')) + '" autocomplete="off">' +
          '<button class="secondary icon-button add-button" data-action="confirmAddSymbol" data-group="' + escapeHtml(groupName) + '" title="' + escapeHtml(t('addToGroup')) + '" aria-label="' + escapeHtml(t('addToGroup')) + '" ' + (isActive && selectedSymbol ? '' : 'disabled') + '>＋</button>' +
        '</div>' +
        '<div class="symbol-results" data-symbol-results-group="' + escapeHtml(groupName) + '">' + (isActive ? renderSymbolResultsHtml() : '') + '</div>' +
      '</div>';
    }

    function renderSymbolResultsHtml() {
      if (!symbolSearchQuery) {
        return '';
      }
      if (symbolSearchLoading) {
        return '<div class="symbol-result-empty">' + escapeHtml(t('searchPending')) + '</div>';
      }
      if (symbolSearchError) {
        return '<div class="symbol-result-empty">' + escapeHtml(symbolSearchError) + '</div>';
      }
      if (symbolSearchResults.length === 0) {
        return '<div class="symbol-result-empty">' + escapeHtml(t('noMatches')) + '</div>';
      }
      return symbolSearchResults.map((item) => {
        const selected = selectedSymbol && selectedSymbol.code === item.code;
        return '<button type="button" class="symbol-result' + (selected ? ' selected' : '') + '" data-action="selectSymbol" data-code="' + escapeHtml(item.code) + '" data-name="' + escapeHtml(item.name) + '" title="' + escapeHtml(t('choose') + ' ' + item.name) + '">' +
          '<span class="symbol-result-main">' + escapeHtml(item.name) + '</span>' +
          '<span class="symbol-result-code">' + escapeHtml(item.market || '') + ' ' + escapeHtml(item.code) + '</span>' +
        '</button>';
      }).join('');
    }

    function renderQuoteHeader(groupName, columns, editing, gridClass, sort) {
      return '<div class="quote quote-header ' + gridClass + (editing ? ' editing' : '') + '" data-columns="' + escapeHtml(columns.join(',')) + '">' +
        columns.map((column) => {
          const active = sort && sort.column === column;
          const icon = active ? sort.direction === 'asc' ? ' ↑' : ' ↓' : '';
          return '<div class="quote-cell ' + getColumnClass(column) + '">' +
            '<button class="sort-button" data-action="sortColumn" data-group="' + escapeHtml(groupName) + '" data-column="' + column + '" title="' + escapeHtml(t('sortByColumn') + ' ' + getColumnLabel(column)) + '">' + escapeHtml(getColumnLabel(column)) + icon + '</button>' +
            '<span class="column-resizer" data-column="' + escapeHtml(column) + '" title="' + escapeHtml(t('dragColumnWidth')) + '"></span>' +
          '</div>';
        }).join('') +
        (editing ? '<div class="quote-cell numeric">' + escapeHtml(t('action')) + '</div>' : '') +
      '</div>';
    }

    function renderQuote(quote, snapshot, editing, columns, gridClass, itemIndex, itemCount) {
      const trend = quote.changePercent > 0 ? 'up' : quote.changePercent < 0 ? 'down' : 'flat';
      const hasAlert = Array.isArray(quote.alerts) && quote.alerts.length > 0;
      const alertText = hasAlert ? quote.alerts.map((alert) => alert.label).join(' / ') : '';
      const highlightClass = getQuoteHighlightClass(quote, snapshot);
      const index = Number(quote.index);
      const first = itemIndex <= 0;
      const last = itemIndex >= itemCount - 1;
      const cells = columns.map((column) => renderQuoteCell(column, quote, snapshot, trend, editing)).join('');

      return '<article class="quote ' + gridClass + (highlightClass ? ' ' + highlightClass : '') + (hasAlert ? ' alert' : '') + (editing ? ' editing' : '') + '" data-columns="' + escapeHtml(columns.join(',')) + '">' +
        cells +
        (editing ? '<div class="quote-actions">' +
          '<button class="secondary icon-button" data-action="up" data-index="' + index + '" title="' + escapeHtml(t('moveUp')) + '" ' + (first ? 'disabled' : '') + '>↑</button>' +
          '<button class="secondary icon-button" data-action="down" data-index="' + index + '" title="' + escapeHtml(t('moveDown')) + '" ' + (last ? 'disabled' : '') + '>↓</button>' +
          '<button class="secondary icon-button danger" data-action="remove" data-index="' + index + '" data-name="' + escapeHtml(quote.name) + '" title="' + escapeHtml(t('deleteSymbol')) + '" aria-label="' + escapeHtml(t('deleteSymbol')) + '">×</button>' +
        '</div>' : '') +
      '</article>';
    }

    function getQuoteHighlightClass(quote, snapshot) {
      const changePercent = Number(quote.changePercent);
      if (!Number.isFinite(changePercent)) {
        return '';
      }
      const thresholds = snapshot.rowHighlight || {};
      const upPercent = Number(thresholds.upPercent);
      const downPercent = Number(thresholds.downPercent);
      if (Number.isFinite(upPercent) && upPercent > 0 && changePercent >= upPercent) {
        return 'highlight-up';
      }
      if (Number.isFinite(downPercent) && downPercent > 0 && changePercent <= -downPercent) {
        return 'highlight-down';
      }
      return '';
    }

    function renderQuoteCell(column, quote, snapshot, trend, editing) {
      const digits = snapshot.priceDecimalPlaces;
      const cellClass = 'quote-cell ' + getColumnClass(column);
      if (column === 'name') {
        if (editing) {
          return '<div class="' + cellClass + '">' + renderEditableText(quote, 'name') + '</div>';
        }
        const hasAlert = Array.isArray(quote.alerts) && quote.alerts.length > 0;
        const alertText = hasAlert ? quote.alerts.map((alert) => alert.label).join(' / ') : '';
        return '<div class="' + cellClass + '">' +
          '<div class="name" title="' + escapeHtml(quote.name) + '">' + escapeHtml(quote.name) + (hasAlert ? '<span class="alert-badge" title="' + escapeHtml(alertText) + '">' + escapeHtml(t('alert')) + '</span>' : '') + '</div>' +
        '</div>';
      }
      if (column === 'alias') {
        const alias = quote.alias || '';
        return '<div class="' + cellClass + '" title="' + escapeHtml(alias) + '">' + escapeHtml(alias || '--') + '</div>';
      }
      if (column === 'code') {
        return '<div class="' + cellClass + ' code">' + escapeHtml(quote.code) + '</div>';
      }
      if (column === 'price') {
        return '<div class="' + cellClass + ' price">' + (quote.price === null ? '--' : formatDecimal(quote.price, digits)) + '</div>';
      }
      if (column === 'changePercent') {
        return '<div class="' + cellClass + ' quote-change ' + trend + '">' + (quote.changePercent === null ? '--' : formatSigned(quote.changePercent, 2) + '%') + '</div>';
      }
      if (column === 'change') {
        return '<div class="' + cellClass + ' quote-change ' + trend + '">' + (quote.change === null ? '--' : formatSignedDecimal(quote.change, digits)) + '</div>';
      }
      if (column === 'cost') {
        return '<div class="' + cellClass + '">' + (editing ? renderEditableNumber(quote, 'cost', 3) : renderReadonlyNumber(quote.cost, 3)) + '</div>';
      }
      if (column === 'holding') {
        return '<div class="' + cellClass + '">' + (editing ? renderEditableNumber(quote, 'holding', 0, '1') : renderReadonlyNumber(quote.holding, 0)) + '</div>';
      }
      if (column === 'position') {
        return '<div class="' + cellClass + '">' + (quote.position === null || quote.position === undefined ? '--' : formatDecimal(quote.position, 2) + '%') + '</div>';
      }
      if (column === 'netProfit') {
        const profit = calculateNetProfit(quote);
        const profitTrend = profit > 0 ? 'up' : profit < 0 ? 'down' : 'flat';
        return '<div class="' + cellClass + ' quote-change ' + profitTrend + '">' + (profit === null ? '--' : formatSignedDecimal(profit, digits)) + '</div>';
      }
      return '<div class="' + cellClass + '">--</div>';
    }

    function renderEditableNumber(quote, field, digits, step = 'any') {
      const value = quote[field];
      const displayValue = value === null || value === undefined ? '' : formatDecimal(value, digits);
      return '<input class="cell-input" type="number" step="' + escapeHtml(step) + '" inputmode="' + (step === '1' ? 'numeric' : 'decimal') + '" data-field="' + field + '" data-index="' + quote.index + '" value="' + escapeHtml(displayValue) + '" placeholder="--" title="' + getColumnLabel(field) + '">';
    }

    function renderReadonlyNumber(value, digits) {
      return value === null || value === undefined ? '--' : formatDecimal(value, digits);
    }

    function renderEditableText(quote, field) {
      const value = quote[field] === null || quote[field] === undefined ? '' : String(quote[field]);
      return '<input class="cell-input text-input" type="text" data-field="' + field + '" data-index="' + quote.index + '" value="' + escapeHtml(value) + '" placeholder="' + escapeHtml(quote.code) + '" title="' + getColumnLabel(field) + '">';
    }

    function focusGroupSearch(groupName) {
      window.setTimeout(() => {
        const input = Array.from(app.querySelectorAll('input[data-symbol-query]')).find((item) => item.dataset.group === groupName);
        if (input) {
          input.focus();
        }
      }, 0);
    }

    function calculateNetProfit(quote) {
      if (quote.price === null || quote.cost === null || quote.cost === undefined || quote.holding === null || quote.holding === undefined) {
        return null;
      }
      return (quote.price - quote.cost) * quote.holding;
    }

    function calculateGroupPositionTotal(items) {
      return items.reduce((total, item) => {
        const value = calculateMarketValue(item);
        return value === null ? total : total + value;
      }, 0);
    }

    function calculatePosition(quote, total) {
      const value = calculateMarketValue(quote);
      if (value === null || !Number.isFinite(total) || total <= 0) {
        return null;
      }
      return (value / total) * 100;
    }

    function calculateMarketValue(quote) {
      const price = Number(quote.price);
      const holding = Number(quote.holding);
      if (!Number.isFinite(price) || !Number.isFinite(holding) || holding <= 0) {
        return null;
      }
      return price * holding;
    }

    function getQuoteGridClass(columns) {
      return 'cols-' + Math.max(1, Math.min(10, columns.length));
    }

    function getGridTemplate(columns, editing) {
      const hasCustomWidth = columns.some((column) => {
        const width = Number(columnWidths[column]);
        return Number.isFinite(width) && width > 0;
      });
      if (!hasCustomWidth) {
        return '';
      }

      const template = columns.map((column, index) => {
        const width = Number(columnWidths[column]);
        if (Number.isFinite(width) && width > 0) {
          return width + 'px';
        }
        return 'minmax(20px, 1fr)';
      });
      if (editing) {
        template.push('max-content');
      }
      return template.join(' ');
    }

    function getColumnLabel(column) {
      return {
        name: t('name'),
        alias: t('alias'),
        code: t('code'),
        price: t('price'),
        changePercent: t('changePercent'),
        change: t('change'),
        cost: t('cost'),
        holding: t('holding'),
        position: t('position'),
        netProfit: t('netProfit')
      }[column] || column;
    }

    function getGroupSummaryMetricLabel(metric) {
      return {
        totalAssets: t('totalAssets'),
        dailyProfit: t('dailyProfit'),
        dailyProfitPercent: t('dailyProfitPercent')
      }[metric] || metric;
    }

    function getColumnClass(column) {
      return column === 'name' || column === 'alias' || column === 'code' ? '' : 'numeric';
    }

    function sortQuotesForColumn(items, column, direction) {
      const multiplier = direction === 'asc' ? 1 : -1;
      return [...items].sort((left, right) => {
        const comparison = compareColumnValue(left, right, column);
        if (comparison !== 0) {
          return comparison * multiplier;
        }
        return left.index - right.index;
      });
    }

    function compareColumnValue(left, right, column) {
      if (column === 'name') {
        return String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN');
      }
      if (column === 'alias') {
        return String(left.alias || '').localeCompare(String(right.alias || ''));
      }
      if (column === 'code') {
        return String(left.code || '').localeCompare(String(right.code || ''));
      }

      const leftValue = getColumnSortValue(left, column);
      const rightValue = getColumnSortValue(right, column);
      const leftMissing = leftValue === null || leftValue === undefined || Number.isNaN(leftValue);
      const rightMissing = rightValue === null || rightValue === undefined || Number.isNaN(rightValue);
      if (leftMissing && rightMissing) {
        return 0;
      }
      if (leftMissing) {
        return 1;
      }
      if (rightMissing) {
        return -1;
      }
      if (leftValue === rightValue) {
        return 0;
      }
      return leftValue > rightValue ? 1 : -1;
    }

    function getColumnSortValue(quote, column) {
      if (column === 'price') {
        return quote.price;
      }
      if (column === 'changePercent') {
        return quote.changePercent;
      }
      if (column === 'change') {
        return quote.change;
      }
      if (column === 'cost') {
        return quote.cost;
      }
      if (column === 'holding') {
        return quote.holding;
      }
      if (column === 'position') {
        return quote.position;
      }
      if (column === 'netProfit') {
        return calculateNetProfit(quote);
      }
      return null;
    }

    function persistViewState() {
      viewState = {
        selectedIndexCode,
        editingGroups,
        collapsedGroups,
        addingGroups,
        settingsOpen,
        tableSort,
        columnWidths,
        lastFlashedUpdatedAt
      };
      vscode.setState(viewState);
    }

    function formatSigned(value, digits) {
      const formatted = formatDecimal(value, digits);
      return value > 0 ? '+' + formatted : formatted;
    }

    function formatDecimal(value, digits) {
      return Number(value).toFixed(digits).replace(/\\.0+$/, '').replace(/(\\.\\d*?)0+$/, '$1');
    }

    function formatAmountDecimal(value, digits) {
      return addThousandsSeparators(formatDecimal(value, digits));
    }

    function addThousandsSeparators(value) {
      const text = String(value);
      const sign = text.startsWith('-') ? '-' : '';
      const unsigned = sign ? text.slice(1) : text;
      const parts = unsigned.split('.');
      parts[0] = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
      return sign + parts.join('.');
    }

    function formatSignedDecimal(value, digits) {
      const formatted = formatDecimal(value, digits);
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

    function reportWebviewError(message, source, line, column) {
      vscode.postMessage({
        command: 'webviewError',
        message,
        source,
        line,
        column
      });
    }

    vscode.postMessage({ command: 'webviewReady' });
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
  const groups = normalizeGroups(config.get('groups', [DEFAULT_GROUP]), symbols);
  const alerts = config.get('alerts', [])
    .map(normalizeAlertRule)
    .filter(Boolean);
  const language = sanitizeLanguage(config.get('language', DEFAULT_LANGUAGE));

  return {
    groups,
    symbols,
    alerts,
    language,
    locale: resolveLanguage(language),
    enableAlerts: config.get('enableAlerts', true),
    enableAlertNotifications: config.get('enableAlertNotifications', true),
    refreshIntervalSeconds: config.get('refreshIntervalSeconds', 5),
    onlyDuringTradingTime: config.get('onlyDuringTradingTime', true),
    showStatusBar: config.get('showStatusBar', false),
    sortBy: sanitizeSortBy(config.get('sortBy', 'configured')),
    sortDirection: config.get('sortDirection', 'desc') === 'asc' ? 'asc' : 'desc',
    priceDecimalPlaces: sanitizeDecimalPlaces(config.get('priceDecimalPlaces', 2)),
    compactLargeAmounts: Boolean(config.get('compactLargeAmounts', false)),
    rowHighlight: {
      upPercent: sanitizeRowHighlightPercent(config.get('rowHighlightUpPercent', 5)),
      downPercent: sanitizeRowHighlightPercent(config.get('rowHighlightDownPercent', 5))
    },
    quoteColumns: sanitizeQuoteColumns(config.get('quoteColumns', DEFAULT_QUOTE_COLUMNS)),
    groupSummaryMetrics: sanitizeGroupSummaryMetrics(config.get('groupSummaryMetrics', DEFAULT_GROUP_SUMMARY_METRICS)),
    requestTimeoutMs: config.get('requestTimeoutMs', 10000),
    colors: getColorPalette(sanitizeColorMode(config.get('colorMode', 'none')))
  };
}

function normalizeGroups(value, symbols = []) {
  const groups = [];
  const addGroup = (name) => {
    const normalized = normalizeGroupName(name);
    if (normalized && !groups.includes(normalized)) {
      groups.push(normalized);
    }
  };

  if (Array.isArray(value)) {
    value.forEach(addGroup);
  }

  symbols.forEach((symbol) => addGroup(symbol.group));
  if (groups.length === 0) {
    addGroup(DEFAULT_GROUP);
  }
  return groups;
}

function normalizeGroupName(value) {
  return String(value || '').trim();
}

async function updateConfiguredSymbols(symbols) {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update('symbols', symbols.map(toConfigSymbol), getConfigTarget(config, 'symbols'));
}

async function updateConfiguredGroups(groups) {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const normalizedGroups = normalizeGroups(groups, []);
  await config.update('groups', normalizedGroups, getConfigTarget(config, 'groups'));
}

function getConfigTarget(config, key) {
  const inspect = config.inspect(key);
  return inspect && inspect.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function toConfigSymbol(symbol) {
  const configSymbol = {
    code: symbol.code,
    name: symbol.name,
    group: symbol.group
  };

  if (symbol.cost !== null && symbol.cost !== undefined) {
    configSymbol.cost = symbol.cost;
  }
  if (symbol.holding !== null && symbol.holding !== undefined) {
    configSymbol.holding = symbol.holding;
  }

  return configSymbol;
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
    group: String(item.group || DEFAULT_GROUP).trim() || DEFAULT_GROUP,
    cost: optionalNumber(item.cost),
    holding: optionalNumber(item.holding)
  };
}

function findGroupInsertIndex(symbols, groupName) {
  const normalizedGroupName = normalizeGroupName(groupName) || DEFAULT_GROUP;
  let insertIndex = symbols.length;

  for (let index = symbols.length - 1; index >= 0; index -= 1) {
    if (symbols[index].group === normalizedGroupName) {
      insertIndex = index + 1;
      break;
    }
  }

  return insertIndex;
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

function optionalInteger(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.trunc(parsed);
}

async function fetchQuotes(symbols, timeoutMs, log) {
  const uniqueCodes = Array.from(new Set(symbols.map((symbol) => symbol.code)));
  const rawQuotes = await fetchRawQuotesConcurrent(uniqueCodes, timeoutMs, log);

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

async function fetchRawQuotes(codes, timeoutMs, log) {
  const providers = [
    {
      name: '新浪',
      url: (query) => `https://hq.sinajs.cn/list=${query}`,
      headers: {
        Referer: 'https://finance.sina.com.cn/',
        'User-Agent': 'Mozilla/5.0 VSCode Market Monitoring'
      },
      parse: parseSinaResponse
    },
    {
      name: '腾讯',
      url: (query) => `https://qt.gtimg.cn/q=${query}`,
      headers: {
        Referer: 'https://gu.qq.com/',
        'User-Agent': 'Mozilla/5.0 VSCode Market Monitoring'
      },
      parse: parseTencentResponse
    }
  ];
  const query = codes.join(',');
  const mergedQuotes = new Map();
  const errors = [];

  for (const provider of providers) {
    try {
      const body = await requestText(provider.url(query), timeoutMs, provider.headers);
      const quotes = provider.parse(body);
      if (log) {
        log('Quote provider returned', {
          provider: provider.name,
          requested: codes.length,
          returned: quotes.size,
          usable: countUsableCodesFromMap(quotes, codes)
        });
      }

      for (const code of codes) {
        if (mergedQuotes.has(code)) {
          continue;
        }

        const quote = quotes.get(code);
        if (isUsableQuote(quote)) {
          mergedQuotes.set(code, quote);
        }
      }

      if (codes.every((code) => mergedQuotes.has(code))) {
        return mergedQuotes;
      }

      if (quotes.size === 0) {
        errors.push(`${provider.name}: 未返回有效行情`);
      }
    } catch (error) {
      if (log) {
        log('Quote provider failed', {
          provider: provider.name,
          error: getErrorMessage(error)
        });
      }
      errors.push(`${provider.name}: ${getErrorMessage(error)}`);
    }
  }

  if (mergedQuotes.size > 0) {
    return mergedQuotes;
  }

  throw new Error(`行情请求失败：${errors.join('；')}`);
}

async function fetchRawQuotesConcurrent(codes, timeoutMs, log) {
  const providers = [
    {
      name: '新浪',
      url: (query) => `https://hq.sinajs.cn/list=${query}`,
      headers: {
        Referer: 'https://finance.sina.com.cn/',
        'User-Agent': 'Mozilla/5.0 VSCode Market Monitoring'
      },
      parse: parseSinaResponse
    },
    {
      name: '腾讯',
      url: (query) => `https://qt.gtimg.cn/q=${query}`,
      headers: {
        Referer: 'https://gu.qq.com/',
        'User-Agent': 'Mozilla/5.0 VSCode Market Monitoring'
      },
      parse: parseTencentResponse
    }
  ];
  const query = codes.join(',');
  const mergedQuotes = new Map();
  const errors = [];

  if (log) {
    log('Quote providers started', {
      providers: providers.map((provider) => provider.name),
      requested: codes.length
    });
  }

  const pending = providers.map((provider) => fetchProviderQuotes(provider, query, timeoutMs));
  while (pending.length > 0) {
    const { index, result } = await Promise.race(pending.map((promise, index) => promise.then((result) => ({ index, result }))));
    pending.splice(index, 1);

    if (result.error) {
      if (log) {
        log('Quote provider failed', {
          provider: result.provider,
          elapsedMs: result.elapsedMs,
          error: result.error
        });
      }
      errors.push(`${result.provider}: ${result.error}`);
      continue;
    }

    const quotes = result.quotes;
    if (log) {
      log('Quote provider returned', {
        provider: result.provider,
        requested: codes.length,
        returned: quotes.size,
        usable: countUsableCodesFromMap(quotes, codes),
        elapsedMs: result.elapsedMs
      });
    }

    for (const code of codes) {
      if (mergedQuotes.has(code)) {
        continue;
      }

      const quote = quotes.get(code);
      if (isUsableQuote(quote)) {
        mergedQuotes.set(code, quote);
      }
    }

    if (codes.every((code) => mergedQuotes.has(code))) {
      return mergedQuotes;
    }

    if (quotes.size === 0) {
      errors.push(`${result.provider}: 未返回有效行情`);
    }
  }

  if (mergedQuotes.size > 0) {
    return mergedQuotes;
  }

  throw new Error(`行情请求失败：${errors.join('；')}`);
}

async function fetchProviderQuotes(provider, query, timeoutMs) {
  const startedAt = Date.now();
  try {
    const body = await requestText(provider.url(query), timeoutMs, provider.headers);
    return {
      provider: provider.name,
      quotes: provider.parse(body),
      elapsedMs: Date.now() - startedAt,
      error: ''
    };
  } catch (error) {
    return {
      provider: provider.name,
      quotes: new Map(),
      elapsedMs: Date.now() - startedAt,
      error: getErrorMessage(error)
    };
  }
}

async function fetchSymbolSearchResults(keyword, timeoutMs) {
  const normalizedKeyword = String(keyword || '').trim();
  if (!normalizedKeyword) {
    return [];
  }

  const url = `http://suggest3.sinajs.cn/suggest/type=&key=${encodeURIComponent(normalizedKeyword)}`;
  const body = await requestText(url, Math.min(Math.max(timeoutMs, 3000), 10000), {
    Referer: 'https://finance.sina.com.cn/',
    'User-Agent': 'Mozilla/5.0 VSCode Market Monitoring'
  }, 'gb18030');
  const results = parseSinaSuggestResponse(body);

  if (results.length === 0) {
    const code = normalizeCode(normalizedKeyword);
    return code ? [{ code, name: code, market: getCodeMarketLabel(code) }] : [];
  }

  return results;
}

function parseSinaSuggestResponse(body) {
  const match = String(body || '').match(/suggestvalue="([\s\S]*)";?\s*$/);
  const payload = match ? match[1] : '';
  const seen = new Set();
  const results = [];

  for (const row of payload.split(';')) {
    const fields = row.split(',');
    const code = normalizeCode(fields[3] || fields[0] || fields[2] || '');
    if (!code || seen.has(code)) {
      continue;
    }

    const name = String(fields[4] || fields[6] || fields[0] || code).trim() || code;
    seen.add(code);
    results.push({
      code,
      name,
      market: getCodeMarketLabel(code)
    });

    if (results.length >= 12) {
      break;
    }
  }

  return results;
}

function getCodeMarketLabel(code) {
  const prefix = String(code || '').slice(0, 2).toUpperCase();
  return prefix || '';
}

function isUsableQuote(quote) {
  return Boolean(quote && quote.price !== null);
}

function countUsableQuotes(quotes) {
  return quotes.filter(isUsableQuote).length;
}

function countUsableCodes(quotes, codes) {
  const quoteByCode = new Map(quotes.map((quote) => [quote.code, quote]));
  return codes.filter((code) => isUsableQuote(quoteByCode.get(code))).length;
}

function countUsableCodesFromMap(quotes, codes) {
  return codes.filter((code) => isUsableQuote(quotes.get(code))).length;
}

function readCachedQuoteSnapshot(globalState) {
  const value = globalState.get(QUOTE_CACHE_KEY);
  if (!value || !Array.isArray(value.quotes)) {
    return { quotes: [], updatedAt: '', updatedDate: '' };
  }

  return {
    quotes: value.quotes.map(normalizeCachedQuote).filter(Boolean),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    updatedDate: typeof value.updatedDate === 'string' ? value.updatedDate : ''
  };
}

async function writeCachedQuoteSnapshot(globalState, quotes, updatedAt, updatedDate) {
  await globalState.update(QUOTE_CACHE_KEY, {
    updatedAt,
    updatedDate,
    quotes: quotes.filter(isUsableQuote).map((quote) => ({
      code: quote.code,
      price: quote.price,
      previousClose: quote.previousClose,
      change: quote.change,
      changePercent: quote.changePercent,
      time: quote.time,
      status: quote.status
    }))
  });
}

function normalizeCachedQuote(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const code = normalizeCode(value.code);
  if (!code) {
    return null;
  }

  return {
    code,
    price: optionalNumber(value.price),
    previousClose: optionalNumber(value.previousClose),
    change: optionalNumber(value.change),
    changePercent: optionalNumber(value.changePercent),
    time: typeof value.time === 'string' ? value.time : '',
    status: typeof value.status === 'string' ? value.status : ''
  };
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

function requestText(url, timeoutMs, headers = {}, encoding = 'utf8') {
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
      response.on('end', () => resolve(decodeResponseText(Buffer.concat(chunks), encoding)));
    });

    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('行情请求超时'));
    });
  });
}

function decodeResponseText(buffer, encoding) {
  if (!encoding || encoding.toLowerCase() === 'utf8' || encoding.toLowerCase() === 'utf-8') {
    return buffer.toString('utf8');
  }

  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch (error) {
    return buffer.toString('utf8');
  }
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

function mergeWithPreviousQuotes(quotes, previousQuotes) {
  const previousByCode = new Map(previousQuotes.map((quote) => [quote.code, quote]));
  return quotes.map((quote) => {
    const previous = previousByCode.get(quote.code);
    if (isUsableQuote(quote) || !isUsableQuote(previous)) {
      return quote;
    }

    return {
      ...quote,
      price: previous.price,
      previousClose: previous.previousClose,
      change: previous.change,
      changePercent: previous.changePercent,
      time: previous.time,
      status: previous.status
    };
  });
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

function groupQuotes(quotes, configuredGroups, configuredSymbols, alerts, sortBy, sortDirection) {
  const order = [];
  const groups = new Map();
  const quoteByCode = new Map(quotes.map((quote) => [quote.code, quote]));
  const alertsByCode = groupAlertsByCode(alerts);

  for (const groupName of configuredGroups) {
    if (!groups.has(groupName)) {
      groups.set(groupName, []);
      order.push(groupName);
    }
  }

  for (const [index, symbol] of configuredSymbols.entries()) {
    const key = symbol.group || DEFAULT_GROUP;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }

    const quote = quoteByCode.get(symbol.code);
    const item = quote ? {
      ...quote,
      name: symbol.name,
      group: symbol.group,
      cost: symbol.cost,
      holding: symbol.holding
    } : {
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
      alias: toPinyin(item.name),
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

function decodeCsvImportText(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length >= 3 && data[0] === 0xEF && data[1] === 0xBB && data[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(data.slice(3));
  }
  if (data.length >= 2 && data[0] === 0xFF && data[1] === 0xFE) {
    return new TextDecoder('utf-16le').decode(data.slice(2));
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch (error) {
    try {
      return new TextDecoder('gb18030').decode(data);
    } catch (decodeError) {
      return Buffer.from(data).toString('utf8');
    }
  }
}

function parseCsvImportRows(text) {
  const normalizedText = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!normalizedText) {
    throw new Error('CSV 文件为空');
  }

  const delimiter = detectCsvDelimiter(normalizedText);
  const table = parseDelimitedTable(normalizedText, delimiter).filter((row) => row.some((cell) => String(cell || '').trim()));
  if (table.length < 2) {
    throw new Error('CSV 文件没有可导入的数据行');
  }

  const headers = table[0].map(normalizeImportHeader);
  const getColumn = (name) => headers.indexOf(name);
  const indexes = {
    group: getColumn('分组'),
    name: getColumn('名称'),
    code: getColumn('代码'),
    cost: getColumn('成本'),
    holding: getColumn('持仓')
  };

  if (indexes.name < 0 && indexes.code < 0) {
    throw new Error('CSV 必须包含“名称”或“代码”列');
  }

  return table.slice(1).map((row, index) => ({
    line: index + 2,
    group: getImportCell(row, indexes.group),
    name: getImportCell(row, indexes.name),
    code: getImportCell(row, indexes.code),
    costText: getImportCell(row, indexes.cost),
    holdingText: getImportCell(row, indexes.holding)
  }));
}

async function resolveImportRows(rows, config, output, progress) {
  const existingCodes = new Set(config.symbols.map((symbol) => symbol.code));
  const importedCodes = new Set();
  const groups = [];
  const symbols = [];
  let validated = 0;
  let skipped = 0;

  for (const [index, row] of rows.entries()) {
    progress.report({
      increment: rows.length > 0 ? 100 / rows.length : 100,
      message: `${index + 1}/${rows.length}`
    });

    const parsed = parseImportRow(row);
    if (!parsed.ok) {
      skipped += 1;
      output.appendLine(`[${new Date().toISOString()}] CSV 第 ${row.line} 行跳过: ${parsed.reason}`);
      continue;
    }

    const resolved = await resolveImportedSymbol(parsed.value, config.requestTimeoutMs);
    if (!resolved) {
      skipped += 1;
      output.appendLine(`[${new Date().toISOString()}] CSV 第 ${row.line} 行跳过: 标的无效或没有真实行情`);
      continue;
    }

    validated += 1;
    if (existingCodes.has(resolved.code) || importedCodes.has(resolved.code)) {
      skipped += 1;
      output.appendLine(`[${new Date().toISOString()}] CSV 第 ${row.line} 行跳过: ${resolved.code} 已存在`);
      continue;
    }

    importedCodes.add(resolved.code);
    if (!groups.includes(parsed.value.group)) {
      groups.push(parsed.value.group);
    }
    symbols.push({
      code: resolved.code,
      name: parsed.value.name || resolved.name || resolved.code,
      group: parsed.value.group,
      cost: parsed.value.cost,
      holding: parsed.value.holding
    });
  }

  return {
    symbols,
    groups,
    validated,
    skipped
  };
}

function parseImportRow(row) {
  const group = normalizeGroupName(row.group) || DEFAULT_GROUP;
  const name = String(row.name || '').trim();
  const code = String(row.code || '').trim();
  if (!name && !code) {
    return { ok: false, reason: '名称和代码不能同时为空' };
  }

  const cost = parseOptionalImportDecimal(row.costText);
  if (!cost.ok) {
    return { ok: false, reason: '成本必须是小数' };
  }

  const holding = parseOptionalImportInteger(row.holdingText);
  if (!holding.ok) {
    return { ok: false, reason: '持仓必须是整数' };
  }

  return {
    ok: true,
    value: {
      group,
      name,
      code,
      cost: cost.value,
      holding: holding.value
    }
  };
}

async function resolveImportedSymbol(row, timeoutMs) {
  const code = normalizeCode(row.code);
  if (code) {
    const quote = await fetchSingleUsableQuote({ code, name: row.name || code, group: row.group }, timeoutMs);
    if (!quote) {
      return undefined;
    }

    const searchName = await findSymbolNameByCode(code, timeoutMs);
    return {
      code,
      name: searchName || row.name || code
    };
  }

  if (!row.name) {
    return undefined;
  }

  const results = await fetchSymbolSearchResults(row.name, timeoutMs).catch(() => []);
  const candidates = results.slice(0, 6).map((item) => ({
    code: item.code,
    name: item.name,
    group: row.group
  }));
  if (candidates.length === 0) {
    return undefined;
  }

  const quotes = await fetchQuotes(candidates, timeoutMs).catch(() => []);
  const usable = quotes.find((quote) => isUsableQuote(quote));
  if (!usable) {
    return undefined;
  }

  const matched = candidates.find((item) => item.code === usable.code);
  return {
    code: usable.code,
    name: matched ? matched.name : usable.code
  };
}

async function fetchSingleUsableQuote(symbol, timeoutMs) {
  const quotes = await fetchQuotes([symbol], timeoutMs).catch(() => []);
  const quote = quotes[0];
  return isUsableQuote(quote) ? quote : undefined;
}

async function findSymbolNameByCode(code, timeoutMs) {
  const results = await fetchSymbolSearchResults(code, timeoutMs).catch(() => []);
  const matched = results.find((item) => item.code === code);
  return matched ? matched.name : '';
}

function detectCsvDelimiter(text) {
  const firstLine = String(text).split(/\r?\n/, 1)[0] || '';
  const commaCount = countDelimiterOutsideQuotes(firstLine, ',');
  const tabCount = countDelimiterOutsideQuotes(firstLine, '\t');
  return tabCount > commaCount ? '\t' : ',';
}

function countDelimiterOutsideQuotes(line, delimiter) {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && char === delimiter) {
      count += 1;
    }
  }
  return count;
}

function parseDelimitedTable(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (!quoted && char === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }

    if (!quoted && (char === '\n' || char === '\r')) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (char === '\r' && text[index + 1] === '\n') {
        index += 1;
      }
      continue;
    }

    cell += char;
  }

  row.push(cell);
  rows.push(row);
  return rows;
}

function normalizeImportHeader(value) {
  return String(value || '').replace(/^\uFEFF/, '').trim();
}

function getImportCell(row, index) {
  if (index < 0 || index >= row.length) {
    return '';
  }
  return String(row[index] || '').trim();
}

function parseOptionalImportDecimal(value) {
  const text = String(value || '').trim();
  if (!text) {
    return { ok: true, value: null };
  }

  const parsed = Number(text);
  return Number.isFinite(parsed)
    ? { ok: true, value: parsed }
    : { ok: false, value: null };
}

function parseOptionalImportInteger(value) {
  const text = String(value || '').trim();
  if (!text) {
    return { ok: true, value: null };
  }
  if (!/^-?\d+$/.test(text)) {
    return { ok: false, value: null };
  }

  const parsed = Number(text);
  return Number.isSafeInteger(parsed)
    ? { ok: true, value: parsed }
    : { ok: false, value: null };
}

function buildCsvRows(groups, priceDecimalPlaces, compactLargeAmounts = false) {
  const rows = [[
    '分组',
    '名称',
    '别名',
    '代码',
    '价格',
    '涨跌幅',
    '涨跌额',
    '成本',
    '持仓',
    '仓位',
    '净收益额'
  ]];

  for (const group of groups) {
    if (!Array.isArray(group.items) || group.items.length === 0) {
      continue;
    }

    const positionTotal = calculateGroupPositionTotalValue(group.items);
    for (const quote of group.items) {
      rows.push([
        group.name,
        quote.name,
        quote.alias || toPinyin(quote.name),
        quote.code,
        formatOptionalDecimal(quote.price, priceDecimalPlaces),
        formatOptionalSignedPercent(quote.changePercent),
        formatOptionalSignedDecimal(quote.change, priceDecimalPlaces),
        formatOptionalDecimal(quote.cost, 3),
        formatOptionalDecimal(quote.holding, 0),
        formatOptionalPercent(calculatePositionValue(quote, positionTotal)),
        formatOptionalSignedDecimal(calculateNetProfitValue(quote), priceDecimalPlaces)
      ]);
    }

    const summary = calculateGroupPortfolioSummaryValue(group.items);
    rows.push([
      group.name,
      '汇总',
      '',
      '',
      formatOptionalLargeAmount(summary.totalAssets, compactLargeAmounts),
      formatOptionalSignedPercent(summary.dailyProfitPercent),
      formatOptionalSignedLargeAmount(summary.dailyProfit, compactLargeAmounts),
      '',
      '',
      '',
      ''
    ]);
  }

  return rows;
}

function calculateNetProfitValue(quote) {
  if (quote.price === null || quote.price === undefined || quote.cost === null || quote.cost === undefined || quote.holding === null || quote.holding === undefined) {
    return null;
  }
  const holding = Number(quote.holding);
  if (!Number.isFinite(holding)) {
    return null;
  }
  return (quote.price - quote.cost) * holding;
}

function calculateGroupPositionTotalValue(items) {
  return items.reduce((total, item) => {
    const value = calculateMarketValue(item);
    return value === null ? total : total + value;
  }, 0);
}

function calculatePositionValue(quote, total) {
  const value = calculateMarketValue(quote);
  if (value === null || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  return (value / total) * 100;
}

function calculateMarketValue(quote) {
  const price = Number(quote.price);
  const holding = Number(quote.holding);
  if (!Number.isFinite(price) || !Number.isFinite(holding) || holding <= 0) {
    return null;
  }
  return price * holding;
}

function toPinyin(value) {
  return pinyin(String(value || ''), {
    toneType: 'none',
    nonZh: 'consecutive',
    separator: "'"
  });
}

function calculateGroupPortfolioSummaryValue(items) {
  let totalAssets = 0;
  let dailyProfit = 0;
  let previousAssets = 0;
  let assetCount = 0;
  let profitCount = 0;

  for (const item of items) {
    if (item.cost === null || item.cost === undefined || item.holding === null || item.holding === undefined || item.price === null || item.price === undefined) {
      continue;
    }

    const holding = Number(item.holding);
    if (!Number.isFinite(holding) || holding <= 0) {
      continue;
    }

    totalAssets += item.price * holding;
    assetCount += 1;

    if (item.change !== null && item.change !== undefined) {
      dailyProfit += item.change * holding;
      profitCount += 1;
    }
    if (item.previousClose !== null && item.previousClose !== undefined) {
      previousAssets += item.previousClose * holding;
    }
  }

  return {
    totalAssets: assetCount > 0 ? totalAssets : null,
    dailyProfit: profitCount > 0 ? dailyProfit : null,
    dailyProfitPercent: profitCount > 0 && previousAssets > 0 ? (dailyProfit / previousAssets) * 100 : null
  };
}

function toCsv(rows) {
  return `\uFEFF${rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n')}`;
}

function escapeCsvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatOptionalDecimal(value, digits) {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return '';
  }
  return formatDecimalTrimmed(number, digits);
}

function formatOptionalSignedDecimal(value, digits) {
  const formatted = formatOptionalDecimal(value, digits);
  if (!formatted) {
    return '';
  }
  return Number(value) > 0 ? `+${formatted}` : formatted;
}

function formatOptionalSignedPercent(value) {
  const formatted = formatOptionalDecimal(value, 2);
  if (!formatted) {
    return '';
  }
  return `${Number(value) > 0 ? '+' : ''}${formatted}%`;
}

function formatOptionalPercent(value) {
  const formatted = formatOptionalDecimal(value, 2);
  return formatted ? `${formatted}%` : '';
}

function formatOptionalLargeAmount(value, compact = false) {
  if (value === null || value === undefined) {
    return '';
  }
  const amount = Number(value);
  if (!Number.isFinite(amount)) {
    return '';
  }
  if (compact && Math.abs(amount) > 10000) {
    return `${formatAmountTrimmed(amount / 10000, 2)}W`;
  }
  return formatAmountTrimmed(amount, 2);
}

function formatOptionalSignedLargeAmount(value, compact = false) {
  const formatted = formatOptionalLargeAmount(value, compact);
  if (!formatted) {
    return '';
  }
  return Number(value) > 0 ? `+${formatted}` : formatted;
}

function formatDecimalTrimmed(value, digits) {
  return Number(value).toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function formatAmountTrimmed(value, digits) {
  return addThousandsSeparators(formatDecimalTrimmed(value, digits));
}

function addThousandsSeparators(value) {
  const text = String(value);
  const sign = text.startsWith('-') ? '-' : '';
  const unsigned = sign ? text.slice(1) : text;
  const parts = unsigned.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + parts.join('.');
}

function formatFileTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('') + '-' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
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
  if (sortBy === 'alias') {
    return toPinyin(left.name).localeCompare(toPinyin(right.name));
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

function getShanghaiDateString() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
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
  if (colors.mode === 'none') {
    return undefined;
  }
  if (value > 0) {
    return colors.up;
  }
  if (value < 0) {
    return colors.down;
  }
  return colors.flat;
}

function sanitizeLanguage(value) {
  return ['auto', 'zh-CN', 'en-US'].includes(value) ? value : DEFAULT_LANGUAGE;
}

function resolveLanguage(value) {
  const language = sanitizeLanguage(value);
  if (language !== 'auto') {
    return language;
  }
  return String(vscode.env.language || '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

function sanitizeColorMode(value) {
  const allowed = new Set(['none', 'redUpGreenDown', 'greenUpRedDown']);
  return allowed.has(value) ? value : 'none';
}

function getColorPalette(mode) {
  if (mode === 'redUpGreenDown') {
    return {
      mode,
      up: '#e51400',
      down: '#16a34a',
      flat: 'var(--vscode-foreground)'
    };
  }

  if (mode === 'greenUpRedDown') {
    return {
      mode,
      up: '#16a34a',
      down: '#e51400',
      flat: 'var(--vscode-foreground)'
    };
  }

  return {
    mode: 'none',
    up: 'var(--vscode-foreground)',
    down: 'var(--vscode-foreground)',
    flat: 'var(--vscode-foreground)'
  };
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
  const allowed = new Set(['configured', 'changePercent', 'price', 'name', 'alias', 'code']);
  return allowed.has(value) ? value : 'configured';
}

function sanitizeDecimalPlaces(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return 2;
  }
  return Math.min(6, Math.max(0, parsed));
}

function sanitizeRowHighlightPercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return parsed;
}

function sanitizeQuoteColumns(value) {
  const allowed = new Set(AVAILABLE_QUOTE_COLUMNS);
  const defaults = DEFAULT_QUOTE_COLUMNS;
  if (!Array.isArray(value)) {
    return defaults;
  }

  const normalized = value.map((column) => column === 'identity' ? 'name' : column);
  const columns = normalized.filter((column, index) => allowed.has(column) && normalized.indexOf(column) === index);
  return columns.length > 0 ? columns : defaults;
}

function sanitizeGroupSummaryMetrics(value) {
  const allowed = new Set(AVAILABLE_GROUP_SUMMARY_METRICS);
  if (!Array.isArray(value)) {
    return DEFAULT_GROUP_SUMMARY_METRICS;
  }
  return value.filter((metric, index) => allowed.has(metric) && value.indexOf(metric) === index);
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

function formatLogLine(level, message, details) {
  const suffix = details === undefined ? '' : ` ${safeStringify(details)}`;
  return `[${new Date().toISOString()}] ${level} ${message}${suffix}`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
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
