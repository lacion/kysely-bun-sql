### Contributing to trpc-bun

Thanks for your interest in contributing! Please follow these guidelines:

1) Setup
- Install Bun ≥ 1.3.0
- bun install

2) Validate before pushing
```bash
bun run lint
bun run typecheck
bun test
```

3) Commit scope
- Keep PRs focused and small
- Add/extend tests for behavior changes
- Match existing code style (tab indentation)

4) Filing issues
- Include Bun version, OS, package version
- Provide minimal reproduction when possible

5) Release process (maintainers)
- Ensure tests pass on main
- Update CHANGELOG.md (if present) and bump version
- Publish to npm

We appreciate your time and help!
