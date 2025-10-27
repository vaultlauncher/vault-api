import express from "express";
import axios from "axios";
import NodeCache from "node-cache";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });

// In-memory store for all Steam apps
let steamApps = [];

// Fetch the full Steam app list on startup
async function preloadSteamApps() {
  try {
    console.log("Fetching Steam app list...");
    const { data } = await axios.get(
      "https://api.steampowered.com/ISteamApps/GetAppList/v2/"
    );
    steamApps = data.applist.apps || [];
    console.log(`Loaded ${steamApps.length} apps.`);
  } catch (err) {
    console.error("Failed to fetch Steam apps:", err.message);
  }
}

// Filter apps in memory by search query
function searchApps(query) {
  const q = query.toLowerCase();
  return steamApps
    .filter((app) => app.name.toLowerCase().includes(q))
    .slice(0, 50); // limit results for speed
}

// API endpoint
app.get("/search", (req, res) => {
  const { q } = req.query;
  if (!q)
    return res.status(400).json({ error: "Query parameter 'q' required" });

  const cacheKey = q.toLowerCase();
  if (cache.has(cacheKey)) {
    return res.json({ cached: true, results: cache.get(cacheKey) });
  }

  const results = searchApps(q);
  cache.set(cacheKey, results);
  res.json({ cached: false, results });
});

// Start server after preloading apps
preloadSteamApps().then(() => {
  app.listen(PORT, () =>
    console.log(`Steam search API running on port ${PORT}`)
  );
});
