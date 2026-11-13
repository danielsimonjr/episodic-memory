import type { SQLOutputValue } from 'node:sqlite';
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
/**
 * Refuse a node:sqlite handle that has no `isTransaction` property.
 *
 * The transaction wrapper reads `isTransaction` to select a savepoint for a nested call.
 * Below Node 22.16.0 the property is absent, so a nested call starts a second BEGIN and fails.
 * The function closes the handle before it throws, so the file stays unlocked.
 *
 * @throws Error that names the Node floor, when the handle has no boolean `isTransaction`.
 */
export declare function requireTransactionState(handle: {
    isTransaction?: unknown;
    close(): void;
}): void;
/**
 * A database connection with the better-sqlite3 method names.
 * Every connection turns foreign key enforcement on.
 */
export declare class Database {
    private readonly db;
    /** The path that the constructor opened. */
    readonly name: string;
    private savepointCount;
    /**
     * Open the database file at `path`. Use the readonly option to refuse writes.
     * The first construction loads node:sqlite.
     */
    constructor(path: string, options?: DatabaseOptions);
    /** True while the connection is open. */
    get open(): boolean;
    /** True while a transaction is open on the connection. */
    get inTransaction(): boolean;
    /**
     * Prepare one SQL statement. Bound values pass the same coercion on every call.
     * An undefined value binds as NULL. A safe integer binds as INTEGER.
     * A call with too few values binds the missing ones as NULL, and does not throw.
     * The SQL text must hold one statement. Text after the first statement is ignored.
     */
    prepare(sql: string): Statement;
    /** Run one or more SQL statements. Rows that they return are discarded. */
    exec(sql: string): this;
    /** Close the connection. A second close does nothing. */
    close(): this;
    /**
     * Register a SQL function on the connection.
     * The function receives the SQL values as arguments and returns one SQL value.
     */
    function(name: string, options: SqlFunctionOptions, fn: (...args: never[]) => unknown): this;
    /**
     * Run a PRAGMA and return the rows, like better-sqlite3. A write form often returns no row.
     * With the simple option, return the first column value of the first row.
     */
    pragma(text: string, options?: PragmaOptions): unknown;
    /**
     * Wrap a function in a transaction. The returned function passes its arguments
     * to the function and returns its value. The immediate, deferred and exclusive
     * methods choose the begin mode. A call inside an open transaction uses a savepoint.
     * An async function is refused when it is wrapped. A function that returns a promise
     * is refused when it runs. A write after an await is outside every transaction.
     */
    transaction<F extends (...args: never[]) => unknown>(fn: F): Transaction<F>;
    /** Run the body in a transaction, or in a savepoint when a transaction is open. */
    private runTransaction;
    /** Run the body in a savepoint with a unique name. Release it on success. */
    private runSavepoint;
    /**
     * Roll back the open transaction, if one is still open.
     * A failed rollback does not replace the original error, so it is not rethrown.
     */
    private rollbackQuietly;
}
