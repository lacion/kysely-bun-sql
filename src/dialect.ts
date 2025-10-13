import {
	type DatabaseIntrospector,
	type Dialect,
	type DialectAdapter,
	type Driver,
	type Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
	type QueryCompiler,
} from "kysely";
import type { BunPostgresDialectConfig } from "./config";
import { BunPostgresDriver } from "./driver";

export class BunPostgresDialect implements Dialect {
	readonly #config: BunPostgresDialectConfig;

	constructor(config: BunPostgresDialectConfig = {}) {
		this.#config = { ...config };
	}

	createDriver(): Driver {
		return new BunPostgresDriver(this.#config);
	}

	createQueryCompiler(): QueryCompiler {
		return new PostgresQueryCompiler();
	}

	createAdapter(): DialectAdapter {
		return new PostgresAdapter();
	}

	createIntrospector<DB>(db: Kysely<DB>): DatabaseIntrospector {
		// PostgresIntrospector expects Kysely<any>; narrow without using any in the signature
		// biome-ignore lint/suspicious/noExplicitAny: upstream type requires any here
		return new PostgresIntrospector(db as unknown as Kysely<any>);
	}
}
