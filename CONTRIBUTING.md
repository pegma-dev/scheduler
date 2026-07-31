# Contributing to Scheduler

Scheduler requires Node.js 22 or newer.

```sh
npm ci
npm run format:check
npm run check
npm test
```

Keep changes bounded and include tests for concurrency, crash recovery, stale
claims, malformed stored state, and cursor behavior when applicable. A new
runtime adapter needs two real consumers or one consumer plus a green public
composition fixture. Do not add provider SDKs to the core package.

Security concerns should use GitHub private vulnerability reporting rather
than a public issue.
