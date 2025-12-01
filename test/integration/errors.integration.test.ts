import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { CompiledQuery, type Generated, Kysely, sql } from "kysely";
import { BunPostgresDialect } from "../../src/dialect.ts";

const hasDb = !!process.env.DATABASE_URL;

describe.if(hasDb)("Error Handling (integration)", () => {
	interface ParentTable {
		id: Generated<number>;
		name: string;
	}

	interface ChildTable {
		id: Generated<number>;
		parent_id: number;
		value: string;
	}

	interface ConstraintTable {
		id: Generated<number>;
		age: number;
		email: string;
	}

	interface DB {
		parent_err: ParentTable;
		child_err: ChildTable;
		constraint_err: ConstraintTable;
	}

	let db: Kysely<DB>;

	beforeAll(async () => {
		db = new Kysely<DB>({
			dialect: new BunPostgresDialect({ url: process.env.DATABASE_URL }),
		});

		// Clean up any existing tables
		await sql`DROP TABLE IF EXISTS child_err CASCADE`.execute(db);
		await sql`DROP TABLE IF EXISTS parent_err CASCADE`.execute(db);
		await sql`DROP TABLE IF EXISTS constraint_err CASCADE`.execute(db);

		// Create parent table
		await db.schema
			.createTable("parent_err")
			.addColumn("id", "serial", (col) => col.primaryKey())
			.addColumn("name", "varchar", (col) => col.notNull())
			.execute();

		// Create child table with foreign key
		await sql`
			CREATE TABLE child_err (
				id SERIAL PRIMARY KEY,
				parent_id INTEGER NOT NULL REFERENCES parent_err(id) ON DELETE RESTRICT,
				value VARCHAR NOT NULL
			)
		`.execute(db);

		// Create table with check constraint
		await sql`
			CREATE TABLE constraint_err (
				id SERIAL PRIMARY KEY,
				age INTEGER NOT NULL CHECK (age >= 0 AND age <= 150),
				email VARCHAR NOT NULL UNIQUE
			)
		`.execute(db);
	});

	beforeEach(async () => {
		await db.deleteFrom("child_err").execute();
		await db.deleteFrom("parent_err").execute();
		await db.deleteFrom("constraint_err").execute();
	});

	afterAll(async () => {
		await sql`DROP TABLE IF EXISTS child_err CASCADE`.execute(db);
		await sql`DROP TABLE IF EXISTS parent_err CASCADE`.execute(db);
		await sql`DROP TABLE IF EXISTS constraint_err CASCADE`.execute(db);
		await db.destroy();
	});

	// ==================== Foreign Key Constraint Tests ====================

	test("foreign key violation on INSERT is caught", async () => {
		let caught: unknown;
		try {
			// Try to insert child with non-existent parent
			await db
				.insertInto("child_err")
				.values({ parent_id: 999, value: "orphan" })
				.execute();
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeDefined();
		expect(String(caught)).toContain("foreign key");
	});

	test("foreign key violation on DELETE is caught", async () => {
		// First create a valid parent-child relationship
		const result = await db
			.insertInto("parent_err")
			.values({ name: "Parent" })
			.returning("id")
			.execute();
		const parent = result[0];

		if (!parent) {
			throw new Error("Failed to insert parent");
		}

		await db
			.insertInto("child_err")
			.values({ parent_id: parent.id, value: "child" })
			.execute();

		// Now try to delete the parent (should fail due to RESTRICT)
		let caught: unknown;
		try {
			await db.deleteFrom("parent_err").where("id", "=", parent.id).execute();
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeDefined();
		expect(String(caught)).toContain("foreign key");
	});

	// ==================== Check Constraint Tests ====================

	test("check constraint violation is caught (age too low)", async () => {
		let caught: unknown;
		try {
			await db
				.insertInto("constraint_err")
				.values({ age: -1, email: "test@example.com" })
				.execute();
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeDefined();
		expect(String(caught)).toMatch(/check|constraint|violates/i);
	});

	test("check constraint violation is caught (age too high)", async () => {
		let caught: unknown;
		try {
			await db
				.insertInto("constraint_err")
				.values({ age: 200, email: "test@example.com" })
				.execute();
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeDefined();
		expect(String(caught)).toMatch(/check|constraint|violates/i);
	});

	test("valid age passes check constraint", async () => {
		const result = await db
			.insertInto("constraint_err")
			.values({ age: 25, email: "valid@example.com" })
			.returning("id")
			.execute();

		expect(result.length).toBe(1);
	});

	// ==================== Unique Constraint Tests ====================

	test("unique constraint violation is caught", async () => {
		// First insert succeeds
		await db
			.insertInto("constraint_err")
			.values({ age: 30, email: "unique@example.com" })
			.execute();

		// Second insert with same email should fail
		let caught: unknown;
		try {
			await db
				.insertInto("constraint_err")
				.values({ age: 25, email: "unique@example.com" })
				.execute();
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeDefined();
		expect(String(caught)).toMatch(/unique|duplicate/i);
	});

	// ==================== NOT NULL Constraint Tests ====================

	test("NOT NULL violation is caught", async () => {
		let caught: unknown;
		try {
			await sql`
				INSERT INTO constraint_err (age, email) VALUES (NULL, 'test@example.com')
			`.execute(db);
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeDefined();
		expect(String(caught)).toMatch(/null|not-null/i);
	});

	// ==================== Syntax Error Tests ====================

	test("SQL syntax error is caught with descriptive message", async () => {
		let caught: unknown;
		try {
			await sql`SELEC * FROM parent_err`.execute(db);
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeDefined();
		expect(String(caught)).toMatch(/syntax|SELEC/i);
	});

	test("invalid table reference is caught", async () => {
		let caught: unknown;
		try {
			await sql`SELECT * FROM nonexistent_table_xyz`.execute(db);
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeDefined();
		expect(String(caught)).toMatch(/exist|relation/i);
	});

	test("invalid column reference is caught", async () => {
		let caught: unknown;
		try {
			await sql`SELECT nonexistent_column FROM parent_err`.execute(db);
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeDefined();
		expect(String(caught)).toMatch(/column|exist/i);
	});
});

describe.if(hasDb)("onCreateConnection Integration (integration)", () => {
	test("onCreateConnection is called with a valid connection", async () => {
		let callCount = 0;
		let connectionValid = false;

		const db = new Kysely({
			dialect: new BunPostgresDialect({
				url: process.env.DATABASE_URL,
				onCreateConnection: async (conn) => {
					callCount++;
					// Test that the connection is usable
					const result = await conn.executeQuery(
						CompiledQuery.raw("SELECT 1 as test"),
					);
					connectionValid = result.rows.length === 1;
				},
			}),
		});

		// First query should trigger onCreateConnection
		await sql`SELECT 1`.execute(db);

		expect(callCount).toBeGreaterThanOrEqual(1);
		expect(connectionValid).toBe(true);

		await db.destroy();
	});

	test("onCreateConnection can set session variables", async () => {
		const db = new Kysely({
			dialect: new BunPostgresDialect({
				url: process.env.DATABASE_URL,
				onCreateConnection: async (conn) => {
					// Set a custom session variable
					await conn.executeQuery(CompiledQuery.raw("SET search_path TO public"));
				},
			}),
		});

		// Verify the session variable was set
		const result = await sql`SHOW search_path`.execute(db);
		const row = result.rows[0] as { search_path: string };
		expect(row.search_path).toContain("public");

		await db.destroy();
	});

	test("onCreateConnection is not called when no callback provided", async () => {
		// This should work without any issues
		const db = new Kysely({
			dialect: new BunPostgresDialect({
				url: process.env.DATABASE_URL,
				// No onCreateConnection callback
			}),
		});

		const result = await sql`SELECT 1 as value`.execute(db);
		const row = result.rows[0] as { value: number };
		expect(row.value).toBe(1);

		await db.destroy();
	});
});


