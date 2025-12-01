import { SQL } from "bun";
import {
	CompiledQuery,
	type DatabaseConnection,
	type Driver,
	type QueryResult,
} from "kysely";
import type { BunPostgresDialectConfig } from "./config.ts";

type ReservedClient = SQL & { release: () => void };

export class BunPostgresDriver implements Driver {
	readonly #config: BunPostgresDialectConfig;
	readonly #connections = new WeakMap<ReservedClient, BunPostgresConnection>();
	#client!: SQL;

	constructor(config: BunPostgresDialectConfig = {}) {
		this.#config = { ...config };
	}

	async init(): Promise<void> {
		if (this.#config.client) {
			this.#client = this.#config.client;
			return;
		}

		if (this.#config.url) {
			this.#client = new SQL(this.#config.url);
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

	async acquireConnection(): Promise<DatabaseConnection> {
		const reserved = (await this.#client.reserve()) as ReservedClient;

		// Check if we already have a connection wrapper for this reserved client
		let connection = this.#connections.get(reserved);

		if (!connection) {
			// This is a new connection - create wrapper and call onCreateConnection
			connection = new BunPostgresConnection(reserved);
			this.#connections.set(reserved, connection);

			if (this.#config.onCreateConnection) {
				await this.#config.onCreateConnection(connection);
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
		const rows = (await this.#client.unsafe(
			sql,
			parameters as unknown[],
		)) as O[];

		return { rows };
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
