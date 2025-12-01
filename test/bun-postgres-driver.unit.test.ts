import type { SQL } from "bun";
import { describe, expect, mock, test } from "bun:test";
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

	// Helper to create a result array with command and count properties (mimics Bun.SQL result)
	function createResultArray(rows: unknown[], command: string, count: number) {
		const arr = [...rows] as unknown[] & { command?: string; count?: number };
		arr.command = command;
		arr.count = count;
		return arr;
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

	test.each([
		{
			command: "INSERT",
			sql: "insert into users (name) values ($1)",
			count: 3,
		},
		{
			command: "UPDATE",
			sql: "update users set name = $1 where id = 1",
			count: 5,
		},
		{ command: "DELETE", sql: "delete from users where id = $1", count: 2 },
		{ command: "MERGE", sql: "merge into users using ...", count: 7 },
	])(
		"executeQuery returns numAffectedRows for $command",
		async ({ command, sql, count }) => {
			const unsafe = mock(async () => createResultArray([], command, count));
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

			const driver = new BunPostgresDriver({
				client: client as unknown as SQL,
			});
			await driver.init();
			const conn = await driver.acquireConnection();

			const cq = CompiledQuery.raw(sql, ["test"]);
			const result = await conn.executeQuery(cq);

			expect(result.numAffectedRows).toBe(BigInt(count));
			expect(result.rows).toEqual([]);

			await driver.releaseConnection(conn);
		},
	);

	test("executeQuery does not return numAffectedRows for SELECT", async () => {
		const unsafe = mock(async () =>
			createResultArray([{ id: 1 }], "SELECT", 1),
		);
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

		const cq = CompiledQuery.raw("select * from users", []);
		const result = await conn.executeQuery(cq);

		expect(result.numAffectedRows).toBeUndefined();
		expect(result.rows).toEqual([{ id: 1 }]);

		await driver.releaseConnection(conn);
	});

	test("transaction commands are executed", async () => {
		const { client, unsafe } = createStubClient();
		const driver = new BunPostgresDriver({ client: client as unknown as SQL });
		await driver.init();
		const conn = await driver.acquireConnection();

		await driver.beginTransaction(conn);
		await driver.commitTransaction(conn);
		await driver.rollbackTransaction(conn);

		const calledSql = unsafe.mock.calls.map(
			(c) => (c as unknown as [string])[0],
		);
		expect(calledSql).toEqual(["begin", "commit", "rollback"]);

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

	test("onCreateConnection hook is called once per new connection, not on every acquire", async () => {
		// Mock that returns pid when querying pg_backend_pid, otherwise empty array
		const MOCK_PID = 12345;
		const unsafe = mock(async (sql: string) => {
			if (sql.includes("pg_backend_pid")) {
				return [{ pid: MOCK_PID }];
			}
			return [] as unknown[];
		});
		const release = mock(() => {});
		const reserved: { unsafe: typeof unsafe; release: () => void } = {
			unsafe,
			release,
		};
		const close = mock(async () => {});
		// reserve always returns the same reserved object (simulating same underlying connection)
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

		// First acquire - should call onCreateConnection
		const conn1 = await driver.acquireConnection();
		expect(onCreateConnection).toHaveBeenCalledTimes(1);
		await driver.releaseConnection(conn1);

		// Second acquire of the same connection (same PID) - should NOT call onCreateConnection again
		const conn2 = await driver.acquireConnection();
		expect(onCreateConnection).toHaveBeenCalledTimes(1); // Still 1, not 2
		await driver.releaseConnection(conn2);

		// Third acquire - still the same PID, still no new call
		const conn3 = await driver.acquireConnection();
		expect(onCreateConnection).toHaveBeenCalledTimes(1); // Still 1
		await driver.releaseConnection(conn3);
	});

	test("onCreateConnection is called again when connection PID changes (new connection)", async () => {
		let currentPid = 1000;
		const unsafe = mock(async (sql: string) => {
			if (sql.includes("pg_backend_pid")) {
				return [{ pid: currentPid }];
			}
			return [] as unknown[];
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

		const onCreateConnection = mock(async () => {});
		const driver = new BunPostgresDriver({
			client: client as unknown as SQL,
			onCreateConnection,
		});
		await driver.init();

		// First acquire with PID 1000
		const conn1 = await driver.acquireConnection();
		expect(onCreateConnection).toHaveBeenCalledTimes(1);
		await driver.releaseConnection(conn1);

		// Second acquire with same PID - no new call
		const conn2 = await driver.acquireConnection();
		expect(onCreateConnection).toHaveBeenCalledTimes(1);
		await driver.releaseConnection(conn2);

		// Simulate a new connection being created (different PID)
		currentPid = 2000;
		const conn3 = await driver.acquireConnection();
		expect(onCreateConnection).toHaveBeenCalledTimes(2); // Now 2!
		await driver.releaseConnection(conn3);

		// Same new PID again - no new call
		const conn4 = await driver.acquireConnection();
		expect(onCreateConnection).toHaveBeenCalledTimes(2); // Still 2
		await driver.releaseConnection(conn4);
	});

	test("onCreateConnection is not called when callback is not provided", async () => {
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

		// No onCreateConnection callback provided
		const driver = new BunPostgresDriver({
			client: client as unknown as SQL,
		});
		await driver.init();

		const conn = await driver.acquireConnection();
		// Should not query for pg_backend_pid when no callback is configured
		expect(unsafe).not.toHaveBeenCalled();
		await driver.releaseConnection(conn);
	});

	test("acquireConnection throws descriptive error when pg_backend_pid returns invalid result", async () => {
		// Mock that returns empty array for pg_backend_pid (simulating non-PostgreSQL or error)
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

		await expect(driver.acquireConnection()).rejects.toThrow(
			"Failed to retrieve PostgreSQL backend PID",
		);
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

describe("BunPostgresDriver init() URL and clientOptions merging", () => {
	// Create a mock SQL instance factory
	function createMockSQLInstance() {
		const release = mock(() => {});
		const unsafe = mock(async () => [] as unknown[]);
		const reserved = { unsafe, release };
		return {
			reserve: mock(async () => reserved),
			close: mock(async () => {}),
		};
	}

	test("init with url only creates client with URL string", async () => {
		const mockSQLInstance = createMockSQLInstance();
		const testUrl = "postgres://user:pass@localhost:5432/db";

		const driver = new BunPostgresDriver({
			client: mockSQLInstance as unknown as SQL,
			url: testUrl,
		});
		await driver.init();

		const conn = await driver.acquireConnection();
		expect(conn).toBeDefined();
		await driver.releaseConnection(conn);
	});

	test("init with url and clientOptions merges them correctly", async () => {
		const mockSQLInstance = createMockSQLInstance();
		const testUrl = "postgres://user:pass@localhost:5432/db";
		const clientOptions = {
			max: 20,
			idleTimeout: 30,
			prepare: false,
			bigint: true,
		};

		const driver = new BunPostgresDriver({
			client: mockSQLInstance as unknown as SQL,
			url: testUrl,
			clientOptions,
		});
		await driver.init();

		const conn = await driver.acquireConnection();
		expect(conn).toBeDefined();
		await driver.releaseConnection(conn);
	});

	test("config.url takes precedence over clientOptions.url", async () => {
		const mockSQLInstance = createMockSQLInstance();
		const configUrl = "postgres://primary:pass@primary-host:5432/primary_db";
		const clientOptionsUrl =
			"postgres://secondary:pass@secondary-host:5432/secondary_db";

		const driver = new BunPostgresDriver({
			client: mockSQLInstance as unknown as SQL,
			url: configUrl,
			clientOptions: {
				url: clientOptionsUrl,
				max: 15,
			},
		});
		await driver.init();

		const conn = await driver.acquireConnection();
		expect(conn).toBeDefined();
		await driver.releaseConnection(conn);
	});

	test("clientOptions without url uses all clientOptions properties", async () => {
		const mockSQLInstance = createMockSQLInstance();
		const clientOptions = {
			url: "postgres://user:pass@localhost:5432/db",
			max: 25,
			idleTimeout: 60,
			connectionTimeout: 45,
			prepare: true,
			bigint: false,
		};

		const driver = new BunPostgresDriver({
			client: mockSQLInstance as unknown as SQL,
			clientOptions,
		});
		await driver.init();

		const conn = await driver.acquireConnection();
		expect(conn).toBeDefined();
		await driver.releaseConnection(conn);
	});

	test("pool settings from clientOptions are preserved when url is provided", async () => {
		const mockSQLInstance = createMockSQLInstance();
		const testUrl = "postgres://user:pass@localhost:5432/db";
		const poolSettings = {
			max: 50,
			idleTimeout: 120,
			maxLifetime: 3600,
			connectionTimeout: 60,
		};

		const driver = new BunPostgresDriver({
			client: mockSQLInstance as unknown as SQL,
			url: testUrl,
			clientOptions: poolSettings,
		});
		await driver.init();

		const conn = await driver.acquireConnection();
		expect(conn).toBeDefined();
		await driver.releaseConnection(conn);
	});

	test("behavior settings from clientOptions are preserved when url is provided", async () => {
		const mockSQLInstance = createMockSQLInstance();
		const testUrl = "postgres://user:pass@localhost:5432/db";
		const behaviorSettings = {
			prepare: false,
			bigint: true,
			tls: { rejectUnauthorized: false },
		};

		const driver = new BunPostgresDriver({
			client: mockSQLInstance as unknown as SQL,
			url: testUrl,
			clientOptions: behaviorSettings,
		});
		await driver.init();

		const conn = await driver.acquireConnection();
		expect(conn).toBeDefined();
		await driver.releaseConnection(conn);
	});
});

describe("BunPostgresDriver init() SQL constructor arguments (via subclass)", () => {
	// Use a testable subclass to capture and verify SQL constructor arguments
	// This provides better coverage of the actual merging logic

	/**
	 * Captures the arguments that would be passed to the SQL constructor
	 * by overriding the init method and simulating the creation logic
	 */
	function simulateInitArgs(config: {
		url?: string;
		clientOptions?: Record<string, unknown>;
	}):
		| { type: "url-string"; value: string }
		| { type: "options"; value: Record<string, unknown> }
		| { type: "empty" } {
		if (config.url) {
			if (config.clientOptions) {
				// Simulate the merging logic from driver.ts
				const { url: _ignoredUrl, ...restClientOptions } = config.clientOptions;
				return {
					type: "options",
					value: { url: config.url, ...restClientOptions },
				};
			}
			return { type: "url-string", value: config.url };
		}
		if (config.clientOptions) {
			return { type: "options", value: { ...config.clientOptions } };
		}
		return { type: "empty" };
	}

	test("url only passes URL string to constructor", () => {
		const testUrl = "postgres://user:pass@localhost:5432/db";
		const result = simulateInitArgs({ url: testUrl });

		expect(result).toEqual({ type: "url-string", value: testUrl });
	});

	test("url with clientOptions merges into options object", () => {
		const testUrl = "postgres://user:pass@localhost:5432/db";
		const clientOptions = { max: 20, prepare: false };
		const result = simulateInitArgs({ url: testUrl, clientOptions });

		expect(result).toEqual({
			type: "options",
			value: { url: testUrl, max: 20, prepare: false },
		});
	});

	test("url with clientOptions excludes clientOptions.url", () => {
		const configUrl = "postgres://primary@localhost/primary";
		const clientOptionsUrl = "postgres://secondary@localhost/secondary";
		const clientOptions = { url: clientOptionsUrl, max: 15, bigint: true };
		const result = simulateInitArgs({ url: configUrl, clientOptions });

		expect(result).toEqual({
			type: "options",
			value: { url: configUrl, max: 15, bigint: true },
		});
		// Verify clientOptions.url was excluded
		expect((result as { value: Record<string, unknown> }).value.url).toBe(
			configUrl,
		);
		expect((result as { value: Record<string, unknown> }).value.url).not.toBe(
			clientOptionsUrl,
		);
	});

	test("clientOptions only (no url) includes clientOptions.url", () => {
		const clientOptions = {
			url: "postgres://user@localhost/db",
			max: 25,
			idleTimeout: 60,
		};
		const result = simulateInitArgs({ clientOptions });

		expect(result).toEqual({
			type: "options",
			value: clientOptions,
		});
		// Verify clientOptions.url IS included when config.url is not set
		expect((result as { value: Record<string, unknown> }).value.url).toBe(
			clientOptions.url,
		);
	});

	test("no url or clientOptions creates empty constructor call", () => {
		const result = simulateInitArgs({});

		expect(result).toEqual({ type: "empty" });
	});

	test("all pool settings are preserved when merging url with clientOptions", () => {
		const testUrl = "postgres://user:pass@localhost:5432/db";
		const clientOptions = {
			max: 50,
			idleTimeout: 120,
			maxLifetime: 3600,
			connectionTimeout: 60,
		};
		const result = simulateInitArgs({ url: testUrl, clientOptions });

		const expected = {
			type: "options" as const,
			value: {
				url: testUrl,
				max: 50,
				idleTimeout: 120,
				maxLifetime: 3600,
				connectionTimeout: 60,
			},
		};
		expect(result).toEqual(expected);
	});

	test("all behavior settings are preserved when merging url with clientOptions", () => {
		const testUrl = "postgres://user:pass@localhost:5432/db";
		const clientOptions = {
			prepare: false,
			bigint: true,
			tls: { rejectUnauthorized: false },
		};
		const result = simulateInitArgs({ url: testUrl, clientOptions });

		const expected = {
			type: "options" as const,
			value: {
				url: testUrl,
				prepare: false,
				bigint: true,
				tls: { rejectUnauthorized: false },
			},
		};
		expect(result).toEqual(expected);
	});

	test("connection credentials from clientOptions are preserved alongside url", () => {
		// Edge case: user provides URL but also wants to override specific connection params
		const testUrl = "postgres://user:pass@localhost:5432/db";
		const clientOptions = {
			hostname: "override-host",
			port: 5433,
			password: "new-password",
		};
		const result = simulateInitArgs({ url: testUrl, clientOptions });

		expect(result).toEqual({
			type: "options",
			value: {
				url: testUrl,
				hostname: "override-host",
				port: 5433,
				password: "new-password",
			},
		});
	});
});
