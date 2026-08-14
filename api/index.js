// api/index.js

const OSRM_BASE = {
  driving: "https://routing.openstreetmap.de/routed-car/route/v1/driving",
  cycling: "https://routing.openstreetmap.de/routed-bike/route/v1/driving",
  walking: "https://routing.openstreetmap.de/routed-foot/route/v1/driving",
};

const EMISSIONS = {
  driving: {
    gas: 0.2485,
    suv: 0.3450,
    hybrid: 0.1650,
    ev: 0.0450
  },
  cycling: 0.011,
  walking: 0,
  flightShortHaul: 0.255,
  flightMediumHaul: 0.156,
  flightLongHaul: 0.15,
};

const TREE_KG_PER_YEAR = 21;

function toRad(d) { return (d * Math.PI) / 180; }
function toDeg(r) { return (r * 180) / Math.PI; }

function haversineKm(lon1, lat1, lon2, lat2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function greatCirclePoints(lon1, lat1, lon2, lat2, segments = 48) {
  const phi1 = toRad(lat1); const lam1 = toRad(lon1);
  const phi2 = toRad(lat2); const lam2 = toRad(lon2);
  const d = 2 * Math.asin(Math.sqrt(Math.sin((phi2 - phi1) / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin((lam2 - lam1) / 2) ** 2));
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    if (d === 0) { pts.push([lon1, lat1]); continue; }
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(phi1) * Math.cos(lam1) + B * Math.cos(phi2) * Math.cos(lam2);
    const y = A * Math.cos(phi1) * Math.sin(lam1) + B * Math.cos(phi2) * Math.sin(lam2);
    const z = A * Math.sin(phi1) + B * Math.sin(phi2);
    pts.push([toDeg(Math.atan2(y, x)), toDeg(Math.atan2(z, Math.sqrt(x * x + y * y)))]);
  }
  return pts;
}

async function geocodeOne(query, apiKey) {
  if (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(query)) {
    const [lng, lat] = query.split(',').map(Number);
    return { center: [lng, lat], place_name: "GPS Location" };
  }
  const res = await fetch(`https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?key=${apiKey}&limit=1`);
  const data = await res.json();
  if (!data.features || !data.features.length) throw new Error(`Could not locate "${query}". Try a more specific address.`);
  return data.features[0];
}

async function fetchOSRMRoute(mode, startCoords, endCoords) {
  const url = `${OSRM_BASE[mode]}/${startCoords[0]},${startCoords[1]};${endCoords[0]},${endCoords[1]}?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== "Ok") throw new Error(`Cannot find a valid ${mode} route.`);
  return data.routes[0];
}

function emissionFactorForFlight(distanceKm) {
  if (distanceKm < 500) return EMISSIONS.flightShortHaul;
  if (distanceKm <= 3700) return EMISSIONS.flightMediumHaul;
  return EMISSIONS.flightLongHaul;
}

async function buildRouteResult(mode, startFeature, endFeature, vehicleType = 'gas') {
  const startCoords = startFeature.center;
  const endCoords = endFeature.center;
  let geometry, distanceKm, durationMin, accuracyNote, steps = [];

  if (mode === "flight") {
    distanceKm = haversineKm(startCoords[0], startCoords[1], endCoords[0], endCoords[1]);
    geometry = { type: "LineString", coordinates: greatCirclePoints(startCoords[0], startCoords[1], endCoords[0], endCoords[1]) };
    durationMin = Math.round((distanceKm / 850) * 60 + 40);
    accuracyNote = "Great-circle distance. Modeled flight time.";
  } else {
    const route = await fetchOSRMRoute(mode, startCoords, endCoords);
    geometry = route.geometry;
    distanceKm = route.distance / 1000;
    durationMin = Math.round(route.duration / 60);
    steps = route.legs[0].steps;
    accuracyNote = `Real ${mode} path computed from OpenStreetMap.`;
  }

  const distanceMiles = distanceKm / 1.60934;

  let co2Kg;
  if (mode === "flight") {
    co2Kg = distanceKm * emissionFactorForFlight(distanceKm);
  } else if (mode === "driving") {
    const vFactor = EMISSIONS.driving[vehicleType] || EMISSIONS.driving.gas;
    co2Kg = distanceKm * vFactor;
  } else {
    co2Kg = distanceKm * EMISSIONS[mode];
  }

  let urbanMultiplier = 1.0;
  if (distanceKm < 15 && mode === "driving") {
    urbanMultiplier = 1.18;
  }
  durationMin = Math.round(durationMin * urbanMultiplier);
  co2Kg = Number((co2Kg * urbanMultiplier).toFixed(2));

  const baselineDrivingKg = distanceKm * EMISSIONS.driving.gas;
  const savedVsDriving = baselineDrivingKg - co2Kg;
  const treesPerYear = co2Kg / TREE_KG_PER_YEAR;
  const smartphoneCharges = Math.round(Math.max(0, savedVsDriving) * 120);

  let caloriesBurned = 0;
  if (mode === "walking") caloriesBurned = Math.round(distanceKm * 50);
  if (mode === "cycling") caloriesBurned = Math.round(distanceKm * 30);

  let fuelSavedUSD = 0;
  if (mode === "walking" || mode === "cycling" || vehicleType === "ev") {
    fuelSavedUSD = (distanceMiles * 0.15).toFixed(2);
  }

  let aqi = null, weather = null;
  try {
    const [aqiRes, weatherRes] = await Promise.all([
      fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${endCoords[1]}&longitude=${endCoords[0]}&current=us_aqi`),
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${endCoords[1]}&longitude=${endCoords[0]}&current=temperature_2m,precipitation,cloudcover`)
    ]);
    const aqiData = await aqiRes.json();
    const weatherData = await weatherRes.json();
    aqi = aqiData?.current?.us_aqi ?? null;
    weather = weatherData?.current ?? null;
  } catch (e) { console.error("Weather/AQI Error", e); }

  return {
    mode,
    vehicleType,
    startCoords,
    endCoords,
    startName: startFeature.place_name,
    endName: endFeature.place_name,
    geometry,
    distanceMiles: Number(distanceMiles.toFixed(1)),
    distanceKm: Number(distanceKm.toFixed(1)),
    duration: durationMin,
    co2: Number(co2Kg.toFixed(2)),
    savedVsDriving: Number(savedVsDriving.toFixed(2)),
    trees: Number(treesPerYear.toFixed(2)),
    smartphoneCharges,
    caloriesBurned,
    fuelSavedUSD,
    aqi,
    weather,
    accuracyNote,
    steps
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const endpoint = req.query.endpoint;
  const API_KEY = process.env.MY_MAPTILER_KEY;

  try {
    if (endpoint === "config") return res.status(200).json({ mapTilerKey: API_KEY });
    if (!API_KEY) throw new Error("Missing MapTiler API key.");

    if (endpoint === "route") {
      const { start, end, mode, vehicle } = req.query;
      if (!start || !end) throw new Error("Start and end missing.");

      const result = await buildRouteResult(
        mode || "driving",
        await geocodeOne(start, API_KEY),
        await geocodeOne(end, API_KEY),
        vehicle || "gas"
      );

      return res.status(200).json(result);
    }

    return res.status(400).json({ error: "Invalid endpoint requested." });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Internal server error." });
  }
};
