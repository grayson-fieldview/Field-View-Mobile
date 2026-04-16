# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

### artifacts/mobile — Field View (Expo React Native)

Field construction app. Burst-mode camera + GPS, projects/tasks/checklists, client sharing.

**Auth**: Session cookies against the live Field View web backend. Base URL is configured via `EXPO_PUBLIC_API_BASE_URL` in `artifacts/mobile/.env` (currently `https://code-genius-graysongladu.replit.app`).

Endpoint contract (confirmed empirically against the live backend):
- `POST /api/register` — signup. Body: `{email, password, firstName, lastName}`. Password must be 8+ chars.
- `POST /api/login` — login. Body: `{email, password}`. Returns 401 JSON on bad creds, sets session cookie on success.
- `POST /api/logout` — logout. Returns `{"message":"Logged out"}`.
- `GET  /api/auth/user` — current user. Returns 401 JSON when unauth, user JSON when auth.
- Note the mixed prefix: login/register/logout live at `/api/*`; identity lives at `/api/auth/user`.

**Cookie jar**: On native, `services/api.ts` parses `Set-Cookie` from responses and persists it in `expo-secure-store` (Keychain/Keystore), then attaches it as a `Cookie` header on every subsequent request. On web, relies on `credentials: "include"` and the browser cookie jar.

**CORS caveat**: Web preview (Expo web running at `*.replit.dev`) cannot authenticate because the backend doesn't allowlist that origin for credentialed requests. This only affects the web preview — native iOS/Android builds are not subject to browser CORS and work normally. If the user wants web testing to work, the backend must add the Expo preview origin to its CORS allowlist with `Access-Control-Allow-Credentials: true`.

**Dev error overlay**: `components/ErrorFallback.tsx` shows the real error name + message inline (monospace red) when `__DEV__` is true, with a top-right alert icon that opens the full stack trace in a modal. Production build shows only the generic "Something went wrong" message.
