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
	url?: string;
	hostname?: string;
	port?: number;
	database?: string;
	username?: string;
	password?: string | (() => string | Promise<string>);
	// Pool
	max?: number;
	idleTimeout?: number;
	maxLifetime?: number;
	connectionTimeout?: number;
	// Behavior
	prepare?: boolean;
	bigint?: boolean;
	tls?: boolean | Record<string, unknown>;
	// Callbacks (typed loosely to avoid importing Bun internals)
	onconnect?: (client: unknown) => void;
	onclose?: (client: unknown, err?: unknown) => void;
}

export interface BunSqlCloseOptions {
	timeout?: number;
}
