# Verification record

This file records what was actually run against the code, and what was not. It is the only
place that claims verification. Anything not listed here has not been verified.

## Environment for this record

The build sandbox had no network access and no npm registry, so `pnpm install` could not run. The
checks below used the offline TypeScript 6.0, Zod 3.25 (whose `zod/v4` entry point is the Zod 4
API used by the code), esbuild 0.28 and Node 22. Drizzle, Next.js, React types, Better Auth, Vitest
and the Lucide package were not available.

## Results

| Check | Scope | Result |
|---|---|---|
| Type check (strict, `noUncheckedIndexedAccess`) | Pure modules, schemas, DB schema, all unit tests | Passes. Drizzle's `pg-core` and Vitest were replaced by typed stand-ins (see below). |
| Unit tests | 23 files, 123 tests (format, milestones, sign-off, payments, invitations, milestone flow, change-request replies, outbox and retries, notifications, events, file rules and uploads, file removal and the abandoned-upload sweep, cron authorisation, SigV4 signing, studio access, proposal builder, email templates) | All 95 pass. Run through a Vitest stand-in; see below. |
| Import resolution | 123 files: local paths, `@/` aliases, declared packages | 0 problems |
| Named and default imports | 440 local imports | 0 problems |
| Next.js boundary rules | 121 files: "use server" exports, "use client" server-only imports | 0 problems |

## What the stand-ins mean

- **drizzle-orm/pg-core** was replaced by a typed stub. Enum value tuples keep their literal types,
  which is what the code relies on. No query API was exercised, and the schema has never run against Postgres.
- **vitest** was replaced by a small runner that supports `describe`, `it`, and the matchers the tests use
  (`toBe`, `toEqual`, `toMatchObject`, `toContain`, `toHaveLength`, `toBeNull`, `toBeTruthy`, `toMatch`,
  `toThrow`, and `rejects.toThrow`). It runs tests in order, as Vitest does within a file.
  Real Vitest will report the same results or a clearer failure, but this has not been run under it.

## Not verified

- **React components and pages (`.tsx`).** Only their syntax and their imports were checked. No type check
  ran, because `@types/react` and `next` were unavailable.
- **Next.js runtime behaviour.** `redirect`, `notFound`, `headers()`, the `params` promise, `useActionState`, and
  the form-action flow have not run.
- **Better Auth.** Its API and table names are from memory (docs/assumptions.md, item 31).
- **Paystack.** Its endpoints, the webhook signature header, and the response shapes are from memory (item 37 onwards).
- **SigV4 signing.** Checked against AWS's documented presigned-URL example, which matches exactly. Not checked against Cloudflare R2 or MinIO (assumptions, item 87).
- **Object storage.** The S3-compatible adapter, the upload and download flow in the browser, and the CSP change have not been run against a live bucket.
- **Database.** No migration has been generated or applied. No query has run. This includes the production outbox (`server/outbox-drizzle.ts`), which is unverified against drizzle-orm.
- **Browser behaviour.** No end-to-end, visual, or accessibility test has run.
- **Email.** The Resend call and the templates have not been sent.

## Results from the first real install

These are results from a run on a Windows machine with network access, pasted into the conversation. They are the first real checks of this code, and they replace the stand-in results above where the two differ.

| Step | Result | Action taken |
|---|---|---|
| `pnpm check:static` | Passed: 127 files, 459 named imports, 125 boundary files, 0 problems | None |
| `pnpm typecheck` | 8 errors in 4 files: 5 lucide names not exported, 2 typed-route `href` values typed as `string`, 1 seed insert given a string where a Date is required | Fixed. Route targets are typed `Route`. Seed timestamps are `Date`. Five icons replaced (see assumptions, item 97). Not re-run. |
| `pnpm lint` | 6 errors, 2 warnings: CommonJS `require` in the check scripts; an unused variable; an anonymous default export | Fixed. Check scripts are ES modules. Config is named before export. Not re-run. |
| `pnpm format:check` | Passed after `pnpm format` | None |
| `pnpm test` | Passed: 17 files, 99 tests, under Vitest 3.2.7 | None. First real run of the test suite. |
| `pnpm build` | Failed: 15 Turbopack errors, all caused by the five missing lucide exports | Fixed by the same icon change. Not re-run. |

Versions observed in that install: Next.js 16.4.6 (Turbopack), lucide-react 0.383.0, React 19.3.1, Vitest 3.2.7.

Second run: check:static, typecheck, lint, format:check passed. The build compiled, then Next.js type checking failed on three back links built from dynamic paths (projects and proposals). These now go through lib/routes.ts (routeTo). Not yet re-run.

Third run: the build compiled and passed TypeScript, then failed while collecting page data. Cause: lib/env.ts validated the environment when it was first imported, so every route module needed real secrets during `next build`. Fixed: the environment, the database pool and the Better Auth instance are now created on first use, and instrumentation.ts validates at boot. The build should need no secrets. Not yet re-run.

Third run: compile and TypeScript passed. The build then failed while collecting page data, because environment validation rejected a blank CRON_SECRET from .env.example. Fixed: blank values count as unset, and the schema now lives in lib/env-schema.ts so it can be tested (tests/unit/env.test.ts).

Open after this round: the build has not been re-run, so further errors may appear behind the icon failure, most likely in prerendering or in environment checks at build time.

## Tooling added but never run

| Item | File | State |
|---|---|---|
| CI workflow (install, static checks, typecheck, lint, format check, tests, audit, build) | .github/workflows/ci.yml | Parses as YAML. Has never run on GitHub. |
| Dependabot (npm and GitHub Actions, weekly) | .github/dependabot.yml | Parses as YAML. Not active until pushed. |
| Prettier configuration | .prettierrc.json, .prettierignore | Valid JSON. Never applied to the code. |
| Pre-commit hook (lint-staged) | .husky/pre-commit, package.json | Not installed. Needs a git repository. |
| Lockfile | pnpm-lock.yaml | Does not exist yet. CI uses --frozen-lockfile and will fail until it is committed. |

Follow docs/first-run.md. It sets out the order and the failures to expect.

## How to run the real checks

```bash
pnpm install
pnpm check:static      # the three checks above, no dependencies
pnpm typecheck         # the full project, including pages and components
pnpm test              # Vitest, the unit tests
pnpm db:generate       # then review db/migrations before applying
```

## Pages written in the latest batch (not yet run in a browser)

Built this batch: studio clients, payments ledger (owner and admin), team (read-only); client pre-work, milestones, files, change requests, handover, payment history and detail, notifications, account, data export and deletion request; public landing, help, contact, and three legal drafts; error boundaries and a projects loading state. The read models for these are unit-tested (tests/unit/read-models.test.ts, tests/unit/studio-reads.test.ts). The pages themselves have not been type-checked by Next or rendered.

## Batch: design port (log-in, sign-up, landing) and theme

Checks run after this batch: static checks (177 files, 652 imports, 175 boundary files) all pass. The new pure modules (theme, sign-up validation, onboarding) pass the type check and their tests (122 tests across 22 files, under the stand-in runner). Not yet run: the pages in Next, the passkey and Google flows, the migration for the passkey table, and any visual comparison against the designs.

## Batch: email check, expired link, 404, invitation

Static checks pass (181 files, 675 imports, 179 boundary files). The stand-in unit tests pass (123 tests across 23 files), including the new invitation preview test. Not yet run: the pages in Next, the cookie hand-off between sign-in and the email check, and any visual comparison with the designs.

## Batch: proposal review, printable copy, notes

Static checks pass (192 files, 707 imports, 190 boundary files). The stand-in unit tests pass: 127 tests across 24 files, including the new review-data, fingerprint and note tests. The stage labels moved to a plain module, so server code and the tests no longer load UI components. Not yet run: the pages in Next, the note dialog in a browser, the print layout, and any visual comparison against the design's screen.png.
