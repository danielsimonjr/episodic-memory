/**
 * A better-sqlite3-compatible subset over the node:sqlite built-in module.
 *
 * This module is the only importer of node:sqlite. The built-in loads on the
 * first construction of a Database, not on import. Other modules import
 * Database and Statement from here.
 */
import { createRequire } from 'module';
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';

/** The start of the warning that node:sqlite writes when it loads. */
const SQLITE_WARNING_PREFIX = 'SQLite is an experimental feature';

/** The message of a transaction function that returns a promise. */
const ASYNC_REFUSED = 'A transaction function must not return a promise. Use a synchronous function.';

/**
 * The parameters of one call: positional values, or one object of named values.
 * The type is open on purpose. A value that node:sqlite cannot bind throws at the call.
 */
export type BindParams = unknown[];

/** One result row, unless the caller names a narrower type. */
export type Row = Record<string, SQLOutputValue>;

/** The result of run(). The counts are JavaScript numbers. */
export interface RunResult {
  /** The number of rows the statement changed. */
  changes: number;
  /** The rowid of the last inserted row. */
  lastInsertRowid: number;
}

/** A prepared statement. */
export interface Statement {
  /** Run the statement and return the change counts. */
  run(...params: BindParams): RunResult;
  /** Return the first row, or undefined when no row matches. The type T is the caller's claim. */
  get<T = unknown>(...params: BindParams): T | undefined;
  /** Return every row. The type T is the caller's claim. */
  all<T = unknown>(...params: BindParams): T[];
  /** Return the rows one at a time. The type T is the caller's claim. */
  iterate<T = unknown>(...params: BindParams): IterableIterator<T>;
}

/** The options of the Database constructor. */
export interface DatabaseOptions {
  /** Open the file read-only. A write on the connection throws. */
  readonly?: boolean;
  /** Accepted for compatibility. A read-only open of a missing file always throws. */
  fileMustExist?: boolean;
}

/** The options of pragma(). */
export interface PragmaOptions {
  /** Return the first column value of the first row, not the rows. */
  simple?: boolean;
}

/** The options of function(). */
export interface SqlFunctionOptions {
  /** Mark the function as deterministic. */
  deterministic?: boolean;
  /** Allow the function only in top-level SQL. */
  directOnly?: boolean;
  /** Accept any number of arguments. */
  varargs?: boolean;
  /** Pass integer arguments as BigInt values. */
  useBigIntArguments?: boolean;
}

/** A transaction function. It also has one method for each begin mode. */
export type Transaction<F extends (...args: never[]) => unknown> = F & {
  /** Run as BEGIN DEFERRED, or as a savepoint inside a transaction. */
  deferred: F;
  /** Run as BEGIN IMMEDIATE, or as a savepoint inside a transaction. */
  immediate: F;
  /** Run as BEGIN EXCLUSIVE, or as a savepoint inside a transaction. */
  exclusive: F;
};

type Body = (...args: unknown[]) => unknown;

let sqliteModule: typeof import('node:sqlite') | undefined;

/**
 * Load node:sqlite once. Drop the first experimental warning that the load writes.
 * Every other warning passes through unchanged.
 */
function loadSqlite(): typeof import('node:sqlite') {
  if (sqliteModule) return sqliteModule;
  const original = process.emitWarning;
  // node:sqlite writes the warning synchronously while it loads, so the filter is needed only during the load.
  process.emitWarning = function (this: unknown, ...args: unknown[]): void {
    if (isSqliteWarning(args[0])) return;
    return (original as (...rest: unknown[]) => void).apply(this, args);
  } as typeof process.emitWarning;
  try {
    sqliteModule = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

/** True when a warning message starts with the node:sqlite experimental notice. */
function isSqliteWarning(warning: unknown): boolean {
  const text = typeof warning === 'string' ? warning : (warning as { message?: unknown } | null)?.message;
  return typeof text === 'string' && text.startsWith(SQLITE_WARNING_PREFIX);
}

/**
 * Map a bind value to the form node:sqlite binds as the intended SQL type.
 * This differs from better-sqlite3 on purpose. better-sqlite3 binds every Number as REAL.
 * This adapter binds a safe integer as INTEGER, so 7 concatenates as "7" and not "7.0".
 * The integer form also keeps an FTS5 rowid condition on SQLite 3.54.
 */
function coerce(value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return value as SQLInputValue;
}

/** True for a plain object. A Buffer, an array and a class instance are not plain. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The arguments of one native call: one named object, or the positional values. */
type NativeArgs = [Record<string, SQLInputValue>] | SQLInputValue[];

/** Coerce the parameters of one call. A single plain object is a set of named values. */
function bindParams(params: BindParams): NativeArgs {
  const [first] = params;
  if (params.length === 1 && isPlainObject(first)) {
    const named: Record<string, SQLInputValue> = {};
    for (const [key, value] of Object.entries(first)) named[key] = coerce(value);
    return [named];
  }
  return params.map(coerce);
}

/** Wrap one node:sqlite statement with the better-sqlite3 method shapes. */
function wrapStatement(native: StatementSync): Statement {
  return {
    // A named object is passed as the first argument, which node:sqlite reads as named values.
    run(...params: BindParams): RunResult {
      const info = native.run(...(bindParams(params) as SQLInputValue[]));
      return { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
    },
    get<T = unknown>(...params: BindParams): T | undefined {
      return native.get(...(bindParams(params) as SQLInputValue[])) as T | undefined;
    },
    all<T = unknown>(...params: BindParams): T[] {
      return native.all(...(bindParams(params) as SQLInputValue[])) as T[];
    },
    iterate<T = unknown>(...params: BindParams): IterableIterator<T> {
      return native.iterate(...(bindParams(params) as SQLInputValue[])) as IterableIterator<T>;
    },
  };
}

/** True for an object with a then method. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  return typeof (value as { then?: unknown }).then === 'function';
}

/**
 * A database connection with the better-sqlite3 method names.
 * Every connection turns foreign key enforcement on.
 */
export class Database {
  private readonly db: DatabaseSync;
  private savepointCount = 0;

  /**
   * Open the database file at `path`. Use the readonly option to refuse writes.
   * The first construction loads node:sqlite.
   */
  constructor(path: string, options: DatabaseOptions = {}) {
    const { DatabaseSync: Native } = loadSqlite();
    this.db = new Native(path, {
      readOnly: !!options.readonly,
      enableForeignKeyConstraints: true,
    });
  }

  /** True while the connection is open. */
  get open(): boolean {
    return this.db.isOpen;
  }

  /** True while a transaction is open on the connection. */
  get inTransaction(): boolean {
    return this.db.isTransaction;
  }

  /**
   * Prepare one SQL statement. Bound values pass the same coercion on every call.
   * An undefined value binds as NULL. A safe integer binds as INTEGER.
   * A call with too few values binds the missing ones as NULL, and does not throw.
   * The SQL text must hold one statement. Text after the first statement is ignored.
   */
  prepare(sql: string): Statement {
    return wrapStatement(this.db.prepare(sql));
  }

  /** Run one or more SQL statements. Rows that they return are discarded. */
  exec(sql: string): this {
    this.db.exec(sql);
    return this;
  }

  /** Close the connection. A second close does nothing. */
  close(): this {
    if (this.db.isOpen) this.db.close();
    return this;
  }

  /**
   * Register a SQL function on the connection.
   * The function receives the SQL values as arguments and returns one SQL value.
   */
  function(name: string, options: SqlFunctionOptions, fn: (...args: never[]) => unknown): this {
    this.db.function(name, options, fn as unknown as (...args: SQLOutputValue[]) => SQLInputValue);
    return this;
  }

  /**
   * Run a PRAGMA and return the rows, like better-sqlite3. A write form often returns no row.
   * With the simple option, return the first column value of the first row.
   */
  pragma(text: string, options: PragmaOptions = {}): unknown {
    const rows = this.prepare(`PRAGMA ${text}`).all<Row>();
    if (options.simple) return rows.length > 0 ? Object.values(rows[0])[0] : undefined;
    return rows;
  }

  /**
   * Wrap a function in a transaction. The returned function passes its arguments
   * to the function and returns its value. The immediate, deferred and exclusive
   * methods choose the begin mode. A call inside an open transaction uses a savepoint.
   * An async function is refused when it is wrapped. A function that returns a promise
   * is refused when it runs. A write after an await is outside every transaction.
   */
  transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F> {
    if (Object.prototype.toString.call(fn) === '[object AsyncFunction]') throw new TypeError(ASYNC_REFUSED);
    const body = fn as unknown as Body;
    const runner = (begin: string) => (...args: unknown[]): unknown => this.runTransaction(body, begin, args);
    return Object.assign(runner('BEGIN'), {
      deferred: runner('BEGIN DEFERRED'),
      immediate: runner('BEGIN IMMEDIATE'),
      exclusive: runner('BEGIN EXCLUSIVE'),
    }) as unknown as Transaction<F>;
  }

  /** Run the body in a transaction, or in a savepoint when a transaction is open. */
  private runTransaction(body: Body, begin: string, args: unknown[]): unknown {
    if (this.db.isTransaction) return this.runSavepoint(body, args);
    // A failed BEGIN has no transaction to roll back, so the error passes unchanged.
    this.db.exec(begin);
    try {
      const result = body(...args);
      if (isThenable(result)) {
        result.then(undefined, () => undefined);
        throw new TypeError(ASYNC_REFUSED);
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.rollbackQuietly();
      throw error;
    }
  }

  /** Run the body in a savepoint with a unique name. Release it on success. */
  private runSavepoint(body: Body, args: unknown[]): unknown {
    const name = `tx_${++this.savepointCount}`;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const result = body(...args);
      if (isThenable(result)) {
        result.then(undefined, () => undefined);
        throw new TypeError(ASYNC_REFUSED);
      }
      this.db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      if (this.db.isTransaction) {
        try {
          this.db.exec(`ROLLBACK TO ${name}`);
          this.db.exec(`RELEASE ${name}`);
        } catch {
          // The original error is the one to report, so a failed rollback is not rethrown.
        }
      }
      throw error;
    }
  }

  /**
   * Roll back the open transaction, if one is still open.
   * A failed rollback does not replace the original error, so it is not rethrown.
   */
  private rollbackQuietly(): void {
    if (!this.db.isTransaction) return;
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // The original error is the one to report, so a failed rollback is not rethrown.
    }
  }
}
