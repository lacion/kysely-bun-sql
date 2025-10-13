import { describe, expect, test } from "bun:test";
import {
	type Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
} from "kysely";
import { BunPostgresDialect } from "../src/dialect.ts";

describe("BunPostgresDialect (unit)", () => {
	test("creates adapter, query compiler, driver, and introspector", () => {
		const dialect = new BunPostgresDialect();
		expect(dialect.createAdapter()).toBeInstanceOf(PostgresAdapter);
		expect(dialect.createQueryCompiler()).toBeInstanceOf(PostgresQueryCompiler);
		// createDriver should return a driver instance (not asserting exact class name here)
		const driver = dialect.createDriver();
		expect(driver).toBeDefined();
		// createIntrospector returns PostgresIntrospector
		const introspector = dialect.createIntrospector(
			{} as unknown as Kysely<unknown>,
		);
		expect(introspector).toBeInstanceOf(PostgresIntrospector);
	});
});
