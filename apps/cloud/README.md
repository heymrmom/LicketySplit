# LicketySplit Cloud API

Cloudflare Worker API for LicketySplit template storage and sharing. The
tracked configuration still names upstream Cloudflare resources; this checkout
does not establish a separately deployed or redirected LicketySplit service.

## Features

- **Template Storage**: Upload and store templates in Cloudflare R2
- **Template Listing**: Browse all available templates
- **Template Download**: Download individual templates
- **Template Deletion**: Delete custom templates (built-ins protected)

## Setup

### 1. Existing Upstream R2 Configuration

The tracked Worker configuration refers to the upstream bucket
`openreel-templates`. The command below is a historical configuration example;
do not run it for a new LicketySplit account without an owner-approved resource
mapping.

```bash
cd apps/cloud
npx wrangler r2 bucket create openreel-templates
```

### 2. Deploy Worker

This command targets the Worker and route named by the existing upstream
configuration below. Treat it as an upstream maintenance instruction; a new
LicketySplit deployment needs an approved resource mapping first.

```bash
npm run deploy
```

The tracked configuration names the Worker `openreel-cloud` and routes
`https://api.openreel.video` to it. These are upstream deployment targets; this
documentation makes no claim about their live state and establishes no new
worker or redirect.

## API Endpoints

### GET `/`
Get API information and available endpoints.

**Response:**
```json
{
  "name": "LicketySplit Cloud API",
  "version": "1.0.0",
  "endpoints": {
    "templates": {
      "list": "GET /templates",
      "get": "GET /templates/:id",
      "upload": "POST /templates",
      "delete": "DELETE /templates/:id"
    }
  }
}
```

### GET `/templates`
List all templates.

**Query Parameters:**
- `cursor` (optional): Pagination cursor

**Response:**
```json
{
  "templates": [
    {
      "id": "template-123",
      "name": "My Template",
      "category": "youtube",
      "description": "A cool template",
      "thumbnailUrl": null,
      "placeholderCount": 2,
      "duration": 30,
      "createdAt": 1234567890,
      "tags": ["intro", "animated"],
      "author": "username"
    }
  ],
  "cursor": "next-page-token",
  "truncated": false
}
```

### GET `/templates/:id`
Get a specific template by ID.

**Response:**
```json
{
  "id": "template-123",
  "name": "My Template",
  "description": "A cool template",
  "category": "youtube",
  "settings": {
    "width": 1920,
    "height": 1080,
    "frameRate": 30
  },
  "timeline": {
    "tracks": [...],
    "graphics": {...}
  },
  "placeholders": [...]
}
```

### POST `/templates`
Upload a new template.

**Request Body:**
```json
{
  "id": "template-123",
  "name": "My Template",
  "description": "Description",
  "category": "youtube",
  "timeline": {...},
  "placeholders": [...],
  "tags": ["intro"],
  "author": "username"
}
```

**Response:**
```json
{
  "success": true,
  "id": "template-123",
  "message": "Template uploaded successfully"
}
```

### DELETE `/templates/:id`
Delete a template.

**Response:**
```json
{
  "success": true,
  "message": "Template deleted successfully"
}
```

### GET `/health`
Health check endpoint.

**Response:**
```json
{
  "status": "healthy",
  "timestamp": 1234567890
}
```

## R2 Configuration

The worker uses Cloudflare R2 for storage with the following configuration:

- **Existing upstream bucket**: `openreel-templates`
- **Binding**: `TEMPLATES_BUCKET`
- **Access**: Via Cloudflare Workers R2 API (no direct S3 access needed)

## CORS

The tracked CORS allowlist contains these existing upstream origins:
- `http://localhost:5173` (local development)
- `https://app.openreel.video`
- `https://*.openreel-3pq.pages.dev`

## Local Development

```bash
npm run dev
```

The worker will be available at `http://localhost:8787`

## Environment Variables

Set in `wrangler.jsonc`:
- `ENVIRONMENT`: `production` or `development`

## Security Notes

- Built-in templates (IDs starting with `builtin-`) cannot be deleted
- Template IDs must be unique
- All uploads are validated for required fields (id, name, timeline)
- CORS is restricted to the origins listed in the existing deployment allowlist
