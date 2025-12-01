import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { type ColumnType, type Generated, Kysely, sql } from "kysely";
import { BunPostgresDialect } from "../../src/dialect.ts";

const hasDb = !!process.env.DATABASE_URL;

describe.if(hasDb)("PostgreSQL Data Types (integration)", () => {
	interface DataTypesTable {
		id: Generated<number>;
		// JSON types
		json_col: unknown;
		jsonb_col: unknown;
		// UUID
		uuid_col: string | null;
		// Arrays
		text_array: string[] | null;
		int_array: number[] | null;
		// Timestamps
		created_at: ColumnType<Date, Date | string | undefined, Date | string>;
		updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
		// Numeric
		decimal_col: string | null; // Kysely returns decimal as string for precision
		// Boolean
		bool_col: boolean | null;
		// Binary
		bytea_col: Buffer | null;
		// Text
		text_col: string | null;
		varchar_col: string | null;
	}

	interface DB {
		datatypes_test: DataTypesTable;
	}

	let db: Kysely<DB>;
	const table = "datatypes_test" as const;

	beforeAll(async () => {
		db = new Kysely<DB>({
			dialect: new BunPostgresDialect({ url: process.env.DATABASE_URL }),
		});

		await db.schema.dropTable(table).ifExists().execute();

		// Create table with various PostgreSQL data types
		await sql`
			CREATE TABLE ${sql.table(table)} (
				id SERIAL PRIMARY KEY,
				json_col JSON,
				jsonb_col JSONB,
				uuid_col UUID,
				text_array TEXT[],
				int_array INTEGER[],
				created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
				updated_at TIMESTAMPTZ,
				decimal_col DECIMAL(10, 2),
				bool_col BOOLEAN,
				bytea_col BYTEA,
				text_col TEXT,
				varchar_col VARCHAR(255)
			)
		`.execute(db);
	});

	beforeEach(async () => {
		await db.deleteFrom(table).execute();
	});

	afterAll(async () => {
		await db.schema.dropTable(table).ifExists().execute();
		await db.destroy();
	});

	// ==================== JSON/JSONB Tests ====================
	// Note: Bun SQL returns JSON/JSONB as strings - need to parse manually

	test("JSON column stores and retrieves objects", async () => {
		const testData = { name: "test", count: 42, nested: { foo: "bar" } };

		await sql`
			INSERT INTO ${sql.table(table)} (json_col)
			VALUES (${JSON.stringify(testData)}::json)
		`.execute(db);

		const result = await db.selectFrom(table).select("json_col").executeTakeFirst();
		// Bun SQL returns JSON as a string - parse to compare
		const parsed =
			typeof result?.json_col === "string"
				? JSON.parse(result.json_col)
				: result?.json_col;
		expect(parsed).toEqual(testData);
	});

	test("JSONB column stores and retrieves objects", async () => {
		const testData = { items: [1, 2, 3], active: true };

		await sql`
			INSERT INTO ${sql.table(table)} (jsonb_col)
			VALUES (${JSON.stringify(testData)}::jsonb)
		`.execute(db);

		const result = await db.selectFrom(table).select("jsonb_col").executeTakeFirst();
		// Bun SQL returns JSONB as a string - parse to compare
		const parsed =
			typeof result?.jsonb_col === "string"
				? JSON.parse(result.jsonb_col)
				: result?.jsonb_col;
		expect(parsed).toEqual(testData);
	});

	test("JSONB column handles arrays", async () => {
		const testArray = [1, "two", { three: 3 }];

		await sql`
			INSERT INTO ${sql.table(table)} (jsonb_col)
			VALUES (${JSON.stringify(testArray)}::jsonb)
		`.execute(db);

		const result = await db.selectFrom(table).select("jsonb_col").executeTakeFirst();
		// Bun SQL returns JSONB as a string - parse to compare
		const parsed =
			typeof result?.jsonb_col === "string"
				? JSON.parse(result.jsonb_col)
				: result?.jsonb_col;
		expect(parsed).toEqual(testArray);
	});

	test("JSONB column handles null", async () => {
		await sql`
			INSERT INTO ${sql.table(table)} (jsonb_col)
			VALUES (NULL)
		`.execute(db);

		const result = await db.selectFrom(table).select("jsonb_col").executeTakeFirst();
		expect(result?.jsonb_col).toBeNull();
	});

	// ==================== UUID Tests ====================

	test("UUID column stores and retrieves UUIDs", async () => {
		const testUuid = "550e8400-e29b-41d4-a716-446655440000";

		await sql`
			INSERT INTO ${sql.table(table)} (uuid_col)
			VALUES (${testUuid}::uuid)
		`.execute(db);

		const result = await db.selectFrom(table).select("uuid_col").executeTakeFirst();
		expect(result?.uuid_col).toBe(testUuid);
	});

	test("UUID column accepts gen_random_uuid()", async () => {
		await sql`
			INSERT INTO ${sql.table(table)} (uuid_col)
			VALUES (gen_random_uuid())
		`.execute(db);

		const result = await db.selectFrom(table).select("uuid_col").executeTakeFirst();
		// Should be a valid UUID format
		expect(result?.uuid_col).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);
	});

	// ==================== Array Tests ====================

	test("TEXT[] column stores and retrieves string arrays", async () => {
		const testArray = ["apple", "banana", "cherry"];

		await sql`
			INSERT INTO ${sql.table(table)} (text_array)
			VALUES (${sql.raw(`ARRAY['apple', 'banana', 'cherry']::TEXT[]`)})
		`.execute(db);

		const result = await db.selectFrom(table).select("text_array").executeTakeFirst();
		expect(result?.text_array).toEqual(testArray);
	});

	test("INTEGER[] column stores and retrieves number arrays", async () => {
		const testArray = [1, 2, 3, 4, 5];

		await sql`
			INSERT INTO ${sql.table(table)} (int_array)
			VALUES (${sql.raw(`ARRAY[1, 2, 3, 4, 5]::INTEGER[]`)})
		`.execute(db);

		const result = await db.selectFrom(table).select("int_array").executeTakeFirst();
		expect(result?.int_array).toEqual(testArray);
	});

	test("Array columns handle empty arrays", async () => {
		await sql`
			INSERT INTO ${sql.table(table)} (text_array, int_array)
			VALUES (ARRAY[]::TEXT[], ARRAY[]::INTEGER[])
		`.execute(db);

		const result = await db
			.selectFrom(table)
			.select(["text_array", "int_array"])
			.executeTakeFirst();
		expect(result?.text_array).toEqual([]);
		expect(result?.int_array).toEqual([]);
	});

	// ==================== Timestamp Tests ====================

	test("TIMESTAMPTZ column stores and retrieves dates", async () => {
		const testDate = new Date("2024-06-15T12:30:00.000Z");

		await sql`
			INSERT INTO ${sql.table(table)} (updated_at)
			VALUES (${testDate.toISOString()}::timestamptz)
		`.execute(db);

		const result = await db.selectFrom(table).select("updated_at").executeTakeFirst();
		expect(result?.updated_at).toBeInstanceOf(Date);
		expect(result?.updated_at?.toISOString()).toBe(testDate.toISOString());
	});

	test("TIMESTAMPTZ column handles timezone correctly", async () => {
		// Insert a date with specific timezone
		await sql`
			INSERT INTO ${sql.table(table)} (updated_at)
			VALUES ('2024-06-15 12:30:00+05:30'::timestamptz)
		`.execute(db);

		const result = await db.selectFrom(table).select("updated_at").executeTakeFirst();
		// The time should be normalized to UTC
		expect(result?.updated_at?.toISOString()).toBe("2024-06-15T07:00:00.000Z");
	});

	test("DEFAULT NOW() works for created_at", async () => {
		const before = new Date();
		await sql`INSERT INTO ${sql.table(table)} (text_col) VALUES ('test')`.execute(db);
		const after = new Date();

		const result = await db.selectFrom(table).select("created_at").executeTakeFirst();
		expect(result?.created_at).toBeInstanceOf(Date);
		expect(result?.created_at?.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
		expect(result?.created_at?.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
	});

	// ==================== Numeric Tests ====================

	test("DECIMAL column maintains precision", async () => {
		const testValue = "12345.67";

		await sql`
			INSERT INTO ${sql.table(table)} (decimal_col)
			VALUES (${testValue}::decimal(10,2))
		`.execute(db);

		const result = await db.selectFrom(table).select("decimal_col").executeTakeFirst();
		// Decimal values are returned as strings to maintain precision
		expect(result?.decimal_col).toBe(testValue);
	});

	test("DECIMAL column handles zero", async () => {
		await sql`
			INSERT INTO ${sql.table(table)} (decimal_col)
			VALUES (0.00)
		`.execute(db);

		const result = await db.selectFrom(table).select("decimal_col").executeTakeFirst();
		expect(result?.decimal_col).toBe("0.00");
	});

	test("DECIMAL column handles negative numbers", async () => {
		const testValue = "-999.99";

		await sql`
			INSERT INTO ${sql.table(table)} (decimal_col)
			VALUES (${testValue}::decimal(10,2))
		`.execute(db);

		const result = await db.selectFrom(table).select("decimal_col").executeTakeFirst();
		expect(result?.decimal_col).toBe(testValue);
	});

	// ==================== Boolean Tests ====================

	test("BOOLEAN column stores true", async () => {
		await sql`
			INSERT INTO ${sql.table(table)} (bool_col)
			VALUES (true)
		`.execute(db);

		const result = await db.selectFrom(table).select("bool_col").executeTakeFirst();
		expect(result?.bool_col).toBe(true);
	});

	test("BOOLEAN column stores false", async () => {
		await sql`
			INSERT INTO ${sql.table(table)} (bool_col)
			VALUES (false)
		`.execute(db);

		const result = await db.selectFrom(table).select("bool_col").executeTakeFirst();
		expect(result?.bool_col).toBe(false);
	});

	test("BOOLEAN column handles NULL", async () => {
		await sql`
			INSERT INTO ${sql.table(table)} (bool_col)
			VALUES (NULL)
		`.execute(db);

		const result = await db.selectFrom(table).select("bool_col").executeTakeFirst();
		expect(result?.bool_col).toBeNull();
	});

	// ==================== Text Tests ====================

	test("TEXT column stores long strings", async () => {
		const longText = "a".repeat(10000);

		await db
			.insertInto(table)
			// biome-ignore lint/suspicious/noExplicitAny: DB type doesn't include all columns
			.values({ text_col: longText } as any)
			.execute();

		const result = await db.selectFrom(table).select("text_col").executeTakeFirst();
		expect(result?.text_col).toBe(longText);
		expect(result?.text_col?.length).toBe(10000);
	});

	test("VARCHAR column stores strings up to limit", async () => {
		const testString = "Hello, World!";

		await db
			.insertInto(table)
			// biome-ignore lint/suspicious/noExplicitAny: DB type doesn't include all columns
			.values({ varchar_col: testString } as any)
			.execute();

		const result = await db.selectFrom(table).select("varchar_col").executeTakeFirst();
		expect(result?.varchar_col).toBe(testString);
	});

	test("TEXT column handles special characters", async () => {
		const specialChars = "Hello 世界 🌍 <script>alert('xss')</script> \"quotes\" 'apostrophe'";

		await db
			.insertInto(table)
			// biome-ignore lint/suspicious/noExplicitAny: DB type doesn't include all columns
			.values({ text_col: specialChars } as any)
			.execute();

		const result = await db.selectFrom(table).select("text_col").executeTakeFirst();
		expect(result?.text_col).toBe(specialChars);
	});

	test("TEXT column handles newlines and tabs", async () => {
		const multilineText = "Line 1\nLine 2\tTabbed\rCarriage return";

		await db
			.insertInto(table)
			// biome-ignore lint/suspicious/noExplicitAny: DB type doesn't include all columns
			.values({ text_col: multilineText } as any)
			.execute();

		const result = await db.selectFrom(table).select("text_col").executeTakeFirst();
		expect(result?.text_col).toBe(multilineText);
	});

	// ==================== NULL Handling Tests ====================

	test("NULL values are handled correctly across all types", async () => {
		await sql`
			INSERT INTO ${sql.table(table)}
				(json_col, jsonb_col, uuid_col, text_array, int_array, decimal_col, bool_col, text_col)
			VALUES
				(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)
		`.execute(db);

		const result = await db
			.selectFrom(table)
			.select([
				"json_col",
				"jsonb_col",
				"uuid_col",
				"text_array",
				"int_array",
				"decimal_col",
				"bool_col",
				"text_col",
			])
			.executeTakeFirst();

		expect(result?.json_col).toBeNull();
		expect(result?.jsonb_col).toBeNull();
		expect(result?.uuid_col).toBeNull();
		expect(result?.text_array).toBeNull();
		expect(result?.int_array).toBeNull();
		expect(result?.decimal_col).toBeNull();
		expect(result?.bool_col).toBeNull();
		expect(result?.text_col).toBeNull();
	});

	// ==================== Binary Data Tests ====================

	test("BYTEA column stores and retrieves binary data", async () => {
		const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);

		await sql`
			INSERT INTO ${sql.table(table)} (bytea_col)
			VALUES (${sql.raw(`'\\x${binaryData.toString("hex")}'::bytea`)})
		`.execute(db);

		const result = await db.selectFrom(table).select("bytea_col").executeTakeFirst();
		expect(Buffer.isBuffer(result?.bytea_col)).toBe(true);
		expect(result?.bytea_col?.toString("hex")).toBe(binaryData.toString("hex"));
	});
});


