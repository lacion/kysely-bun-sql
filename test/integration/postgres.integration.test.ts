import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { SQL } from "bun";
import { type Generated, Kysely, sql as ksql } from "kysely";
import { BunPostgresDialect } from "../../src/dialect.ts";

const hasDb = !!process.env.DATABASE_URL;

describe.if(hasDb)("BunPostgresDialect (integration)", () => {
	interface UsersTable {
		id: Generated<number>;
		name: string;
	}

	interface DB {
		users_it: UsersTable;
	}

	let db: Kysely<DB>;
	const table = "users_it" as const;

	beforeAll(async () => {
		db = new Kysely<DB>({
			dialect: new BunPostgresDialect({ url: process.env.DATABASE_URL }),
		});

		// Ensure a clean slate for local iterative runs
		await db.schema.dropTable(table).ifExists().execute();

		await db.schema
			.createTable(table)
			.addColumn("id", "serial", (col) => col.primaryKey())
			.addColumn("name", "varchar", (col) => col.notNull())
			.execute();
	});

	beforeEach(async () => {
		// Clean rows between tests for deterministic assertions in local runs
		await db.deleteFrom(table).execute();
	});

	test("concurrent inserts and reads (pool usage)", async () => {
		const names = Array.from({ length: 50 }, (_, i) => `N${i}`);
		const before = await db.selectFrom(table).selectAll().execute();
		await Promise.all(
			names.map((n) => db.insertInto(table).values({ name: n }).execute()),
		);
		const after = await db.selectFrom(table).selectAll().execute();
		expect(after.length - before.length).toBe(names.length);
	});

	test("update with RETURNING returns updated rows", async () => {
		await db.insertInto(table).values({ name: "Target" }).execute();
		const updated = await db
			.updateTable(table)
			.set({ name: "Renamed" })
			.where("name", "=", "Target")
			.returning(["id", "name"])
			.execute();

		expect(updated.length).toBe(1);
		expect(updated[0]?.name).toBe("Renamed");
	});

	test("introspector lists our table and columns", async () => {
		const dialect = new BunPostgresDialect();
		const introspector = dialect.createIntrospector(db as any);
		const tables = await introspector.getTables();
		const usersTable = tables.find((t: any) => t.name === table);
		expect(usersTable).toBeDefined();
		const cols = usersTable!.columns.map((c: any) => c.name);
		expect(cols).toEqual(expect.arrayContaining(["id", "name"]));
	});

	test.if(!!process.env.DATABASE_URL)(
		"bigint handling with custom client",
		async () => {
			const url = process.env.DATABASE_URL!;
			const client = new SQL({ url, bigint: true } as any);
			const db2 = new Kysely<DB>({
				dialect: new BunPostgresDialect({ client }),
			});
			const res = await ksql`select 9223372036854777 as x`.execute(db2);
			const rows = res.rows as Array<{ x: bigint }>;
			expect(typeof rows[0]?.x).toBe("bigint");
			await db2.destroy();
			await client.close();
		},
	);

	test("syntax error surfaces Postgres error", async () => {
		let caught: unknown;
		try {
			await ksql`SELEC 1`.execute(db);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeDefined();
		// Optional: instance check if Bun's error classes are available here
		// expect(caught).toBeInstanceOf(SQL.PostgresError);
	});

	afterAll(async () => {
		await db.schema.dropTable(table).ifExists().execute();
		await db.destroy();
	});

	test("insert and select", async () => {
		await db.insertInto(table).values({ name: "Alice" }).execute();
		await db.insertInto(table).values({ name: "Bob" }).execute();

		const rows = await db
			.selectFrom(table)
			.select(["name"])
			.where("name", "in", ["Alice", "Bob"])
			.orderBy("id")
			.execute();
		expect(rows.map((r) => r.name)).toEqual(["Alice", "Bob"]);
	});

	test("transaction commit and rollback", async () => {
		await db.transaction().execute(async (trx) => {
			await trx.insertInto(table).values({ name: "Charlie" }).execute();
		});

		try {
			await db.transaction().execute(async (trx) => {
				await trx.insertInto(table).values({ name: "Dave" }).execute();
				throw new Error("force rollback");
			});
		} catch {}

		const names = (
			await db.selectFrom(table).select(["name"]).orderBy("id").execute()
		).map((r) => r.name);
		expect(names).toContain("Charlie");
		expect(names).not.toContain("Dave");
	});

	test("raw SQL via sql``, parameter binding", async () => {
		const res = await ksql`select ${1}::int as one`.execute(db);
		const rows = res.rows as Array<{ one: number }>;
		expect(rows[0]?.one).toBe(1);
	});

	test("unique constraint violation raises error and preserves data", async () => {
		// Enforce uniqueness via index; IF NOT EXISTS makes repeated local runs safe
		await ksql`CREATE UNIQUE INDEX IF NOT EXISTS users_it_name_key ON users_it(name)`.execute(
			db,
		);

		const before = await db.selectFrom(table).selectAll().execute();
		// First insert succeeds
		await db.insertInto(table).values({ name: "Alice" }).execute();

		// Second identical insert should violate unique index
		let caught: unknown;
		try {
			await db.insertInto(table).values({ name: "Alice" }).execute();
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeDefined();
		const after = await db.selectFrom(table).selectAll().execute();
		expect(after.length).toBe(before.length + 1);
	});

	test("parameterized values prevent SQL injection", async () => {
		const malicious = "Mallory'); DROP TABLE users_it; --";
		await db.insertInto(table).values({ name: malicious }).execute();
		// Insert a second safe row; if the table was dropped, this will throw
		await db.insertInto(table).values({ name: "Harmless" }).execute();

		const rows = await db
			.selectFrom(table)
			.select(["name"])
			.where("name", "in", [malicious, "Harmless"])
			.orderBy("id")
			.execute();

		expect(rows.map((r) => r.name)).toEqual([malicious, "Harmless"]);
	});

	test("nested transaction rolls back inner changes only", async () => {
		await db.transaction().execute(async (outer) => {
			await outer.insertInto(table).values({ name: "Outer" }).execute();
			try {
				await outer.transaction().execute(async (inner) => {
					await inner.insertInto(table).values({ name: "Inner" }).execute();
					throw new Error("boom");
				});
			} catch {}
			await outer.insertInto(table).values({ name: "Outer2" }).execute();
		});

		const names = (
			await db.selectFrom(table).select(["name"]).orderBy("id").execute()
		).map((r) => r.name);
		expect(names).toContain("Outer");
		expect(names).toContain("Outer2");
		expect(names).not.toContain("Inner");
	});
});

describe.if(!hasDb)("Integration skipped", () => {
	test("skipped due to missing DATABASE_URL", () => {
		expect(process.env.DATABASE_URL).toBeUndefined();
	});
});
