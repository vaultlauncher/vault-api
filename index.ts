import express from "express";
import axios from "axios";
import NodeCache from "node-cache";
import cors from "cors";
import fs from "fs/promises";
import dotenv from "dotenv";
import Fuse from "fuse.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const port = Number(process.env.PORT) || 3000;
const cache = new NodeCache({ stdTTL: 18000 });
const APP_LIST_FILE = "app_list.json";

let steamApps: any[] = [];
let fuseInstance: Fuse<any> | null = null;

const STEAM_APP_LIST_URL =
  "https://api.steampowered.com/ISteamApps/GetAppList/v2/";
const STEAM_APP_DETAILS_URL = "https://store.steampowered.com/api/appdetails";
const STEAM_FEATURED_CATEGORIES_URL =
  "https://store.steampowered.com/api/featuredcategories/";
const STEAMGRIDDB_API_KEY = process.env.STEAMGRIDDB_API_KEY;
const STEAMGRIDDB_BASE_URL = "https://www.steamgriddb.com/api/v2";

let appListReady = false;

function prepareApps(appList: any[]) {
  appList.forEach((g: any) => {
    g.lowerName = g.name.toLowerCase();
    g.searchName = g.name
      .toLowerCase()
      .replace(/[®™©:]/g, "")
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
      const data = await fs.readFile(APP_LIST_FILE, "utf8");
      steamApps = prepareApps(JSON.parse(data));
      fuseInstance = createFuseIndex(steamApps);
      appListReady = true;
      console.log(`App list loaded from file: ${steamApps.length} games`);
      return;
    } catch {}

    console.log("Fetching Steam app list...");
    const response = await axios.get(STEAM_APP_LIST_URL);
    steamApps = prepareApps(response.data.applist.apps);
    fuseInstance = createFuseIndex(steamApps);
    appListReady = true;
    await fs.writeFile(APP_LIST_FILE, JSON.stringify(steamApps));
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
  const cached = cache.get(key);
  if (cached) return cached;
  const data = await fetchFn();
  cache.set(key, data);
  return data;
}

async function fetchAppDetails(appid: number) {
  return getCachedOrFetch(`appDetails_${appid}`, async () => {
    const response = await axios.get(STEAM_APP_DETAILS_URL, {
      params: { appids: appid, l: 'english' },
    });
    return response.data[appid];
  });
}

async function fetchSteamGridAssets(
  appid: number,
  assetType: "logos" | "heroes"
) {
  const cacheKey = `${assetType}_${appid}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  if (!STEAMGRIDDB_API_KEY) return [];

  try {
    const searchResp = await axios.get(
      `${STEAMGRIDDB_BASE_URL}/games/steam/${appid}`,
      {
        headers: { Authorization: `Bearer ${STEAMGRIDDB_API_KEY}` },
        timeout: 5000,
      }
    );

    if (!searchResp.data.success) {
      cache.set(cacheKey, []);
      return [];
    }

    const assetsResp = await axios.get(
      `${STEAMGRIDDB_BASE_URL}/${assetType}/game/${searchResp.data.data.id}`,
      {
        headers: { Authorization: `Bearer ${STEAMGRIDDB_API_KEY}` },
        timeout: 5000,
      }
    );

    const assets = assetsResp.data.success ? assetsResp.data.data || [] : [];
    cache.set(cacheKey, assets, 86400);
    return assets;
  } catch (error: any) {
    cache.set(cacheKey, [], error.response?.status === 404 ? 3600 : 0);
    return [];
  }
}

app.get("/", (_, res) => {
  const stats = {
    totalGames: steamApps.length,
    appListReady,
    cacheStats: {
      keys: cache.keys().length,
      hits: cache.getStats().hits,
      misses: cache.getStats().misses,
    },
    uptime: process.uptime(),
  };

  res.json({
    name: "Vault API",
    version: "0.1.0",
    description:
      "A REST API for Vault Launcher to access Steam games data, including search, details, and assets",
    stats,
  });
});

app.get("/games/search", async (req, res) => {
  const query = ((req.query.q as string) || "").trim();
  if (!query) return res.status(400).json({ error: "Search query required" });

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const perPage = Math.min(100, parseInt(req.query.perPage as string) || 16);

  try {
    const allGames = await getAppList();
    if (!allGames?.length || !fuseInstance) {
      return res.status(503).json({ error: "App list not ready" });
    }

    const cacheKey = `search_${query.toLowerCase()}`;
    let filtered: any = cache.get(cacheKey);

    if (!filtered) {
      const queryLower = query.toLowerCase();
      const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 0);
      const maxResults = 200;

      const results = fuseInstance.search(query, { limit: maxResults });

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

      cache.set(cacheKey, filtered, 300);
    }

    const totalPages = Math.ceil(filtered.length / perPage);

    res.json({
      total: filtered.length,
      page,
      perPage,
      totalPages,
      games: filtered.slice((page - 1) * perPage, page * perPage),
    });
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ error: "Failed to fetch games" });
  }
});

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

app.get("/games", async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const perPage = Math.min(100, parseInt(req.query.perPage as string) || 16);

  try {
    const allGames = await getAppList();
    if (!allGames?.length)
      return res.status(503).json({ error: "App list not ready" });

    res.json({
      total: allGames.length,
      page,
      perPage,
      games: allGames.slice((page - 1) * perPage, page * perPage),
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch games list" });
  }
});

app.get("/games/hot", async (req, res) => {
  try {
    const categories = await getCachedOrFetch(
      "featuredCategories",
      async () => (await axios.get(STEAM_FEATURED_CATEGORIES_URL)).data
    );
    const items = (categories.specials?.items || []).slice(0, 46);
    const detailed = await Promise.all(
      items.map(async (g: any) => {
        const data = await fetchAppDetails(g.id || g.appid);
        return data?.success ? data.data : null;
      })
    );
    res.json(detailed.filter(Boolean));
  } catch {
    res.status(500).json({ error: "Failed to fetch hot games" });
  }
});

app.get("/games/top", async (req, res) => {
  try {
    const categories = await getCachedOrFetch(
      "featuredCategories",
      async () => (await axios.get(STEAM_FEATURED_CATEGORIES_URL)).data
    );
    const items = (categories.top_sellers?.items || []).slice(0, 40);
    const detailed = await Promise.all(
      items.map(async (g: any) => {
        const data = await fetchAppDetails(g.id || g.appid);
        return data?.success ? data.data : null;
      })
    );
    res.json(detailed.filter(Boolean));
  } catch {
    res.status(500).json({ error: "Failed to fetch top games" });
  }
});

app.get("/games/:appid", async (req, res) => {
  try {
    const data = await fetchAppDetails(parseInt(req.params.appid));
    if (data?.success) res.json(data.data);
    else res.status(404).json({ error: "Game not found" });
  } catch {
    res.status(500).json({ error: "Failed to fetch game details" });
  }
});

app.get("/games/:appid/logos", async (req, res) => {
  const appid = parseInt(req.params.appid);
  if (isNaN(appid)) return res.status(400).json({ error: "Invalid appid" });
  try {
    res.json({ logos: await fetchSteamGridAssets(appid, "logos") });
  } catch {
    res.status(500).json({ error: "Failed to fetch logos" });
  }
});

app.get("/games/:appid/heroes", async (req, res) => {
  const appid = parseInt(req.params.appid);
  if (isNaN(appid)) return res.status(400).json({ error: "Invalid appid" });
  try {
    res.json({ heroes: await fetchSteamGridAssets(appid, "heroes") });
  } catch {
    res.status(500).json({ error: "Failed to fetch heroes" });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Vault API server running on port ${port}`);
});
