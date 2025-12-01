import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "bun";
import { CompiledQuery } from "kysely";
import { BunPostgresDriver } from "../src/driver.ts";

describe("BunPostgresDriver (unit)", () => {
	// Create a minimal stub that matches the parts of Bun.SQL we use
	function createStubClient() {
		const unsafe = mock(async (sql: string, params?: unknown[]) => {
			return [{ sql, params }];
		});

		const release = mock(() => {});
		const reserved: { unsafe: typeof unsafe; release: () => void } = {
			unsafe,
			release,
		};

		const close = mock(async () => {});
		const reserve = mock(async () => reserved);

		const client: {
			reserve: () => Promise<typeof reserved>;
			close: () => Promise<void>;
		} = {
			reserve,
			close,
		};
		return { client, reserved, unsafe, release, reserve, close };
	}

	test("init uses provided client", async () => {
		const { client } = createStubClient();
		const driver = new BunPostgresDriver({ client: client as unknown as SQL });
		await driver.init();
		const conn = await driver.acquireConnection();
		expect(conn).toBeDefined();
		await driver.releaseConnection(conn);
	});

	test("executeQuery forwards SQL and parameters to Bun", async () => {
		const { client, unsafe } = createStubClient();
		const driver = new BunPostgresDriver({ client: client as unknown as SQL });
		await driver.init();
		const conn = await driver.acquireConnection();

		const cq = CompiledQuery.raw("select $1::int as x", [123]);
		const result = await conn.executeQuery<{ x: number }>(cq);

		expect(unsafe).toHaveBeenCalledTimes(1);
		const [firstSql, firstParams] = unsafe.mock.calls[0] as [
			string,
			unknown[] | undefined,
		];
		expect(firstSql).toBe(cq.sql);
		expect(firstParams).toEqual([...cq.parameters]);
		expect(result.rows.length).toBe(1);

		await driver.releaseConnection(conn);
	});

	test("transaction commands are executed", async () => {
		const { client, unsafe } = createStubClient();
		const driver = new BunPostgresDriver({ client: client as unknown as SQL });
		await driver.init();
		const conn = await driver.acquireConnection();

		await driver.beginTransaction(conn, {});
		await driver.commitTransaction(conn);
		await driver.rollbackTransaction(conn);

		const calledSql = unsafe.mock.calls.map(
			(c) => (c as unknown as [string])[0],
		);
		expect(calledSql).toEqual(["begin", "commit", "rollback"]);

		await driver.releaseConnection(conn);
	});

	test("transaction with isolation level and access mode", async () => {
		const { client, unsafe } = createStubClient();
		const driver = new BunPostgresDriver({ client: client as unknown as SQL });
		await driver.init();
		const conn = await driver.acquireConnection();

		await driver.beginTransaction(conn, {
			isolationLevel: "serializable",
			accessMode: "read only",
		});

		const calledSql = unsafe.mock.calls.map(
			(c) => (c as unknown as [string])[0],
		);
		expect(calledSql).toEqual([
			"start transaction isolation level serializable read only",
		]);

		await driver.releaseConnection(conn);
	});

	test("releaseConnection and destroy close resources", async () => {
		const { client, release, close } = createStubClient();
		const driver = new BunPostgresDriver({ client: client as unknown as SQL });
		await driver.init();
		const conn = await driver.acquireConnection();
		await driver.releaseConnection(conn);
		expect(release).toHaveBeenCalledTimes(1);
		await driver.destroy();
		expect(close).toHaveBeenCalledTimes(1);
	});

	test("onCreateConnection hook is called once per acquire", async () => {
		const unsafe = mock(async () => [] as unknown[]);
		const release = mock(() => {});
		const reserved: { unsafe: typeof unsafe; release: () => void } = {
			unsafe,
			release,
		};
		const close = mock(async () => {});
		const reserve = mock(async () => reserved);
		const client: {
			reserve: () => Promise<typeof reserved>;
			close: () => Promise<void>;
		} = {
			reserve,
			close,
		};

		const onCreateConnection = mock(async () => {});
		const driver = new BunPostgresDriver({
			client: client as unknown as SQL,
			onCreateConnection,
		});
		await driver.init();
		const conn = await driver.acquireConnection();
		expect(onCreateConnection).toHaveBeenCalledTimes(1);
		await driver.releaseConnection(conn);
	});

	test("reserve failure surfaces error", async () => {
		// no-op placeholders to keep structure consistent
		const close = mock(async () => {});
		const reserve = mock(async () => {
			throw new Error("pool exhausted");
		});
		const client: {
			reserve: () => Promise<never>;
			close: () => Promise<void>;
		} = {
			reserve,
			close,
		};

		const driver = new BunPostgresDriver({ client: client as unknown as SQL });
		await driver.init();
		await expect(driver.acquireConnection()).rejects.toThrow("pool exhausted");
	});

	test("streamQuery yields rows individually", async () => {
		const rows = [{ id: 1 }, { id: 2 }];
		const unsafe = mock(async () => rows);
		const release = mock(() => {});
		const reserved: { unsafe: typeof unsafe; release: () => void } = {
			unsafe,
			release,
		};
		const close = mock(async () => {});
		const reserve = mock(async () => reserved);
		const client: {
			reserve: () => Promise<typeof reserved>;
			close: () => Promise<void>;
		} = {
			reserve,
			close,
		};

		const driver = new BunPostgresDriver({ client: client as unknown as SQL });
		await driver.init();
		const conn = await driver.acquireConnection();

		const cq = CompiledQuery.raw("select 1", []);
		const received: Array<{ id: number }> = [];
		for await (const chunk of conn.streamQuery<{ id: number }>(cq)) {
			received.push(...chunk.rows);
		}

		expect(received).toEqual(rows);
		await driver.releaseConnection(conn);
	});
});
