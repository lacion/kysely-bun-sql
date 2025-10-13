### kysely-bun-sql — Kysely Postgres dialect powered by Bun SQL

[![CI](https://github.com/obsurvive/kysely-bun-sql/actions/workflows/ci.yml/badge.svg)](https://github.com/obsurvive/kysely-bun-sql/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/kysely-bun-sql.svg)](https://www.npmjs.com/package/kysely-bun-sql)
![bun](https://img.shields.io/badge/Bun-%3E%3D1.1.31-black?logo=bun)
![Kysely](https://img.shields.io/badge/Kysely-%3E%3D0.28-2596be)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)

- **What**: A tiny, dependency-free Kysely dialect/driver for PostgreSQL backed by Bun's native `SQL` client.
- **Why**: Use Kysely with Bun without Node shims or third‑party drivers.
- **How**: Uses Bun's pooled `SQL` client under the hood (`reserve()`/`release()`), Kysely's Postgres adapter and query compiler.

---

### Table of Contents
- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Quickstart](#quickstart)
- [Usage](#usage)
  - [Configuration options](#configuration-options)
  - [Using an existing Bun SQL client](#using-an-existing-bun-sql-client)
  - [Transactions](#transactions)
  - [Raw SQL with Kysely `sql`](#raw-sql-with-kysely-sql)
  - [Connection pooling & shutdown](#connection-pooling--shutdown)
- [API](#api)
- [Testing](#testing)
- [Repository overview](#repository-overview)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgments](#acknowledgments)
- [Contact](#contact)

### Features
- Bun‑native PostgreSQL via `new SQL()` or environment auto‑detection
- Connection pooling, prepared statements, parameter binding via Bun SQL
- Full Kysely integration: Postgres adapter, query compiler, introspector
- Transactions and savepoints through Kysely
- Tiny surface area: no runtime deps, ESM only

### Requirements
- Bun ≥ 1.1.31
- Kysely ≥ 0.28
- TypeScript ≥ 5

### Install

```bash
# with bun
bun add kysely-bun-sql kysely

# (optional) tooling
bun add -d @biomejs/biome

# with npm
yarn add kysely-bun-sql kysely
# or
npm install kysely-bun-sql kysely
```

Peer deps: `kysely`, `typescript` (TS used for types only).

### Quickstart

```ts
import { Kysely, type Generated } from "kysely";
import { BunPostgresDialect } from "kysely-bun-sql";

interface User {
	id: Generated<number>;
	name: string;
}

interface DB { users: User }

const db = new Kysely<DB>({
	dialect: new BunPostgresDialect({ url: process.env.DATABASE_URL }),
});

await db.schema
	.createTable("users")
	.ifNotExists()
	.addColumn("id", "serial", (c) => c.primaryKey())
	.addColumn("name", "varchar", (c) => c.notNull())
	.execute();

await db.insertInto("users").values({ name: "Alice" }).execute();
const users = await db.selectFrom("users").selectAll().execute();

await db.destroy();
```

### Usage

#### Configuration options

```ts
import type { BunPostgresDialectConfig } from "kysely-bun-sql";

const config: BunPostgresDialectConfig = {
	// Provide a URL OR an existing SQL client
	url: process.env.DATABASE_URL,
	// client?: new SQL(urlOrOpts)

	// Called once per reserved connection
	onCreateConnection: async (conn) => {
		// e.g. set app_name, or run per-connection SETs
		await conn.executeQuery({ sql: "select 1", parameters: [] } as any);
	},

	// Optional: tune Bun SQL client when we create it for you
	clientOptions: {
		max: 20,
		idleTimeout: 30,
		maxLifetime: 0,
		connectionTimeout: 10,
		prepare: true,
		bigint: false,
		// tls: true | { ...advanced }
	},

	// Optional: close timeout when shutting down the pool
	closeOptions: { timeout: 5 },
};
```

#### Using an existing Bun SQL client

```ts
import { SQL } from "bun";
import { Kysely } from "kysely";
import { BunPostgresDialect } from "kysely-bun-sql";

const client = new SQL(process.env.DATABASE_URL);
const db = new Kysely({ dialect: new BunPostgresDialect({ client }) });
```

#### Transactions

```ts
await db.transaction().execute(async (trx) => {
	await trx.insertInto("users").values({ name: "Charlie" }).execute();
});

try {
	await db.transaction().execute(async (trx) => {
		await trx.insertInto("users").values({ name: "Dave" }).execute();
		throw new Error("force rollback");
	});
} catch {}
```

#### Raw SQL with Kysely `sql`

```ts
import { sql } from "kysely";

const res = await sql`select ${1}::int as one`.execute(db);
const [{ one }] = res.rows as Array<{ one: number }>;
```

#### Connection pooling & shutdown

- This dialect reserves a pooled connection per Kysely connection using `client.reserve()` and releases it on `db.releaseConnection()`.
- Call `await db.destroy()` when finished to close the pool via `client.close()`.

### API

- **`class BunPostgresDialect`**
  - `constructor(config?: BunPostgresDialectConfig)`
  - Implements Kysely's `Dialect` interface for Postgres
- **`interface BunPostgresDialectConfig`**
  - `client?: SQL` — existing Bun SQL client to use
  - `url?: string` — Postgres connection URL; used when `client` is not provided
  - `onCreateConnection?: (connection: DatabaseConnection) => Promise<void>`

Notes:
- Query execution uses Bun SQL's `unsafe(sql, params)` with Kysely's compiled `$1`‑style bindings.
- Streams currently yield rows one by one based on the full result; Bun SQL streaming cursors may be supported in the future.

### Testing

Uses Bun's built‑in test runner.

```bash
# unit tests only
bun test test/*.unit.test.ts

# run full suite (integration tests require DATABASE_URL)
DATABASE_URL=postgres://user:pass@localhost:5432/db bun test

# or with Docker Compose (recommended)
docker compose up -d postgres
DATABASE_URL=postgres://postgres:postgres@localhost:5432/testdb bun test
```

Integration tests are skipped automatically when `DATABASE_URL` is not set.

### Repository overview
```
.
├─ src/
│  ├─ config.ts      # BunPostgresDialectConfig
│  ├─ dialect.ts     # Kysely Dialect implementation (Postgres)
│  └─ driver.ts      # Driver backed by Bun SQL (reserve/release)
└─ test/
   ├─ bun-postgres-dialect.unit.test.ts
   ├─ bun-postgres-driver.unit.test.ts
   └─ integration/postgres.integration.test.ts
```

### Contributing
- Issues and PRs welcome! Please:
  - Run `bun run lint && bun test` before submitting
  - Keep changes small and well‑documented
  - Add/extend tests when changing behavior

Local dev scripts:
```bash
bun run lint
bun run format
bun test
```

### License
MIT — see the `license` field in `package.json`.

### Acknowledgments
- Kysely for a great type‑safe SQL builder
- Bun team for fast native SQL and a great runtime

### Contact
- Author: Luis — `luismmorales@gmail.com`
- GitHub: [`lacion`](https://github.com/lacion)
