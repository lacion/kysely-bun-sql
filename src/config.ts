import type { SQL } from "bun";
import type { DatabaseConnection } from "kysely";

/**
 * Configuration for the Bun SQL Postgres dialect.
 */
export interface BunPostgresDialectConfig {
	/**
	 * Optional existing Bun SQL client. If not provided, a new client will be created.
	 */
	client?: SQL;

	/**
	 * Optional Postgres connection URL used to create the client if `client` is not provided.
	 */
	url?: string;

	/**
	 * Options forwarded to Bun's SQL constructor when creating the client internally.
	 * Use this to configure pool sizes, timeouts, TLS, `prepare`, `bigint`, etc.
	 */
	clientOptions?: BunSqlClientOptions;

	/**
	 * Called once when a reserved connection is created (first use of the connection).
	 */
	onCreateConnection?: (connection: DatabaseConnection) => Promise<void>;

	/**
	 * Options forwarded to `client.close()` when the driver is destroyed.
	 */
	closeOptions?: BunSqlCloseOptions;
}

/** Minimal subset of Bun SQL constructor options we support/document. */
export interface BunSqlClientOptions {
	/** Connection URL - can also be set via BunPostgresDialectConfig.url */
	url?: string;
	hostname?: string;
	port?: number;
	database?: string;
	username?: string;
	password?: string | (() => string | Promise<string>);
	// Pool
	/** Maximum number of connections in the pool @default 10 */
	max?: number;
	/** Maximum time in seconds to wait for connection to become available @default 0 */
	idleTimeout?: number;
	/** Maximum lifetime in seconds of a connection @default 0 */
	maxLifetime?: number;
	/** Maximum time in seconds to wait when establishing a connection @default 30 */
	connectionTimeout?: number;
	// Behavior
	/** Automatic creation of prepared statements @default true */
	prepare?: boolean;
	/** Return values outside i32 range as BigInts @default false */
	bigint?: boolean;
	/** TLS/SSL configuration for the connection */
	tls?: boolean | Record<string, unknown>;
	// Callbacks (typed loosely to avoid importing Bun internals)
	onconnect?: (client: unknown) => void;
	onclose?: (client: unknown, err?: unknown) => void;
}

export interface BunSqlCloseOptions {
	timeout?: number;
}
