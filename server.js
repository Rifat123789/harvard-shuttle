const express = require("express");
const cors = require("cors");
const unzipper = require("unzipper");
const csv = require("csv-parser");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");
const app = express();
app.use(cors());

const GTFS_ZIP_URL = "https://passio3.com/harvard/passioTransit/gtfs/google_transit.zip";

let STOPS = []; // [{stop_id, stop_name, stop_lat, stop_lon}]
let stopsLoadedAt = 0;

let STOP_ROUTES = {};
let TRIP_ROUTE = {};

async function loadStops() {
  const res = await fetch(GTFS_ZIP_URL);
  if (!res.ok) throw new Error("Failed GTFS zip download: " + res.status);

  const buffer = await res.arrayBuffer();
const directory = await unzipper.Open.buffer(Buffer.from(buffer));

  const stops = [];
  STOP_ROUTES = {};
  TRIP_ROUTE = {};
  for (const entry of directory.files) {
  const content = await entry.buffer();
  const lines = content.toString().split("\n");
  const headers = lines[0].split(",");

  if (entry.path === "stops.txt") {
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      if (cols.length !== headers.length) continue;

      const row = {};
      headers.forEach((h, idx) => (row[h.trim()] = cols[idx]));

      if (row.stop_id && row.stop_lat && row.stop_lon) {
        stops.push({
          stop_id: row.stop_id,
          stop_name: row.stop_name,
          stop_lat: Number(row.stop_lat),
          stop_lon: Number(row.stop_lon),
        });
      }
    }
  }

  if (entry.path === "trips.txt") {
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      if (cols.length !== headers.length) continue;

      const row = {};
      headers.forEach((h, idx) => (row[h.trim()] = cols[idx]));

      TRIP_ROUTE[row.trip_id] = row.route_id;
    }
  }

  if (entry.path === "stop_times.txt") {
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      if (cols.length !== headers.length) continue;

      const row = {};
      headers.forEach((h, idx) => (row[h.trim()] = cols[idx]));

      const route = TRIP_ROUTE[row.trip_id];
      if (!route) continue;

      if (!STOP_ROUTES[row.stop_id]) {
        STOP_ROUTES[row.stop_id] = new Set();
      }

      STOP_ROUTES[row.stop_id].add(route);
    }
  }
}

  STOPS = stops;
 
  stopsLoadedAt = Date.now();
  console.log("Loaded stops:", STOPS.length);
}

// simple Haversine distance (meters)
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function walkingMinutesFromMeters(m) {
  // ~1.3 m/s typical walking speed
  return Math.max(1, Math.round(m / (1.3 * 60)));
}
const TRIP_UPDATES_URL =
  "https://passio3.com/harvard/passioTransit/gtfs/realtime/tripUpdates";

let lastRtFetchAt = 0;

async function getArrivalsForStop(stop_id) {
  const res = await fetch(TRIP_UPDATES_URL);
  if (!res.ok) throw new Error("Failed realtime feed");

  const buffer = await res.arrayBuffer();
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
    Buffer.from(buffer)
  );

  lastRtFetchAt = Date.now();
  const nowSec = Math.floor(Date.now() / 1000);

  const arrivals = [];

  for (const entity of feed.entity) {
    if (!entity.tripUpdate) continue;

    const tu = entity.tripUpdate;

    for (const stu of tu.stopTimeUpdate || []) {
      if (stu.stopId !== stop_id) continue;

      const t =
        (stu.arrival && stu.arrival.time) ||
        (stu.departure && stu.departure.time);

      if (!t) continue;

      const mins = Math.round((t - nowSec) / 60);
      if (mins < 0) continue;

      arrivals.push({
        route_id: tu.trip.routeId,
        arrival_minutes: mins,
      });
    }
  }

  arrivals.sort((a, b) => a.arrival_minutes - b.arrival_minutes);
  return arrivals.slice(0, 3);
}
app.get("/nearest", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({ error: "lat and lon required" });
  }

  let best = null;

  for (const s of STOPS) {
    const d = haversineMeters(lat, lon, s.stop_lat, s.stop_lon);
    if (!best || d < best.d) best = { s, d };
  }

  const arrivals = await getArrivalsForStop(best.s.stop_id);

  res.json({
    stop: best.s.stop_name,
    walk_meters: Math.round(best.d),
    walk_minutes: walkingMinutesFromMeters(best.d),
    next_arrivals: arrivals,
    realtime_freshness_seconds: Math.round(
      (Date.now() - lastRtFetchAt) / 1000
    ),
  });
});

app.get("/plan", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const destStopId = req.query.destStopId;

  if (!lat || !lon || !destStopId) {
    return res.status(400).json({ error: "lat, lon, destStopId required" });
  }

  const destRoutes = STOP_ROUTES[destStopId];
  if (!destRoutes) {
    return res.json({ error: "Invalid destination stop" });
  }

  let best = null;

  for (const s of STOPS) {
    const routesHere = STOP_ROUTES[s.stop_id];
    if (!routesHere) continue;

    const sharedRoute = [...routesHere].some(r => destRoutes.has(r));
    if (!sharedRoute) continue;

    const d = haversineMeters(lat, lon, s.stop_lat, s.stop_lon);

    if (!best || d < best.d) best = { s, d };
  }

  const arrivals = await getArrivalsForStop(best.s.stop_id);

  res.json({
    board_at: best.s.stop_name,
    walk_minutes: walkingMinutesFromMeters(best.d),
    arrivals
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await loadStops();
  console.log("Server on", PORT);
});