import express from "express";
import axios from "axios";
import NodeCache from "node-cache";
import cors from "cors";

const app = express();
app.use(cors());
app.disable("x-powered-by");
app.use(express.json());

const port = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 18000 }); // 5 hours

const STEAM_APP_LIST_URL =
  "https://api.steampowered.com/ISteamApps/GetAppList/v2/";
const STEAM_APP_DETAILS_URL = "https://store.steampowered.com/api/appdetails";
const STEAM_FEATURED_CATEGORIES_URL =
  "https://store.steampowered.com/api/featuredcategories/";
const STEAM_CONCURRENT_PLAYERS_URL =
  "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/";

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

  const sortBy = (req.query.sortBy as string) || "rating_desc";
  const onlyAvailable = req.query.onlyAvailable === "1";
  const genre = req.query.genre as string;
  const minRating = parseInt(req.query.minRating as string) || 0;
  const minYear = parseInt(req.query.minYear as string) || 0;
  const maxYear = parseInt(req.query.maxYear as string) || 9999;

  try {
    const allGames = await getCachedOrFetch(
      "appList",
      async () => (await axios.get(STEAM_APP_LIST_URL)).data.applist.apps
    );

    // Get detailed info for filtered games
    let filtered = allGames.filter((g: any) =>
      g.name.toLowerCase().includes(query)
    );

    // Fetch details for filtered games (limited batch to avoid too many requests)
    const batchSize = 100;
    const gamesToFetch = filtered.slice(0, batchSize);

    const detailedGames = await Promise.all(
      gamesToFetch.map(async (g: any) => {
        const detailsWrapper = await fetchAppDetails(g.appid);
        if (!detailsWrapper?.success) return null;
        return detailsWrapper.data;
      })
    );

    let validGames = detailedGames.filter(Boolean);

    // Apply filters
    if (onlyAvailable) {
      validGames = validGames.filter((g: any) => g.is_free || g.price_overview);
    }

    if (genre && genre !== "all") {
      validGames = validGames.filter((g: any) =>
        g.genres?.some((gen: any) => gen.description === genre)
      );
    }

    if (minRating > 0) {
      validGames = validGames.filter(
        (g: any) => (g.metacritic?.score || 0) >= minRating
      );
    }

    if (minYear > 0 || maxYear < 9999) {
      validGames = validGames.filter((g: any) => {
        const releaseYear = g.release_date?.date
          ? new Date(g.release_date.date).getFullYear()
          : 0;
        return releaseYear >= minYear && releaseYear <= maxYear;
      });
    }

    // Sort
    switch (sortBy) {
      case "rating_desc":
        validGames.sort(
          (a: any, b: any) =>
            (b.metacritic?.score || 0) - (a.metacritic?.score || 0)
        );
        break;
      case "rating_asc":
        validGames.sort(
          (a: any, b: any) =>
            (a.metacritic?.score || 0) - (b.metacritic?.score || 0)
        );
        break;
      case "name_asc":
        validGames.sort((a: any, b: any) => a.name.localeCompare(b.name));
        break;
      case "release_desc":
        validGames.sort((a: any, b: any) => {
          const dateA = a.release_date?.date
            ? new Date(a.release_date.date).getTime()
            : 0;
          const dateB = b.release_date?.date
            ? new Date(b.release_date.date).getTime()
            : 0;
          return dateB - dateA;
        });
        break;
    }

    const paginatedGames = validGames.slice(
      (page - 1) * perPage,
      page * perPage
    );

    res.json({
      total: validGames.length,
      page,
      perPage,
      games: paginatedGames,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch games" });
  }
});

app.get("/games", async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const perPage = Math.min(100, parseInt(req.query.perPage as string) || 16);
  try {
    const allGames = await getCachedOrFetch(
      "appList",
      async () => (await axios.get(STEAM_APP_LIST_URL)).data.applist.apps
    );
    res.json({
      total: allGames.length,
      page,
      perPage,
      games: allGames.slice((page - 1) * perPage, page * perPage),
    });
  } catch {
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
