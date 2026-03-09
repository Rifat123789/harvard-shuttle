const express = require("express");
const cors = require("cors");
const path = require("path");
const unzipper = require("unzipper");
const csv = require("csv-parser");
const GtfsRealtimeBindings = require("gtfs-realtime-bindings");

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const GTFS_ZIP_URL =
  "https://passio3.com/harvard/passioTransit/gtfs/google_transit.zip";

let STOPS = [];
let stopsLoadedAt = 0;

let STOP_ROUTES  = {};  // stop_id -> Set of route_ids
let TRIP_ROUTE   = {};  // trip_id -> route_id
let ROUTE_INFO   = {};  // route_id -> { short_name, long_name, color }
let ROUTE_SHAPES = {};  // route_id -> [[lat, lon], ...]

const ROUTE_COLOUR_MAP = {
  "1636": "#2563eb",
  "al":   "#dc2626",
  "qsec": "#16a34a",
  "cc":   "#6b7280",
};

const FALLBACK_COLOURS = [
  "#7c3aed", "#d97706", "#0891b2", "#be185d",
  "#059669", "#b45309", "#4338ca", "#0f766e",
];

function routeColour(routeId) {
  const info = ROUTE_INFO[routeId] || {};
  if (info.color && info.color.length === 6) return `#${info.color}`;
  const name = (info.short_name || info.long_name || String(routeId)).toLowerCase();
  for (const [key, colour] of Object.entries(ROUTE_COLOUR_MAP)) {
    if (name.startsWith(key)) return colour;
  }
  let hash = 0;
  const s = String(routeId);
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return FALLBACK_COLOURS[hash % FALLBACK_COLOURS.length];
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/);
  if (!lines[0]) return [];
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(",");
    const row = {};
    headers.forEach((h, idx) => { row[h] = (cols[idx] || "").trim().replace(/^"|"$/g, ""); });
    rows.push(row);
  }
  return rows;
}

async function loadStops() {
  const res = await fetch(GTFS_ZIP_URL);
  if (!res.ok) throw new Error("Failed GTFS zip download: " + res.status);

  const buffer    = await res.arrayBuffer();
  const directory = await unzipper.Open.buffer(Buffer.from(buffer));

  const stops       = [];
  STOP_ROUTES  = {};
  TRIP_ROUTE   = {};
  ROUTE_INFO   = {};
  ROUTE_SHAPES = {};

  const tripStopSeq = {};
  const rawShapes   = {};
  const tripShape   = {};

  for (const entry of directory.files) {
    const content = await entry.buffer();
    const text    = content.toString();

    if (entry.path === "stops.txt") {
      for (const row of parseCSV(text)) {
        if (row.stop_id && row.stop_lat && row.stop_lon) {
          stops.push({
            stop_id:   row.stop_id,
            stop_name: row.stop_name,
            stop_lat:  Number(row.stop_lat),
            stop_lon:  Number(row.stop_lon),
          });
        }
      }
    }

    if (entry.path === "routes.txt") {
      for (const row of parseCSV(text)) {
        if (row.route_id) {
          ROUTE_INFO[row.route_id] = {
            short_name: row.route_short_name || "",
            long_name:  row.route_long_name  || "",
            color:      (row.route_color || "").replace(/^#/, ""),
          };
        }
      }
    }

    if (entry.path === "trips.txt") {
      for (const row of parseCSV(text)) {
        if (!row.trip_id) continue;
        TRIP_ROUTE[row.trip_id] = row.route_id;
        if (row.shape_id) tripShape[row.trip_id] = row.shape_id;
      }
    }

    if (entry.path === "stop_times.txt") {
      for (const row of parseCSV(text)) {
        const route = TRIP_ROUTE[row.trip_id];
        if (!route) continue;

        if (!STOP_ROUTES[row.stop_id]) STOP_ROUTES[row.stop_id] = new Set();
        STOP_ROUTES[row.stop_id].add(route);

        if (!tripStopSeq[row.trip_id]) tripStopSeq[row.trip_id] = [];
        tripStopSeq[row.trip_id].push({ seq: Number(row.stop_sequence) || 0, stop_id: row.stop_id });
      }
    }

    if (entry.path === "shapes.txt") {
      for (const row of parseCSV(text)) {
        if (!row.shape_id) continue;
        if (!rawShapes[row.shape_id]) rawShapes[row.shape_id] = [];
        rawShapes[row.shape_id].push({
          lat: Number(row.shape_pt_lat),
          lon: Number(row.shape_pt_lon),
          seq: Number(row.shape_pt_sequence) || 0,
        });
      }
    }
  }

  STOPS = stops;
  const stopById = {};
  for (const s of stops) stopById[s.stop_id] = s;

  const routeShapeId = {};
  for (const [tripId, shapeId] of Object.entries(tripShape)) {
    const routeId = TRIP_ROUTE[tripId];
    if (routeId && !routeShapeId[routeId]) routeShapeId[routeId] = shapeId;
  }

  const hasShapes = Object.keys(rawShapes).length > 0;

  if (hasShapes) {
    for (const [routeId, shapeId] of Object.entries(routeShapeId)) {
      const pts = rawShapes[shapeId];
      if (!pts || pts.length === 0) continue;
      pts.sort((a, b) => a.seq - b.seq);
      ROUTE_SHAPES[routeId] = pts.map(p => [p.lat, p.lon]);
    }
  }

  for (const routeId of Object.keys(ROUTE_INFO)) {
    if (ROUTE_SHAPES[routeId]) continue;
    const repTrip = Object.entries(TRIP_ROUTE).find(([, rId]) => rId === routeId);
    if (!repTrip) continue;
    const seqArr = tripStopSeq[repTrip[0]];
    if (!seqArr) continue;
    seqArr.sort((a, b) => a.seq - b.seq);
    const coords = [];
    for (const { stop_id } of seqArr) {
      const s = stopById[stop_id];
      if (s) coords.push([s.stop_lat, s.stop_lon]);
    }
    if (coords.length >= 2) ROUTE_SHAPES[routeId] = coords;
  }

  stopsLoadedAt = Date.now();
  console.log(
    `Loaded: ${STOPS.length} stops, ${Object.keys(ROUTE_INFO).length} routes, ` +
    `${Object.keys(ROUTE_SHAPES).length} shapes`
  );
}

// ── Endpoints ────────────────────────────────────────────────────────────────

app.get("/stops", (req, res) => {
  if (!STOPS || STOPS.length === 0)
    return res.status(503).json({ error: "Stops not loaded yet, please try again shortly." });
  res.json(STOPS);
});

app.get("/routes", (req, res) => {
  if (!STOPS || STOPS.length === 0)
    return res.status(503).json({ error: "Data not loaded yet." });

  const routes = Object.entries(ROUTE_INFO).map(([routeId, info]) => ({
    route_id:   routeId,
    short_name: info.short_name,
    long_name:  info.long_name,
    colour:     routeColour(routeId),
    coords:     ROUTE_SHAPES[routeId] || [],
  })).filter(r => r.coords.length >= 2);

  res.json(routes);
});

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function walkingMinutesFromMeters(m) {
  return Math.max(1, Math.round(m / (1.3 * 60)));
}

const TRIP_UPDATES_URL      = "https://passio3.com/harvard/passioTransit/gtfs/realtime/tripUpdates";
const VEHICLE_POSITIONS_URL = "https://passio3.com/harvard/passioTransit/gtfs/realtime/vehiclePositions";

let lastRtFetchAt = 0;

async function getArrivalsForStop(stop_id) {
  const res = await fetch(TRIP_UPDATES_URL);
  if (!res.ok) throw new Error("Failed realtime feed");
  const buffer = await res.arrayBuffer();
  const feed   = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(Buffer.from(buffer));
  lastRtFetchAt = Date.now();

  const nowSec   = Math.floor(Date.now() / 1000);
  const arrivals = [];
  for (const entity of feed.entity) {
    if (!entity.tripUpdate) continue;
    const tu = entity.tripUpdate;
    for (const stu of tu.stopTimeUpdate || []) {
      if (stu.stopId !== stop_id) continue;
      const t = (stu.arrival && stu.arrival.time) || (stu.departure && stu.departure.time);
      if (!t) continue;
      const mins = Math.round((t - nowSec) / 60);
      if (mins < 0) continue;
      arrivals.push({ route_id: tu.trip.routeId, arrival_minutes: mins });
    }
  }
  arrivals.sort((a, b) => a.arrival_minutes - b.arrival_minutes);
  return arrivals.slice(0, 3);
}

app.get("/stopArrivals", async (req, res) => {
  const stopId = req.query.stopId;
  if (!stopId) return res.status(400).json({ error: "stopId required" });

  try {
    const arrivals = await getArrivalsForStop(stopId);
    const enriched = arrivals.map(a => {
      const info = ROUTE_INFO[a.route_id] || {};
      return {
        route_id:        a.route_id,
        route_name:      info.short_name || info.long_name || String(a.route_id ?? "Unknown"),
        route_colour:    routeColour(a.route_id),
        arrival_minutes: a.arrival_minutes,
      };
    });

    const staticRoutes = [...(STOP_ROUTES[stopId] || [])].map(rId => {
      const info = ROUTE_INFO[rId] || {};
      return {
        route_id:   rId,
        route_name: info.short_name || info.long_name || String(rId),
        colour:     routeColour(rId),
      };
    });

    const stop = STOPS.find(s => s.stop_id === stopId);
    res.json({
      stop_id:   stopId,
      stop_name: stop ? stop.stop_name : undefined,
      arrivals:  enriched,
      routes:    staticRoutes,
      realtime_freshness_seconds: Math.round((Date.now() - lastRtFetchAt) / 1000),
    });
  } catch (err) {
    console.error("Error in /stopArrivals:", err);
    res.status(500).json({ error: "Internal error reading arrivals for stop" });
  }
});

app.get("/vehicles", async (req, res) => {
  try {
    const rtRes = await fetch(VEHICLE_POSITIONS_URL);
    if (!rtRes.ok)
      return res.status(502).json({ error: "Failed vehicle positions feed", status: rtRes.status });

    const buffer = await rtRes.arrayBuffer();
    const feed   = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(Buffer.from(buffer));

    const vehicles = [];
    for (const entity of feed.entity) {
      if (!entity.vehicle || !entity.vehicle.position) continue;
      const v   = entity.vehicle;
      const pos = v.position;
      if (!Number.isFinite(pos.latitude) || !Number.isFinite(pos.longitude)) continue;
      const rId = (v.trip && v.trip.routeId) || null;
      vehicles.push({
        id:       (v.vehicle && v.vehicle.id) || entity.id || undefined,
        lat:      pos.latitude,
        lon:      pos.longitude,
        route_id: rId,
        colour:   rId ? routeColour(rId) : "#374151",
      });
    }
    res.json(vehicles);
  } catch (err) {
    console.error("Error in /vehicles:", err);
    res.status(500).json({ error: "Internal error reading vehicle positions" });
  }
});

app.get("/nearest", async (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon))
    return res.status(400).json({ error: "lat and lon required" });

  let best = null;
  for (const s of STOPS) {
    const d = haversineMeters(lat, lon, s.stop_lat, s.stop_lon);
    if (!best || d < best.d) best = { s, d };
  }

  const arrivals = await getArrivalsForStop(best.s.stop_id);
  res.json({
    stop_id:       best.s.stop_id,
    stop_lat:      best.s.stop_lat,
    stop_lon:      best.s.stop_lon,
    stop:          best.s.stop_name,
    walk_meters:   Math.round(best.d),
    walk_minutes:  walkingMinutesFromMeters(best.d),
    next_arrivals: arrivals,
    realtime_freshness_seconds: Math.round((Date.now() - lastRtFetchAt) / 1000),
  });
});

app.get("/plan", async (req, res) => {
  const lat        = Number(req.query.lat);
  const lon        = Number(req.query.lon);
  const destStopId = req.query.destStopId;
  if (!lat || !lon || !destStopId)
    return res.status(400).json({ error: "lat, lon, destStopId required" });

  const destRoutes = STOP_ROUTES[destStopId];
  if (!destRoutes) return res.json({ error: "Invalid destination stop" });

  let best = null, bestSharedRoute = null;
  for (const s of STOPS) {
    const routesHere = STOP_ROUTES[s.stop_id];
    if (!routesHere) continue;
    const sharedRoute = [...routesHere].find(r => destRoutes.has(r));
    if (!sharedRoute) continue;
    const d = haversineMeters(lat, lon, s.stop_lat, s.stop_lon);
    if (!best || d < best.d) { best = { s, d }; bestSharedRoute = sharedRoute; }
  }
  if (!best) return res.json({ error: "No connecting stop found" });

  const arrivals = await getArrivalsForStop(best.s.stop_id);
  const enrichedArrivals = arrivals.map(a => {
    const info = ROUTE_INFO[a.route_id] || {};
    return { ...a, route_name: info.short_name || info.long_name || String(a.route_id || "Unknown") };
  });

  const routeInfo = ROUTE_INFO[bestSharedRoute] || {};
  const routeName = routeInfo.short_name || routeInfo.long_name || String(bestSharedRoute || "Shuttle");
  const destStop  = STOPS.find(s => s.stop_id === destStopId);

  res.json({
    board_at:       best.s.stop_name,
    board_stop_id:  best.s.stop_id,
    board_stop_lat: best.s.stop_lat,
    board_stop_lon: best.s.stop_lon,
    route_id:       bestSharedRoute,
    route_name:     routeName,
    route_colour:   routeColour(bestSharedRoute),
    dest_stop_name: destStop ? destStop.stop_name : destStopId,
    walk_meters:    Math.round(best.d),
    walk_minutes:   walkingMinutesFromMeters(best.d),
    arrivals:       enrichedArrivals,
    realtime_freshness_seconds: Math.round((Date.now() - lastRtFetchAt) / 1000),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await loadStops();
  console.log("Server on", PORT);
});