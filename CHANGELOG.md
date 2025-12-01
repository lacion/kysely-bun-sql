# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2024-12-01

### Added

- Transaction isolation level and access mode support via `beginTransaction(connection, settings)`
- `numAffectedRows` is now returned in `QueryResult` for INSERT, UPDATE, DELETE, and MERGE operations

### Fixed

- `onCreateConnection` callback is now correctly called only once per new connection, not on every `acquireConnection()` call
- URL and `clientOptions` are now properly merged when both are provided
- README version requirement updated to match package.json (`Bun >= 1.3.0`)

### Changed

- **Breaking**: `beginTransaction(connection, settings)` now requires a `TransactionSettings` parameter (pass `{}` for default behavior)

## [0.1.0] - Initial Release

### Added

- Initial Kysely dialect/driver for PostgreSQL using Bun's native SQL client
- Connection pooling via `reserve()`/`release()`
- Transaction support (begin, commit, rollback)
- Streaming query support (row-by-row fallback)
- `onCreateConnection` callback hook
- `clientOptions` for Bun SQL configuration (pool size, timeouts, TLS, etc.)
- `closeOptions` for graceful shutdown
