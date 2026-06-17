const fs = require('fs');
const path = require('path');
const initSqlJs = require('./vendor/sql.js/sql-wasm');

const DATABASE_FILE_NAME = 'market-monitoring.sqlite';

class MarketDatabase {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.db = undefined;
    this.SQL = undefined;
    this.readyPromise = undefined;
    this.writeQueue = Promise.resolve();
    this.dbPath = path.join(context.globalStorageUri.fsPath, DATABASE_FILE_NAME);
    this.wasmDirectory = path.join(context.extensionUri.fsPath, 'src', 'vendor', 'sql.js');
  }

  async upsertSymbols(symbols) {
    return this.enqueueWrite(async (db) => {
      const now = new Date().toISOString();
      const statement = db.prepare(`
        INSERT INTO monitored_symbols (
          code, name, market, exchange, group_name, cost, holding, source, active, created_at, updated_at
        ) VALUES (
          $code, $name, $market, $exchange, $groupName, $cost, $holding, $source, $active, $createdAt, $updatedAt
        )
        ON CONFLICT(code, group_name) DO UPDATE SET
          name = excluded.name,
          market = excluded.market,
          exchange = excluded.exchange,
          cost = excluded.cost,
          holding = excluded.holding,
          source = excluded.source,
          active = excluded.active,
          updated_at = excluded.updated_at
      `);

      db.run('BEGIN TRANSACTION');
      try {
        db.run("UPDATE monitored_symbols SET active = 0, updated_at = $updatedAt WHERE source = 'configured'", {
          $updatedAt: now
        });
        for (const symbol of symbols || []) {
          if (!symbol || !symbol.code) {
            continue;
          }
          statement.run({
            $code: symbol.code,
            $name: symbol.name || symbol.code,
            $market: getMarketName(symbol.code),
            $exchange: getExchangeCode(symbol.code),
            $groupName: symbol.group || '',
            $cost: toSqlNumber(symbol.cost),
            $holding: toSqlNumber(symbol.holding),
            $source: 'configured',
            $active: 1,
            $createdAt: now,
            $updatedAt: now
          });
        }
        db.run('COMMIT');
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      } finally {
        statement.free();
      }
    }, 'upsertSymbols');
  }

  async readQuoteSnapshot(symbols) {
    const codes = new Set((symbols || []).map((symbol) => symbol && symbol.code).filter(Boolean));
    if (codes.size === 0) {
      return { quotes: [], updatedAt: '', updatedDate: '' };
    }

    return this.enqueueRead((db) => {
      const rows = selectRows(db, `
        SELECT code, price, open, high, low, previous_close, change_value, change_percent,
               volume, amount, intraday_vwap, quote_time, status, updated_at_text, updated_date
        FROM quote_snapshots
      `);
      const quotes = [];
      let updatedAt = '';
      let updatedDate = '';

      for (const row of rows) {
        if (!codes.has(row.code)) {
          continue;
        }
        quotes.push({
          code: row.code,
          price: optionalSqlNumber(row.price),
          open: optionalSqlNumber(row.open),
          high: optionalSqlNumber(row.high),
          low: optionalSqlNumber(row.low),
          previousClose: optionalSqlNumber(row.previous_close),
          change: optionalSqlNumber(row.change_value),
          changePercent: optionalSqlNumber(row.change_percent),
          volume: optionalSqlNumber(row.volume),
          amount: optionalSqlNumber(row.amount),
          intradayVwap: optionalSqlNumber(row.intraday_vwap),
          time: row.quote_time || '',
          status: row.status || ''
        });
        if (!updatedDate || String(row.updated_date || '') > updatedDate) {
          updatedDate = row.updated_date || '';
          updatedAt = row.updated_at_text || '';
        }
      }

      return { quotes, updatedAt, updatedDate };
    }, 'readQuoteSnapshot', { quotes: [], updatedAt: '', updatedDate: '' });
  }

  async upsertQuoteSnapshot(quotes, updatedAt, updatedDate) {
    const normalizedQuotes = (quotes || [])
      .map((quote) => normalizeQuoteSnapshot(quote, updatedAt, updatedDate))
      .filter(Boolean);
    if (normalizedQuotes.length === 0) {
      return;
    }

    return this.enqueueWrite(async (db) => {
      const now = new Date().toISOString();
      const statement = db.prepare(`
        INSERT INTO quote_snapshots (
          code, price, open, high, low, previous_close, change_value, change_percent,
          volume, amount, intraday_vwap, quote_time, status, updated_at_text, updated_date, persisted_at
        ) VALUES (
          $code, $price, $open, $high, $low, $previousClose, $change, $changePercent,
          $volume, $amount, $intradayVwap, $quoteTime, $status, $updatedAtText, $updatedDate, $persistedAt
        )
        ON CONFLICT(code) DO UPDATE SET
          price = excluded.price,
          open = excluded.open,
          high = excluded.high,
          low = excluded.low,
          previous_close = excluded.previous_close,
          change_value = excluded.change_value,
          change_percent = excluded.change_percent,
          volume = excluded.volume,
          amount = excluded.amount,
          intraday_vwap = excluded.intraday_vwap,
          quote_time = excluded.quote_time,
          status = excluded.status,
          updated_at_text = excluded.updated_at_text,
          updated_date = excluded.updated_date,
          persisted_at = excluded.persisted_at
      `);

      db.run('BEGIN TRANSACTION');
      try {
        for (const quote of normalizedQuotes) {
          statement.run({
            $code: quote.code,
            $price: toSqlNumber(quote.price),
            $open: toSqlNumber(quote.open),
            $high: toSqlNumber(quote.high),
            $low: toSqlNumber(quote.low),
            $previousClose: toSqlNumber(quote.previousClose),
            $change: toSqlNumber(quote.change),
            $changePercent: toSqlNumber(quote.changePercent),
            $volume: toSqlNumber(quote.volume),
            $amount: toSqlNumber(quote.amount),
            $intradayVwap: toSqlNumber(quote.intradayVwap),
            $quoteTime: quote.time || '',
            $status: quote.status || '',
            $updatedAtText: quote.updatedAt,
            $updatedDate: quote.updatedDate,
            $persistedAt: now
          });
        }
        db.run('COMMIT');
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      } finally {
        statement.free();
      }
    }, 'upsertQuoteSnapshot');
  }

  async upsertQuoteDailyBars(quotes, tradeDate) {
    const bars = (quotes || [])
      .map((quote) => quoteToDailyBar(quote, tradeDate))
      .filter(Boolean);
    return this.upsertDailyKlineBarsBatch(bars, 'upsertQuoteDailyBars');
  }

  async upsertDailyKlineBars(code, bars) {
    const normalizedBars = (bars || [])
      .map((bar) => normalizeDailyBar(code, bar))
      .filter(Boolean);
    return this.upsertDailyKlineBarsBatch(normalizedBars, 'upsertDailyKlineBars');
  }

  async readDailyKlineBars(code, limit) {
    if (!code) {
      return [];
    }
    const normalizedLimit = Math.max(1, Math.trunc(Number(limit) || 1));
    return this.enqueueRead((db) => {
      const statement = db.prepare(`
        SELECT trade_date, open, close, high, low, volume, amount
        FROM daily_kline
        WHERE code = $code
        ORDER BY trade_date DESC
        LIMIT $limit
      `);
      const rows = [];
      try {
        statement.bind({ $code: code, $limit: normalizedLimit });
        while (statement.step()) {
          rows.push(statement.getAsObject());
        }
      } finally {
        statement.free();
      }
      return rows.reverse().map((row) => ({
        date: row.trade_date,
        open: optionalSqlNumber(row.open),
        close: optionalSqlNumber(row.close),
        high: optionalSqlNumber(row.high),
        low: optionalSqlNumber(row.low),
        volume: optionalSqlNumber(row.volume),
        amount: optionalSqlNumber(row.amount)
      }));
    }, 'readDailyKlineBars', []);
  }

  async readSymbolSearchResults(keyword) {
    const normalizedKeyword = normalizeSearchKeyword(keyword);
    if (!normalizedKeyword) {
      return [];
    }
    return this.enqueueRead((db) => {
      const statement = db.prepare(`
        SELECT code, name, market
        FROM symbol_search_results
        WHERE keyword = $keyword
        ORDER BY rank ASC
      `);
      const rows = [];
      try {
        statement.bind({ $keyword: normalizedKeyword });
        while (statement.step()) {
          rows.push(statement.getAsObject());
        }
      } finally {
        statement.free();
      }
      return rows.map((row) => ({
        code: row.code,
        name: row.name,
        market: row.market || ''
      }));
    }, 'readSymbolSearchResults', []);
  }

  async upsertSymbolSearchResults(keyword, results) {
    const normalizedKeyword = normalizeSearchKeyword(keyword);
    const normalizedResults = (results || [])
      .map(normalizeSymbolSearchResult)
      .filter(Boolean);
    if (!normalizedKeyword || normalizedResults.length === 0) {
      return;
    }

    return this.enqueueWrite(async (db) => {
      const now = new Date().toISOString();
      const statement = db.prepare(`
        INSERT INTO symbol_search_results (
          keyword, code, name, market, rank, updated_at
        ) VALUES (
          $keyword, $code, $name, $market, $rank, $updatedAt
        )
        ON CONFLICT(keyword, code) DO UPDATE SET
          name = excluded.name,
          market = excluded.market,
          rank = excluded.rank,
          updated_at = excluded.updated_at
      `);

      db.run('BEGIN TRANSACTION');
      try {
        db.run('DELETE FROM symbol_search_results WHERE keyword = $keyword', {
          $keyword: normalizedKeyword
        });
        normalizedResults.forEach((result, index) => {
          statement.run({
            $keyword: normalizedKeyword,
            $code: result.code,
            $name: result.name,
            $market: result.market,
            $rank: index,
            $updatedAt: now
          });
        });
        db.run('COMMIT');
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      } finally {
        statement.free();
      }
    }, 'upsertSymbolSearchResults');
  }

  async readAlertNotificationCache(date) {
    const normalizedDate = String(date || '');
    if (!normalizedDate) {
      return { date: '', codes: [] };
    }
    return this.enqueueRead((db) => {
      const rows = selectRows(db, `
        SELECT code
        FROM alert_notifications
        WHERE notify_date = ${sqlString(normalizedDate)}
        ORDER BY code ASC
      `);
      return {
        date: normalizedDate,
        codes: rows.map((row) => row.code).filter(Boolean)
      };
    }, 'readAlertNotificationCache', { date: '', codes: [] });
  }

  async writeAlertNotificationCache(date, codes) {
    const normalizedDate = String(date || '');
    const normalizedCodes = Array.from(new Set((codes || []).filter((code) => typeof code === 'string' && code)));
    if (!normalizedDate) {
      return;
    }

    return this.enqueueWrite(async (db) => {
      const now = new Date().toISOString();
      const statement = db.prepare(`
        INSERT INTO alert_notifications (notify_date, code, updated_at)
        VALUES ($notifyDate, $code, $updatedAt)
        ON CONFLICT(notify_date, code) DO UPDATE SET
          updated_at = excluded.updated_at
      `);

      db.run('BEGIN TRANSACTION');
      try {
        db.run('DELETE FROM alert_notifications WHERE notify_date = $notifyDate', {
          $notifyDate: normalizedDate
        });
        for (const code of normalizedCodes) {
          statement.run({
            $notifyDate: normalizedDate,
            $code: code,
            $updatedAt: now
          });
        }
        db.run('COMMIT');
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      } finally {
        statement.free();
      }
    }, 'writeAlertNotificationCache');
  }

  async readViewState() {
    return this.enqueueRead((db) => {
      const rows = selectRows(db, `
        SELECT value_json
        FROM view_state
        WHERE state_key = 'quotesView'
        LIMIT 1
      `);
      if (rows.length === 0 || !rows[0].value_json) {
        return {};
      }
      try {
        const parsed = JSON.parse(rows[0].value_json);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }, 'readViewState', {});
  }

  async writeViewState(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return;
    }

    return this.enqueueWrite(async (db) => {
      db.run(`
        INSERT INTO view_state (state_key, value_json, updated_at)
        VALUES ($stateKey, $valueJson, $updatedAt)
        ON CONFLICT(state_key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `, {
        $stateKey: 'quotesView',
        $valueJson: JSON.stringify(state),
        $updatedAt: new Date().toISOString()
      });
    }, 'writeViewState');
  }

  async upsertDailyKlineBarsBatch(bars, operation) {
    if (!Array.isArray(bars) || bars.length === 0) {
      return;
    }

    return this.enqueueWrite(async (db) => {
      const now = new Date().toISOString();
      const statement = db.prepare(`
        INSERT INTO daily_kline (
          code, trade_date, open, close, high, low, volume, amount, created_at, updated_at
        ) VALUES (
          $code, $tradeDate, $open, $close, $high, $low, $volume, $amount, $createdAt, $updatedAt
        )
        ON CONFLICT(code, trade_date) DO UPDATE SET
          open = excluded.open,
          close = excluded.close,
          high = excluded.high,
          low = excluded.low,
          volume = excluded.volume,
          amount = excluded.amount,
          updated_at = excluded.updated_at
      `);

      db.run('BEGIN TRANSACTION');
      try {
        for (const bar of bars) {
          statement.run({
            $code: bar.code,
            $tradeDate: bar.tradeDate,
            $open: toSqlNumber(bar.open),
            $close: toSqlNumber(bar.close),
            $high: toSqlNumber(bar.high),
            $low: toSqlNumber(bar.low),
            $volume: toSqlNumber(bar.volume),
            $amount: toSqlNumber(bar.amount),
            $createdAt: now,
            $updatedAt: now
          });
        }
        db.run('COMMIT');
      } catch (error) {
        db.run('ROLLBACK');
        throw error;
      } finally {
        statement.free();
      }
    }, operation);
  }

  async enqueueWrite(task, operation) {
    const next = this.writeQueue.then(async () => {
      try {
        const db = await this.ensureDatabase();
        await task(db);
        await this.save();
      } catch (error) {
        this.logWarn('SQLite persistence failed', {
          operation,
          database: this.dbPath,
          error: getErrorMessage(error)
        });
      }
    });
    this.writeQueue = next.catch(() => {});
    return next;
  }

  async enqueueRead(task, operation, fallback) {
    try {
      await this.writeQueue;
      const db = await this.ensureDatabase();
      return task(db);
    } catch (error) {
      this.logWarn('SQLite read failed', {
        operation,
        database: this.dbPath,
        error: getErrorMessage(error)
      });
      return fallback;
    }
  }

  async ensureDatabase() {
    if (this.db) {
      return this.db;
    }
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = (async () => {
      await fs.promises.mkdir(path.dirname(this.dbPath), { recursive: true });
      this.SQL = await initSqlJs({
        locateFile: (filename) => path.join(this.wasmDirectory, filename)
      });

      if (fs.existsSync(this.dbPath)) {
        const content = await fs.promises.readFile(this.dbPath);
        this.db = new this.SQL.Database(content);
      } else {
        this.db = new this.SQL.Database();
      }
      this.initializeSchema(this.db);
      await this.save();
      this.logInfo('SQLite database ready', { database: this.dbPath });
      return this.db;
    })();

    return this.readyPromise;
  }

  initializeSchema(db) {
    db.exec(`
      PRAGMA user_version = 2;

      CREATE TABLE IF NOT EXISTS monitored_symbols (
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        market TEXT,
        exchange TEXT,
        group_name TEXT NOT NULL DEFAULT '',
        cost REAL,
        holding REAL,
        source TEXT NOT NULL DEFAULT 'configured',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (code, group_name)
      );

      CREATE TABLE IF NOT EXISTS daily_kline (
        code TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        open REAL,
        close REAL,
        high REAL,
        low REAL,
        volume REAL,
        amount REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (code, trade_date)
      );

      CREATE INDEX IF NOT EXISTS idx_daily_kline_trade_date ON daily_kline(trade_date);

      CREATE TABLE IF NOT EXISTS quote_snapshots (
        code TEXT PRIMARY KEY,
        price REAL,
        open REAL,
        high REAL,
        low REAL,
        previous_close REAL,
        change_value REAL,
        change_percent REAL,
        volume REAL,
        amount REAL,
        intraday_vwap REAL,
        quote_time TEXT,
        status TEXT,
        updated_at_text TEXT,
        updated_date TEXT,
        persisted_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_quote_snapshots_updated_date ON quote_snapshots(updated_date);

      CREATE TABLE IF NOT EXISTS symbol_search_results (
        keyword TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        market TEXT,
        rank INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (keyword, code)
      );

      CREATE INDEX IF NOT EXISTS idx_symbol_search_results_keyword ON symbol_search_results(keyword, rank);

      CREATE TABLE IF NOT EXISTS alert_notifications (
        notify_date TEXT NOT NULL,
        code TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (notify_date, code)
      );

      CREATE TABLE IF NOT EXISTS view_state (
        state_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.migrateDailyKlineSchema(db);
    this.migrateMonitoredSymbolsSchema(db);
    this.ensureColumn(db, 'monitored_symbols', 'active', 'INTEGER NOT NULL DEFAULT 1');
  }

  migrateDailyKlineSchema(db) {
    const rows = selectRows(db, `
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'daily_kline'
      LIMIT 1
    `);
    const createSql = rows.length > 0 ? String(rows[0].sql || '') : '';
    if (!/FOREIGN\s+KEY/i.test(createSql)) {
      return;
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS daily_kline_v2 (
        code TEXT NOT NULL,
        trade_date TEXT NOT NULL,
        open REAL,
        close REAL,
        high REAL,
        low REAL,
        volume REAL,
        amount REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (code, trade_date)
      );

      INSERT OR REPLACE INTO daily_kline_v2 (
        code, trade_date, open, close, high, low, volume, amount, created_at, updated_at
      )
      SELECT code, trade_date, open, close, high, low, volume, amount, created_at, updated_at
      FROM daily_kline;

      DROP TABLE daily_kline;
      ALTER TABLE daily_kline_v2 RENAME TO daily_kline;
      CREATE INDEX IF NOT EXISTS idx_daily_kline_trade_date ON daily_kline(trade_date);
    `);
  }

  migrateMonitoredSymbolsSchema(db) {
    const result = db.exec('PRAGMA table_info(monitored_symbols)');
    const rows = result.length > 0 ? result[0].values : [];
    const codeColumn = rows.find((row) => row[1] === 'code');
    const groupColumn = rows.find((row) => row[1] === 'group_name');
    const hasCompositePrimaryKey = codeColumn && groupColumn && codeColumn[5] === 1 && groupColumn[5] === 2;
    if (hasCompositePrimaryKey) {
      return;
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS monitored_symbols_v2 (
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        market TEXT,
        exchange TEXT,
        group_name TEXT NOT NULL DEFAULT '',
        cost REAL,
        holding REAL,
        source TEXT NOT NULL DEFAULT 'configured',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (code, group_name)
      );

      INSERT OR REPLACE INTO monitored_symbols_v2 (
        code, name, market, exchange, group_name, cost, holding, source, active, created_at, updated_at
      )
      SELECT
        code,
        name,
        market,
        exchange,
        COALESCE(group_name, ''),
        cost,
        holding,
        source,
        active,
        created_at,
        updated_at
      FROM monitored_symbols;

      DROP TABLE monitored_symbols;
      ALTER TABLE monitored_symbols_v2 RENAME TO monitored_symbols;
    `);
  }

  ensureColumn(db, tableName, columnName, definition) {
    const result = db.exec(`PRAGMA table_info(${tableName})`);
    const rows = result.length > 0 ? result[0].values : [];
    const hasColumn = rows.some((row) => row[1] === columnName);
    if (!hasColumn) {
      db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    }
  }

  async save() {
    if (!this.db) {
      return;
    }
    const data = this.db.export();
    await fs.promises.writeFile(this.dbPath, Buffer.from(data));
  }

  dispose() {
    if (this.db) {
      this.db.close();
      this.db = undefined;
    }
  }

  logInfo(message, details) {
    if (this.output) {
      this.output.appendLine(formatLogLine('INFO', message, details));
    }
  }

  logWarn(message, details) {
    if (this.output) {
      this.output.appendLine(formatLogLine('WARN', message, details));
    }
  }
}

function quoteToDailyBar(quote, tradeDate) {
  if (!quote || !quote.code || !isFiniteNumber(quote.price) || !/^\d{4}-\d{2}-\d{2}$/.test(String(tradeDate || ''))) {
    return null;
  }

  return {
    code: quote.code,
    tradeDate,
    open: quote.open,
    close: quote.price,
    high: quote.high,
    low: quote.low,
    volume: quote.volume,
    amount: quote.amount
  };
}

function normalizeDailyBar(code, bar) {
  if (!code || !bar || !/^\d{4}-\d{2}-\d{2}$/.test(String(bar.date || bar.tradeDate || '')) || !isFiniteNumber(bar.close)) {
    return null;
  }

  return {
    code,
    tradeDate: bar.tradeDate || bar.date,
    open: bar.open,
    close: bar.close,
    high: bar.high,
    low: bar.low,
    volume: bar.volume,
    amount: bar.amount
  };
}

function normalizeQuoteSnapshot(quote, updatedAt, updatedDate) {
  if (!quote || !quote.code || !/^\d{4}-\d{2}-\d{2}$/.test(String(updatedDate || ''))) {
    return null;
  }

  return {
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
    status: quote.status,
    updatedAt: String(updatedAt || ''),
    updatedDate: String(updatedDate || '')
  };
}

function normalizeSymbolSearchResult(result) {
  if (!result || !result.code || !result.name) {
    return null;
  }
  return {
    code: String(result.code),
    name: String(result.name),
    market: String(result.market || '')
  };
}

function normalizeSearchKeyword(keyword) {
  return String(keyword || '').trim().toLowerCase();
}

function selectRows(db, sql) {
  const result = db.exec(sql);
  if (result.length === 0) {
    return [];
  }
  const columns = result[0].columns;
  return result[0].values.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

function sqlString(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function getExchangeCode(code) {
  const prefix = String(code || '').slice(0, 2);
  return ['sh', 'sz', 'bj'].includes(prefix) ? prefix : '';
}

function getMarketName(code) {
  const exchange = getExchangeCode(code);
  if (exchange === 'sh') {
    return 'Shanghai';
  }
  if (exchange === 'sz') {
    return 'Shenzhen';
  }
  if (exchange === 'bj') {
    return 'Beijing';
  }
  return '';
}

function toSqlNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalSqlNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFiniteNumber(value) {
  return Number.isFinite(Number(value));
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

module.exports = {
  MarketDatabase
};
