# Vault API

A REST API for accessing Steam games data, including search, details, and assets. Built with Express.js, using Steam Web API and SteamGridDB.

## Setup

1. Install dependencies: `pnpm install`
2. Create `.env` file with:
   - `PORT` (optional, default 3000)
   - `STEAMGRIDDB_API_KEY` (required for logos/heroes endpoints, get from https://www.steamgriddb.com/)
3. Start server: `pnpm start`

The API fetches Steam app list on startup and caches it locally. Updates daily.

## Endpoints

### GET /

Returns a simple HTML landing page.

**Response:** HTML page

### GET /games/search

Search games using fuzzy matching. Supports partial matches, abbreviations, and multi-word queries.

**Query Parameters:**
- `q` (string, required): Search query (min 3 chars)
- `page` (integer, optional): Page number (default 1, min 1)
- `perPage` (integer, optional): Items per page (default 16, max 100)

**Response (200):**
```json
{
  "total": 123,
  "page": 1,
  "perPage": 16,
  "games": [
    {
      "appid": 570,
      "name": "Dota 2",
      "relevanceScore": 95000
    }
  ]
}
```

**Error Responses:**
- 400: Missing or invalid query
- 503: App list not ready

### GET /games

List all Steam games with pagination.

**Query Parameters:**
- `page` (integer, optional): Page number (default 1, min 1)
- `perPage` (integer, optional): Items per page (default 16, max 100)

**Response (200):**
```json
{
  "total": 12345,
  "page": 1,
  "perPage": 16,
  "games": [
    {
      "appid": 570,
      "name": "Dota 2"
    }
  ]
}
```

**Error Responses:**
- 503: App list not ready

### GET /games/hot

Get currently featured/hot games from Steam specials.

**Response (200):** Array of detailed game objects (up to 46 items)

**Error Responses:**
- 500: Failed to fetch data

### GET /games/top

Get top selling games from Steam.

**Response (200):** Array of detailed game objects (up to 40 items)

**Error Responses:**
- 500: Failed to fetch data

### GET /games/:appid

Get detailed information for a specific game.

**Path Parameters:**
- `appid` (integer, required): Steam App ID

**Response (200):** Full game details object from Steam API

**Error Responses:**
- 404: Game not found
- 500: Failed to fetch data

### GET /games/:appid/logos

Get logo assets for a game from SteamGridDB.

**Path Parameters:**
- `appid` (integer, required): Steam App ID

**Response (200):**
```json
{
  "logos": [
    {
      "id": 123,
      "url": "https://...",
      "thumb": "https://...",
      "style": "official"
    }
  ]
}
```

**Error Responses:**
- 400: Invalid appid
- 500: Failed to fetch data

### GET /games/:appid/heroes

Get hero/banner images for a game from SteamGridDB.

**Path Parameters:**
- `appid` (integer, required): Steam App ID

**Response (200):**
```json
{
  "heroes": [
    {
      "id": 456,
      "url": "https://...",
      "thumb": "https://...",
      "style": "official"
    }
  ]
}
```

**Error Responses:**
- 400: Invalid appid
- 500: Failed to fetch data

## Data Structures

### Basic Game Object
```json
{
  "appid": 570,
  "name": "Dota 2"
}
```

### Detailed Game Object
Full Steam app details including price, screenshots, etc. (varies by game).

### Asset Object (Logos/Heroes)
```json
{
  "id": 123,
  "url": "https://cdn.steamgriddb.com/file/...",
  "thumb": "https://cdn.steamgriddb.com/thumb/...",
  "style": "official",
  "score": 95
}
```

## Caching

- App list: Cached locally in `app_list.json`, refreshed daily
- Search results: Cached for 5 minutes
- Game details: Cached for 5 hours
- Assets: Cached for 24 hours
- Featured categories: Cached for 5 hours

## Search Algorithm

Uses Fuse.js with custom scoring:
- Exact matches: Highest priority
- Starts with query: High priority
- Contains query: Medium priority
- Fuzzy matches: Lower priority
- Penalizes long names, boosts short names

## Examples

Search for "dota":
```
GET /games/search?q=dota
```

Get page 2 of all games:
```
GET /games?page=2&perPage=50
```

Get Dota 2 details:
```
GET /games/570
```

Get Dota 2 logos:
```
GET /games/570/logos
```

## Notes

- All endpoints support CORS
- Data sourced from Steam Web API and SteamGridDB
- Search requires app list to be loaded (may take time on first run)
- Asset endpoints require SteamGridDB API key