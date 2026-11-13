/**
 * A better-sqlite3-compatible subset over the node:sqlite built-in module.
 *
 * This module is the only importer of node:sqlite. The built-in loads on the
 * first construction of a Database, not on import. Other modules import
 * Database and Statement from here.
 */
import { createRequire } from 'module';
import { NODE_FLOOR, assertNodeFloor } from './node-floor.js';
/** The start of the warning that node:sqlite writes when it loads. */
const SQLITE_WARNING_PREFIX = 'SQLite is an experimental feature';
/** The message of a transaction function that returns a promise. */
const ASYNC_REFUSED = 'A transaction function must not return a promise. Use a synchronous function.';
let sqliteModule;
/**
 * Turn a failed load of node:sqlite into an error that names the Node floor.
 *
 * Below Node 22.13.0 the module needs a flag, so the load fails with an unknown built-in module.
 * At or above the floor the function returns the original error unchanged.
 *
 * @param err The error of the failed load.
 * @param version The Node version, without the leading "v".
 */
export function sqliteLoadError(err, version) {
    const floor = assertNodeFloor(version);
    if (floor === null)
        return err instanceof Error ? err : new Error(String(err));
    return new Error(floor, { cause: err });
}
/**
 * Load node:sqlite once. Drop the first experimental warning that the load writes.
 * Every other warning passes through unchanged.
 */
function loadSqlite() {
    if (sqliteModule)
        return sqliteModule;
    const original = process.emitWarning;
    // node:sqlite writes the warning synchronously while it loads, so the filter is needed only during the load.
    process.emitWarning = function (...args) {
        if (isSqliteWarning(args[0]))
            return;
        return original.apply(this, args);
    };
    try {
        sqliteModule = createRequire(import.meta.url)('node:sqlite');
    }
    catch (err) {
        throw sqliteLoadError(err, process.versions.node);
    }
    finally {
        process.emitWarning = original;
    }
    return sqliteModule;
}
/** True when a warning message starts with the node:sqlite experimental notice. */
function isSqliteWarning(warning) {
    const text = typeof warning === 'string' ? warning : warning?.message;
    return typeof text === 'string' && text.startsWith(SQLITE_WARNING_PREFIX);
}
/**
 * Map a bind value to the form node:sqlite binds as the intended SQL type.
 * This differs from better-sqlite3 on purpose. better-sqlite3 binds every Number as REAL.
 * This adapter binds a safe integer as INTEGER, so 7 concatenates as "7" and not "7.0".
 * The integer form also keeps an FTS5 rowid condition on SQLite 3.54.
 */
function coerce(value) {
    if (value === undefined)
        return null;
    if (typeof value === 'number' && Number.isSafeInteger(value))
        return BigInt(value);
    return value;
}
/** True for a plain object. A Buffer, an array and a class instance are not plain. */
function isPlainObject(value) {
    if (typeof value !== 'object' || value === null || ArrayBuffer.isView(value))
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
/** Coerce the parameters of one call. A single plain object is a set of named values. */
function bindParams(params) {
    const [first] = params;
    if (params.length === 1 && isPlainObject(first)) {
        const named = {};
        for (const [key, value] of Object.entries(first))
            named[key] = coerce(value);
        return [named];
    }
    return params.map(coerce);
}
/** Wrap one node:sqlite statement with the better-sqlite3 method shapes. */
function wrapStatement(native) {
    return {
        // A named object is passed as the first argument, which node:sqlite reads as named values.
        run(...params) {
            const info = native.run(...bindParams(params));
            return { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
        },
        get(...params) {
            return native.get(...bindParams(params));
        },
        all(...params) {
            return native.all(...bindParams(params));
        },
        iterate(...params) {
            return native.iterate(...bindParams(params));
        },
    };
}
/** True for an object with a then method. */
function isThenable(value) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
        return false;
    return typeof value.then === 'function';
}
/**
 * Refuse a node:sqlite handle that has no `isTransaction` property.
 *
 * The transaction wrapper reads `isTransaction` to select a savepoint for a nested call.
 * Below Node 22.16.0 the property is absent, so a nested call starts a second BEGIN and fails.
 * The function closes the handle before it throws, so the file stays unlocked.
 *
 * @throws Error that names the Node floor, when the handle has no boolean `isTransaction`.
 */
export function requireTransactionState(handle) {
    if (typeof handle.isTransaction === 'boolean')
        return;
    handle.close();
    throw new Error(assertNodeFloor(process.versions.node) ??
        `node:sqlite has no DatabaseSync.isTransaction. Use Node ${NODE_FLOOR} or newer.`);
}
/**
 * A database connection with the better-sqlite3 method names.
 * Every connection turns foreign key enforcement on.
 */
export class Database {
    db;
    /** The path that the constructor opened. */
    name;
    savepointCount = 0;
    /**
     * Open the database file at `path`. Use the readonly option to refuse writes.
     * The first construction loads node:sqlite.
     */
    constructor(path, options = {}) {
        const { DatabaseSync: Native } = loadSqlite();
        this.name = path;
        this.db = new Native(path, {
            readOnly: !!options.readonly,
            enableForeignKeyConstraints: true,
        });
        requireTransactionState(this.db);
    }
    /** True while the connection is open. */
    get open() {
        return this.db.isOpen;
    }
    /** True while a transaction is open on the connection. */
    get inTransaction() {
        return this.db.isTransaction;
    }
    /**
     * Prepare one SQL statement. Bound values pass the same coercion on every call.
     * An undefined value binds as NULL. A safe integer binds as INTEGER.
     * A call with too few values binds the missing ones as NULL, and does not throw.
     * The SQL text must hold one statement. Text after the first statement is ignored.
     */
    prepare(sql) {
        return wrapStatement(this.db.prepare(sql));
    }
    /** Run one or more SQL statements. Rows that they return are discarded. */
    exec(sql) {
        this.db.exec(sql);
        return this;
    }
    /** Close the connection. A second close does nothing. */
    close() {
        if (this.db.isOpen)
            this.db.close();
        return this;
    }
    /**
     * Register a SQL function on the connection.
     * The function receives the SQL values as arguments and returns one SQL value.
     */
    function(name, options, fn) {
        this.db.function(name, options, fn);
        return this;
    }
    /**
     * Run a PRAGMA and return the rows, like better-sqlite3. A write form often returns no row.
     * With the simple option, return the first column value of the first row.
     */
    pragma(text, options = {}) {
        const rows = this.prepare(`PRAGMA ${text}`).all();
        if (options.simple)
            return rows.length > 0 ? Object.values(rows[0])[0] : undefined;
        return rows;
    }
    /**
     * Wrap a function in a transaction. The returned function passes its arguments
     * to the function and returns its value. The immediate, deferred and exclusive
     * methods choose the begin mode. A call inside an open transaction uses a savepoint.
     * An async function is refused when it is wrapped. A function that returns a promise
     * is refused when it runs. A write after an await is outside every transaction.
     */
    transaction(fn) {
        if (Object.prototype.toString.call(fn) === '[object AsyncFunction]')
            throw new TypeError(ASYNC_REFUSED);
        const body = fn;
        const runner = (begin) => (...args) => this.runTransaction(body, begin, args);
        return Object.assign(runner('BEGIN'), {
            deferred: runner('BEGIN DEFERRED'),
            immediate: runner('BEGIN IMMEDIATE'),
            exclusive: runner('BEGIN EXCLUSIVE'),
        });
    }
    /** Run the body in a transaction, or in a savepoint when a transaction is open. */
    runTransaction(body, begin, args) {
        if (this.db.isTransaction)
            return this.runSavepoint(body, args);
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
        }
        catch (error) {
            this.rollbackQuietly();
            throw error;
        }
    }
    /** Run the body in a savepoint with a unique name. Release it on success. */
    runSavepoint(body, args) {
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
        }
        catch (error) {
            if (this.db.isTransaction) {
                try {
                    this.db.exec(`ROLLBACK TO ${name}`);
                    this.db.exec(`RELEASE ${name}`);
                }
                catch {
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
    rollbackQuietly() {
        if (!this.db.isTransaction)
            return;
        try {
            this.db.exec('ROLLBACK');
        }
        catch {
            // The original error is the one to report, so a failed rollback is not rethrown.
        }
    }
}
