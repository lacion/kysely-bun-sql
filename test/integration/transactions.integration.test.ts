import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { type Generated, Kysely, sql } from "kysely";
import { BunPostgresDialect } from "../../src/dialect.ts";

const hasDb = !!process.env.DATABASE_URL;

describe.if(hasDb)("Transaction Isolation Levels (integration)", () => {
	interface AccountsTable {
		id: Generated<number>;
		name: string;
		balance: number;
	}

	interface DB {
		accounts_trx: AccountsTable;
	}

	let db: Kysely<DB>;
	const table = "accounts_trx" as const;

	beforeAll(async () => {
		db = new Kysely<DB>({
			dialect: new BunPostgresDialect({ url: process.env.DATABASE_URL }),
		});

		await db.schema.dropTable(table).ifExists().execute();

		await db.schema
			.createTable(table)
			.addColumn("id", "serial", (col) => col.primaryKey())
			.addColumn("name", "varchar", (col) => col.notNull())
			.addColumn("balance", "integer", (col) => col.notNull().defaultTo(0))
			.execute();
	});

	beforeEach(async () => {
		await db.deleteFrom(table).execute();
		// Set up initial test data
		await db
			.insertInto(table)
			.values([
				{ name: "Alice", balance: 1000 },
				{ name: "Bob", balance: 500 },
			])
			.execute();
	});

	afterAll(async () => {
		await db.schema.dropTable(table).ifExists().execute();
		await db.destroy();
	});

	test("default transaction uses read committed isolation", async () => {
		// This test verifies that the default transaction works
		await db.transaction().execute(async (trx) => {
			const accounts = await trx.selectFrom(table).selectAll().execute();
			expect(accounts.length).toBe(2);

			await trx
				.updateTable(table)
				.set({ balance: 900 })
				.where("name", "=", "Alice")
				.execute();
		});

		const alice = await db
			.selectFrom(table)
			.selectAll()
			.where("name", "=", "Alice")
			.executeTakeFirst();
		expect(alice?.balance).toBe(900);
	});

	test("serializable isolation level is accepted", async () => {
		// Test that serializable isolation level can be set without error
		await db
			.transaction()
			.setIsolationLevel("serializable")
			.execute(async (trx) => {
				const accounts = await trx.selectFrom(table).selectAll().execute();
				expect(accounts.length).toBe(2);
			});
	});

	test("repeatable read isolation level is accepted", async () => {
		await db
			.transaction()
			.setIsolationLevel("repeatable read")
			.execute(async (trx) => {
				const accounts = await trx.selectFrom(table).selectAll().execute();
				expect(accounts.length).toBe(2);
			});
	});

	test("read committed isolation level is accepted", async () => {
		await db
			.transaction()
			.setIsolationLevel("read committed")
			.execute(async (trx) => {
				const accounts = await trx.selectFrom(table).selectAll().execute();
				expect(accounts.length).toBe(2);
			});
	});

	test("read uncommitted isolation level is accepted", async () => {
		// Note: PostgreSQL treats read uncommitted as read committed
		await db
			.transaction()
			.setIsolationLevel("read uncommitted")
			.execute(async (trx) => {
				const accounts = await trx.selectFrom(table).selectAll().execute();
				expect(accounts.length).toBe(2);
			});
	});

	test("read only access mode prevents writes", async () => {
		let caught: unknown;
		try {
			await db
				.transaction()
				.setAccessMode("read only")
				.execute(async (trx) => {
					// This should fail because the transaction is read-only
					await trx
						.updateTable(table)
						.set({ balance: 0 })
						.where("name", "=", "Alice")
						.execute();
				});
		} catch (e) {
			caught = e;
		}

		expect(caught).toBeDefined();
		// Verify data was not modified
		const alice = await db
			.selectFrom(table)
			.selectAll()
			.where("name", "=", "Alice")
			.executeTakeFirst();
		expect(alice?.balance).toBe(1000);
	});

	test("read write access mode allows writes", async () => {
		await db
			.transaction()
			.setAccessMode("read write")
			.execute(async (trx) => {
				await trx
					.updateTable(table)
					.set({ balance: 1500 })
					.where("name", "=", "Alice")
					.execute();
			});

		const alice = await db
			.selectFrom(table)
			.selectAll()
			.where("name", "=", "Alice")
			.executeTakeFirst();
		expect(alice?.balance).toBe(1500);
	});

	test("combined isolation level and access mode", async () => {
		await db
			.transaction()
			.setIsolationLevel("serializable")
			.setAccessMode("read write")
			.execute(async (trx) => {
				await trx
					.updateTable(table)
					.set({ balance: 2000 })
					.where("name", "=", "Bob")
					.execute();
			});

		const bob = await db
			.selectFrom(table)
			.selectAll()
			.where("name", "=", "Bob")
			.executeTakeFirst();
		expect(bob?.balance).toBe(2000);
	});

	test("transaction rollback on error preserves original data", async () => {
		const originalAlice = await db
			.selectFrom(table)
			.selectAll()
			.where("name", "=", "Alice")
			.executeTakeFirst();

		try {
			await db
				.transaction()
				.setIsolationLevel("serializable")
				.execute(async (trx) => {
					await trx
						.updateTable(table)
						.set({ balance: 0 })
						.where("name", "=", "Alice")
						.execute();

					// Force a rollback
					throw new Error("Intentional rollback");
				});
		} catch {
			// Expected
		}

		const afterAlice = await db
			.selectFrom(table)
			.selectAll()
			.where("name", "=", "Alice")
			.executeTakeFirst();
		expect(afterAlice?.balance).toBe(originalAlice?.balance);
	});

	test("nested transactions work with savepoints", async () => {
		await db.transaction().execute(async (outer) => {
			await outer
				.updateTable(table)
				.set({ balance: 800 })
				.where("name", "=", "Alice")
				.execute();

			try {
				await outer.transaction().execute(async (inner) => {
					await inner
						.updateTable(table)
						.set({ balance: 100 })
						.where("name", "=", "Alice")
						.execute();
					throw new Error("Inner rollback");
				});
			} catch {
				// Inner transaction rolled back
			}

			// Alice should have the outer transaction's value (800), not inner's (100)
			const alice = await outer
				.selectFrom(table)
				.selectAll()
				.where("name", "=", "Alice")
				.executeTakeFirst();
			expect(alice?.balance).toBe(800);
		});

		// After outer commits, Alice should have 800
		const finalAlice = await db
			.selectFrom(table)
			.selectAll()
			.where("name", "=", "Alice")
			.executeTakeFirst();
		expect(finalAlice?.balance).toBe(800);
	});

	test("concurrent transactions can operate independently", async () => {
		// Start two transactions that read and update different rows
		const trx1Promise = db.transaction().execute(async (trx) => {
			await trx
				.updateTable(table)
				.set({ balance: sql`balance + 100` })
				.where("name", "=", "Alice")
				.execute();
			// Small delay to allow interleaving
			await new Promise((r) => setTimeout(r, 10));
			return trx
				.selectFrom(table)
				.selectAll()
				.where("name", "=", "Alice")
				.executeTakeFirst();
		});

		const trx2Promise = db.transaction().execute(async (trx) => {
			await trx
				.updateTable(table)
				.set({ balance: sql`balance + 200` })
				.where("name", "=", "Bob")
				.execute();
			return trx
				.selectFrom(table)
				.selectAll()
				.where("name", "=", "Bob")
				.executeTakeFirst();
		});

		const [aliceResult, bobResult] = await Promise.all([
			trx1Promise,
			trx2Promise,
		]);

		expect(aliceResult?.balance).toBe(1100); // 1000 + 100
		expect(bobResult?.balance).toBe(700); // 500 + 200
	});
});


