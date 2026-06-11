const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { pinyin } = require('pinyin-pro');
const vscode = require('vscode');
const { MarketDatabase } = require('./database');

const CONFIG_SECTION = 'marketMonitoring';
const VIEW_ID = 'marketMonitoring.quotesView';
const QUOTE_CACHE_KEY = 'quoteCache.v1';
const ALERT_NOTIFICATION_CACHE_KEY = 'alertNotificationCache.v1';
const DEFAULT_GROUP = '自选';
const DEFAULT_LANGUAGE = 'auto';
const DEFAULT_QUOTE_COLUMNS = ['name', 'price', 'changePercent'];
const DEFAULT_MOVING_AVERAGE_DAYS = 20;
const DEFAULT_MOVING_AVERAGE_ALERT_DAYS = [5, 10, 20, 60];
const MAX_MOVING_AVERAGE_DAYS = 250;
const DEFAULT_BEARISH_MA_DAYS = { short: 5, mid: 20, long: 60 };
const DEFAULT_VOLUME_AVERAGE_DAYS = 5;
const DEFAULT_LOW_BREAK_DAYS = 20;
const DEFAULT_RSI_DAYS = 14;
const DEFAULT_BOLLINGER_DAYS = 20;
const DEFAULT_BOLLINGER_STD_DEV = 2;
const DEFAULT_INTRADAY_HIGH_PULLBACK_PERCENT = 2;
const DEFAULT_INTRADAY_DOWNTREND_CONFIRM_TICKS = 3;
const DEFAULT_INTRADAY_DOWNTREND_SLOPE_POINTS = 5;
const AVAILABLE_QUOTE_COLUMNS = ['name', 'alias', 'code', 'price', 'changePercent', 'change', 'cost', 'holding', 'position', 'netProfit'];
const QUOTE_COLUMN_LABELS = {
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
};
const DEFAULT_GROUP_SUMMARY_METRICS = [];
const AVAILABLE_GROUP_SUMMARY_METRICS = ['totalAssets', 'dailyProfit', 'dailyProfitPercent'];
const AI_LOG_TEXT_LIMIT = 2000;
const AI_PROVIDERS = ['disabled', 'openai', 'azureOpenAI', 'anthropic', 'gemini', 'deepseek', 'openrouter', 'ollama', 'lmStudio', 'customOpenAICompatible'];
const OPENAI_COMPATIBLE_AI_PROVIDERS = ['openai', 'deepseek', 'openrouter', 'ollama', 'lmStudio', 'customOpenAICompatible'];
const DEFAULT_AI_MODELS = {
  openai: 'gpt-4.1-mini',
  azureOpenAI: '',
  anthropic: 'claude-3-5-sonnet-latest',
  gemini: 'gemini-1.5-flash',
  deepseek: 'deepseek-chat',
  openrouter: 'openai/gpt-4o-mini',
  ollama: 'llama3.1',
  lmStudio: 'local-model',
  customOpenAICompatible: ''
};
const DEFAULT_AI_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
  lmStudio: 'http://localhost:1234/v1'
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
    monitor.database,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.commands.registerCommand('marketMonitoring.refresh', () => monitor.refresh(true)),
    vscode.commands.registerCommand('marketMonitoring.importCsv', () => monitor.importCsv()),
    vscode.commands.registerCommand('marketMonitoring.exportCsv', () => monitor.exportCsv()),
    vscode.commands.registerCommand('marketMonitoring.start', () => monitor.start(true)),
    vscode.commands.registerCommand('marketMonitoring.stop', () => monitor.stop(true)),
    vscode.commands.registerCommand('marketMonitoring.openAiAssistant', async () => {
      if (!readAiConfig(vscode.workspace.getConfiguration(CONFIG_SECTION)).enabled) {
        vscode.window.showInformationMessage('AI 入口未开启，请先在 Market Monitoring 设置中开启 marketMonitoring.ai.enabled。');
        return;
      }
      await vscode.commands.executeCommand('workbench.view.extension.marketMonitoring');
      provider.openAiAssistant();
    }),
    vscode.commands.registerCommand('marketMonitoring.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${getExtensionId(context)}`);
    }),
    vscode.commands.registerCommand('marketMonitoring.configureQuoteColumns', () => monitor.runWithRefreshPaused(() => configureQuoteColumns(), 'configureQuoteColumns')),
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
    } else if (message.command === 'aiManage') {
      monitor.aiManage(message.prompt, message.requestId);
    } else if (message.command === 'webviewReady') {
      monitor.updateCollapsedGroups(message.collapsedGroups);
      monitor.updateEditingState(message.editing);
      monitor.webviewReady();
    } else if (message.command === 'webviewError') {
      monitor.logError('Webview error', {
        message: message.message || '',
        source: message.source || '',
        line: message.line || 0,
        column: message.column || 0
      });
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
    } else if (message.command === 'collapsedGroupsChanged') {
      monitor.updateCollapsedGroups(message.collapsedGroups);
    } else if (message.command === 'editingStateChanged') {
      monitor.updateEditingState(message.editing);
    }
  });

  monitor.start(false);
}

function deactivate() {}

async function configureQuoteColumns() {
  let columns = sanitizeQuoteColumns(vscode.workspace.getConfiguration(CONFIG_SECTION).get('quoteColumns', DEFAULT_QUOTE_COLUMNS));

  while (true) {
    const hiddenColumns = AVAILABLE_QUOTE_COLUMNS.filter((column) => !columns.includes(column));
    const picked = await vscode.window.showQuickPick([
      ...columns.map((column, index) => ({
        label: `$(check) ${index + 1}. ${getQuoteColumnLabel(column)}`,
        description: column,
        detail: 'Visible. Select to move up, move down, or hide.',
        column,
        visible: true
      })),
      ...hiddenColumns.map((column) => ({
        label: `$(add) ${getQuoteColumnLabel(column)}`,
        description: column,
        detail: 'Hidden. Select to add it to the end.',
        column,
        visible: false
      })),
      {
        label: '$(settings-gear) Open Quote Columns Setting',
        detail: 'Open the native VS Code setting.',
        action: 'openSetting'
      },
      {
        label: '$(check) Done',
        action: 'done'
      }
    ], {
      title: 'Configure Quote Columns',
      placeHolder: 'Select a column to move up, move down, show, or hide'
    });

    if (!picked || picked.action === 'done') {
      return;
    }
    if (picked.action === 'openSetting') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'marketMonitoring.quoteColumns');
      return;
    }
    if (!picked.visible) {
      columns = sanitizeQuoteColumns([...columns, picked.column]);
      await updateConfiguredQuoteColumns(columns);
      continue;
    }

    const index = columns.indexOf(picked.column);
    if (index < 0) {
      continue;
    }

    const actions = [];
    if (index > 0) {
      actions.push({ label: '$(arrow-up) Move Up', action: 'up' });
    }
    if (index < columns.length - 1) {
      actions.push({ label: '$(arrow-down) Move Down', action: 'down' });
    }
    if (columns.length > 1) {
      actions.push({ label: '$(eye-closed) Hide Column', action: 'hide' });
    }
    actions.push({ label: '$(debug-restart) Reset Default Columns', action: 'reset' });
    actions.push({ label: '$(arrow-left) Back', action: 'back' });

    const action = await vscode.window.showQuickPick(actions, {
      title: getQuoteColumnLabel(picked.column),
      placeHolder: 'Choose an action'
    });
    if (!action || action.action === 'back') {
      continue;
    }
    if (action.action === 'up') {
      columns = moveArrayItem(columns, index, index - 1);
    } else if (action.action === 'down') {
      columns = moveArrayItem(columns, index, index + 1);
    } else if (action.action === 'hide') {
      columns = columns.filter((column) => column !== picked.column);
    } else if (action.action === 'reset') {
      columns = DEFAULT_QUOTE_COLUMNS;
    }

    columns = sanitizeQuoteColumns(columns);
    await updateConfiguredQuoteColumns(columns);
  }
}

async function updateConfiguredQuoteColumns(columns) {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update('quoteColumns', sanitizeQuoteColumns(columns), getConfigTarget(config, 'quoteColumns'));
}

function moveArrayItem(items, fromIndex, toIndex) {
  const nextItems = [...items];
  const [item] = nextItems.splice(fromIndex, 1);
  nextItems.splice(toIndex, 0, item);
  return nextItems;
}

function getQuoteColumnLabel(column) {
  return QUOTE_COLUMN_LABELS[column] || column;
}

class MarketMonitor {
  constructor(context, provider, output) {
    this.context = context;
    this.provider = provider;
    this.output = output;
    this.database = new MarketDatabase(context, output);
    this.timer = undefined;
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
    this.statusBarItem.command = 'marketMonitoring.refresh';
    this.context.subscriptions.push(this.statusBarItem);
    this.running = false;
    const cachedSnapshot = readCachedQuoteSnapshot(this.context.globalState);
    this.lastQuotes = cachedSnapshot.quotes;
    this.groupStatsQuotes = cachedSnapshot.quotes;
    this.triggeredAlerts = [];
    this.activeAlertKeys = new Set();
    const alertNotificationCache = readAlertNotificationCache(this.context.globalState);
    const today = getShanghaiDateString();
    this.notifiedAlertDate = alertNotificationCache.date === today ? alertNotificationCache.date : today;
    this.notifiedAlertCodes = new Set(alertNotificationCache.date === today ? alertNotificationCache.codes : []);
    this.dailyKlineCache = new Map();
    this.intradayTrendState = new Map();
    this.lastAlertEvaluationKey = '';
    this.activeAlertEvaluationKey = '';
    this.alertEvaluationPromise = undefined;
    this.lastRefreshSkipKey = '';
    this.lastError = '';
    this.lastUpdatedAt = cachedSnapshot.updatedAt;
    this.lastUpdatedDate = cachedSnapshot.updatedDate;
    this.isRefreshing = false;
    this.collapsedGroups = {};
    this.editingRefreshPaused = false;
    this.configureRefreshPauseDepth = 0;
    this.pendingRefreshAfterPause = false;
    this.config = readConfig();
    this.persistConfiguredSymbols('activation');
    this.databaseRestorePromise = this.restoreCachedDataFromDatabase('activation');
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
    this.persistConfiguredSymbols(reason);
    this.databaseRestorePromise = this.restoreCachedDataFromDatabase(reason);
    this.lastAlertEvaluationKey = '';
    this.lastRefreshSkipKey = '';
    this.logInfo('Configuration reloaded', {
      reason,
      symbols: this.config.symbols.length,
      groups: this.config.groups.length,
      intervalSeconds: this.config.refreshIntervalSeconds,
      onlyDuringTradingTime: this.config.onlyDuringTradingTime
    });
    this.updateViews(getMarketPhase().name, this.isRefreshing);
    if (this.isRefreshPaused()) {
      this.pendingRefreshAfterPause = true;
      this.logInfo('Refresh deferred', {
        reason: 'configurationReload',
        pauseReasons: this.getRefreshPauseReasons()
      });
      return;
    }
    this.schedule();
    this.refresh(false);
  }

  persistConfiguredSymbols(reason) {
    this.database.upsertSymbols(this.config.symbols).then(() => {
      this.logInfo('Configured symbols persisted', {
        reason,
        symbols: this.config.symbols.length
      });
    });
  }

  async restoreCachedDataFromDatabase(reason) {
    const quoteSymbols = mergeQuoteSymbols(this.config.symbols, INDEX_SYMBOLS);
    const storedSnapshot = await this.database.readQuoteSnapshot(quoteSymbols);
    if (storedSnapshot.quotes.length > 0 && (!this.lastUpdatedDate || storedSnapshot.updatedDate >= this.lastUpdatedDate)) {
      this.groupStatsQuotes = mergeQuoteUpdates(storedSnapshot.quotes, this.groupStatsQuotes, quoteSymbols);
      this.lastQuotes = mergeQuoteUpdates(storedSnapshot.quotes, this.lastQuotes, quoteSymbols);
      this.lastUpdatedAt = storedSnapshot.updatedAt || this.lastUpdatedAt;
      this.lastUpdatedDate = storedSnapshot.updatedDate || this.lastUpdatedDate;
      this.logInfo('Quote snapshot restored from SQLite', {
        reason,
        quotes: storedSnapshot.quotes.length,
        updatedDate: this.lastUpdatedDate || '',
        updatedAt: this.lastUpdatedAt || ''
      });
      this.updateViews(getMarketPhase().name);
    }

    const today = getShanghaiDateString();
    const alertNotificationCache = await this.database.readAlertNotificationCache(today);
    if (alertNotificationCache.date === today && alertNotificationCache.codes.length > 0) {
      this.notifiedAlertDate = today;
      this.notifiedAlertCodes = new Set(alertNotificationCache.codes);
      this.logInfo('Alert notification cache restored from SQLite', {
        reason,
        date: today,
        codes: alertNotificationCache.codes.length
      });
    }
  }

  webviewReady() {
    this.logInfo('Webview ready');
    this.reloadConfiguration('webviewReady');
  }

  updateCollapsedGroups(collapsedGroups) {
    const previous = this.collapsedGroups || {};
    const next = normalizeCollapsedGroups(collapsedGroups);
    const expandedGroups = Object.keys(previous).filter((group) => previous[group] && !next[group]);
    const changed = !areCollapsedGroupsEqual(previous, next);
    this.collapsedGroups = next;
    if (!changed) {
      return;
    }

    this.lastRefreshSkipKey = '';
    this.logInfo('Group collapse state updated', {
      collapsedGroups: Object.keys(next),
      expandedGroups
    });
    if (expandedGroups.length > 0) {
      this.refresh(true);
    }
  }

  updateEditingState(editing) {
    const nextEditing = Boolean(editing);
    if (this.editingRefreshPaused === nextEditing) {
      return;
    }

    this.editingRefreshPaused = nextEditing;
    this.lastRefreshSkipKey = '';
    if (nextEditing) {
      this.clearRefreshTimer();
      this.logInfo('Refresh paused', {
        reason: 'editing',
        pauseReasons: this.getRefreshPauseReasons()
      });
      return;
    }

    this.logInfo('Refresh pause ended', {
      reason: 'editing',
      pendingRefresh: this.pendingRefreshAfterPause
    });
    this.resumeRefreshAfterPause('editing');
  }

  async runWithRefreshPaused(callback, reason) {
    this.configureRefreshPauseDepth += 1;
    this.clearRefreshTimer();
    this.logInfo('Refresh paused', {
      reason,
      pauseReasons: this.getRefreshPauseReasons()
    });
    try {
      return await callback();
    } finally {
      this.configureRefreshPauseDepth = Math.max(0, this.configureRefreshPauseDepth - 1);
      this.logInfo('Refresh pause ended', {
        reason,
        pendingRefresh: this.pendingRefreshAfterPause,
        pauseReasons: this.getRefreshPauseReasons()
      });
      this.resumeRefreshAfterPause(reason);
    }
  }

  isRefreshPaused() {
    return this.editingRefreshPaused || this.configureRefreshPauseDepth > 0;
  }

  getRefreshPauseReasons() {
    const reasons = [];
    if (this.editingRefreshPaused) {
      reasons.push('editing');
    }
    if (this.configureRefreshPauseDepth > 0) {
      reasons.push('configuration');
    }
    return reasons;
  }

  resumeRefreshAfterPause(reason) {
    if (this.isRefreshPaused() || !this.running) {
      return;
    }

    if (this.pendingRefreshAfterPause) {
      this.pendingRefreshAfterPause = false;
      this.refresh(true);
      return;
    }

    this.schedule();
  }

  clearRefreshTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
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
      const results = await fetchSymbolSearchResults(keyword, this.config.requestTimeoutMs, this.database);
      this.provider.postSymbolSearchResults(requestId, keyword, results);
    } catch (error) {
      const message = getErrorMessage(error);
      this.output.appendLine(`[${new Date().toISOString()}] 标的搜索失败: ${message}`);
      this.provider.postSymbolSearchResults(requestId, keyword, [], message);
    }
  }

  async aiManage(prompt, requestId) {
    const naturalLanguagePrompt = String(prompt || '').trim();
    this.logInfo('AI manage requested', {
      requestId,
      promptLength: naturalLanguagePrompt.length,
      promptPreview: truncateForLog(naturalLanguagePrompt, 500),
      enabled: this.config.ai.enabled,
      provider: this.config.ai.provider,
      model: this.config.ai.model,
      baseUrl: sanitizeUrlForLog(this.config.ai.baseUrl),
      groups: this.config.groups.length,
      symbols: this.config.symbols.length
    });
    if (!naturalLanguagePrompt) {
      this.logWarn('AI manage rejected', { requestId, reason: 'emptyPrompt' });
      this.provider.postAiResult(requestId, {
        ok: false,
        message: '请输入要执行的 AI 指令。',
        changes: [],
        warnings: []
      });
      return;
    }

    if (!this.config.ai.enabled) {
      this.logWarn('AI manage rejected', { requestId, reason: 'aiEntryDisabled' });
      this.provider.postAiResult(requestId, {
        ok: false,
        message: 'AI 入口未开启，请先在设置中开启 marketMonitoring.ai.enabled。',
        changes: [],
        warnings: []
      });
      return;
    }

    if (!isAiConfigured(this.config.ai)) {
      this.logWarn('AI manage rejected', {
        requestId,
        reason: 'aiNotConfigured',
        provider: this.config.ai.provider,
        model: this.config.ai.model,
        hasApiKey: Boolean(this.config.ai.apiKey),
        baseUrl: sanitizeUrlForLog(this.config.ai.baseUrl)
      });
      this.provider.postAiResult(requestId, {
        ok: false,
        message: '请先在设置中配置 AI Provider、Model 和 API Key（本地模型可不填 Key）。',
        changes: [],
        warnings: []
      });
      return;
    }

    const startedAt = Date.now();
    try {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Market Monitoring AI 正在处理指令',
        cancellable: false
      }, async () => {
        const plan = await createAiManagementPlan(naturalLanguagePrompt, this.config, this.output);
        return applyAiManagementPlan(plan, this.config, this.output, this.database);
      });

      if (result.changed) {
        await updateConfiguredGroups(result.groups);
        await updateConfiguredSymbols(result.symbols);
        this.config = {
          ...this.config,
          groups: normalizeGroups(result.groups, result.symbols),
          symbols: result.symbols
        };
        this.updateViews(getMarketPhase().name);
        this.refresh(true);
      }

      this.logInfo('AI manage completed', {
        requestId,
        changed: result.changed,
        changes: result.changes.length,
        warnings: result.warnings.length,
        elapsedMs: Date.now() - startedAt,
        summary: result.summary
      });
      this.provider.postAiResult(requestId, {
        ok: true,
        message: result.summary,
        changes: result.changes,
        warnings: result.warnings
      });
      vscode.window.showInformationMessage(result.summary);
    } catch (error) {
      const message = getErrorMessage(error);
      this.logError('AI manage failed', {
        requestId,
        elapsedMs: Date.now() - startedAt,
        error: message
      });
      this.provider.postAiResult(requestId, {
        ok: false,
        message: `AI 指令执行失败：${message}`,
        changes: [],
        warnings: []
      });
      vscode.window.showErrorMessage(`AI 指令执行失败：${message}`);
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
      }, (progress) => resolveImportRows(rows, this.config, this.output, progress, this.database));

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
    if (this.databaseRestorePromise) {
      await this.databaseRestorePromise;
    }

    if (!this.running || this.isRefreshing || this.isRefreshPaused()) {
      const paused = this.isRefreshPaused();
      if (paused && this.running) {
        this.pendingRefreshAfterPause = true;
      }
      if (force) {
        this.logWarn('Refresh skipped', {
          reason: !this.running ? 'notRunning' : paused ? 'paused' : 'alreadyRefreshing',
          pauseReasons: paused ? this.getRefreshPauseReasons() : [],
          force
        });
      }
      return;
    }

    const phase = getMarketPhase();
    const quoteSymbols = mergeQuoteSymbols(this.config.symbols, INDEX_SYMBOLS);
    const realtimeQuoteSymbols = mergeQuoteSymbols(getRealtimeRefreshSymbols(this.config.symbols, this.collapsedGroups), INDEX_SYMBOLS);
    const shouldRefreshCachedSnapshot = this.config.onlyDuringTradingTime
      && !phase.isActive
      && quoteSymbols.length > 0
      && this.lastUpdatedDate !== getShanghaiDateString();
    const shouldRefreshClosingSnapshot = this.config.onlyDuringTradingTime
      && !phase.isActive
      && quoteSymbols.length > 0
      && shouldRefreshAfterCloseSnapshot(this.lastUpdatedDate, this.lastUpdatedAt);
    const shouldRefreshAlertFieldsSnapshot = this.config.enableAlerts
      && quoteSymbols.length > 0
      && needsAlertQuoteFieldsSnapshot(this.config.alerts, this.groupStatsQuotes);
    const shouldFetch = force
      || !this.config.onlyDuringTradingTime
      || phase.isActive
      || needsQuoteSnapshot(realtimeQuoteSymbols, this.lastQuotes)
      || needsQuoteSnapshot(quoteSymbols, this.groupStatsQuotes)
      || shouldRefreshCachedSnapshot
      || shouldRefreshClosingSnapshot
      || shouldRefreshAlertFieldsSnapshot;

    if (!shouldFetch) {
      this.lastError = '';
      const skipKey = `${phase.name}:${this.lastUpdatedDate}:${this.lastUpdatedAt}:${this.lastQuotes.length}:${this.groupStatsQuotes.length}`;
      if (force || this.lastRefreshSkipKey !== skipKey) {
        this.logInfo('Refresh skipped', {
          reason: 'notNeeded',
          phase: phase.name,
          quotes: this.lastQuotes.length,
          groupStatsQuotes: this.groupStatsQuotes.length,
          cachedAt: this.lastUpdatedAt || ''
        });
        this.lastRefreshSkipKey = skipKey;
      }
      if (this.shouldEvaluateCurrentAlertSnapshot()) {
        await this.evaluateCurrentAlerts('cachedSnapshot');
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
      realtimeCodes: realtimeQuoteSymbols.length,
      cachedQuotes: this.lastQuotes.length,
      cachedGroupStatsQuotes: this.groupStatsQuotes.length,
      reasons: {
        force,
        allDay: !this.config.onlyDuringTradingTime,
        activePhase: phase.isActive,
        missingQuotes: needsQuoteSnapshot(realtimeQuoteSymbols, this.lastQuotes),
        missingGroupStatsQuotes: needsQuoteSnapshot(quoteSymbols, this.groupStatsQuotes),
        staleCachedDate: shouldRefreshCachedSnapshot,
        afterCloseSnapshot: shouldRefreshClosingSnapshot,
        missingAlertFields: shouldRefreshAlertFieldsSnapshot
      }
    });
    this.updateViews(phase.name, true);

    try {
      const fetchedQuotes = await fetchQuotes(quoteSymbols, this.config.requestTimeoutMs, (message, details) => this.logInfo(message, details));
      if (this.isRefreshPaused()) {
        this.pendingRefreshAfterPause = true;
        this.logInfo('Refresh result ignored', {
          reason: 'paused',
          pauseReasons: this.getRefreshPauseReasons()
        });
        return;
      }
      const realtimeCodes = new Set(realtimeQuoteSymbols.map((symbol) => symbol.code));
      this.lastQuotes = mergeQuoteUpdates(fetchedQuotes.filter((quote) => realtimeCodes.has(quote.code)), this.lastQuotes, quoteSymbols);
      this.groupStatsQuotes = mergeQuoteUpdates(fetchedQuotes, this.groupStatsQuotes, quoteSymbols);
      this.lastUpdatedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      this.lastUpdatedDate = getShanghaiDateString();
      await this.evaluateCurrentAlerts('refresh');
      this.lastError = '';
      await writeCachedQuoteSnapshot(this.context.globalState, this.groupStatsQuotes, this.lastUpdatedAt, this.lastUpdatedDate);
      await this.persistQuoteSnapshotToDatabase();
      this.logInfo('Refresh succeeded', {
        quotes: this.lastQuotes.length,
        groupStatsQuotes: this.groupStatsQuotes.length,
        usableQuotes: countUsableQuotes(this.lastQuotes),
        usableSymbols: countUsableCodes(this.lastQuotes, this.config.symbols.map((symbol) => symbol.code)),
        usableGroupStatsSymbols: countUsableCodes(this.groupStatsQuotes, this.config.symbols.map((symbol) => symbol.code)),
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

  async persistQuoteSnapshotToDatabase() {
    const configuredCodes = new Set(this.config.symbols.map((symbol) => symbol.code));
    const configuredQuotes = this.groupStatsQuotes.filter((quote) => configuredCodes.has(quote.code));
    await this.database.upsertSymbols(this.config.symbols);
    await this.database.upsertQuoteSnapshot(this.groupStatsQuotes, this.lastUpdatedAt, this.lastUpdatedDate);
    await this.database.upsertQuoteDailyBars(configuredQuotes, this.lastUpdatedDate);
  }

  shouldEvaluateCurrentAlertSnapshot() {
    if (this.groupStatsQuotes.length === 0) {
      return false;
    }
    return this.lastAlertEvaluationKey !== this.getAlertEvaluationKey();
  }

  getAlertEvaluationKey() {
    return [
      this.lastUpdatedDate || '',
      this.lastUpdatedAt || '',
      this.config.enableAlerts ? 'enabled' : 'disabled',
      this.config.alerts.length,
      this.groupStatsQuotes.length
    ].join(':');
  }

  async evaluateCurrentAlerts(reason) {
    const evaluationKey = this.getAlertEvaluationKey();
    if (this.alertEvaluationPromise && this.activeAlertEvaluationKey === evaluationKey) {
      await this.alertEvaluationPromise;
      return;
    }
    if (!this.config.enableAlerts) {
      this.triggeredAlerts = [];
      this.lastAlertEvaluationKey = evaluationKey;
      this.logInfo('Alerts skipped', {
        reason: 'disabled'
      });
      return;
    }

    this.activeAlertEvaluationKey = evaluationKey;
    this.alertEvaluationPromise = (async () => {
      this.triggeredAlerts = await evaluateAlerts(this.groupStatsQuotes, this.config.alerts, this.config.priceDecimalPlaces, this.config.requestTimeoutMs, this.dailyKlineCache, this.intradayTrendState, this.database, (message, details) => this.logInfo(message, details));
      this.lastAlertEvaluationKey = evaluationKey;
      this.logInfo('Alerts evaluated', {
        reason,
        rules: this.config.alerts.length,
        ruleTypes: summarizeAlertRules(this.config.alerts),
        triggered: this.triggeredAlerts.length,
        quotes: this.groupStatsQuotes.length,
        cachedAt: this.lastUpdatedAt || ''
      });
      await this.notifyAlerts(this.triggeredAlerts);
    })();

    try {
      await this.alertEvaluationPromise;
    } finally {
      if (this.activeAlertEvaluationKey === evaluationKey) {
        this.activeAlertEvaluationKey = '';
        this.alertEvaluationPromise = undefined;
      }
    }
  }

  schedule() {
    this.clearRefreshTimer();

    if (!this.running || this.isRefreshPaused()) {
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

  async notifyAlerts(alerts) {
    const nextKeys = new Set(alerts.map((alert) => alert.key));
    const freshAlerts = alerts.filter((alert) => !this.activeAlertKeys.has(alert.key));
    this.activeAlertKeys = nextKeys;

    if (!this.config.enableAlertNotifications || freshAlerts.length === 0) {
      return;
    }

    const today = getShanghaiDateString();
    if (this.notifiedAlertDate !== today) {
      this.notifiedAlertDate = today;
      this.notifiedAlertCodes = new Set();
    }

    const eligibleAlerts = [];
    const eligibleCodes = new Set();
    for (const alert of freshAlerts) {
      if (!alert.code || this.notifiedAlertCodes.has(alert.code) || eligibleCodes.has(alert.code)) {
        continue;
      }
      eligibleAlerts.push(alert);
      eligibleCodes.add(alert.code);
    }

    if (eligibleAlerts.length === 0) {
      return;
    }

    for (const code of eligibleCodes) {
      this.notifiedAlertCodes.add(code);
    }
    await writeAlertNotificationCache(this.context.globalState, this.notifiedAlertDate, Array.from(this.notifiedAlertCodes));
    await this.database.writeAlertNotificationCache(this.notifiedAlertDate, Array.from(this.notifiedAlertCodes));

    const visibleAlerts = eligibleAlerts.slice(0, 3);
    for (const alert of visibleAlerts) {
      vscode.window.showWarningMessage(alert.message);
    }

    if (eligibleAlerts.length > visibleAlerts.length) {
      vscode.window.showWarningMessage(`还有 ${eligibleAlerts.length - visibleAlerts.length} 条行情预警已触发`);
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
      ai: createPublicAiConfig(this.config.ai),
      configuredGroups: this.config.groups,
      configuredSymbols: this.config.symbols,
      defaultIndexCode: DEFAULT_INDEX_CODE,
      indexes: buildIndexQuotes(this.lastQuotes),
      groups: groupQuotes(this.lastQuotes, this.config.groups, this.config.symbols, this.triggeredAlerts, this.config.sortBy, this.config.sortDirection, this.groupStatsQuotes)
    };
  }
}

class QuotesViewProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = undefined;
    this.messageHandler = undefined;
    this.openAiOnResolve = false;
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
      ai: createPublicAiConfig(readAiConfig(vscode.workspace.getConfiguration(CONFIG_SECTION))),
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
    if (this.openAiOnResolve) {
      this.openAiOnResolve = false;
      this.openAiAssistant();
    }
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

  openAiAssistant() {
    if (this.view) {
      this.view.show(true);
      this.view.webview.postMessage({ type: 'openAiAssistant' });
      return;
    }
    this.openAiOnResolve = true;
  }

  postAiResult(requestId, result) {
    if (this.view) {
      this.view.webview.postMessage({
        type: 'aiResult',
        requestId,
        result
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
      --group-stat-up: var(--up);
      --group-stat-down: var(--down);
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
      height: 100%;
    }

    body {
      margin: 0;
      padding: 12px;
      width: 100%;
      max-width: 100%;
      height: 100vh;
      min-height: 0;
      overflow: hidden;
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

    .ai-panel {
      display: grid;
      gap: 8px;
      margin-bottom: 10px;
      padding: 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: color-mix(in srgb, var(--surface-soft) 52%, transparent);
    }

    .ai-panel[hidden] {
      display: none;
    }

    .ai-panel-header {
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      min-width: 0;
    }

    .ai-panel-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-sideBarTitle-foreground);
    }

    .ai-input {
      width: 100%;
      min-height: 72px;
      resize: vertical;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 5px;
      padding: 6px 7px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font: inherit;
      outline: none;
    }

    .ai-input:focus {
      border-color: var(--focus);
      outline: 1px solid transparent;
    }

    .ai-actions {
      display: flex;
      gap: 6px;
      align-items: center;
      justify-content: flex-end;
      min-width: 0;
    }

    .ai-result {
      display: grid;
      gap: 4px;
      min-width: 0;
      color: var(--muted);
      line-height: 1.45;
    }

    .ai-result.error {
      color: var(--vscode-errorForeground);
    }

    .ai-result-list {
      margin: 0;
      padding-left: 18px;
      min-width: 0;
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

    .group-inline-panel {
      position: sticky;
      top: 44px;
      z-index: 3;
      display: grid;
      gap: 7px;
      padding: 8px;
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      background: var(--surface);
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
      overflow: visible;
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
      overflow-y: auto;
      padding-bottom: 10px;
    }

    .group-title {
      position: sticky;
      top: 0;
      z-index: 4;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 8px 8px;
      color: var(--vscode-sideBarTitle-foreground);
      background: color-mix(in srgb, var(--surface-soft) 72%, transparent);
      border-radius: 7px 7px 0 0;
    }

    .group-title-actions {
      display: flex;
      gap: 4px;
      align-items: center;
      flex: 0 1 auto;
      min-width: 0;
    }

    .group-title-actions .icon-button {
      min-width: 22px;
      width: 22px;
      height: 22px;
      font-size: 12px;
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
      gap: 0;
      align-items: center;
      flex: 0 0 auto;
      color: inherit;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .group-stats-up {
      color: var(--group-stat-up);
    }

    .group-stats-down {
      color: var(--group-stat-down);
    }

    .quote {
      display: grid;
      position: relative;
      gap: 5px;
      align-items: center;
      min-width: 0;
      padding: 4px 7px;
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
      top: 50%;
      width: 2px;
      height: 61.8%;
      border-radius: 0;
      opacity: 0.46;
      transform: translateY(-50%);
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
      gap: 8px;
      padding: 5px 7px;
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
      display: inline-flex;
      align-items: center;
      justify-content: center;
      position: relative;
      top: -1px;
      min-width: 15px;
      height: 15px;
      padding: 0 3px;
      margin-left: 4px;
      border: 1px solid currentColor;
      border-radius: 999px;
      box-sizing: border-box;
      color: var(--vscode-notificationsWarningIcon-foreground, #d29922);
      font-size: 9px;
      font-weight: 700;
      line-height: 1;
      letter-spacing: 0;
      vertical-align: middle;
      background: color-mix(in srgb, currentColor 10%, transparent);
    }

    .alert-badge-level-5 {
      color: color-mix(in srgb, #d29922 68%, var(--vscode-foreground) 32%);
    }

    .alert-badge-level-10 {
      color: color-mix(in srgb, #e67e22 76%, var(--vscode-foreground) 24%);
    }

    .alert-badge-level-20 {
      color: color-mix(in srgb, #e5534b 84%, var(--vscode-foreground) 16%);
    }

    .alert-badge-level-60 {
      color: color-mix(in srgb, #d1242f 92%, var(--vscode-foreground) 8%);
    }

    .alert-badge-generic {
      color: var(--vscode-notificationsWarningIcon-foreground, #d29922);
    }

    .alert-badge-direction {
      display: inline-block;
      width: 14px;
      height: 14px;
      margin-left: 3px;
      overflow: visible;
      vertical-align: -2.5px;
      opacity: 0.84;
    }

    .alert-badge-direction-up {
      color: color-mix(in srgb, var(--up) 76%, var(--vscode-foreground) 24%);
    }

    .alert-badge-direction-down {
      color: color-mix(in srgb, var(--down) 76%, var(--vscode-foreground) 24%);
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
      color: var(--group-stat-up);
    }

    .quote-change.down {
      color: var(--group-stat-down);
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
      padding: 2px 5px;
      min-height: 22px;
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
      display: grid;
      grid-template-columns: minmax(0, 1fr) max-content;
      gap: 8px;
      align-items: flex-end;
      flex: 0 0 auto;
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
    <button class="secondary icon-button" id="ai-assistant" title="AI" aria-label="AI" hidden>🤖</button>
  </div>
  <form class="group-form" id="group-form">
    <input id="group-name" name="group" placeholder="新增分组" autocomplete="off">
    <button class="secondary icon-button" type="submit" title="新增分组" aria-label="新增分组">＋</button>
  </form>
  <section class="ai-panel" id="ai-panel" hidden></section>
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
        risingCount: '上升数',
        fallingCount: '下降数',
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
        netProfit: '净收益额',
        aiAssistant: 'AI 助手',
        aiPromptPlaceholder: '例如：新建“观察”分组，把贵州茅台和中际旭创加入观察；把兆易创新移到自选',
        aiRun: '执行',
        aiRunning: '执行中...',
        aiOpenSettings: '配置 AI',
        aiNotConfigured: '未配置 AI。请先配置 Provider、Model 和 API Key。',
        aiReady: '自然语言管理分组和标的',
        aiChanges: '修改',
        aiWarnings: '提醒'
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
        risingCount: 'Rising',
        fallingCount: 'Falling',
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
        netProfit: 'Net profit',
        aiAssistant: 'AI Assistant',
        aiPromptPlaceholder: 'Example: create a Watch group, add Kweichow Moutai and Zhongji Innolight to Watch, move GigaDevice to Favorites',
        aiRun: 'Run',
        aiRunning: 'Running...',
        aiOpenSettings: 'Configure AI',
        aiNotConfigured: 'AI is not configured. Configure Provider, Model, and API Key first.',
        aiReady: 'Manage groups and symbols with natural language',
        aiChanges: 'Changes',
        aiWarnings: 'Warnings'
      }
    };
    let viewState = vscode.getState() || {};
    const app = document.getElementById('app');
    const phase = document.getElementById('phase');
    const toggle = document.getElementById('toggle');
    const refresh = document.getElementById('refresh');
    const importCsv = document.getElementById('import-csv');
    const exportCsv = document.getElementById('export-csv');
    const aiAssistant = document.getElementById('ai-assistant');
    const groupForm = document.getElementById('group-form');
    const groupName = document.getElementById('group-name');
    const aiPanel = document.getElementById('ai-panel');
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
    let aiOpen = Boolean(viewState.aiOpen);
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
    let aiPrompt = viewState.aiPrompt || '';
    let aiRequestId = 0;
    let activeAiRequestId = 0;
    let aiLoading = false;
    let aiResult;
    let latestSnapshot;
    let lastFlashedUpdatedAt = viewState.lastFlashedUpdatedAt || '';
    let lastSyncedEditingActive;

    refresh.addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    importCsv.addEventListener('click', () => vscode.postMessage({ command: 'importCsv' }));
    exportCsv.addEventListener('click', () => vscode.postMessage({ command: 'exportCsv' }));
    aiAssistant.addEventListener('click', () => {
      if (!latestSnapshot || !latestSnapshot.ai || !latestSnapshot.ai.enabled) {
        return;
      }
      aiOpen = !aiOpen;
      persistViewState();
      renderAiPanel(latestSnapshot);
      if (aiOpen) {
        focusAiInput();
      }
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
      syncEditingState();
      groupName.focus();
    });
    groupName.addEventListener('input', () => syncEditingState());
    groupName.addEventListener('focus', () => syncEditingState());
    groupName.addEventListener('blur', () => syncEditingState());
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
        syncEditingState();
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
        syncEditingState();
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
        syncEditingState();
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
        syncCollapsedGroups();
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
      }
    });
    aiPanel.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) {
        return;
      }
      const action = button.dataset.action;
      if (action === 'runAiPrompt') {
        runAiPrompt();
      } else if (action === 'openNativeSettings') {
        vscode.postMessage({ command: 'settings' });
      }
    });
    aiPanel.addEventListener('input', (event) => {
      const input = event.target.closest('textarea[data-ai-prompt]');
      if (!input) {
        return;
      }
      aiPrompt = input.value;
      const runButton = aiPanel.querySelector('button[data-action="runAiPrompt"]');
      if (runButton && latestSnapshot && latestSnapshot.ai) {
        runButton.disabled = !latestSnapshot.ai.configured || aiLoading || !aiPrompt.trim();
      }
      persistViewState();
    });
    aiPanel.addEventListener('keydown', (event) => {
      const input = event.target.closest('textarea[data-ai-prompt]');
      if (!input || event.key !== 'Enter' || !event.ctrlKey) {
        return;
      }
      event.preventDefault();
      runAiPrompt();
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
        syncEditingState();
        renderActiveSymbolResults();
        return;
      }

      symbolSearchLoading = true;
      syncEditingState();
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
      } else if (event.data && event.data.type === 'openAiAssistant') {
        aiOpen = true;
        persistViewState();
        renderAiPanel(latestSnapshot);
        focusAiInput();
      } else if (event.data && event.data.type === 'aiResult') {
        if (event.data.requestId !== activeAiRequestId) {
          return;
        }
        aiLoading = false;
        aiResult = event.data.result || {};
        renderAiPanel(latestSnapshot);
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
      aiAssistant.hidden = !snapshot.ai || !snapshot.ai.enabled;
      if (aiAssistant.hidden && aiOpen) {
        aiOpen = false;
        persistViewState();
      }
      const rowHighlightUp = snapshot.colors.mode === 'none' ? '#d73a49' : snapshot.colors.up;
      const rowHighlightDown = snapshot.colors.mode === 'none' ? '#16a34a' : snapshot.colors.down;
      const groupStatUp = snapshot.colors.up;
      const groupStatDown = 'color-mix(in srgb, ' + snapshot.colors.down + ' 80%, var(--surface) 20%)';
      dynamicColors.textContent = ':root{--up:' + snapshot.colors.up + ';--down:' + snapshot.colors.down + ';--flat:' + snapshot.colors.flat + ';--group-stat-up:' + groupStatUp + ';--group-stat-down:' + groupStatDown + ';--row-highlight-up:' + rowHighlightUp + ';--row-highlight-down:' + rowHighlightDown + ';}';
      toggle.dataset.running = String(snapshot.running);
      toggle.textContent = snapshot.running ? '⏸' : '▶';
      toggle.title = snapshot.running ? t('pause') : t('start');
      toggle.setAttribute('aria-label', toggle.title);
      renderAiPanel(snapshot);

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
      aiAssistant.title = t('aiAssistant');
      aiAssistant.setAttribute('aria-label', t('aiAssistant'));
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

    function renderAiPanel(snapshot) {
      const ai = snapshot && snapshot.ai ? snapshot.ai : { enabled: false, configured: false };
      aiPanel.hidden = !aiOpen || !ai.enabled;
      if (!aiOpen) {
        aiPanel.innerHTML = '';
        return;
      }
      if (!ai.enabled) {
        aiPanel.innerHTML = '';
        return;
      }

      const canRun = Boolean(ai.configured) && !aiLoading && aiPrompt.trim();
      aiPanel.innerHTML = '<div class="ai-panel-header">' +
          '<span class="ai-panel-title">' + escapeHtml(t('aiAssistant')) + '</span>' +
        '</div>' +
        '<textarea class="ai-input" data-ai-prompt placeholder="' + escapeHtml(t('aiPromptPlaceholder')) + '">' + escapeHtml(aiPrompt) + '</textarea>' +
        '<div class="ai-actions">' +
          '<span class="meta">' + escapeHtml(ai.configured ? t('aiReady') : t('aiNotConfigured')) + '</span>' +
          '<button class="secondary" data-action="openNativeSettings">' + escapeHtml(t('aiOpenSettings')) + '</button>' +
          '<button data-action="runAiPrompt" ' + (canRun ? '' : 'disabled') + '>' + escapeHtml(aiLoading ? t('aiRunning') : t('aiRun')) + '</button>' +
        '</div>' +
        renderAiResult();
    }

    function renderAiResult() {
      if (!aiResult) {
        return '';
      }
      const changes = Array.isArray(aiResult.changes) ? aiResult.changes : [];
      const warnings = Array.isArray(aiResult.warnings) ? aiResult.warnings : [];
      return '<div class="ai-result' + (aiResult.ok === false ? ' error' : '') + '">' +
        '<div>' + escapeHtml(aiResult.message || '') + '</div>' +
        renderAiResultList(t('aiChanges'), changes) +
        renderAiResultList(t('aiWarnings'), warnings) +
      '</div>';
    }

    function renderAiResultList(label, items) {
      if (!Array.isArray(items) || items.length === 0) {
        return '';
      }
      return '<div>' + escapeHtml(label) + '</div><ul class="ai-result-list">' +
        items.map((item) => '<li>' + escapeHtml(item) + '</li>').join('') +
      '</ul>';
    }

    function focusAiInput() {
      window.setTimeout(() => {
        const input = aiPanel.querySelector('textarea[data-ai-prompt]');
        if (input) {
          input.focus();
        }
      }, 0);
    }

    function runAiPrompt() {
      const prompt = aiPrompt.trim();
      if (!prompt || aiLoading) {
        return;
      }
      aiLoading = true;
      aiResult = undefined;
      activeAiRequestId = ++aiRequestId;
      renderAiPanel(latestSnapshot);
      vscode.postMessage({
        command: 'aiManage',
        requestId: activeAiRequestId,
        prompt
      });
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
        const groupStats = '<span class="group-stats" title="' + escapeHtml(t('risingCount') + ': ' + stats.up + ', ' + t('fallingCount') + ': ' + stats.down) + '">' +
          '<span>(</span>' +
          '<span class="group-stats-up">' + stats.up + '</span>' +
          '<span>:</span>' +
          '<span class="group-stats-down">' + stats.down + '</span>' +
          '<span>)</span>' +
        '</span>';
        return '<section class="group' + (editing ? ' editing' : '') + '">' +
          '<div class="group-title">' +
            '<span class="group-title-main">' +
              '<button class="secondary icon-button" data-action="toggleGroup" data-group="' + escapeHtml(group.name) + '" title="' + (collapsed ? escapeHtml(t('expand')) : escapeHtml(t('collapse'))) + '" aria-label="' + (collapsed ? escapeHtml(t('expand')) : escapeHtml(t('collapse'))) + '">' + (collapsed ? '›' : '⌄') + '</button>' +
              '<span class="group-name' + (flashGroupNames ? ' refresh-succeeded' : '') + '">' + escapeHtml(group.name) + '</span>' +
              groupStats +
            '</span>' +
            '<span class="group-title-actions">' +
              renderGroupAddButton(group.name, adding) +
              renderGroupEditButton(group.name, editing) +
            '</span>' +
          '</div>' +
          renderGroupInlinePanel(group.name, editing, adding) +
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
        '<div class="group-footer-actions">' +
          renderGroupAddButton(groupName, adding) +
          renderGroupEditButton(groupName, editing) +
        '</div>' +
      '</div>';
    }

    function renderGroupInlinePanel(groupName, editing, adding) {
      const content = (adding ? renderGroupSymbolSearch(groupName) : '') +
        (editing ? renderGroupRenameRow(groupName) : '');
      return content ? '<div class="group-inline-panel">' + content + '</div>' : '';
    }

    function renderGroupRenameRow(groupName) {
      return '<div class="group-rename-row">' +
        '<input data-group-name="' + escapeHtml(groupName) + '" value="' + escapeHtml(groupName) + '" title="' + escapeHtml(t('groupName')) + '">' +
        '<button class="secondary icon-button" data-action="renameGroup" data-group="' + escapeHtml(groupName) + '" title="' + escapeHtml(t('saveGroupName')) + '" aria-label="' + escapeHtml(t('saveGroupName')) + '">✓</button>' +
      '</div>';
    }

    function renderGroupAddButton(groupName, adding) {
      return '<button class="secondary icon-button" data-action="addToGroup" data-group="' + escapeHtml(groupName) + '" title="' + (adding ? escapeHtml(t('collapseAdd')) : escapeHtml(t('addSymbol'))) + '" aria-label="' + (adding ? escapeHtml(t('collapseAdd')) : escapeHtml(t('addSymbol'))) + '">' + (adding ? '−' : '＋') + '</button>';
    }

    function renderGroupEditButton(groupName, editing) {
      return '<button class="secondary icon-button" data-action="editGroup" data-group="' + escapeHtml(groupName) + '" title="' + (editing ? escapeHtml(t('doneEditing')) : escapeHtml(t('editGroup'))) + '" aria-label="' + (editing ? escapeHtml(t('doneEditing')) : escapeHtml(t('editGroup'))) + '">' + (editing ? '✓' : '✎') + '</button>';
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
          '<div class="name" title="' + escapeHtml(quote.name) + '">' + escapeHtml(quote.name) + renderAlertBadge(quote.alerts, alertText) + '</div>' +
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

    function renderAlertBadge(alerts, alertText) {
      if (!Array.isArray(alerts) || alerts.length === 0) {
        return '';
      }
      const title = escapeHtml(alertText);
      const label = escapeHtml(t('alert'));
      const movingAverageDays = getMaxMovingAverageAlertDays(alerts);
      const badgeText = movingAverageDays === null ? '!' : String(movingAverageDays);
      const levelClass = movingAverageDays === null ? ' alert-badge-generic' : ' alert-badge-level-' + movingAverageDays;
      const badges = [
        '<span class="alert-badge' + levelClass + '" title="' + title + '" aria-label="' + label + '">' + escapeHtml(badgeText) + '</span>'
      ];
      for (const direction of getAlertDirections(alerts)) {
        badges.push(renderAlertDirectionBadge(direction, title, label));
      }
      return badges.join('');
    }

    function getMaxMovingAverageAlertDays(alerts) {
      const days = alerts
        .map((alert) => Number(alert && alert.movingAverageDays))
        .filter((value) => Number.isFinite(value) && value > 0);
      return days.length > 0 ? Math.max(...days) : null;
    }

    function getAlertDirections(alerts) {
      const directions = [];
      for (const alert of alerts) {
        const direction = getAlertDirection(alert);
        if (direction && !directions.includes(direction)) {
          directions.push(direction);
        }
      }
      return directions;
    }

    function getAlertDirection(alert) {
      const type = String(alert && alert.type || '');
      if ([
        'movingAverageBelow',
        'intradayHighPullback',
        'bearishMovingAverage',
        'macdDeathCross',
        'volumeDrop',
        'lowBreak',
        'rsiWeak',
        'bollingerBelow'
      ].includes(type)) {
        return 'down';
      }
      if (type === 'reboundLowVolume') {
        return 'up';
      }

      const key = String(alert && alert.key || '');
      if (/:priceAbove:|:changePercentAbove:|:reboundLowVolume:/.test(key)) {
        return 'up';
      }
      if (/:priceBelow:|:changePercentBelow:|:movingAverageBelow:|:intradayHighPullback:|:bearishMovingAverage:|:macdDeathCross:|:volumeDrop:|:lowBreak:|:rsiWeak:|:bollingerBelow:/.test(key)) {
        return 'down';
      }

      const label = String(alert && alert.label || '');
      if (/上涨|涨幅|反弹|>=/.test(label)) {
        return 'up';
      }
      if (/下跌|跌破|回落|走弱|死叉|<=/.test(label)) {
        return 'down';
      }
      return '';
    }

    function renderAlertDirectionBadge(direction, title, label) {
      const up = direction === 'up';
      return '<svg class="alert-badge-direction alert-badge-direction-' + direction + '" title="' + title + '" aria-label="' + label + '" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M8 ' + (up ? '13.25V3.75' : '2.75V12.25') + '" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"></path>' +
        '<path d="' + (up ? 'M4.75 7L8 3.75L11.25 7' : 'M4.75 9L8 12.25L11.25 9') + '" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"></path>' +
      '</svg>';
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
        aiOpen,
        aiPrompt,
        tableSort,
        columnWidths,
        lastFlashedUpdatedAt
      };
      vscode.setState(viewState);
    }

    function syncCollapsedGroups() {
      vscode.postMessage({
        command: 'collapsedGroupsChanged',
        collapsedGroups
      });
    }

    function isEditingActive() {
      return hasEnabledFlag(editingGroups)
        || hasEnabledFlag(addingGroups)
        || Boolean(String(groupName.value || '').trim());
    }

    function hasEnabledFlag(value) {
      return Boolean(value && typeof value === 'object' && Object.values(value).some(Boolean));
    }

    function syncEditingState(force = false) {
      const editing = isEditingActive();
      if (!force && editing === lastSyncedEditingActive) {
        return;
      }
      lastSyncedEditingActive = editing;
      vscode.postMessage({
        command: 'editingStateChanged',
        editing
      });
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

    syncEditingState(true);
    vscode.postMessage({ command: 'webviewReady', collapsedGroups, editing: isEditingActive() });
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
  const rawAlerts = config.get('alerts', []);
  const explicitAlertCodes = getExplicitAlertCodes(rawAlerts);
  const normalizedAlerts = rawAlerts
    .map(normalizeAlertRule)
    .filter(Boolean);
  const alerts = addDefaultIntradayHighPullbackAlerts(symbols, addDefaultMovingAverageAlerts(symbols, normalizedAlerts, explicitAlertCodes));
  const language = sanitizeLanguage(config.get('language', DEFAULT_LANGUAGE));
  const ai = readAiConfig(config);

  return {
    groups,
    symbols,
    alerts,
    ai,
    language,
    locale: resolveLanguage(language),
    enableAlerts: config.get('enableAlerts', true),
    enableAlertNotifications: config.get('enableAlertNotifications', false),
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

function readAiConfig(config) {
  const enabled = Boolean(config.get('ai.enabled', false));
  const provider = sanitizeAiProvider(config.get('ai.provider', 'disabled'));
  const model = String(config.get('ai.model', '') || DEFAULT_AI_MODELS[provider] || '').trim();
  const baseUrl = normalizeBaseUrl(config.get('ai.baseUrl', '') || DEFAULT_AI_BASE_URLS[provider] || '');
  const apiKey = String(config.get('ai.apiKey', '') || '').trim();
  const azureApiVersion = String(config.get('ai.azureApiVersion', '2024-06-01') || '2024-06-01').trim();
  const temperature = clampNumber(config.get('ai.temperature', 0.1), 0, 1, 0.1);
  const timeoutMs = Math.round(clampNumber(config.get('ai.timeoutMs', 30000), 5000, 120000, 30000));

  return {
    enabled,
    provider,
    model,
    baseUrl,
    apiKey,
    azureApiVersion,
    temperature,
    timeoutMs
  };
}

function sanitizeAiProvider(value) {
  return AI_PROVIDERS.includes(value) ? value : 'disabled';
}

function createPublicAiConfig(ai) {
  return {
    enabled: Boolean(ai && ai.enabled),
    configured: Boolean(ai && ai.enabled && isAiConfigured(ai))
  };
}

function isAiConfigured(ai) {
  if (!ai || !ai.provider || ai.provider === 'disabled') {
    return false;
  }
  if (!ai.model) {
    return false;
  }
  if ((ai.provider === 'azureOpenAI' || ai.provider === 'customOpenAICompatible') && !ai.baseUrl) {
    return false;
  }
  return ['ollama', 'lmStudio'].includes(ai.provider) || Boolean(ai.apiKey);
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
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

async function createAiManagementPlan(prompt, config, output) {
  const startedAt = Date.now();
  appendLog(output, 'INFO', 'AI plan creation started', {
    provider: config.ai.provider,
    model: config.ai.model,
    baseUrl: sanitizeUrlForLog(config.ai.baseUrl),
    temperature: config.ai.temperature,
    timeoutMs: config.ai.timeoutMs,
    promptLength: prompt.length,
    promptPreview: truncateForLog(prompt, 500),
    groups: config.groups.length,
    symbols: config.symbols.length
  });
  const systemPrompt = [
    '你是 Market Monitoring VS Code 扩展的分组和标的管理助手。',
    '你必须只返回 JSON，不要 Markdown，不要解释。',
    '根据用户自然语言，把需求转换为 actions 数组。',
    '可用 action.type：addGroup, renameGroup, removeGroup, addSymbol, removeSymbol, moveSymbol, renameSymbol, updateSymbol。',
    '字段约定：group/name/newName/oldName/code/cost/holding/moveSymbolsTo。',
    'addSymbol 可以只给 name，扩展会搜索匹配标的；如果用户给了股票代码，必须放到 code。',
    'removeGroup 默认把组内标的移动到 moveSymbolsTo；没有指定时可以省略。',
    '不要编造不存在于当前列表中的旧标的代码；不确定时优先用 name。',
    '返回格式：{"actions":[...],"note":"简短说明"}'
  ].join('\n');
  const userPrompt = JSON.stringify({
    instruction: prompt,
    currentGroups: config.groups,
    currentSymbols: config.symbols.map((symbol) => ({
      code: symbol.code,
      name: symbol.name,
      group: symbol.group,
      cost: symbol.cost,
      holding: symbol.holding
    }))
  });
  const content = await requestAiCompletion(config.ai, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ], output);
  appendLog(output, 'INFO', 'AI plan response received', {
    elapsedMs: Date.now() - startedAt,
    contentLength: content.length,
    contentPreview: truncateForLog(content)
  });
  let parsed;
  try {
    parsed = parseAiJson(content);
  } catch (error) {
    appendLog(output, 'ERROR', 'AI plan JSON parse failed', {
      error: getErrorMessage(error),
      contentLength: content.length,
      contentPreview: truncateForLog(content)
    });
    throw error;
  }
  const actions = Array.isArray(parsed.actions)
    ? parsed.actions
    : Array.isArray(parsed.operations)
      ? parsed.operations
      : [];
  appendLog(output, 'INFO', 'AI plan parsed', {
    actions: actions.length,
    note: truncateForLog(String(parsed.note || parsed.summary || ''), 500),
    actionTypes: actions.map((action) => action && action.type).filter(Boolean)
  });
  return {
    note: String(parsed.note || parsed.summary || '').trim(),
    actions
  };
}

async function applyAiManagementPlan(plan, config, output, database) {
  appendLog(output, 'INFO', 'AI plan application started', {
    requestedActions: Array.isArray(plan.actions) ? plan.actions.length : 0,
    currentGroups: config.groups.length,
    currentSymbols: config.symbols.length
  });
  const changes = [];
  const warnings = [];
  let nextGroups = [...config.groups];
  let nextSymbols = config.symbols.map((symbol) => ({ ...symbol }));

  const ensureGroup = (name) => {
    const group = normalizeGroupName(name) || DEFAULT_GROUP;
    if (!nextGroups.includes(group)) {
      nextGroups.push(group);
      changes.push(`新增分组：${group}`);
    }
    return group;
  };

  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
    const rawAction = actions[actionIndex];
    const action = normalizeAiAction(rawAction);
    appendLog(output, 'INFO', 'AI action received', {
      index: actionIndex,
      rawAction: sanitizeAiActionForLog(rawAction),
      normalizedType: action ? action.type : ''
    });
    if (!action) {
      warnings.push('跳过无法识别的 AI 操作。');
      appendLog(output, 'WARN', 'AI action skipped', {
        index: actionIndex,
        reason: 'unknownAction',
        rawAction: sanitizeAiActionForLog(rawAction)
      });
      continue;
    }

    if (action.type === 'addGroup') {
      const group = ensureGroup(action.name || action.group);
      appendLog(output, 'INFO', 'AI action applied', { index: actionIndex, type: action.type, group });
      continue;
    }

    if (action.type === 'renameGroup') {
      const oldName = normalizeGroupName(action.oldName || action.name || action.group);
      const newName = normalizeGroupName(action.newName || action.to || action.targetGroup);
      if (!oldName || !newName) {
        warnings.push('跳过分组重命名：缺少旧名称或新名称。');
        appendLog(output, 'WARN', 'AI action skipped', { index: actionIndex, type: action.type, reason: 'missingGroupName', action: sanitizeAiActionForLog(action) });
        continue;
      }
      if (!nextGroups.includes(oldName)) {
        warnings.push(`分组不存在，无法重命名：${oldName}`);
        appendLog(output, 'WARN', 'AI action skipped', { index: actionIndex, type: action.type, reason: 'groupNotFound', oldName });
        continue;
      }
      nextGroups = nextGroups
        .map((group) => group === oldName ? newName : group)
        .filter((group, index, groups) => groups.indexOf(group) === index);
      nextSymbols = nextSymbols.map((symbol) => symbol.group === oldName ? { ...symbol, group: newName } : symbol);
      changes.push(`重命名分组：${oldName} -> ${newName}`);
      appendLog(output, 'INFO', 'AI action applied', { index: actionIndex, type: action.type, oldName, newName });
      continue;
    }

    if (action.type === 'removeGroup') {
      const groupName = normalizeGroupName(action.name || action.group);
      if (!groupName || !nextGroups.includes(groupName)) {
        warnings.push(`分组不存在，无法删除：${groupName || '(空)'}`);
        appendLog(output, 'WARN', 'AI action skipped', { index: actionIndex, type: action.type, reason: 'groupNotFound', groupName });
        continue;
      }
      const fallbackGroup = ensureGroup(action.moveSymbolsTo || DEFAULT_GROUP);
      nextGroups = nextGroups.filter((group) => group !== groupName);
      nextSymbols = nextSymbols.map((symbol) => symbol.group === groupName ? { ...symbol, group: fallbackGroup } : symbol);
      changes.push(`删除分组：${groupName}，组内标的移动到 ${fallbackGroup}`);
      appendLog(output, 'INFO', 'AI action applied', { index: actionIndex, type: action.type, groupName, fallbackGroup });
      continue;
    }

    if (action.type === 'addSymbol') {
      const symbol = await resolveAiSymbol(action, config, warnings, output, database);
      if (!symbol) {
        appendLog(output, 'WARN', 'AI action skipped', { index: actionIndex, type: action.type, reason: 'symbolResolveFailed', action: sanitizeAiActionForLog(action) });
        continue;
      }
      if (isBuiltInIndexCode(symbol.code)) {
        warnings.push(`${symbol.name} 是内置指数，未加入自选标的。`);
        appendLog(output, 'WARN', 'AI action skipped', { index: actionIndex, type: action.type, reason: 'builtInIndex', symbol });
        continue;
      }
      if (nextSymbols.some((item) => item.code === symbol.code)) {
        warnings.push(`标的已存在，跳过：${symbol.name} (${symbol.code})`);
        appendLog(output, 'WARN', 'AI action skipped', { index: actionIndex, type: action.type, reason: 'symbolExists', symbol });
        continue;
      }
      const group = ensureGroup(symbol.group || action.group || DEFAULT_GROUP);
      const insertIndex = findGroupInsertIndex(nextSymbols, group);
      nextSymbols.splice(insertIndex, 0, { ...symbol, group });
      changes.push(`新增标的：${symbol.name} (${symbol.code}) -> ${group}`);
      appendLog(output, 'INFO', 'AI action applied', { index: actionIndex, type: action.type, symbol, insertIndex });
      continue;
    }

    const symbolIndex = findAiSymbolIndex(nextSymbols, action);
    if (symbolIndex < 0) {
      warnings.push(`未找到标的，跳过：${action.name || action.code || '(未指定)'}`);
      appendLog(output, 'WARN', 'AI action skipped', { index: actionIndex, type: action.type, reason: 'symbolNotFound', action: sanitizeAiActionForLog(action) });
      continue;
    }

    const currentSymbol = nextSymbols[symbolIndex];
    if (action.type === 'removeSymbol') {
      nextSymbols.splice(symbolIndex, 1);
      changes.push(`删除标的：${currentSymbol.name} (${currentSymbol.code})`);
      appendLog(output, 'INFO', 'AI action applied', { index: actionIndex, type: action.type, symbol: currentSymbol });
      continue;
    }

    if (action.type === 'moveSymbol') {
      const group = ensureGroup(action.group || action.newGroup || action.targetGroup);
      nextSymbols[symbolIndex] = { ...currentSymbol, group };
      changes.push(`移动标的：${currentSymbol.name} (${currentSymbol.code}) -> ${group}`);
      appendLog(output, 'INFO', 'AI action applied', { index: actionIndex, type: action.type, symbol: currentSymbol, group });
      continue;
    }

    if (action.type === 'renameSymbol') {
      const nextName = String(action.newName || action.alias || '').trim();
      if (!nextName) {
        warnings.push(`跳过标的重命名：${currentSymbol.name} 缺少新名称。`);
        appendLog(output, 'WARN', 'AI action skipped', { index: actionIndex, type: action.type, reason: 'missingNewName', symbol: currentSymbol });
        continue;
      }
      nextSymbols[symbolIndex] = { ...currentSymbol, name: nextName };
      changes.push(`重命名标的：${currentSymbol.name} -> ${nextName}`);
      appendLog(output, 'INFO', 'AI action applied', { index: actionIndex, type: action.type, oldName: currentSymbol.name, newName: nextName, code: currentSymbol.code });
      continue;
    }

    if (action.type === 'updateSymbol') {
      const patch = {};
      if (action.name) {
        patch.name = String(action.name).trim();
      }
      if (action.group || action.newGroup || action.targetGroup) {
        patch.group = ensureGroup(action.group || action.newGroup || action.targetGroup);
      }
      if (action.cost !== undefined) {
        patch.cost = optionalNumber(action.cost);
      }
      if (action.holding !== undefined) {
        patch.holding = optionalNumber(action.holding);
      }
      nextSymbols[symbolIndex] = { ...currentSymbol, ...patch };
      changes.push(`更新标的：${currentSymbol.name} (${currentSymbol.code})`);
      appendLog(output, 'INFO', 'AI action applied', { index: actionIndex, type: action.type, symbol: currentSymbol, patch });
    }
  }

  nextGroups = normalizeGroups(nextGroups, nextSymbols);
  const changed = changes.length > 0;
  appendLog(output, 'INFO', 'AI plan applied', {
    changed,
    changes,
    warnings,
    nextGroups: nextGroups.length,
    nextSymbols: nextSymbols.length
  });
  return {
    changed,
    groups: nextGroups,
    symbols: nextSymbols,
    changes,
    warnings,
    summary: changed
      ? `AI 已执行 ${changes.length} 项修改${warnings.length > 0 ? `，${warnings.length} 项提醒` : ''}`
      : `AI 未产生配置修改${warnings.length > 0 ? `，${warnings.length} 项提醒` : ''}`
  };
}

function normalizeAiAction(action) {
  if (!action || typeof action !== 'object') {
    return undefined;
  }
  const aliases = {
    add_group: 'addGroup',
    rename_group: 'renameGroup',
    remove_group: 'removeGroup',
    deleteGroup: 'removeGroup',
    delete_group: 'removeGroup',
    add_symbol: 'addSymbol',
    remove_symbol: 'removeSymbol',
    deleteSymbol: 'removeSymbol',
    delete_symbol: 'removeSymbol',
    move_symbol: 'moveSymbol',
    rename_symbol: 'renameSymbol',
    update_symbol: 'updateSymbol'
  };
  const type = aliases[action.type] || action.type;
  const allowed = new Set(['addGroup', 'renameGroup', 'removeGroup', 'addSymbol', 'removeSymbol', 'moveSymbol', 'renameSymbol', 'updateSymbol']);
  return allowed.has(type) ? { ...action, type } : undefined;
}

async function resolveAiSymbol(action, config, warnings, output, database) {
  const code = normalizeCode(String(action.code || ''));
  const group = normalizeGroupName(action.group || action.targetGroup || action.newGroup) || DEFAULT_GROUP;
  if (code) {
    appendLog(output, 'INFO', 'AI symbol resolved by code', { code, group });
    const name = String(action.name || '').trim() || await findSymbolNameByCode(code, config.requestTimeoutMs, database) || code;
    return {
      code,
      name,
      group,
      cost: optionalNumber(action.cost),
      holding: optionalNumber(action.holding)
    };
  }

  const name = String(action.name || action.keyword || '').trim();
  if (!name) {
    warnings.push('跳过新增标的：缺少名称或代码。');
    appendLog(output, 'WARN', 'AI symbol resolve skipped', { reason: 'missingNameAndCode', action: sanitizeAiActionForLog(action) });
    return undefined;
  }

  const startedAt = Date.now();
  appendLog(output, 'INFO', 'AI symbol search started', { keyword: name, timeoutMs: config.requestTimeoutMs });
  const results = await fetchSymbolSearchResults(name, config.requestTimeoutMs, database).catch((error) => {
    warnings.push(`搜索标的失败：${name}，${getErrorMessage(error)}`);
    appendLog(output, 'WARN', 'AI symbol search failed', {
      keyword: name,
      elapsedMs: Date.now() - startedAt,
      error: getErrorMessage(error)
    });
    return [];
  });
  appendLog(output, 'INFO', 'AI symbol search returned', {
    keyword: name,
    elapsedMs: Date.now() - startedAt,
    results: results.length,
    topResults: results.slice(0, 5).map((item) => ({ code: item.code, name: item.name, market: item.market }))
  });
  const matched = results[0];
  if (!matched) {
    warnings.push(`没有找到可添加的标的：${name}`);
    return undefined;
  }

  return {
    code: matched.code,
    name: String(action.displayName || action.name || matched.name || matched.code).trim(),
    group,
    cost: optionalNumber(action.cost),
    holding: optionalNumber(action.holding)
  };
}

function findAiSymbolIndex(symbols, action) {
  const code = normalizeCode(String(action.code || ''));
  if (code) {
    return symbols.findIndex((symbol) => symbol.code === code);
  }

  const name = String(action.name || action.oldName || action.keyword || '').trim();
  if (!name) {
    return -1;
  }
  const exactIndex = symbols.findIndex((symbol) => symbol.name === name);
  if (exactIndex >= 0) {
    return exactIndex;
  }
  const lowerName = name.toLowerCase();
  return symbols.findIndex((symbol) => symbol.name.toLowerCase().includes(lowerName) || symbol.code.toLowerCase() === lowerName);
}

async function requestAiCompletion(ai, messages, output) {
  appendLog(output, 'INFO', 'AI completion dispatch', {
    provider: ai.provider,
    model: ai.model,
    baseUrl: sanitizeUrlForLog(ai.baseUrl),
    messageCount: messages.length,
    messageSizes: messages.map((message) => ({ role: message.role, length: String(message.content || '').length }))
  });
  if (OPENAI_COMPATIBLE_AI_PROVIDERS.includes(ai.provider)) {
    return requestOpenAiCompatibleCompletion(ai, messages, output);
  }
  if (ai.provider === 'azureOpenAI') {
    return requestAzureOpenAiCompletion(ai, messages, output);
  }
  if (ai.provider === 'anthropic') {
    return requestAnthropicCompletion(ai, messages, output);
  }
  if (ai.provider === 'gemini') {
    return requestGeminiCompletion(ai, messages, output);
  }
  throw new Error(`不支持的 AI Provider：${ai.provider}`);
}

async function requestOpenAiCompatibleCompletion(ai, messages, output) {
  const baseUrl = ai.baseUrl || DEFAULT_AI_BASE_URLS[ai.provider];
  const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'VSCode Market Monitoring'
  };
  if (ai.apiKey) {
    headers.Authorization = `Bearer ${ai.apiKey}`;
  }
  if (ai.provider === 'openrouter') {
    headers['X-Title'] = 'Market Monitoring';
  }
  const response = await requestJson(url, {
    method: 'POST',
    headers,
    body: {
      model: ai.model,
      messages,
      temperature: ai.temperature
    },
    timeoutMs: ai.timeoutMs,
    errorPrefix: 'AI 接口',
    output,
    logContext: {
      provider: ai.provider,
      model: ai.model,
      endpointType: 'openaiCompatibleChatCompletions'
    }
  });
  const content = response && response.choices && response.choices[0] && response.choices[0].message
    ? String(response.choices[0].message.content || '')
    : '';
  appendLog(output, 'INFO', 'AI completion extracted', {
    provider: ai.provider,
    model: ai.model,
    contentLength: content.length,
    choices: Array.isArray(response.choices) ? response.choices.length : 0,
    finishReason: response && response.choices && response.choices[0] ? response.choices[0].finish_reason : '',
    usage: response ? response.usage : undefined
  });
  return content;
}

async function requestAzureOpenAiCompletion(ai, messages, output) {
  const baseUrl = ai.baseUrl || '';
  if (!baseUrl) {
    throw new Error('Azure OpenAI 需要配置 marketMonitoring.ai.baseUrl');
  }
  const url = `${baseUrl}/openai/deployments/${encodeURIComponent(ai.model)}/chat/completions?api-version=${encodeURIComponent(ai.azureApiVersion)}`;
  const response = await requestJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': ai.apiKey,
      'User-Agent': 'VSCode Market Monitoring'
    },
    body: {
      messages,
      temperature: ai.temperature
    },
    timeoutMs: ai.timeoutMs,
    errorPrefix: 'Azure OpenAI 接口',
    output,
    logContext: {
      provider: ai.provider,
      model: ai.model,
      endpointType: 'azureChatCompletions'
    }
  });
  const content = response && response.choices && response.choices[0] && response.choices[0].message
    ? String(response.choices[0].message.content || '')
    : '';
  appendLog(output, 'INFO', 'AI completion extracted', {
    provider: ai.provider,
    model: ai.model,
    contentLength: content.length,
    choices: Array.isArray(response.choices) ? response.choices.length : 0,
    finishReason: response && response.choices && response.choices[0] ? response.choices[0].finish_reason : '',
    usage: response ? response.usage : undefined
  });
  return content;
}

async function requestAnthropicCompletion(ai, messages, output) {
  const systemMessage = messages.find((message) => message.role === 'system');
  const userMessages = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content || '')
    }));
  const response = await requestJson(`${ai.baseUrl || DEFAULT_AI_BASE_URLS.anthropic}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ai.apiKey,
      'anthropic-version': '2023-06-01',
      'User-Agent': 'VSCode Market Monitoring'
    },
    body: {
      model: ai.model,
      max_tokens: 1200,
      temperature: ai.temperature,
      system: systemMessage ? String(systemMessage.content || '') : undefined,
      messages: userMessages
    },
    timeoutMs: ai.timeoutMs,
    errorPrefix: 'Anthropic 接口',
    output,
    logContext: {
      provider: ai.provider,
      model: ai.model,
      endpointType: 'anthropicMessages'
    }
  });
  const content = Array.isArray(response.content)
    ? response.content.map((item) => item && item.text ? item.text : '').join('')
    : '';
  appendLog(output, 'INFO', 'AI completion extracted', {
    provider: ai.provider,
    model: ai.model,
    contentLength: content.length,
    stopReason: response ? response.stop_reason : '',
    usage: response ? response.usage : undefined
  });
  return content;
}

async function requestGeminiCompletion(ai, messages, output) {
  const baseUrl = ai.baseUrl || DEFAULT_AI_BASE_URLS.gemini;
  const systemMessage = messages.find((message) => message.role === 'system');
  const userText = messages
    .filter((message) => message.role !== 'system')
    .map((message) => String(message.content || ''))
    .join('\n\n');
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(ai.model)}:generateContent?key=${encodeURIComponent(ai.apiKey)}`;
  const response = await requestJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'VSCode Market Monitoring'
    },
    body: {
      systemInstruction: systemMessage ? { parts: [{ text: String(systemMessage.content || '') }] } : undefined,
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: {
        temperature: ai.temperature,
        responseMimeType: 'application/json'
      }
    },
    timeoutMs: ai.timeoutMs,
    errorPrefix: 'Gemini 接口',
    output,
    logContext: {
      provider: ai.provider,
      model: ai.model,
      endpointType: 'geminiGenerateContent'
    }
  });
  const parts = response && response.candidates && response.candidates[0] && response.candidates[0].content
    ? response.candidates[0].content.parts
    : [];
  const content = Array.isArray(parts) ? parts.map((part) => part.text || '').join('') : '';
  appendLog(output, 'INFO', 'AI completion extracted', {
    provider: ai.provider,
    model: ai.model,
    contentLength: content.length,
    candidates: Array.isArray(response.candidates) ? response.candidates.length : 0,
    finishReason: response && response.candidates && response.candidates[0] ? response.candidates[0].finishReason : '',
    usage: response ? response.usageMetadata : undefined
  });
  return content;
}

function parseAiJson(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!text) {
    throw new Error('AI 未返回内容');
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw error;
  }
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

function getExplicitAlertCodes(items) {
  if (!Array.isArray(items)) {
    return new Set();
  }

  return new Set(items
    .map((item) => item && typeof item === 'object' ? normalizeCode(String(item.code || '')) : '')
    .filter(Boolean));
}

function addDefaultMovingAverageAlerts(symbols, alerts, explicitAlertCodes) {
  const configuredCodes = explicitAlertCodes || new Set();
  const existingCodes = new Set((alerts || []).map((alert) => alert.code));
  const defaults = [];

  for (const symbol of symbols) {
    if (!symbol || !symbol.code || configuredCodes.has(symbol.code) || existingCodes.has(symbol.code)) {
      continue;
    }

    defaults.push({
      code: symbol.code,
      name: symbol.name || '',
      movingAverageBelow: true,
      movingAverageDays: DEFAULT_MOVING_AVERAGE_DAYS,
      movingAverageDaysList: DEFAULT_MOVING_AVERAGE_ALERT_DAYS,
      intradayHighPullback: true,
      intradayHighPullbackPercent: DEFAULT_INTRADAY_HIGH_PULLBACK_PERCENT,
      intradayDowntrendConfirmTicks: DEFAULT_INTRADAY_DOWNTREND_CONFIRM_TICKS,
      intradayDowntrendSlopePoints: DEFAULT_INTRADAY_DOWNTREND_SLOPE_POINTS,
      intradayVwapBelow: true,
      priceAbove: null,
      priceBelow: null,
      changePercentAbove: null,
      changePercentBelow: null
    });
  }

  return [...(alerts || []), ...defaults];
}

function addDefaultIntradayHighPullbackAlerts(symbols, alerts) {
  const existingCodes = new Set((alerts || [])
    .filter((alert) => alert && alert.intradayHighPullback)
    .map((alert) => alert.code));
  const defaults = [];

  for (const symbol of symbols) {
    if (!symbol || !symbol.code || existingCodes.has(symbol.code)) {
      continue;
    }

    defaults.push({
      code: symbol.code,
      name: symbol.name || '',
      movingAverageBelow: false,
      intradayHighPullback: true,
      intradayHighPullbackPercent: DEFAULT_INTRADAY_HIGH_PULLBACK_PERCENT,
      intradayDowntrendConfirmTicks: DEFAULT_INTRADAY_DOWNTREND_CONFIRM_TICKS,
      intradayDowntrendSlopePoints: DEFAULT_INTRADAY_DOWNTREND_SLOPE_POINTS,
      intradayVwapBelow: true,
      priceAbove: null,
      priceBelow: null,
      changePercentAbove: null,
      changePercentBelow: null
    });
  }

  return [...(alerts || []), ...defaults];
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
  const movingAverageBelow = item.movingAverageBelow !== false || item.movingAverageBelowDays !== undefined;
  const movingAverageDaysValue = item.movingAverageDays !== undefined ? item.movingAverageDays : item.movingAverageBelowDays;
  const movingAverageDaysList = sanitizeMovingAverageDaysList(movingAverageDaysValue, DEFAULT_MOVING_AVERAGE_ALERT_DAYS);
  const movingAverageDays = movingAverageDaysList.includes(DEFAULT_MOVING_AVERAGE_DAYS)
    ? DEFAULT_MOVING_AVERAGE_DAYS
    : movingAverageDaysList[0];
  const technicalIndicators = {
    bearishMovingAverage: item.bearishMovingAverage === true,
    bearishMovingAverageShortDays: sanitizeMovingAverageDays(item.bearishMovingAverageShortDays || DEFAULT_BEARISH_MA_DAYS.short),
    bearishMovingAverageMidDays: sanitizeMovingAverageDays(item.bearishMovingAverageMidDays || DEFAULT_BEARISH_MA_DAYS.mid),
    bearishMovingAverageLongDays: sanitizeMovingAverageDays(item.bearishMovingAverageLongDays || DEFAULT_BEARISH_MA_DAYS.long),
    macdDeathCross: item.macdDeathCross === true,
    macdBelowZeroOnly: item.macdBelowZeroOnly === true,
    volumeDrop: item.volumeDrop === true,
    volumeDropPercent: optionalPositiveNumber(item.volumeDropPercent, 2),
    volumeDropAverageDays: sanitizeMovingAverageDays(item.volumeDropAverageDays || DEFAULT_VOLUME_AVERAGE_DAYS),
    volumeDropMultiplier: optionalPositiveNumber(item.volumeDropMultiplier, 1.5),
    reboundLowVolume: item.reboundLowVolume === true,
    reboundRisePercent: optionalPositiveNumber(item.reboundRisePercent, 0),
    reboundLowVolumeAverageDays: sanitizeMovingAverageDays(item.reboundLowVolumeAverageDays || DEFAULT_VOLUME_AVERAGE_DAYS),
    reboundLowVolumeRatio: optionalPositiveNumber(item.reboundLowVolumeRatio, 0.8),
    lowBreak: item.lowBreak === true || item.lowBreakDays !== undefined,
    lowBreakDays: sanitizeMovingAverageDays(item.lowBreakDays || DEFAULT_LOW_BREAK_DAYS),
    rsiWeak: item.rsiWeak === true,
    rsiDays: sanitizeMovingAverageDays(item.rsiDays || DEFAULT_RSI_DAYS),
    rsiBelow: clampNumber(optionalPositiveNumber(item.rsiBelow, 50), 0, 100),
    bollingerBelow: sanitizeBollingerBelow(item.bollingerBelow),
    bollingerDays: sanitizeMovingAverageDays(item.bollingerDays || DEFAULT_BOLLINGER_DAYS),
    bollingerStdDev: optionalPositiveNumber(item.bollingerStdDev, DEFAULT_BOLLINGER_STD_DEV),
    intradayHighPullback: item.intradayHighPullback === true,
    intradayHighPullbackPercent: optionalPositiveNumber(item.intradayHighPullbackPercent, DEFAULT_INTRADAY_HIGH_PULLBACK_PERCENT),
    intradayDowntrendConfirmTicks: sanitizeIntradayConfirmTicks(item.intradayDowntrendConfirmTicks),
    intradayDowntrendSlopePoints: sanitizeIntradaySlopePoints(item.intradayDowntrendSlopePoints),
    intradayVwapBelow: item.intradayVwapBelow !== false
  };

  if (Object.values(thresholds).every((value) => value === null) && !movingAverageBelow && !hasTechnicalAlertIndicator(technicalIndicators)) {
    return undefined;
  }

  return {
    code,
    name: String(item.name || '').trim(),
    movingAverageBelow,
    movingAverageDays,
    movingAverageDaysList,
    ...technicalIndicators,
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

function optionalPositiveNumber(value, fallback) {
  const parsed = optionalNumber(value);
  if (parsed === null) {
    return fallback;
  }
  return parsed >= 0 ? parsed : fallback;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
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

function sanitizeMovingAverageDays(value) {
  const parsed = optionalInteger(value);
  if (parsed === null) {
    return DEFAULT_MOVING_AVERAGE_DAYS;
  }
  return Math.min(MAX_MOVING_AVERAGE_DAYS, Math.max(1, parsed));
}

function sanitizeMovingAverageDaysList(value, fallback = [DEFAULT_MOVING_AVERAGE_DAYS]) {
  const source = Array.isArray(value)
    ? value
    : value === undefined || value === null || value === ''
      ? fallback
      : [value];
  const days = source
    .map(optionalInteger)
    .filter((parsed) => parsed !== null)
    .map((parsed) => Math.min(MAX_MOVING_AVERAGE_DAYS, Math.max(1, parsed)));
  const uniqueDays = [...new Set(days)].sort((left, right) => left - right);
  return uniqueDays.length > 0 ? uniqueDays : [...fallback];
}

function sanitizeIntradayConfirmTicks(value) {
  const parsed = optionalInteger(value);
  if (parsed === null) {
    return DEFAULT_INTRADAY_DOWNTREND_CONFIRM_TICKS;
  }
  return Math.min(10, Math.max(1, parsed));
}

function sanitizeIntradaySlopePoints(value) {
  const parsed = optionalInteger(value);
  if (parsed === null) {
    return DEFAULT_INTRADAY_DOWNTREND_SLOPE_POINTS;
  }
  return Math.min(20, Math.max(2, parsed));
}

function sanitizeBollingerBelow(value) {
  if (value === true) {
    return 'middle';
  }
  if (value === 'middle' || value === 'lower') {
    return value;
  }
  return '';
}

function hasTechnicalAlertIndicator(indicators) {
  return Boolean(
    hasDailyKlineAlertIndicator(indicators)
    || indicators.intradayHighPullback
  );
}

function hasDailyKlineAlertIndicator(indicators) {
  return Boolean(
    indicators.bearishMovingAverage
    || indicators.macdDeathCross
    || indicators.volumeDrop
    || indicators.reboundLowVolume
    || indicators.lowBreak
    || indicators.rsiWeak
    || indicators.bollingerBelow
  );
}

async function fetchQuotes(symbols, timeoutMs, log, database) {
  const uniqueCodes = Array.from(new Set(symbols.map((symbol) => symbol.code)));
  if (database && uniqueCodes.length > 0) {
    const storedSnapshot = await database.readQuoteSnapshot(symbols);
    const storedByCode = new Map(storedSnapshot.quotes.map((quote) => [quote.code, quote]));
    if (uniqueCodes.every((code) => isUsableQuote(storedByCode.get(code)))) {
      if (log) {
        log('Quotes restored from SQLite', {
          requested: uniqueCodes.length,
          updatedDate: storedSnapshot.updatedDate || '',
          updatedAt: storedSnapshot.updatedAt || ''
        });
      }
      return symbols.map((symbol) => ({
        ...symbol,
        ...storedByCode.get(symbol.code)
      }));
    }
  }

  const rawQuotes = await fetchRawQuotesConcurrent(uniqueCodes, timeoutMs, log);

  const quotes = symbols.map((symbol) => {
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

  if (database) {
    await database.upsertQuoteSnapshot(quotes, new Date().toLocaleTimeString('zh-CN', { hour12: false }), getShanghaiDateString());
  }

  return quotes;
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

async function fetchSymbolSearchResults(keyword, timeoutMs, database) {
  const normalizedKeyword = String(keyword || '').trim();
  if (!normalizedKeyword) {
    return [];
  }

  if (database) {
    const storedResults = await database.readSymbolSearchResults(normalizedKeyword);
    if (storedResults.length > 0) {
      return storedResults;
    }
  }

  const url = `http://suggest3.sinajs.cn/suggest/type=&key=${encodeURIComponent(normalizedKeyword)}`;
  const body = await requestText(url, Math.min(Math.max(timeoutMs, 3000), 10000), {
    Referer: 'https://finance.sina.com.cn/',
    'User-Agent': 'Mozilla/5.0 VSCode Market Monitoring'
  }, 'gb18030');
  const results = parseSinaSuggestResponse(body);

  if (results.length === 0) {
    const code = normalizeCode(normalizedKeyword);
    const fallbackResults = code ? [{ code, name: code, market: getCodeMarketLabel(code) }] : [];
    if (database && fallbackResults.length > 0) {
      await database.upsertSymbolSearchResults(normalizedKeyword, fallbackResults);
    }
    return fallbackResults;
  }

  if (database) {
    await database.upsertSymbolSearchResults(normalizedKeyword, results);
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
      open: quote.open,
      high: quote.high,
      low: quote.low,
      previousClose: quote.previousClose,
      change: quote.change,
      changePercent: quote.changePercent,
      volume: quote.volume,
      amount: quote.amount,
      intradayVwap: quote.intradayVwap,
      time: quote.time,
      status: quote.status
    }))
  });
}

function readAlertNotificationCache(globalState) {
  const value = globalState.get(ALERT_NOTIFICATION_CACHE_KEY);
  if (!value || typeof value.date !== 'string' || !Array.isArray(value.codes)) {
    return { date: '', codes: [] };
  }

  return {
    date: value.date,
    codes: value.codes.filter((code) => typeof code === 'string' && code)
  };
}

async function writeAlertNotificationCache(globalState, date, codes) {
  await globalState.update(ALERT_NOTIFICATION_CACHE_KEY, {
    date,
    codes: Array.from(new Set(codes.filter((code) => typeof code === 'string' && code)))
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
    open: optionalNumber(value.open),
    high: optionalNumber(value.high),
    low: optionalNumber(value.low),
    previousClose: optionalNumber(value.previousClose),
    change: optionalNumber(value.change),
    changePercent: optionalNumber(value.changePercent),
    volume: optionalNumber(value.volume),
    amount: optionalNumber(value.amount),
    intradayVwap: optionalNumber(value.intradayVwap),
    time: typeof value.time === 'string' ? value.time : '',
    status: typeof value.status === 'string' ? value.status : ''
  };
}

async function evaluateAlerts(quotes, rules, priceDecimalPlaces, timeoutMs, dailyKlineCache, intradayTrendState, database, log) {
  if (!rules || rules.length === 0) {
    return [];
  }

  const alerts = [];
  const quotesByCode = new Map(quotes.map((quote) => [quote.code, quote]));
  const technicalSnapshots = await fetchAlertTechnicalSnapshots(rules, quotesByCode, timeoutMs, dailyKlineCache, database, log);
  const movingAverageSnapshots = await fetchAlertMovingAverageSnapshots(rules, quotesByCode, timeoutMs, dailyKlineCache, database, log);

  for (const rule of rules) {
    const quote = quotesByCode.get(rule.code);
    if (!quote) {
      continue;
    }

    const displayName = rule.name || quote.name || quote.code;
    addMovingAverageAlertIfMet(alerts, quote, displayName, rule, movingAverageSnapshots, priceDecimalPlaces);
    addTechnicalAlertsIfMet(alerts, quote, displayName, rule, technicalSnapshots, priceDecimalPlaces, intradayTrendState);
    addAlertIfMet(alerts, quote, displayName, 'priceAbove', rule.priceAbove, quote.price, '价格 >=', priceDecimalPlaces);
    addAlertIfMet(alerts, quote, displayName, 'priceBelow', rule.priceBelow, quote.price, '价格 <=', priceDecimalPlaces);
    addAlertIfMet(alerts, quote, displayName, 'changePercentAbove', rule.changePercentAbove, quote.changePercent, '涨跌幅 >=', 2, '%');
    addAlertIfMet(alerts, quote, displayName, 'changePercentBelow', rule.changePercentBelow, quote.changePercent, '涨跌幅 <=', 2, '%');
  }

  return alerts;
}

function summarizeAlertRules(rules) {
  const summary = {
    movingAverageBelow: 0,
    intradayHighPullback: 0,
    threshold: 0,
    dailyTechnical: 0
  };
  for (const rule of rules || []) {
    if (!rule) {
      continue;
    }
    if (rule.movingAverageBelow) {
      summary.movingAverageBelow += getRuleMovingAverageDays(rule).length;
    }
    if (rule.intradayHighPullback) {
      summary.intradayHighPullback += 1;
    }
    if (rule.priceAbove !== null || rule.priceBelow !== null || rule.changePercentAbove !== null || rule.changePercentBelow !== null) {
      summary.threshold += 1;
    }
    if (hasDailyKlineAlertIndicator(rule)) {
      summary.dailyTechnical += 1;
    }
  }
  return summary;
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

async function fetchAlertMovingAverageSnapshots(rules, quotesByCode, timeoutMs, dailyKlineCache, database, log) {
  const snapshots = new Map();
  const tasks = [];
  const daysByCode = new Map();
  const failures = [];

  for (const rule of rules) {
    if (!rule.movingAverageBelow) {
      continue;
    }

    const quote = quotesByCode.get(rule.code);
    if (!isUsableQuote(quote)) {
      continue;
    }

    if (!daysByCode.has(rule.code)) {
      daysByCode.set(rule.code, new Set());
    }
    for (const days of getRuleMovingAverageDays(rule)) {
      daysByCode.get(rule.code).add(days);
    }
  }

  for (const [code, daysSet] of daysByCode.entries()) {
    const quote = quotesByCode.get(code);
    const daysList = [...daysSet].sort((left, right) => left - right);
    tasks.push(() => fetchMovingAverageSnapshots(quote, daysList, timeoutMs, dailyKlineCache, database)
      .then((items) => {
        for (const snapshot of items) {
          if (snapshot && snapshot.error) {
            failures.push(snapshot);
            continue;
          }
          if (snapshot) {
            snapshots.set(getMovingAverageSnapshotKey(snapshot.code, snapshot.days), snapshot);
          }
        }
      }));
  }

  await runLimited(tasks, 4);
  if (failures.length > 0 && log) {
    log('Moving average alert data failed', {
      failed: failures.length,
      samples: failures.slice(0, 8)
    });
  }
  return snapshots;
}

async function fetchMovingAverageSnapshots(quote, daysList, timeoutMs, dailyKlineCache, database) {
  const maxDays = Math.max(...daysList);
  try {
    if (database) {
      try {
        const storedBars = await database.readDailyKlineBars(quote.code, maxDays);
        const storedSnapshots = calculateMovingAverageSnapshots(quote, storedBars, daysList);
        if (hasMovingAverageSnapshotsForAllDays(storedSnapshots, daysList)) {
          return storedSnapshots;
        }
      } catch {
        // Fall through to the network path when local storage is temporarily unavailable.
      }
    }

    const bars = await fetchDailyKlineBars(quote.code, maxDays + 10, timeoutMs, dailyKlineCache, database);
    return calculateMovingAverageSnapshots(quote, bars, daysList);
  } catch (error) {
    return [{
      code: quote.code,
      days: maxDays,
      error: getErrorMessage(error)
    }];
  }
}

function calculateMovingAverageSnapshots(quote, bars, daysList) {
  return daysList
    .map((days) => calculateMovingAverageSnapshot(quote, bars, days))
    .filter(Boolean);
}

function hasMovingAverageSnapshotsForAllDays(snapshots, daysList) {
  const availableDays = new Set(snapshots.map((snapshot) => snapshot.days));
  return daysList.every((days) => availableDays.has(days));
}

function calculateMovingAverageSnapshot(quote, bars, days) {
  const today = getShanghaiDateString();
  const previousCloses = bars
    .filter((bar) => bar.date !== today)
    .map((bar) => bar.close)
    .filter((close) => Number.isFinite(close))
    .slice(-(days - 1));

  if (previousCloses.length < days - 1 || !Number.isFinite(quote.price)) {
    return null;
  }

  const closes = [...previousCloses, quote.price];
  const average = closes.reduce((sum, close) => sum + close, 0) / closes.length;
  return {
    code: quote.code,
    days,
    average,
    samples: closes.length
  };
}

async function runLimited(tasks, limit) {
  const pending = [...tasks];
  const workers = Array.from({ length: Math.min(Math.max(1, limit), pending.length) }, async () => {
    while (pending.length > 0) {
      const task = pending.shift();
      await task();
    }
  });
  await Promise.all(workers);
}

async function fetchDailyKlineBars(code, limit, timeoutMs, dailyKlineCache, database) {
  const secid = toEastmoneySecid(code);
  if (!secid) {
    return [];
  }

  const normalizedLimit = Math.max(1, Math.trunc(limit));
  const closeFinalized = isAfterShanghaiClose();
  const cacheKey = `${getShanghaiDateString()}:${code}${closeFinalized ? ':closed' : ''}`;
  if (dailyKlineCache && dailyKlineCache.has(cacheKey)) {
    const cachedBars = dailyKlineCache.get(cacheKey);
    if (Array.isArray(cachedBars) && cachedBars.length >= normalizedLimit) {
      return cachedBars.slice(-normalizedLimit);
    }
  }

  if (database) {
    const storedBars = await database.readDailyKlineBars(code, normalizedLimit);
    if (Array.isArray(storedBars) && storedBars.length >= normalizedLimit) {
      if (dailyKlineCache) {
        dailyKlineCache.set(cacheKey, storedBars);
      }
      return storedBars.slice(-normalizedLimit);
    }
  }

  const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
    + `?secid=${encodeURIComponent(secid)}`
    + '&fields1=f1,f2,f3,f4,f5,f6'
    + '&fields2=f51,f52,f53,f54,f55,f56,f57,f58'
    + '&klt=101&fqt=1&beg=0&end=20500101'
    + `&lmt=${normalizedLimit}`;
  const body = await requestText(url, Math.min(Math.max(timeoutMs || 10000, 3000), 20000), {
    Referer: 'https://quote.eastmoney.com/',
    'User-Agent': 'Mozilla/5.0 VSCode Market Monitoring'
  });
  const parsed = JSON.parse(body);
  const klines = parsed && parsed.data && Array.isArray(parsed.data.klines) ? parsed.data.klines : [];
  const bars = klines.map(parseEastmoneyKline).filter(Boolean);
  if (database) {
    await database.upsertDailyKlineBars(code, bars);
  }

  if (dailyKlineCache) {
    dailyKlineCache.set(cacheKey, bars);
  }
  return bars.slice(-normalizedLimit);
}

function parseEastmoneyKline(row) {
  const fields = String(row || '').split(',');
  const date = fields[0] || '';
  const open = optionalNumber(fields[1]);
  const close = optionalNumber(fields[2]);
  const high = optionalNumber(fields[3]);
  const low = optionalNumber(fields[4]);
  const volume = optionalNumber(fields[5]);
  const amount = optionalNumber(fields[6]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || close === null) {
    return null;
  }
  return { date, open, close, high, low, volume, amount };
}

function toEastmoneySecid(code) {
  if (/^sh\d{6}$/.test(code)) {
    return `1.${code.slice(2)}`;
  }
  if (/^(sz|bj)\d{6}$/.test(code)) {
    return `0.${code.slice(2)}`;
  }
  return '';
}

function addMovingAverageAlertIfMet(alerts, quote, displayName, rule, movingAverageSnapshots, priceDecimalPlaces) {
  if (!rule.movingAverageBelow || quote.price === null) {
    return;
  }

  for (const days of getRuleMovingAverageDays(rule)) {
    const snapshot = movingAverageSnapshots.get(getMovingAverageSnapshotKey(rule.code, days));
    if (!snapshot || !Number.isFinite(snapshot.average) || quote.price >= snapshot.average) {
      continue;
    }

    const formattedAverage = snapshot.average.toFixed(priceDecimalPlaces);
    const formattedValue = quote.price.toFixed(priceDecimalPlaces);
    const alertLabel = `跌破${snapshot.days}日线 ${formattedAverage}`;

    alerts.push({
      key: `${quote.code}:movingAverageBelow:${snapshot.days}:${formattedAverage}`,
      type: 'movingAverageBelow',
      movingAverageDays: snapshot.days,
      code: quote.code,
      name: displayName,
      label: alertLabel,
      message: `${displayName} ${alertLabel}，当前 ${formattedValue}`
    });
  }
}

function getRuleMovingAverageDays(rule) {
  if (!rule || !rule.movingAverageBelow) {
    return [];
  }
  if (Array.isArray(rule.movingAverageDaysList) && rule.movingAverageDaysList.length > 0) {
    return rule.movingAverageDaysList;
  }
  return [sanitizeMovingAverageDays(rule.movingAverageDays)];
}

function getMovingAverageSnapshotKey(code, days) {
  return `${code}:${days}`;
}

async function fetchAlertTechnicalSnapshots(rules, quotesByCode, timeoutMs, dailyKlineCache, database, log) {
  const snapshots = new Map();
  const tasks = [];
  const limitsByCode = new Map();

  for (const rule of rules) {
    if (!hasDailyKlineAlertIndicator(rule)) {
      continue;
    }

    const quote = quotesByCode.get(rule.code);
    if (!isUsableQuote(quote)) {
      continue;
    }

    const limit = getTechnicalHistoryLimit(rule);
    limitsByCode.set(rule.code, Math.max(limitsByCode.get(rule.code) || 0, limit));
  }

  for (const [code, limit] of limitsByCode.entries()) {
    tasks.push(() => fetchDailyKlineBars(code, limit, timeoutMs, dailyKlineCache, database)
      .then((bars) => snapshots.set(code, bars))
      .catch((error) => {
        snapshots.set(code, []);
        if (log) {
          log('Technical alert data failed', {
            code,
            limit,
            error: getErrorMessage(error)
          });
        }
      }));
  }

  await runLimited(tasks, 4);
  return snapshots;
}

function getTechnicalHistoryLimit(rule) {
  const values = [
    rule.bearishMovingAverageLongDays + 10,
    rule.volumeDropAverageDays + 10,
    rule.reboundLowVolumeAverageDays + 10,
    rule.lowBreakDays + 10,
    rule.rsiDays + 30,
    rule.bollingerDays + 10,
    90
  ];
  return Math.min(MAX_MOVING_AVERAGE_DAYS + 30, Math.max(...values.filter((value) => Number.isFinite(value))));
}

function addTechnicalAlertsIfMet(alerts, quote, displayName, rule, technicalSnapshots, priceDecimalPlaces, intradayTrendState) {
  const bars = technicalSnapshots.get(rule.code) || [];
  if (quote.price === null) {
    return;
  }

  if (bars.length > 0) {
    addBearishMovingAverageAlertIfMet(alerts, quote, displayName, rule, bars, priceDecimalPlaces);
    addMacdDeathCrossAlertIfMet(alerts, quote, displayName, rule, bars);
    addVolumeDropAlertIfMet(alerts, quote, displayName, rule, bars);
    addReboundLowVolumeAlertIfMet(alerts, quote, displayName, rule, bars);
    addLowBreakAlertIfMet(alerts, quote, displayName, rule, bars, priceDecimalPlaces);
    addRsiWeakAlertIfMet(alerts, quote, displayName, rule, bars);
    addBollingerBelowAlertIfMet(alerts, quote, displayName, rule, bars, priceDecimalPlaces);
  }
  addIntradayHighPullbackAlertIfMet(alerts, quote, displayName, rule, bars, priceDecimalPlaces, intradayTrendState);
}

function addBearishMovingAverageAlertIfMet(alerts, quote, displayName, rule, bars, priceDecimalPlaces) {
  if (!rule.bearishMovingAverage) {
    return;
  }

  const shortAverage = calculateMovingAverageFromBars(bars, quote.price, rule.bearishMovingAverageShortDays);
  const midAverage = calculateMovingAverageFromBars(bars, quote.price, rule.bearishMovingAverageMidDays);
  const longAverage = calculateMovingAverageFromBars(bars, quote.price, rule.bearishMovingAverageLongDays);
  if (shortAverage === null || midAverage === null || longAverage === null || !(shortAverage < midAverage && midAverage < longAverage)) {
    return;
  }

  alerts.push({
    key: `${quote.code}:bearishMovingAverage:${rule.bearishMovingAverageShortDays}-${rule.bearishMovingAverageMidDays}-${rule.bearishMovingAverageLongDays}`,
    code: quote.code,
    name: displayName,
    label: `均线空头排列 MA${rule.bearishMovingAverageShortDays}<MA${rule.bearishMovingAverageMidDays}<MA${rule.bearishMovingAverageLongDays}`,
    message: `${displayName} 均线空头排列，MA${rule.bearishMovingAverageShortDays} ${shortAverage.toFixed(priceDecimalPlaces)} < MA${rule.bearishMovingAverageMidDays} ${midAverage.toFixed(priceDecimalPlaces)} < MA${rule.bearishMovingAverageLongDays} ${longAverage.toFixed(priceDecimalPlaces)}`
  });
}

function addMacdDeathCrossAlertIfMet(alerts, quote, displayName, rule, bars) {
  if (!rule.macdDeathCross) {
    return;
  }

  const previousCloses = getPreviousCloses(bars, 120);
  if (previousCloses.length < 35) {
    return;
  }

  const previousMacd = calculateMacd(previousCloses);
  const currentMacd = calculateMacd([...previousCloses, quote.price]);
  if (!previousMacd || !currentMacd) {
    return;
  }

  const crossed = previousMacd.dif >= previousMacd.dea && currentMacd.dif < currentMacd.dea;
  const belowZero = currentMacd.dif < 0 && currentMacd.dea < 0;
  if (!crossed || (rule.macdBelowZeroOnly && !belowZero)) {
    return;
  }

  alerts.push({
    key: `${quote.code}:macdDeathCross:${rule.macdBelowZeroOnly ? 'belowZero' : 'any'}`,
    code: quote.code,
    name: displayName,
    label: rule.macdBelowZeroOnly ? 'MACD 零轴下死叉' : 'MACD 死叉',
    message: `${displayName} ${rule.macdBelowZeroOnly ? 'MACD 零轴下死叉' : 'MACD 死叉'}，DIF ${currentMacd.dif.toFixed(3)}，DEA ${currentMacd.dea.toFixed(3)}`
  });
}

function addVolumeDropAlertIfMet(alerts, quote, displayName, rule, bars) {
  if (!rule.volumeDrop || quote.changePercent === null || quote.changePercent > -rule.volumeDropPercent) {
    return;
  }

  const volumeSnapshot = calculateVolumeSnapshot(bars, rule.volumeDropAverageDays);
  if (!volumeSnapshot || volumeSnapshot.current < volumeSnapshot.average * rule.volumeDropMultiplier) {
    return;
  }

  alerts.push({
    key: `${quote.code}:volumeDrop:${rule.volumeDropPercent}:${rule.volumeDropMultiplier}:${rule.volumeDropAverageDays}`,
    code: quote.code,
    name: displayName,
    label: `放量下跌 ${rule.volumeDropMultiplier.toFixed(1)}x`,
    message: `${displayName} 放量下跌，跌幅 ${quote.changePercent.toFixed(2)}%，成交量约为 ${rule.volumeDropAverageDays} 日均量的 ${(volumeSnapshot.current / volumeSnapshot.average).toFixed(2)} 倍`
  });
}

function addReboundLowVolumeAlertIfMet(alerts, quote, displayName, rule, bars) {
  if (!rule.reboundLowVolume || quote.changePercent === null || quote.changePercent < rule.reboundRisePercent) {
    return;
  }

  const volumeSnapshot = calculateVolumeSnapshot(bars, rule.reboundLowVolumeAverageDays);
  if (!volumeSnapshot || volumeSnapshot.current > volumeSnapshot.average * rule.reboundLowVolumeRatio) {
    return;
  }

  alerts.push({
    key: `${quote.code}:reboundLowVolume:${rule.reboundRisePercent}:${rule.reboundLowVolumeRatio}:${rule.reboundLowVolumeAverageDays}`,
    code: quote.code,
    name: displayName,
    label: `反弹缩量 ${(rule.reboundLowVolumeRatio * 100).toFixed(0)}%`,
    message: `${displayName} 反弹缩量，涨幅 ${quote.changePercent.toFixed(2)}%，成交量仅为 ${rule.reboundLowVolumeAverageDays} 日均量的 ${(volumeSnapshot.current / volumeSnapshot.average).toFixed(2)}`
  });
}

function addLowBreakAlertIfMet(alerts, quote, displayName, rule, bars, priceDecimalPlaces) {
  if (!rule.lowBreak) {
    return;
  }

  const previousLows = getPreviousBars(bars)
    .map((bar) => bar.low)
    .filter((low) => Number.isFinite(low))
    .slice(-rule.lowBreakDays);
  if (previousLows.length < rule.lowBreakDays) {
    return;
  }

  const lowest = Math.min(...previousLows);
  if (quote.price >= lowest) {
    return;
  }

  alerts.push({
    key: `${quote.code}:lowBreak:${rule.lowBreakDays}:${lowest.toFixed(priceDecimalPlaces)}`,
    code: quote.code,
    name: displayName,
    label: `跌破${rule.lowBreakDays}日低点 ${lowest.toFixed(priceDecimalPlaces)}`,
    message: `${displayName} 跌破${rule.lowBreakDays}日低点，当前 ${quote.price.toFixed(priceDecimalPlaces)}，前低 ${lowest.toFixed(priceDecimalPlaces)}`
  });
}

function addRsiWeakAlertIfMet(alerts, quote, displayName, rule, bars) {
  if (!rule.rsiWeak) {
    return;
  }

  const rsi = calculateRsi([...getPreviousCloses(bars, rule.rsiDays + 20), quote.price], rule.rsiDays);
  if (rsi === null || rsi >= rule.rsiBelow) {
    return;
  }

  alerts.push({
    key: `${quote.code}:rsiWeak:${rule.rsiDays}:${rule.rsiBelow}`,
    code: quote.code,
    name: displayName,
    label: `RSI${rule.rsiDays} < ${rule.rsiBelow}`,
    message: `${displayName} RSI 走弱，RSI${rule.rsiDays} ${rsi.toFixed(1)} < ${rule.rsiBelow}`
  });
}

function addBollingerBelowAlertIfMet(alerts, quote, displayName, rule, bars, priceDecimalPlaces) {
  if (!rule.bollingerBelow) {
    return;
  }

  const bands = calculateBollingerBands([...getPreviousCloses(bars, rule.bollingerDays - 1), quote.price], rule.bollingerDays, rule.bollingerStdDev);
  if (!bands) {
    return;
  }

  const target = rule.bollingerBelow === 'lower' ? bands.lower : bands.middle;
  if (quote.price >= target) {
    return;
  }

  const label = rule.bollingerBelow === 'lower' ? '跌破布林下轨' : '跌破布林中轨';
  alerts.push({
    key: `${quote.code}:bollingerBelow:${rule.bollingerBelow}:${rule.bollingerDays}:${target.toFixed(priceDecimalPlaces)}`,
    code: quote.code,
    name: displayName,
    label: `${label} ${target.toFixed(priceDecimalPlaces)}`,
    message: `${displayName} ${label}，当前 ${quote.price.toFixed(priceDecimalPlaces)}，阈值 ${target.toFixed(priceDecimalPlaces)}`
  });
}

function addIntradayHighPullbackAlertIfMet(alerts, quote, displayName, rule, bars, priceDecimalPlaces, intradayTrendState) {
  if (!rule.intradayHighPullback) {
    return;
  }

  const currentBar = getIntradayCurrentBar(quote, bars);
  if (!currentBar) {
    return;
  }

  const afterClose = isAfterShanghaiClose();
  const useClosingPrice = afterClose && Number.isFinite(currentBar.close) && currentBar.close > 0;
  const currentPrice = useClosingPrice ? currentBar.close : quote.price;
  const previousClose = Number.isFinite(quote.previousClose) && quote.previousClose > 0 ? quote.previousClose : null;
  const changePercent = previousClose === null ? quote.changePercent : ((currentPrice - previousClose) / previousClose) * 100;
  const belowVwap = !rule.intradayVwapBelow || !Number.isFinite(quote.intradayVwap) || currentPrice < quote.intradayVwap;
  if (
    currentBar.high <= currentBar.open
    || !Number.isFinite(currentPrice)
    || currentPrice >= currentBar.high
    || !(changePercent < 0)
    || !belowVwap
  ) {
    updateIntradayDowntrendState(intradayTrendState, quote, currentPrice, false, rule);
    return;
  }

  const pullbackPercent = ((currentBar.high - currentPrice) / currentBar.high) * 100;
  if (pullbackPercent <= rule.intradayHighPullbackPercent) {
    updateIntradayDowntrendState(intradayTrendState, quote, currentPrice, false, rule);
    return;
  }

  const trendState = updateIntradayDowntrendState(intradayTrendState, quote, currentPrice, true, rule);
  if (!afterClose && !trendState.confirmed) {
    return;
  }

  const alertLabel = `由涨转跌，高点回落 ${pullbackPercent.toFixed(2)}%`;
  const changePercentText = changePercent === null ? '' : `，涨跌幅 ${changePercent.toFixed(2)}%`;
  const priceLabel = useClosingPrice ? '收盘' : '当前';
  const vwapText = Number.isFinite(quote.intradayVwap) ? `，VWAP ${quote.intradayVwap.toFixed(priceDecimalPlaces)}` : '';
  alerts.push({
    key: `${quote.code}:intradayHighPullback:${rule.intradayHighPullbackPercent}`,
    type: 'intradayHighPullback',
    code: quote.code,
    name: displayName,
    label: alertLabel,
    message: `${displayName} 当日最高价高于开盘价后转为下跌，从最高点 ${currentBar.high.toFixed(priceDecimalPlaces)} 回落 ${pullbackPercent.toFixed(2)}%，开盘 ${currentBar.open.toFixed(priceDecimalPlaces)}，${priceLabel} ${currentPrice.toFixed(priceDecimalPlaces)}${vwapText}${changePercentText}`
  });
}

function getIntradayCurrentBar(quote, bars) {
  const today = getShanghaiDateString();
  const currentBar = [...bars].reverse().find((bar) => bar.date === today);
  const open = getFirstFinitePositive(currentBar && currentBar.open, quote.open);
  const high = getFirstFinitePositive(currentBar && currentBar.high, quote.high);
  if (!Number.isFinite(open) || !Number.isFinite(high)) {
    return null;
  }
  return {
    open,
    high,
    close: getFirstFinitePositive(currentBar && currentBar.close)
  };
}

function getFirstFinitePositive(...values) {
  for (const value of values) {
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return null;
}

function updateIntradayDowntrendState(stateMap, quote, currentPrice, staticMatched, rule) {
  if (!stateMap || !quote || !quote.code || !Number.isFinite(currentPrice)) {
    return { confirmed: true, confirmTicks: 0, slope: null };
  }

  const state = stateMap.get(quote.code) || { samples: [], confirmTicks: 0, sampleId: 0, lastUpdatedMs: 0 };
  const now = Date.now();
  if (!state.lastUpdatedMs || now - state.lastUpdatedMs >= 1000) {
    state.samples.push(currentPrice);
    state.samples = state.samples.slice(-Math.max(rule.intradayDowntrendSlopePoints, 20));
    state.sampleId += 1;
    state.lastUpdatedMs = now;
  }

  const slope = calculatePriceSlope(state.samples, rule.intradayDowntrendSlopePoints);
  const matched = Boolean(staticMatched && slope !== null && slope < 0);
  if (state.lastMatchedSampleId !== state.sampleId) {
    state.confirmTicks = matched ? state.confirmTicks + 1 : 0;
    state.lastMatchedSampleId = state.sampleId;
  }

  state.lastSlope = slope;
  state.lastMatched = matched;
  stateMap.set(quote.code, state);

  return {
    confirmed: state.confirmTicks >= rule.intradayDowntrendConfirmTicks,
    confirmTicks: state.confirmTicks,
    slope
  };
}

function calculatePriceSlope(samples, points) {
  if (!Array.isArray(samples) || samples.length < points) {
    return null;
  }
  const values = samples.slice(-points);
  const xMean = (values.length - 1) / 2;
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    numerator += (index - xMean) * (values[index] - yMean);
    denominator += Math.pow(index - xMean, 2);
  }
  if (denominator === 0 || yMean <= 0) {
    return null;
  }
  return (numerator / denominator) / yMean;
}

function calculateMovingAverageFromBars(bars, currentPrice, days) {
  const previousCloses = getPreviousCloses(bars, days - 1);
  if (previousCloses.length < days - 1 || !Number.isFinite(currentPrice)) {
    return null;
  }

  const closes = [...previousCloses, currentPrice];
  return closes.reduce((sum, close) => sum + close, 0) / closes.length;
}

function getPreviousBars(bars) {
  const today = getShanghaiDateString();
  return bars.filter((bar) => bar.date !== today);
}

function getPreviousCloses(bars, limit) {
  return getPreviousBars(bars)
    .map((bar) => bar.close)
    .filter((close) => Number.isFinite(close))
    .slice(-limit);
}

function calculateVolumeSnapshot(bars, averageDays) {
  const today = getShanghaiDateString();
  const currentBar = [...bars].reverse().find((bar) => bar.date === today && Number.isFinite(bar.volume));
  if (!currentBar) {
    return null;
  }

  const previousVolumes = getPreviousBars(bars)
    .map((bar) => bar.volume)
    .filter((volume) => Number.isFinite(volume) && volume > 0)
    .slice(-averageDays);
  if (previousVolumes.length < averageDays) {
    return null;
  }

  return {
    current: currentBar.volume,
    average: previousVolumes.reduce((sum, volume) => sum + volume, 0) / previousVolumes.length
  };
}

function calculateMacd(closes) {
  if (!Array.isArray(closes) || closes.length < 35) {
    return null;
  }

  let ema12 = closes[0];
  let ema26 = closes[0];
  let dea = 0;
  for (const close of closes) {
    ema12 = ema12 * (11 / 13) + close * (2 / 13);
    ema26 = ema26 * (25 / 27) + close * (2 / 27);
    const dif = ema12 - ema26;
    dea = dea * (8 / 10) + dif * (2 / 10);
  }

  const dif = ema12 - ema26;
  return {
    dif,
    dea,
    macd: (dif - dea) * 2
  };
}

function calculateRsi(closes, days) {
  if (!Array.isArray(closes) || closes.length < days + 1) {
    return null;
  }

  const recent = closes.slice(-(days + 1));
  let gain = 0;
  let loss = 0;
  for (let index = 1; index < recent.length; index += 1) {
    const change = recent[index] - recent[index - 1];
    if (change > 0) {
      gain += change;
    } else {
      loss -= change;
    }
  }

  if (loss === 0) {
    return gain === 0 ? 50 : 100;
  }
  return 100 - (100 / (1 + (gain / loss)));
}

function calculateBollingerBands(closes, days, stdDevMultiplier) {
  if (!Array.isArray(closes) || closes.length < days) {
    return null;
  }

  const recent = closes.slice(-days);
  const middle = recent.reduce((sum, close) => sum + close, 0) / recent.length;
  const variance = recent.reduce((sum, close) => sum + Math.pow(close - middle, 2), 0) / recent.length;
  const stdDev = Math.sqrt(variance);
  return {
    middle,
    upper: middle + stdDev * stdDevMultiplier,
    lower: middle - stdDev * stdDevMultiplier
  };
}

function requestJson(url, options) {
  const requestOptions = options || {};
  const body = JSON.stringify(removeUndefinedFields(requestOptions.body || {}));
  const startedAt = Date.now();
  appendLog(requestOptions.output, 'INFO', 'HTTP JSON request started', {
    ...requestOptions.logContext,
    method: requestOptions.method || 'POST',
    url: sanitizeUrlForLog(url),
    timeoutMs: requestOptions.timeoutMs || 30000,
    bodyBytes: Buffer.byteLength(body),
    bodyPreview: truncateForLog(safeStringify(sanitizeSensitiveObject(requestOptions.body || {})), AI_LOG_TEXT_LIMIT)
  });
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http:') ? http : https;
    const request = client.request(url, {
      method: requestOptions.method || 'POST',
      headers: {
        ...requestOptions.headers,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = decodeResponseText(Buffer.concat(chunks), 'utf8');
        const elapsedMs = Date.now() - startedAt;
        const responseDetails = {
          ...requestOptions.logContext,
          statusCode: response.statusCode,
          elapsedMs,
          responseBytes: Buffer.byteLength(text),
          responsePreview: truncateForLog(text)
        };
        if (response.statusCode < 200 || response.statusCode >= 300) {
          appendLog(requestOptions.output, 'WARN', 'HTTP JSON request failed', responseDetails);
          reject(new Error(`${requestOptions.errorPrefix || '接口'}返回 HTTP ${response.statusCode}: ${text.slice(0, 500)}`));
          return;
        }
        try {
          const parsed = JSON.parse(text);
          appendLog(requestOptions.output, 'INFO', 'HTTP JSON request succeeded', responseDetails);
          resolve(parsed);
        } catch (error) {
          appendLog(requestOptions.output, 'ERROR', 'HTTP JSON response parse failed', {
            ...responseDetails,
            error: getErrorMessage(error)
          });
          reject(new Error(`${requestOptions.errorPrefix || '接口'}返回的内容不是 JSON: ${text.slice(0, 500)}`));
        }
      });
    });

    request.on('error', (error) => {
      appendLog(requestOptions.output, 'ERROR', 'HTTP JSON request error', {
        ...requestOptions.logContext,
        elapsedMs: Date.now() - startedAt,
        error: getErrorMessage(error)
      });
      reject(error);
    });
    request.setTimeout(requestOptions.timeoutMs || 30000, () => {
      appendLog(requestOptions.output, 'ERROR', 'HTTP JSON request timeout', {
        ...requestOptions.logContext,
        elapsedMs: Date.now() - startedAt,
        timeoutMs: requestOptions.timeoutMs || 30000,
        url: sanitizeUrlForLog(url)
      });
      request.destroy(new Error(`${requestOptions.errorPrefix || '接口'}请求超时`));
    });
    request.write(body);
    request.end();
  });
}

function removeUndefinedFields(value) {
  if (Array.isArray(value)) {
    return value.map(removeUndefinedFields);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .map(([key, entryValue]) => [key, removeUndefinedFields(entryValue)]));
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
    const high = parseNumber(fields[4]);
    const low = parseNumber(fields[5]);
    const volume = parseNumber(fields[8]);
    const amount = parseNumber(fields[9]);
    const price = latest > 0 ? latest : open > 0 ? open : null;
    const change = price !== null && previousClose > 0 ? price - previousClose : null;
    const changePercent = change !== null ? (change / previousClose) * 100 : null;
    const intradayVwap = calculateIntradayVwap(volume, amount);
    const date = fields[30] || '';
    const time = fields[31] || '';

    quotes.set(code, {
      price,
      open: open > 0 ? open : null,
      high: high > 0 ? high : null,
      low: low > 0 ? low : null,
      previousClose: previousClose > 0 ? previousClose : null,
      change,
      changePercent,
      volume: volume > 0 ? volume : null,
      amount: amount > 0 ? amount : null,
      intradayVwap,
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
    const high = parseNumber(fields[33]);
    const low = parseNumber(fields[34]);
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
      open: open > 0 ? open : null,
      high: high > 0 ? high : null,
      low: low > 0 ? low : null,
      previousClose: previousClose > 0 ? previousClose : null,
      change,
      changePercent,
      volume: null,
      amount: null,
      intradayVwap: null,
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

function getRealtimeRefreshSymbols(symbols, collapsedGroups) {
  const collapsed = normalizeCollapsedGroups(collapsedGroups);
  return symbols.filter((symbol) => !collapsed[symbol.group || DEFAULT_GROUP]);
}

function normalizeCollapsedGroups(value) {
  if (!value || typeof value !== 'object') {
    return {};
  }

  return Object.entries(value).reduce((groups, [name, collapsed]) => {
    const groupName = String(name || '').trim();
    if (groupName && collapsed) {
      groups[groupName] = true;
    }
    return groups;
  }, {});
}

function areCollapsedGroupsEqual(left, right) {
  const leftGroups = Object.keys(normalizeCollapsedGroups(left)).sort();
  const rightGroups = Object.keys(normalizeCollapsedGroups(right)).sort();
  if (leftGroups.length !== rightGroups.length) {
    return false;
  }
  return leftGroups.every((group, index) => group === rightGroups[index]);
}

function needsQuoteSnapshot(symbols, quotes) {
  if (symbols.length === 0) {
    return false;
  }

  const quotedCodes = new Set(quotes.map((quote) => quote.code));
  return symbols.some((symbol) => !quotedCodes.has(symbol.code));
}

function needsAlertQuoteFieldsSnapshot(rules, quotes) {
  if (!Array.isArray(rules) || !rules.some((rule) => rule && rule.intradayHighPullback)) {
    return false;
  }
  const quoteByCode = new Map(quotes.map((quote) => [quote.code, quote]));
  return rules.some((rule) => {
    if (!rule || !rule.intradayHighPullback) {
      return false;
    }
    const quote = quoteByCode.get(rule.code);
    return !quote || !Number.isFinite(quote.open) || !Number.isFinite(quote.high);
  });
}

function shouldRefreshAfterCloseSnapshot(lastUpdatedDate, lastUpdatedAt) {
  const today = getShanghaiDateString();
  if (lastUpdatedDate !== today || !isAfterShanghaiClose()) {
    return false;
  }
  const lastUpdatedMinutes = parseTimeToMinutes(lastUpdatedAt);
  return lastUpdatedMinutes !== null && lastUpdatedMinutes < 15 * 60;
}

function isAfterShanghaiClose() {
  const now = getShanghaiTimeParts();
  if (now.weekday === 6 || now.weekday === 7) {
    return false;
  }
  return now.hour * 60 + now.minute > 15 * 60;
}

function parseTimeToMinutes(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  return hour * 60 + minute;
}

function mergeQuoteUpdates(quotes, previousQuotes, symbols) {
  const mergedByCode = new Map(previousQuotes.map((quote) => [quote.code, quote]));
  const previousByCode = new Map(previousQuotes.map((quote) => [quote.code, quote]));
  for (const quote of quotes) {
    mergedByCode.set(quote.code, mergeQuoteWithPrevious(quote, previousByCode.get(quote.code)));
  }

  const ordered = [];
  const seen = new Set();
  for (const symbol of symbols) {
    if (!symbol || !symbol.code || seen.has(symbol.code)) {
      continue;
    }
    seen.add(symbol.code);
    const quote = mergedByCode.get(symbol.code);
    if (quote) {
      ordered.push(quote);
    }
  }
  return ordered;
}

function mergeQuoteWithPrevious(quote, previous) {
  if (isUsableQuote(quote) || !isUsableQuote(previous)) {
    return quote;
  }

  return {
    ...quote,
    price: previous.price,
    open: previous.open,
    high: previous.high,
    low: previous.low,
    previousClose: previous.previousClose,
    change: previous.change,
    changePercent: previous.changePercent,
    volume: previous.volume,
    amount: previous.amount,
    intradayVwap: previous.intradayVwap,
    time: previous.time,
    status: previous.status
  };
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

function groupQuotes(quotes, configuredGroups, configuredSymbols, alerts, sortBy, sortDirection, statsQuotes = quotes) {
  const order = [];
  const groups = new Map();
  const quoteByCode = new Map(quotes.map((quote) => [quote.code, quote]));
  const statsQuoteByCode = new Map(statsQuotes.map((quote) => [quote.code, quote]));
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

  return order.map((name) => {
    const items = groups.get(name);
    return {
      name,
      stats: calculateGroupStats(getGroupStatsItems(items, statsQuoteByCode)),
      items: sortQuotes(items, sortBy, sortDirection)
    };
  });
}

function getGroupStatsItems(items, statsQuoteByCode) {
  return items.map((item) => {
    const statsQuote = statsQuoteByCode.get(item.code);
    if (!statsQuote) {
      return item;
    }
    return {
      ...item,
      change: statsQuote.change,
      changePercent: statsQuote.changePercent
    };
  });
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

async function resolveImportRows(rows, config, output, progress, database) {
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

    const resolved = await resolveImportedSymbol(parsed.value, config.requestTimeoutMs, database);
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

async function resolveImportedSymbol(row, timeoutMs, database) {
  const code = normalizeCode(row.code);
  if (code) {
    const quote = await fetchSingleUsableQuote({ code, name: row.name || code, group: row.group }, timeoutMs, database);
    if (!quote) {
      return undefined;
    }

    const searchName = await findSymbolNameByCode(code, timeoutMs, database);
    return {
      code,
      name: searchName || row.name || code
    };
  }

  if (!row.name) {
    return undefined;
  }

  const results = await fetchSymbolSearchResults(row.name, timeoutMs, database).catch(() => []);
  const candidates = results.slice(0, 6).map((item) => ({
    code: item.code,
    name: item.name,
    group: row.group
  }));
  if (candidates.length === 0) {
    return undefined;
  }

  const quotes = await fetchQuotes(candidates, timeoutMs, undefined, database).catch(() => []);
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

async function fetchSingleUsableQuote(symbol, timeoutMs, database) {
  const quotes = await fetchQuotes([symbol], timeoutMs, undefined, database).catch(() => []);
  const quote = quotes[0];
  return isUsableQuote(quote) ? quote : undefined;
}

async function findSymbolNameByCode(code, timeoutMs, database) {
  const results = await fetchSymbolSearchResults(code, timeoutMs, database).catch(() => []);
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

function calculateIntradayVwap(volume, amount) {
  if (!Number.isFinite(volume) || !Number.isFinite(amount) || volume <= 0 || amount <= 0) {
    return null;
  }
  const value = amount / volume;
  return Number.isFinite(value) && value > 0 ? value : null;
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

function appendLog(output, level, message, details) {
  if (!output) {
    return;
  }
  output.appendLine(formatLogLine(level, message, details));
}

function sanitizeAiConfigForLog(ai) {
  const config = ai || {};
  return {
    provider: config.provider || '',
    model: config.model || '',
    enabled: Boolean(config.enabled),
    baseUrl: sanitizeUrlForLog(config.baseUrl || ''),
    azureApiVersion: config.azureApiVersion || '',
    temperature: config.temperature,
    timeoutMs: config.timeoutMs,
    hasApiKey: Boolean(config.apiKey)
  };
}

function sanitizeAiActionForLog(action) {
  return sanitizeSensitiveObject(action || {});
}

function sanitizeSensitiveObject(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeSensitiveObject);
  }
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? sanitizeTextForLog(value) : value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => {
    if (/api[-_]?key|authorization|token|secret|password/i.test(key)) {
      return [key, entryValue ? '<redacted>' : ''];
    }
    return [key, sanitizeSensitiveObject(entryValue)];
  }));
}

function sanitizeUrlForLog(value) {
  const text = String(value || '');
  if (!text) {
    return '';
  }
  try {
    const url = new URL(text);
    for (const key of Array.from(url.searchParams.keys())) {
      if (/key|token|secret|password|code/i.test(key)) {
        url.searchParams.set(key, '<redacted>');
      }
    }
    return url.toString();
  } catch (error) {
    return sanitizeTextForLog(text);
  }
}

function sanitizeTextForLog(value) {
  return String(value || '')
    .replace(/(api[-_]?key=)[^&\s]+/gi, '$1<redacted>')
    .replace(/(key=)[^&\s]+/gi, '$1<redacted>')
    .replace(/(token=)[^&\s]+/gi, '$1<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>');
}

function truncateForLog(value, limit = AI_LOG_TEXT_LIMIT) {
  const text = sanitizeTextForLog(value);
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...<truncated ${text.length - limit} chars>`;
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
