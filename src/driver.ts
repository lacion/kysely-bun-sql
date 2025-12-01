import { SQL } from "bun";
import {
	CompiledQuery,
	type DatabaseConnection,
	type Driver,
	type QueryResult,
} from "kysely";
import type { BunPostgresDialectConfig } from "./config.ts";

type ReservedClient = SQL & { release: () => void };

/**
 * Bun SQL result array with additional metadata properties.
 * The result is an array with extra properties attached (count, command, etc.)
 */
interface BunSqlResult<T> extends Array<T> {
	/** Number of rows affected by the query (for INSERT/UPDATE/DELETE) */
	count?: number;
	/** The SQL command that was executed (INSERT, UPDATE, DELETE, SELECT, etc.) */
	command?: string;
}

/** Default connection TTL: 1 hour (in milliseconds) */
const DEFAULT_CONNECTION_TTL_MS = 3600 * 1000;

/** Minimum interval between prune operations (in milliseconds) */
const PRUNE_INTERVAL_MS = 60_000;

export class BunPostgresDriver implements Driver {
	readonly #config: BunPostgresDialectConfig;
	#client!: SQL;

	/**
	 * Tracks initialized connections by their PostgreSQL backend PID.
	 * Maps PID -> timestamp of last seen activity.
	 * Used to ensure onCreateConnection is called only once per underlying connection.
	 */
	readonly #initializedPids = new Map<number, number>();

	/** Timestamp of last prune operation */
	#lastPruneTime = 0;

	/** Connection TTL in milliseconds - entries older than this are considered stale */
	readonly #connectionTtlMs: number;

	constructor(config: BunPostgresDialectConfig = {}) {
		this.#config = { ...config };
		// Use maxLifetime from clientOptions if provided, otherwise default to 1 hour
		const maxLifetimeSec = config.clientOptions?.maxLifetime;
		this.#connectionTtlMs =
			maxLifetimeSec !== undefined
				? maxLifetimeSec * 1000
				: DEFAULT_CONNECTION_TTL_MS;
	}

	async init(): Promise<void> {
		if (this.#config.client) {
			this.#client = this.#config.client;
			return;
		}

		if (this.#config.url) {
			// Merge URL with clientOptions if both are provided
			// Exclude clientOptions.url to ensure config.url takes precedence
			if (this.#config.clientOptions) {
				const { url: _ignoredUrl, ...restClientOptions } =
					this.#config.clientOptions;
				this.#client = new SQL({
					url: this.#config.url,
					...restClientOptions,
				});
			} else {
				this.#client = new SQL(this.#config.url);
			}
		} else {
			// Use default environment-based configuration; defaults to Postgres when not MySQL/SQLite
			if (this.#config.clientOptions) {
				// allow configuring pool, prepare, bigint, tls, etc.
				this.#client = new SQL({ ...this.#config.clientOptions });
			} else {
				this.#client = new SQL();
			}
		}
	}

	/**
	 * Removes stale PID entries that are older than the connection TTL.
	 * Called lazily during acquireConnection to avoid timer overhead.
	 */
	#pruneStaleConnections(): void {
		const now = Date.now();

		// Only prune if enough time has passed since last prune
		if (now - this.#lastPruneTime < PRUNE_INTERVAL_MS) {
			return;
		}

		this.#lastPruneTime = now;

		for (const [pid, timestamp] of this.#initializedPids) {
			if (now - timestamp > this.#connectionTtlMs) {
				this.#initializedPids.delete(pid);
			}
		}
	}

	async acquireConnection(): Promise<DatabaseConnection> {
		const reserved = (await this.#client.reserve()) as ReservedClient;
		const connection = new BunPostgresConnection(reserved);

		// Only track PIDs and call onCreateConnection if the callback is configured
		if (this.#config.onCreateConnection) {
			// Lazily prune stale connection tracking entries
			this.#pruneStaleConnections();

			// Query PostgreSQL for the backend process ID to uniquely identify this connection
			const result = await reserved.unsafe("SELECT pg_backend_pid() AS pid");
			const row = result?.[0] as { pid: number } | undefined;
			const pid = row?.pid;

			if (typeof pid !== "number") {
				throw new Error(
					"Failed to retrieve PostgreSQL backend PID. " +
						"Ensure you are connected to a PostgreSQL database.",
				);
			}

			const now = Date.now();

			const existingTimestamp = this.#initializedPids.get(pid);

			// Consider it a "new" connection if:
			// 1. We haven't seen this PID before, OR
			// 2. The tracked entry is older than TTL (connection was recycled, PID reused)
			const isNewConnection =
				existingTimestamp === undefined ||
				now - existingTimestamp > this.#connectionTtlMs;

			if (isNewConnection) {
				this.#initializedPids.set(pid, now);
				await this.#config.onCreateConnection(connection);
			} else {
				// Refresh timestamp - connection is still alive
				this.#initializedPids.set(pid, now);
			}
		}

		return connection;
	}

	async beginTransaction(connection: DatabaseConnection): Promise<void> {
		await connection.executeQuery(CompiledQuery.raw("begin"));
	}

	async commitTransaction(connection: DatabaseConnection): Promise<void> {
		await connection.executeQuery(CompiledQuery.raw("commit"));
	}

	async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
		await connection.executeQuery(CompiledQuery.raw("rollback"));
	}

	async releaseConnection(connection: DatabaseConnection): Promise<void> {
		if (connection instanceof BunPostgresConnection) {
			connection.release();
		}
	}

	async destroy(): Promise<void> {
		this.#initializedPids.clear();
		await this.#client.close(this.#config.closeOptions);
	}
}

class BunPostgresConnection implements DatabaseConnection {
	readonly #client: ReservedClient;

	constructor(client: ReservedClient) {
		this.#client = client;
	}

	release(): void {
		this.#client.release();
	}

	async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
		const { sql, parameters } = compiledQuery;

		// Use unsafe to execute the compiled SQL with $1-style bindings
		// Bun SQL returns an array with additional properties (count, command)
		const result = (await this.#client.unsafe(
			sql,
			parameters as unknown[],
		)) as BunSqlResult<O>;

		// Extract the command type and count from Bun's result
		const command = result.command;
		const count = result.count;

		// Return numAffectedRows for INSERT, UPDATE, DELETE, MERGE operations
		const numAffectedRows =
			(command === "INSERT" ||
				command === "UPDATE" ||
				command === "DELETE" ||
				command === "MERGE") &&
			count !== undefined
				? BigInt(count)
				: undefined;

		return {
			numAffectedRows,
			rows: [...result], // Convert to plain array
		};
	}

	async *streamQuery<R>(
		compiledQuery: CompiledQuery,
	): AsyncIterableIterator<QueryResult<R>> {
		// Fallback streaming by yielding rows one-by-one
		const { rows } = await this.executeQuery<R>(compiledQuery);
		for (const row of rows) {
			yield { rows: [row] };
		}
	}
}
