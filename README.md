# NoSQL Simulator AI

This project now includes:

- A Vite + React frontend simulator
- A local Express backend in [`server/index.js`](/c:/Users/saira/OneDrive/Documents/snist%20projects/nosql-sim-ai/server/index.js)
- A Supabase PostgreSQL schema in [`supabase/schema.sql`](/c:/Users/saira/OneDrive/Documents/snist%20projects/nosql-sim-ai/supabase/schema.sql)

## Local Setup

Prerequisites:

- Node.js 18+
- A Supabase project

1. Install dependencies:
   `npm install`
2. Copy `.env.example` to `.env.local`
3. Fill in:
   `GEMINI_API_KEY`
   `SUPABASE_URL`
   `SUPABASE_KEY`
4. Run frontend + backend locally:
   `npm run dev`

## Supabase Setup

Create a Supabase project, then run the SQL from [`supabase/schema.sql`](/c:/Users/saira/OneDrive/Documents/snist%20projects/nosql-sim-ai/supabase/schema.sql) in the SQL editor.

Required environment variables:

- `SUPABASE_URL`
- `SUPABASE_KEY`

You can use the anon key for simple demos. For production, review your RLS and key choice carefully.

## Backend API

The backend is implemented as a local Express server. The frontend talks to it through Vite's `/api` proxy during development.

- [`server/index.js`](/c:/Users/saira/OneDrive/Documents/snist%20projects/nosql-sim-ai/server/index.js)
- [`server/_supabase.js`](/c:/Users/saira/OneDrive/Documents/snist%20projects/nosql-sim-ai/server/_supabase.js)
- [`server/_utils.js`](/c:/Users/saira/OneDrive/Documents/snist%20projects/nosql-sim-ai/server/_utils.js)

### `POST /api/createNode`

```json
{
  "node_id": "N1",
  "capacity": 100,
  "speed": "fast"
}
```

### `POST /api/insertData`

```json
{
  "key": "user123",
  "value": "{\"name\":\"Alice\"}",
  "size": 10
}
```

### `GET /api/readData?key=user123`

Returns the stored value plus its replica placement.

### `POST /api/updateData`

```json
{
  "key": "user123",
  "value": "{\"name\":\"Alice Updated\"}",
  "size": 12
}
```

### `POST /api/deleteData`

```json
{
  "key": "user123"
}
```

### `GET /api/getState`

Returns all `nodes`, `shards`, and `replicas`.

### `POST /api/simulateFailure`

```json
{
  "node_id": "N1"
}
```

### `POST /api/resetNode`

```json
{
  "node_id": "N1"
}
```

## Running Locally

- Frontend: Vite on `http://localhost:3000`
- Backend: Express on `http://localhost:4000`
- API from the frontend uses `/api/*` and is proxied to the backend automatically

Useful scripts:

- `npm run dev` to start both frontend and backend
- `npm run dev:client` to start only the frontend
- `npm run dev:server` to start only the backend
- `npm run build` to build the frontend
- `npm run start` to run the backend only

## Notes

- `insertData` uses a simple hash-based node selection to keep the backend minimal and viva-ready.
- The current frontend simulator still runs on in-memory state, and the backend panel shows the real Supabase-backed state alongside it.
- The database now stores actual item payloads in `data_items` along with shard and replica metadata.
