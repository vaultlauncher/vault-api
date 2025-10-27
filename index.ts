import express from "express";
import axios from "axios";
import NodeCache from "node-cache";
import cors from "cors";
import fs from "fs/promises";

const app = express();
app.use(cors());
app.disable("x-powered-by");
app.use(express.json());

const port = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 18000 });
const APP_LIST_FILE = "app_list.json";

let steamApps: any[] = [];

const STEAM_APP_LIST_URL =
  "https://api.steampowered.com/ISteamApps/GetAppList/v2/";
const STEAM_APP_DETAILS_URL = "https://store.steampowered.com/api/appdetails";
const STEAM_FEATURED_CATEGORIES_URL =
  "https://store.steampowered.com/api/featuredcategories/";
const STEAM_CONCURRENT_PLAYERS_URL =
  "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/";

let appListReady = false;
async function initAppList() {
  try {
    try {
      const data = await fs.readFile(APP_LIST_FILE, "utf8");
      const appList = JSON.parse(data);
      appList.forEach((g: any) => (g.lowerName = g.name.toLowerCase()));
      steamApps = appList;
      appListReady = true;
      console.log(`App list loaded from file: ${appList.length} games`);
      return;
    } catch {}

    console.log("Fetching Steam app list...");
    const response = await axios.get(STEAM_APP_LIST_URL);
    const appList = response.data.applist.apps;
    appList.forEach((g: any) => (g.lowerName = g.name.toLowerCase()));
    steamApps = appList;
    appListReady = true;
    await fs.writeFile(APP_LIST_FILE, JSON.stringify(appList));
    console.log(`App list cached and saved: ${appList.length} games`);
  } catch (error) {
    console.error("Failed to fetch app list:", error);
    appListReady = false;
  }
}

initAppList();

// Refresh app list every 24 hours
setInterval(initAppList, 86400000);

async function getAppList(): Promise<any[]> {
  if (!steamApps || steamApps.length === 0) {
    console.log("App list not in memory, loading...");
    await initAppList();
    return steamApps;
  }
  return steamApps;
}

async function fetchConcurrentPlayers(appid: number) {
  try {
    const resp = await axios.get(STEAM_CONCURRENT_PLAYERS_URL, {
      params: { appid },
    });
    return resp.data.response?.player_count || 0;
  } catch {
    return 0;
  }
}

async function getCachedOrFetch(
  key: string,
  fetchFunction: () => Promise<any>
) {
  const cached = cache.get(key);
  if (cached) return cached;
  const data = await fetchFunction();
  cache.set(key, data);
  return data;
}

async function fetchAppDetails(appid: number) {
  const cacheKey = `appDetails_${appid}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  try {
    const response = await axios.get(STEAM_APP_DETAILS_URL, {
      params: { appids: appid },
    });
    const appData = response.data[appid];
    cache.set(cacheKey, appData);
    return appData;
  } catch {
    return { success: false };
  }
}

app.get("/", (_, res) =>
  res.send(
    '<!DOCTYPE html><html><head><title>Vault Launcher</title><meta name="color-scheme" content="dark light"></head><body><3</body></html>'
  )
);

app.get("/games/search", async (req, res) => {
  const query = ((req.query.q as string) || "").toLowerCase();
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const perPage = Math.min(100, parseInt(req.query.perPage as string) || 16);

  try {
    const allGames = await getAppList();

    if (!Array.isArray(allGames) || allGames.length === 0) {
      return res
        .status(503)
        .json({ error: "App list not ready, please retry in a moment" });
    }

    const cacheKey = `search_filtered_${query}`;
    let filtered: any = cache.get(cacheKey);
    let cached = true;
    if (!filtered) {
      filtered = allGames.filter((g: any) => g.lowerName.includes(query));
      cache.set(cacheKey, filtered);
      cached = false;
    }
    const pageGames = filtered.slice((page - 1) * perPage, page * perPage);

    res.json({
      cached,
      total: filtered.length,
      page,
      perPage,
      games: pageGames,
    });
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ error: "Failed to fetch games" });
  }
});

app.get("/games", async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const perPage = Math.min(100, parseInt(req.query.perPage as string) || 16);

  try {
    const allGames = await getAppList();

    if (!Array.isArray(allGames) || allGames.length === 0) {
      return res
        .status(503)
        .json({ error: "App list not ready, please retry in a moment" });
    }

    res.json({
      total: allGames.length,
      page,
      perPage,
      games: allGames.slice((page - 1) * perPage, page * perPage),
    });
  } catch (error) {
    console.error("Games list error:", error);
    res.status(500).json({ error: "Failed to fetch games list" });
  }
});

app.get("/games/hot", async (req, res) => {
  try {
    const categories = await getCachedOrFetch(
      "featuredCategories",
      async () => (await axios.get(STEAM_FEATURED_CATEGORIES_URL)).data
    );
    const specials = categories.specials?.items || [];
    const paginated = specials.slice(0, 46);

    const detailed = await Promise.all(
      paginated.map(async (g: any) => {
        const detailsWrapper = await fetchAppDetails(g.id || g.appid);
        if (!detailsWrapper?.success) return null;
        return detailsWrapper.data;
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
    const topItems = categories.top_sellers?.items || [];
    const paginated = topItems.slice(0, 40);
    const detailed = await Promise.all(
      paginated.map(async (g: any) => {
        const detailsWrapper = await fetchAppDetails(g.id || g.appid);
        if (!detailsWrapper?.success) return null;
        return detailsWrapper.data;
      })
    );
    res.json(detailed.filter(Boolean));
  } catch {
    res.status(500).json({ error: "Failed to fetch top games" });
  }
});

app.get("/games/:appid", async (req, res) => {
  const { appid } = req.params;
  try {
    const data = await getCachedOrFetch(
      `appDetails_${appid}`,
      async () =>
        (
          await axios.get(STEAM_APP_DETAILS_URL, { params: { appids: appid } })
        ).data[appid]
    );
    if (data?.success) res.json(data.data);
    else res.status(404).json({ error: "Game not found" });
  } catch {
    res.status(500).json({ error: "Failed to fetch game details" });
  }
});

app.listen(port, () => console.log(`Vault API server running on port ${port}`));
