# @reso-standards/web-client

React-based OData browser UI with server switcher for connecting to external OData servers, metadata explorer, and CRUD interface.

> **[User Guide](doc/GUIDE.md)** – a task-oriented walkthrough with realistic examples.

## Features

- **Resource browser**: Select from Property, Member, Office, Media, OpenHouse, Showing
- **Search with infinite scroll**: OData `$filter` search with automatic pagination
- **Advanced search**: Field-level filters organized by RESO Data Dictionary groups
- **Detail view**: Full record display with fields grouped by category, media carousel
- **Add/Edit/Delete**: Dynamic forms generated from RESO metadata with client-side type validation
- **Media carousel**: Image viewer for expanded Media records (placeholder images for development)
- **Dark mode**: System-preference detection with manual toggle, persisted in URL
- **Responsive**: Mobile-friendly layout with Tailwind CSS

## Tech Stack

- React 19 + TypeScript
- Vite 6 (dev server + build)
- Tailwind CSS v4
- React Router v7 (URL-based state for shareable links)
- Communicates with the reference server OData API at `http://localhost:8080`

## Install

This package isn't on npm yet. Install from the [`reso-tools`](https://github.com/RESOStandards/reso-tools) monorepo on GitHub:

```bash
git clone https://github.com/RESOStandards/reso-tools.git
cd reso-tools/reso-web-client
npm install
```

The `preinstall` hook automatically builds sibling packages this one depends on (`odata-expression-parser`, `reso-client`, `reso-validation`). To bootstrap every package at once, run `npm run bootstrap` from the repo root instead.

## Development

```bash
# Start the dev server (proxy to API at localhost:8080)
npm run dev

# Build for production
npm run build
```

The dev server starts at `http://localhost:5173`. All API requests are proxied to `http://localhost:8080` via the Vite dev server config.

**Prerequisites**: The reference server must be running at port 8080. Start it with:

```bash
cd ../reso-reference-server
docker compose up -d
```

## Configuration

### UI Config (`reso-reference-server/src/ui-config.json`)

Controls which fields appear in the summary results list for each resource.

```json
{
  "resources": {
    "Property": {
      "summaryFields": ["ListingKey", "ListingId", "ListPrice", "BedroomsTotal", ...]
    },
    "Member": { "summaryFields": "__all__" }
  }
}
```

- **Explicit field list**: Array of field names to show in summary cards
- **`"__all__"`**: Show all fields from metadata (used for smaller resources)

Served by the server at `GET /ui-config`.

### Field Groups (`reso-reference-server/src/field-groups.json`)

Maps Property fields to RESO Data Dictionary group categories for organizing detail pages, forms, and advanced search.

```json
{
  "Property": {
    "ListPrice": ["Listing", "Price"],
    "BedroomsTotal": ["Structure"],
    "City": ["Location", "Address"]
  }
}
```

The first element is the primary group (section header), subsequent elements are sub-groups. Non-Property resources have no groups and fields are listed alphabetically.

Served by the server at `GET /field-groups`.

## Routing

All view state is stored in URL query parameters for shareable links and browser history.

| Route | Page | Query Params |
|-------|------|-------------|
| `/:resource` | Search | `$filter`, `$orderby`, `mode`, `theme` |
| `/:resource/:key` | Detail | `theme` |
| `/:resource/add` | Add | `theme` |
| `/:resource/edit` | Edit (key prompt) | `theme` |
| `/:resource/edit/:key` | Edit (form) | `theme` |
| `/:resource/delete` | Delete | `theme` |

## Docker

Two deployment modes are available via Docker Compose profiles.

### Proxy Only (External Servers)

Serves the web UI with a lightweight CORS proxy. No local database – connect to external OData servers using Bearer Token or Client Credentials auth.

```bash
docker compose --profile proxy up -d
# UI + Proxy: http://localhost:8888
```

### Full Stack (Reference Server + UI)

Includes the reference server with PostgreSQL for local test data, plus the web UI served via nginx.

```bash
docker compose --profile full up -d
# UI: http://localhost:5173
# API: http://localhost:8080

# Seed with test data
docker compose --profile full,seed up seed
```

### Without Docker

Run the proxy standalone with Node.js:

```bash
# Build the web client
npm run build

# Start the proxy with the built UI
cd ../reso-web-api-proxy
npm install && npm run build
npm start -- --port 8888 --ui ../reso-web-client/dist
```

## License

See [LICENSE](https://github.com/RESOStandards/reso-tools/blob/main/LICENSE) in the repository root.
