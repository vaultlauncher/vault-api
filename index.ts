import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import Fuse from "fuse.js";
import { auth } from "./src/lib/auth";

const port = Number(process.env.PORT) || 3000;
const APP_LIST_FILE = "app_list.json";

let steamApps: any[] = [];
let fuseInstance: Fuse<any> | null = null;
let appListReady = false;

const cache = new Map<string, { data: any; expiry: number }>();

const STEAM_APP_LIST_URL =
  "https://raw.githubusercontent.com/jsnli/steamappidlist/refs/heads/master/data/games_appid.json";
const STEAM_APP_DETAILS_URL = "https://store.steampowered.com/api/appdetails";
const STEAM_FEATURED_CATEGORIES_URL =
  "https://store.steampowered.com/api/featuredcategories/";
const STEAMGRIDDB_API_KEY = process.env.STEAMGRIDDB_API_KEY;
const STEAMGRIDDB_BASE_URL = "https://www.steamgriddb.com/api/v2";

// Cache utilities
function setCache(key: string, data: any, ttl: number = 18000) {
  cache.set(key, {
    data,
    expiry: Date.now() + ttl * 1000,
  });
}

function getCache(key: string): any | null {
  const cached = cache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiry) {
    cache.delete(key);
    return null;
  }
  return cached.data;
}

function getCacheStats() {
  let hits = 0;
  let misses = 0;
  return { keys: cache.size, hits, misses };
}

function prepareApps(appList: any[]) {
  appList.forEach((g: any) => {
    g.lowerName = g.name.toLowerCase().replace(/[®™©:'".,\-_]/g, "");
    g.searchName = g.name
      .toLowerCase()
      .replace(/[®™©:'".,\-_]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  });
  return appList;
}

function createFuseIndex(apps: any[]) {
  return new Fuse(apps, {
    keys: [
      { name: "name", weight: 2 },
      { name: "searchName", weight: 1 },
    ],
    threshold: 0.25,
    distance: 50,
    ignoreLocation: false,
    location: 0,
    minMatchCharLength: 3,
    includeScore: true,
  });
}

async function initAppList() {
  try {
    try {
      const file = Bun.file(APP_LIST_FILE);
      const data = await file.text();
      steamApps = prepareApps(JSON.parse(data));
      fuseInstance = createFuseIndex(steamApps);
      appListReady = true;
      console.log(`App list loaded from file: ${steamApps.length} games`);
      return;
    } catch {}

    console.log("Fetching Steam app list...");
    const response = await fetch(STEAM_APP_LIST_URL);
    const json = await response.json();
    steamApps = prepareApps(json);
    console.log(`Fetched ${steamApps.length} apps from Steam`);
    fuseInstance = createFuseIndex(steamApps);
    appListReady = true;
    await Bun.write(APP_LIST_FILE, JSON.stringify(steamApps));
    console.log(`App list cached and saved: ${steamApps.length} games`);
  } catch (error) {
    console.error("Failed to fetch app list:", error);
    appListReady = false;
  }
}

initAppList();
setInterval(initAppList, 86400000);

async function getAppList(): Promise<any[]> {
  if (!steamApps?.length) {
    await initAppList();
  }
  return steamApps;
}

async function getCachedOrFetch(key: string, fetchFn: () => Promise<any>) {
  const cached = getCache(key);
  if (cached) return cached;
  const data = await fetchFn();
  setCache(key, data);
  return data;
}

async function fetchAppDetails(appid: number) {
  return getCachedOrFetch(`appDetails_${appid}`, async () => {
    const response = await fetch(
      `${STEAM_APP_DETAILS_URL}?appids=${appid}&l=english`
    );
    const data = await response.json();
    return data[appid];
  });
}

async function fetchSteamGridAssets(
  appid: number,
  assetType: "logos" | "heroes"
) {
  const cacheKey = `${assetType}_${appid}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  if (!STEAMGRIDDB_API_KEY) return [];

  try {
    const searchResp = await fetch(
      `${STEAMGRIDDB_BASE_URL}/games/steam/${appid}`,
      {
        headers: { Authorization: `Bearer ${STEAMGRIDDB_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      }
    );

    const searchData = await searchResp.json();

    if (!searchData.success) {
      setCache(cacheKey, []);
      return [];
    }

    const assetsResp = await fetch(
      `${STEAMGRIDDB_BASE_URL}/${assetType}/game/${searchData.data.id}`,
      {
        headers: { Authorization: `Bearer ${STEAMGRIDDB_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      }
    );

    const assetsData = await assetsResp.json();

    const assets = assetsData.success ? assetsData.data || [] : [];
    setCache(cacheKey, assets, 86400);
    return assets;
  } catch (error: any) {
    setCache(cacheKey, [], error.status === 404 ? 3600 : 0);
    return [];
  }
}

function calculateSimpleScore(name: string, query: string, fuseScore: number) {
  let score = (1 - fuseScore) * 100;

  if (name === query) return 100000;

  if (name.startsWith(query)) return 50000 + score;

  if (name.includes(` ${query} `) || name.endsWith(` ${query}`)) {
    return 20000 + score;
  }

  if (name.includes(query)) return 10000 + score;

  if (name.length < 30) score += (30 - name.length) * 5;

  return score;
}

const app = new Elysia()
  .use(
    cors({
      origin: true,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization"],
    })
  )
  .mount(auth.handler)
  .get("/", () => ({
    name: "Vault API",
    version: "0.1.0",
    description:
      "A REST API for Vault Launcher to access Steam games data, including search, details, and assets",
    stats: {
      totalGames: steamApps.length,
      appListReady,
      cacheStats: {
        keys: cache.size,
        hits: getCacheStats().hits,
        misses: getCacheStats().misses,
      },
      uptime: process.uptime(),
    },
  }))
  .get(
    "/games/search",
    async ({ query, status }) => {
      const q = (query.q || "").trim();
      if (!q) return status(400, { error: "Search query required" });

      const page = Math.max(1, parseInt(query.page as string) || 1);
      const perPage = Math.min(100, parseInt(query.perPage as string) || 16);

      try {
        const allGames = await getAppList();
        if (!allGames?.length || !fuseInstance) {
          return status(503, { error: "App list not ready" });
        }

        const cacheKey = `search_${q.toLowerCase()}`;
        let filtered: any = getCache(cacheKey);

        if (!filtered) {
          const queryLower = q.toLowerCase();
          const queryWords = queryLower
            .split(/\s+/)
            .filter((w) => w.length > 0);
          const maxResults = 200;

          const results = fuseInstance.search(q, { limit: maxResults });

          filtered = results
            .filter((r) => {
              if ((r.score || 1) > 0.4) return false;

              if (queryWords.length > 1) {
                return queryWords.every((w) => r.item.lowerName.includes(w));
              }
              return true;
            })
            .map((r) => ({
              ...r.item,
              relevanceScore: calculateSimpleScore(
                r.item.lowerName,
                queryLower,
                r.score || 0
              ),
            }))
            .sort((a, b) => b.relevanceScore - a.relevanceScore)
            .slice(0, 100);

          setCache(cacheKey, filtered, 300);
        }

        const totalPages = Math.ceil(filtered.length / perPage);

        return {
          total: filtered.length,
          page,
          perPage,
          totalPages,
          games: filtered.slice((page - 1) * perPage, page * perPage),
        };
      } catch (err) {
        console.error("Search error:", err);
        return status(500, { error: "Failed to fetch games" });
      }
    },
    {
      query: t.Object({
        q: t.Optional(t.String()),
        page: t.Optional(t.String()),
        perPage: t.Optional(t.String()),
      }),
    }
  )
  .get(
    "/games",
    async ({ query, status }) => {
      const page = Math.max(1, parseInt(query.page as string) || 1);
      const perPage = Math.min(100, parseInt(query.perPage as string) || 16);

      try {
        const allGames = await getAppList();
        if (!allGames?.length)
          return status(503, { error: "App list not ready" });

        return {
          total: allGames.length,
          page,
          perPage,
          games: allGames.slice((page - 1) * perPage, page * perPage),
        };
      } catch (err) {
        return status(500, { error: "Failed to fetch games list" });
      }
    },
    {
      query: t.Object({
        page: t.Optional(t.String()),
        perPage: t.Optional(t.String()),
      }),
    }
  )
  .get("/games/hot", async ({ status }) => {
    try {
      const categories = await getCachedOrFetch(
        "featuredCategories",
        async () => {
          const response = await fetch(STEAM_FEATURED_CATEGORIES_URL);
          return await response.json();
        }
      );
      const items = (categories.specials?.items || []).slice(0, 46);
      const detailed = await Promise.all(
        items.map(async (g: any) => {
          const data = await fetchAppDetails(g.id || g.appid);
          return data?.success ? data.data : null;
        })
      );
      return detailed.filter(Boolean);
    } catch (err) {
      return status(500, { error: "Failed to fetch hot games" });
    }
  })
  .get("/games/top", async ({ status }) => {
    try {
      const categories = await getCachedOrFetch(
        "featuredCategories",
        async () => {
          const response = await fetch(STEAM_FEATURED_CATEGORIES_URL);
          return await response.json();
        }
      );
      const items = (categories.top_sellers?.items || []).slice(0, 40);
      const detailed = await Promise.all(
        items.map(async (g: any) => {
          const data = await fetchAppDetails(g.id || g.appid);
          return data?.success ? data.data : null;
        })
      );
      return detailed.filter(Boolean);
    } catch (err) {
      return status(500, { error: "Failed to fetch top games" });
    }
  })
  .get(
    "/games/:appid",
    async ({ params, status }) => {
      try {
        const data = await fetchAppDetails(parseInt(params.appid));
        if (data?.success) return data.data;
        else return status(404, { error: "Game not found" });
      } catch (err) {
        return status(500, { error: "Failed to fetch game details" });
      }
    },
    {
      params: t.Object({
        appid: t.String(),
      }),
    }
  )
  .get(
    "/games/:appid/logos",
    async ({ params, status }) => {
      const appid = parseInt(params.appid);
      if (isNaN(appid)) return status(400, { error: "Invalid appid" });
      try {
        return { logos: await fetchSteamGridAssets(appid, "logos") };
      } catch (err) {
        return status(500, { error: "Failed to fetch logos" });
      }
    },
    {
      params: t.Object({
        appid: t.String(),
      }),
    }
  )
  .get(
    "/games/:appid/heroes",
    async ({ params, status }) => {
      const appid = parseInt(params.appid);
      if (isNaN(appid)) return status(400, { error: "Invalid appid" });
      try {
        return { heroes: await fetchSteamGridAssets(appid, "heroes") };
      } catch (err) {
        return status(500, { error: "Failed to fetch heroes" });
      }
    },
    {
      params: t.Object({
        appid: t.String(),
      }),
    }
  )
  .listen(port);

console.log(
  `🦊 Vault API server running at ${app.server?.hostname}:${app.server?.port}`
);
