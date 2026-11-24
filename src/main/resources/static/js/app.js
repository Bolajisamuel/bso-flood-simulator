// Welcome screen entry point: reveal the existing simulator without changing its workflows.
document.getElementById('exploreAppBtn')?.addEventListener('click', () => {
    document.body.classList.remove('welcome-active');
    window.setTimeout(() => {
        if (typeof map !== 'undefined' && map && typeof map.invalidateSize === 'function') map.invalidateSize(true);
        window.dispatchEvent(new Event('resize'));
    }, 180);
});

// ---------- Map ----------
const map = L.map('map').setView([9.082, 8.675], 6); // Nigeria overview

const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);
const satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 19, attribution: 'Tiles &copy; Esri' }
);
L.control.layers({ 'OpenStreetMap': street, 'Satellite': satellite }).addTo(map);
L.control.scale({ position: 'bottomright', metric: true, imperial: false, maxWidth: 140 }).addTo(map);

// ---------- Elements ----------
const radiusInput = document.getElementById('radius');
const coordsBox = document.getElementById('coords');
const resultBox = document.getElementById('result');
const simBtn = document.getElementById('simulateBtn');
const clearBtn = document.getElementById('clearBtn');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const searchResults = document.getElementById('searchResults');
const yearSel = document.getElementById('year');
const waterInput = document.getElementById('waterLevel');
const fileInput = document.getElementById('areaFile');
const playBtn = document.getElementById('playBtn');
const timeSlider = document.getElementById('timeSlider');
const playerBox = document.getElementById('player');
const playerInfo = document.getElementById('playerInfo');
const progressWrap = document.getElementById('progressWrap');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const cancelBtn = document.getElementById('cancelBtn');

const MAX_DISPLAY = 1000; // longest side of the animated layer, in pixels

// Study area state
let marker = null, circle = null, selected = null;
let uploadedLayer = null, uploadedRings = null;

// Flood state
let floodOverlay = null, externalParameterLayer = null, riverVectorLayer = null, simData = null, elev = null;
let simCanvas = null, simCtx = null, simImg = null;
let playTimer = null, playing = false, pct = 0;
let abortCtl = null;
let latestReportData = null;
let latestRainfall = null;
let latestFeatureStats = null;

// ---------- Depth legend ----------
const legend = L.control({ position: 'bottomleft' });
legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'legend');
    div.innerHTML =
        '<b>Flood depth</b>' +
        '<div class="legend-bar"></div>' +
        '<div class="legend-scale"><span>0 m</span><span id="legendMax"></span></div>';
    return div;
};

// ---------- Logo fallback ----------
document.getElementById('logoImg').addEventListener('error', function () {
    this.style.display = 'none';
    document.getElementById('logoFallback').style.display = 'grid';
});

// ---------- Year dropdown (used by rainfall mode later) ----------
const thisYear = new Date().getFullYear();
for (let y = thisYear; y >= 2000; y--) {
    yearSel.innerHTML += `<option value="${y}">${y}</option>`;
}
document.getElementById('yr').textContent = thisYear;

// ---------- Point and radius ----------
map.on('click', (e) => setPoint(e.latlng));

function setPoint(latlng) {
    clearUploaded();
    if (window.bsoDrawnLayer) window.bsoDrawnLayer.clearLayers();
    selected = latlng;
    if (marker) map.removeLayer(marker);
    marker = L.marker(selected).addTo(map);
    coordsBox.innerHTML = `Lat <b>${selected.lat.toFixed(5)}</b> &nbsp; Lng <b>${selected.lng.toFixed(5)}</b>`;
    drawCircle();
}

function drawCircle() {
    if (!selected) return;
    if (circle) map.removeLayer(circle);
    const km = parseFloat(radiusInput.value) || 1;
    circle = L.circle(selected, {
        radius: km * 1000, color: '#14b8a6', weight: 2, fillColor: '#3b82f6', fillOpacity: 0.12
    }).addTo(map);
}
radiusInput.addEventListener('input', drawCircle);

// A circle becomes a 72-sided polygon, so every study area goes through the same path
function circleRing(center, km) {
    const ring = [];
    const dLat = km / 111.32;
    const dLng = km / (111.32 * Math.cos(center.lat * Math.PI / 180));
    for (let k = 0; k < 72; k++) {
        const a = (2 * Math.PI * k) / 72;
        ring.push([center.lng + dLng * Math.cos(a), center.lat + dLat * Math.sin(a)]);
    }
    ring.push(ring[0]);
    return ring;
}

// ---------- Uploaded area ----------
function clearUploaded() {
    if (uploadedLayer) { map.removeLayer(uploadedLayer); uploadedLayer = null; }
    uploadedRings = null;
}

function ringsFromGeoJson(g) {
    const out = [];
    (function walk(o) {
        if (!o) return;
        if (o.type === 'FeatureCollection' && Array.isArray(o.features)) o.features.forEach(walk);
        else if (o.type === 'Feature') walk(o.geometry);
        else if (o.type === 'GeometryCollection' && Array.isArray(o.geometries)) o.geometries.forEach(walk);
        else if (o.type === 'Polygon' && Array.isArray(o.coordinates?.[0])) out.push(o.coordinates[0].filter(Array.isArray).map(c => [c[0], c[1]]));
        else if (o.type === 'MultiPolygon' && Array.isArray(o.coordinates)) o.coordinates.forEach(poly => { if (Array.isArray(poly?.[0])) out.push(poly[0].filter(Array.isArray).map(c => [c[0], c[1]])); });
    })(g);
    return out;
}

function ringsFromKml(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('The KML file is not valid XML');
    const out = [];
    const polys = doc.getElementsByTagNameNS('*', 'Polygon');
    for (const poly of polys) {
        const outer = poly.getElementsByTagNameNS('*', 'outerBoundaryIs')[0] || poly;
        const coordsEl = outer.getElementsByTagNameNS('*', 'coordinates')[0];
        if (!coordsEl) continue;
        const ring = coordsEl.textContent.trim().split(/\s+/)
            .map(t => t.split(',').map(Number))
            .filter(c => c.length >= 2 && !isNaN(c[0]) && !isNaN(c[1]))
            .map(c => [c[0], c[1]]);
        out.push(ring);
    }
    return out;
}

function validateRings(rings) {
    if (!rings.length) throw new Error('No polygon was found in the file');
    for (const ring of rings) {
        if (ring.length < 3) throw new Error('A polygon has fewer than 3 points');
        for (const [lng, lat] of ring) {
            if (!isFinite(lng) || !isFinite(lat) || Math.abs(lat) > 85 || Math.abs(lng) > 180)
                throw new Error('A coordinate is outside the valid range. Use longitude/latitude (WGS84).');
        }
    }
}

// Rough area in km2 (good enough for a label)
function areaKm2(rings) {
    let total = 0;
    for (const ring of rings) {
        const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
        const kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 111.32;
        let a = 0;
        for (let i = 0; i < ring.length; i++) {
            const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
            a += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky);
        }
        total += Math.abs(a) / 2;
    }
    return total;
}

function setUploaded(rings, name) {
    clearAreaGraphics();
    clearFlood();
    uploadedRings = rings;
    if (!Array.isArray(rings) || !rings.length || rings.some(r => !Array.isArray(r) || r.length < 3)) throw new Error('The selected file did not contain a usable polygon.');
    uploadedLayer = L.featureGroup(
        rings.map(r => L.polygon(r.map(([lng, lat]) => [lat, lng]),
            { color: '#14b8a6', weight: 2, fillColor: '#3b82f6', fillOpacity: 0.12 }))
    ).addTo(map);
    map.fitBounds(uploadedLayer.getBounds());
    coordsBox.innerHTML = `Uploaded: <b>${name}</b><br>${rings.length} polygon(s), about <b>${areaKm2(rings).toFixed(1)} km&sup2;</b>`;
}

fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
        const lower = file.name.toLowerCase();
        let text;
        if (lower.endsWith('.kmz')) {
            if (!window.JSZip) throw new Error('KMZ support library did not load. Refresh and try again.');
            const archive = await JSZip.loadAsync(file);
            const kmlEntry = Object.values(archive.files).find(f => !f.dir && f.name.toLowerCase().endsWith('.kml'));
            if (!kmlEntry) throw new Error('The KMZ archive does not contain a KML file');
            text = await kmlEntry.async('text');
        } else text = await file.text();
        let rings;
        if (lower.endsWith('.kml') || lower.endsWith('.kmz')) rings = ringsFromKml(text);
        else if (lower.endsWith('.geojson') || lower.endsWith('.json')) rings = ringsFromGeoJson(JSON.parse(text));
        else throw new Error('Please upload a .kml, .kmz, .geojson or .json file');
        validateRings(rings);
        setUploaded(rings, file.name);
        resultBox.style.display = 'none';
    } catch (err) {
        showResult('Could not read the file: ' + err.message, true);
    }
    fileInput.value = '';
});

// ---------- Clear ----------
function clearAreaGraphics() {
    if (window.bsoDrawnLayer) window.bsoDrawnLayer.clearLayers();
    if (marker) map.removeLayer(marker);
    if (circle) map.removeLayer(circle);
    marker = circle = selected = null;
    clearUploaded();
}

clearBtn.addEventListener('click', () => {
    if (abortCtl) abortCtl.abort();
    clearAreaGraphics();
    coordsBox.textContent = 'No area selected yet. Click the map, or upload an area below.';
    clearFlood();
    resultBox.style.display = 'none';
});

// ---------- Search (OpenStreetMap Nominatim) ----------
async function searchPlace() {
    const q = searchInput.value.trim();
    if (!q) return;
    searchResults.innerHTML = '<li>Searching...</li>';
    try {
        const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' + encodeURIComponent(q));
        const places = await res.json();
        if (!places.length) { searchResults.innerHTML = '<li>No results found</li>'; return; }
        searchResults.innerHTML = '';
        places.forEach(p => {
            const li = document.createElement('li');
            li.textContent = p.display_name;
            li.addEventListener('click', () => {
                map.flyTo([parseFloat(p.lat), parseFloat(p.lon)], 14);
                searchResults.innerHTML = '';
            });
            searchResults.appendChild(li);
        });
    } catch (err) {
        searchResults.innerHTML = '<li>Search failed. Try again.</li>';
    }
}
searchBtn.addEventListener('click', searchPlace);
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchPlace(); });

// ---------- Flood drawing and animation ----------
function depthColor(t) {
    if (!Number.isFinite(t)) t = 0;
    // pale cyan (shallow) -> blue -> deep navy
    const stops = [[125, 211, 252], [37, 99, 235], [30, 58, 138]];
    const s = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
    const k = Math.min(Math.floor(s), stops.length - 2);
    const f = s - k;
    return stops[k].map((v, i) => Math.round(v + (stops[k + 1][i] - v) * f));
}

function decodeElevations(b64) {
    if (typeof b64 !== 'string' || !b64.length) throw new Error('The elevation service returned an empty elevation block. Please retry the analysis.');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Int16Array(bytes.buffer); // decimetres; -32768 means outside the study area
}

function clearFlood() {
    stopPlay();
    toggleRainEffect(false);
    if (floodOverlay) { map.removeLayer(floodOverlay); floodOverlay = null; }
    if (externalParameterLayer) { map.removeLayer(externalParameterLayer); externalParameterLayer = null; }
    if (riverVectorLayer) { map.removeLayer(riverVectorLayer); riverVectorLayer = null; }
    legend.remove();
    playerBox.style.display = 'none';
    simData = null; elev = null; simCanvas = null; simCtx = null; simImg = null;
}

// Exact number of flooded cells for a water rise given in decimetres above the lowest ground
function floodedAt(d, riseDm) {
    if (riseDm <= 0) return 0;
    return d.cum[Math.min(d.K, Math.ceil(riseDm))];
}

// Paint one frame: water rise = p % of the chosen water level
function renderFrame(p) {
    if (!simData) return;
    const d = simData;
    const water = d.waterLevel * p / 100;
    const levelDm = d.minDm + water * 10;
    const maxDepthDm = Math.max(d.waterLevel * 10, 10);
    const half = Math.floor(d.stride / 2);

    const data = simImg.data;
    data.fill(0);

    for (let di = 0; di < d.dispRows; di++) {
        const i = Math.min(d.rows - 1, di * d.stride + half);
        const rowOut = (d.dispRows - 1 - di) * d.dispCols;   // image row 0 is north
        const base = i * d.cols;
        for (let dj = 0; dj < d.dispCols; dj++) {
            const j = Math.min(d.cols - 1, dj * d.stride + half);
            const v = elev[base + j];
            if (v === -32768 || v >= levelDm) continue;        // outside the area, or dry
            const t = (levelDm - v) / maxDepthDm;
            const c = depthColor(t);
            const o = (rowOut + dj) * 4;
            data[o] = c[0];
            data[o + 1] = c[1];
            data[o + 2] = c[2];
            data[o + 3] = Math.round(150 + 90 * Math.min(t, 1));
        }
    }
    simCtx.putImageData(simImg, 0, 0);
    floodOverlay.setUrl(simCanvas.toDataURL());

    const flooded = floodedAt(d, water * 10);              // exact, uses every cell
    const km2 = flooded * d.cellSizeM * d.cellSizeM / 1e6;
    const percent = (100 * flooded / d.total).toFixed(1);
    playerInfo.innerHTML =
        'Water level: <b>' + water.toFixed(1) + ' m</b> above lowest ground<br>' +
        'Flooded: <b>' + flooded.toLocaleString() + ' cells</b> (' + percent + '%)<br>' +
        'Area: <b>' + km2.toFixed(2) + ' km&sup2;</b>';
}

function stopPlay() {
    playing = false;
    if (playTimer) { clearTimeout(playTimer); playTimer = null; }
    playBtn.textContent = 'Play';
}

function startPlay() {
    if (!simData) return;
    stopPlay();
    if (pct >= 100) pct = 0;
    playing = true;
    playBtn.textContent = 'Pause';

    const tick = () => {
        if (!playing) return;
        const t0 = performance.now();
        renderFrame(pct);
        timeSlider.value = pct;
        const cost = performance.now() - t0;
        if (pct >= 100) { stopPlay(); return; }
        // slow frames (big areas) take bigger steps so the animation keeps a similar length
        pct = Math.min(100, pct + Math.max(1.5, cost / 40));
        playTimer = setTimeout(tick, 30);
    };
    tick();
}

playBtn.addEventListener('click', () => {
    if (playing) stopPlay(); else startPlay();
});

timeSlider.addEventListener('input', () => {
    stopPlay();
    pct = parseFloat(timeSlider.value);
    renderFrame(pct);
});

// Build the flood layer from the assembled elevations
function drawFlood(plan, all, waterLevel) {
    clearFlood();
    elev = all;

    let minDm = 32767, maxDm = -32768, total = 0;
    for (let k = 0; k < all.length; k++) {
        const v = all[k];
        if (v === -32768) continue;
        total++;
        if (v < minDm) minDm = v;
        if (v > maxDm) maxDm = v;
    }
    if (!total) throw new Error('The study area contains no 30 m cells');

    // Lookup table so the flooded count at any water level is exact and instant
    const K = maxDm - minDm + 1;
    const counts = new Uint32Array(K);
    for (let k = 0; k < all.length; k++) {
        const v = all[k];
        if (v !== -32768) counts[v - minDm]++;
    }
    const cum = new Float64Array(K + 1);
    for (let k = 0; k < K; k++) cum[k + 1] = cum[k] + counts[k];

    // Thin the animated layer on very large areas (the figures still use every cell)
    const stride = Math.max(1, Math.ceil(Math.max(plan.rows, plan.cols) / MAX_DISPLAY));
    const dispRows = Math.ceil(plan.rows / stride);
    const dispCols = Math.ceil(plan.cols / stride);

    simData = {
        rows: plan.rows, cols: plan.cols, cellSizeM: plan.cellSizeM,
        waterLevel: waterLevel, minDm: minDm, total: total, K: K, cum: cum,
        stride: stride, dispRows: dispRows, dispCols: dispCols
    };

    simCanvas = document.createElement('canvas');
    simCanvas.width = dispCols;
    simCanvas.height = dispRows;
    simCtx = simCanvas.getContext('2d');
    simImg = simCtx.createImageData(dispCols, dispRows);

    const bounds = [
        [plan.latMin - plan.latStep / 2, plan.lngMin - plan.lngStep / 2],
        [plan.latMin + (dispRows * stride - 0.5) * plan.latStep,
            plan.lngMin + (dispCols * stride - 0.5) * plan.lngStep]
    ];
    floodOverlay = L.imageOverlay(simCanvas.toDataURL(), bounds, {
        interactive: false, className: 'flood-img'
    }).addTo(map);

    legend.addTo(map);
    document.getElementById('legendMax').textContent = Math.max(waterLevel, 1).toFixed(1) + ' m';
    const legendBar=document.querySelector('.legend-bar');
    if(legendBar) legendBar.style.background='linear-gradient(90deg,#7dd3fc,#2563eb,#1e3a8a)';

    playerBox.style.display = 'block';
    pct = 0;
    timeSlider.value = 0;
    startPlay();
}

// ---------- Simulate ----------
function showResult(html, isError = false) {
    resultBox.style.display = 'block';
    resultBox.className = 'result' + (isError ? ' error' : '');
    resultBox.innerHTML = html;
}

function setProgress(frac, text) {
    progressBar.style.width = Math.round(frac * 100) + '%';
    progressText.textContent = text;
}

function currentRings() {
    if (uploadedRings) return uploadedRings;
    if (selected) return [circleRing(selected, parseFloat(radiusInput.value))];
    return null;
}

async function postJson(url, body, signal) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || ('Server returned ' + res.status));
    return data;
}

cancelBtn.addEventListener('click', () => { if (abortCtl) abortCtl.abort(); });

simBtn.addEventListener('click', async () => {
    const rings = currentRings();
    if (!rings) { showResult('Click the map to choose a point, or upload an area first.', true); return; }
    if (!uploadedRings && !(parseFloat(radiusInput.value) > 0)) {
        showResult('Please enter a radius greater than 0.', true); return;
    }
    const waterLevel = parseFloat(waterInput.value);
    if (isNaN(waterLevel) || waterLevel < 0) { showResult('Water level must be 0 or more.', true); return; }

    abortCtl = new AbortController();
    simBtn.disabled = true;
    simBtn.textContent = 'Working...';
    resultBox.style.display = 'none';
    clearFlood();
    progressWrap.style.display = 'block';
    setProgress(0, 'Planning the grid...');
    const t0 = performance.now();

    try {
        const plan = await postJson('/api/plan', { rings: rings }, abortCtl.signal);
        const mode = document.getElementById('analysisMode')?.value || 'water';
        if (['soil','landcover','surfacewater'].includes(mode)) {
            renderExternalParameter(mode, plan);
            latestRainfall = null;
            latestReportData = null; latestRiskAnalysis=null; latestFeatureStats=null; latestParameterStats=null;
            document.getElementById('reportBtn').disabled = true;
            setProgress(1, 'External thematic layer requested.');
            return;
        }
        const all = new Int16Array(plan.rows * plan.cols);
        const intro = plan.rows.toLocaleString() + ' x ' + plan.cols.toLocaleString() + ' cells, about ' +
            plan.estimatedTiles.toLocaleString() + ' terrain tiles. ';

        for (let b = 0; b < plan.bands; b++) {
            const row0 = b * plan.bandRows;
            const row1 = Math.min(plan.rows, row0 + plan.bandRows);
            setProgress(b / plan.bands, intro + 'Terrain block ' + (b + 1) + ' of ' + plan.bands + '...');
            const part = await postJson('/api/band', { rings: rings, row0: row0, row1: row1 }, abortCtl.signal);
            if (!part || typeof part.elevations !== 'string') throw new Error('The elevation service returned an incomplete terrain block (' + (b + 1) + '/' + plan.bands + ').');
            const bandElevations = decodeElevations(part.elevations);
            if (bandElevations.length !== (row1 - row0) * plan.cols) throw new Error('The elevation block dimensions do not match the requested grid. Please retry with a smaller study area.');
            all.set(bandElevations, row0 * plan.cols);
        }

        setProgress(1, 'Building the flood layer...');
        await new Promise(r => setTimeout(r, 30)); // let the bar repaint
        drawFlood(plan, all, waterLevel);

        const d = simData;
        let reportOverlay;
        if (mode === 'rainfall' || mode === 'risk') {
            setProgress(0.92, 'Retrieving annual spatial rainfall for ' + yearSel.value + '…');
            latestRainfall = await postJson('/api/rainfall/spatial', { rings: rings, year: Number(yearSel.value) }, abortCtl.signal);
            stopPlay();
            if (mode === 'rainfall') renderAnnualRainfall(plan, latestRainfall);
            else renderAdvancedRisk(plan, all, latestRainfall);
            reportOverlay = simCanvas ? simCanvas.toDataURL('image/png') : null;
        } else if (mode === 'rivers') {
            latestRainfall = null;
            stopPlay();
            setProgress(0.92, 'Retrieving mapped rivers and streams from OpenStreetMap…');
            const riverData = await postJson('/api/rivers', { rings: rings }, abortCtl.signal);
            renderRiverDistance(plan, all, riverData);
            reportOverlay = simCanvas ? simCanvas.toDataURL('image/png') : null;
        } else if (['elevation','slope','flow'].includes(mode)) {
            latestRainfall = null;
            stopPlay();
            renderTerrainParameter(plan, all, mode);
            reportOverlay = simCanvas ? simCanvas.toDataURL('image/png') : null;
        } else {
            latestRainfall = null;
            stopPlay();
            toggleRainEffect(false);
            renderFrame(100);
            reportOverlay = simCanvas ? simCanvas.toDataURL('image/png') : null;
            renderFrame(0);
            pct = 0; timeSlider.value = 0;
            startPlay();
        }
        latestReportData = {
            plan: plan, elevations: all, waterLevel: waterLevel,
            rings: rings, mode: mode, year: Number(yearSel.value || new Date().getFullYear()),
            overlayPng: reportOverlay,
            overlayBounds: [
                plan.latMin - plan.latStep / 2,
                plan.lngMin - plan.lngStep / 2,
                plan.latMin + (simData.dispRows * simData.stride - 0.5) * plan.latStep,
                plan.lngMin + (simData.dispCols * simData.stride - 0.5) * plan.lngStep
            ],
            stats: {
                studyAreaKm2: (d.total * d.cellSizeM * d.cellSizeM / 1e6),
                cellSizeM: d.cellSizeM
            }
        };
        if (mode === 'water') {
            latestReportData.stats.floodedAreaKm2 = floodedAt(d, waterLevel * 10) * d.cellSizeM * d.cellSizeM / 1e6;
            latestReportData.stats.floodedPercent = 100 * floodedAt(d, waterLevel * 10) / d.total;
            latestReportData.stats.waterLevelM = waterLevel;
        }
        document.getElementById('reportBtn').disabled = false;
        if (latestRainfall) {
            latestReportData.stats.rainfallMeanMm = latestRainfall.meanSampleMm;
            latestReportData.stats.rainfallMinMm = latestRainfall.minSampleMm;
            latestReportData.stats.rainfallMaxMm = latestRainfall.maxSampleMm;
            latestReportData.rainfallSource = latestRainfall.source;
        }
        const flooded = floodedAt(d, waterLevel * 10);
        const cellKm2 = d.cellSizeM * d.cellSizeM / 1e6;
        const secs = ((performance.now() - t0) / 1000).toFixed(1);
        if (mode === 'water') {
            showResult('<h3>Water-level simulation</h3><pre>Analysis grid spacing: ' + d.cellSizeM + ' m (source DEM resolution may differ)' +
                '\nStudy area: ' + (d.total * cellKm2).toFixed(2) + ' km2 (' + d.total.toLocaleString() + ' cells)' +
                '\nFlooded at selected level: ' + (flooded * cellKm2).toFixed(2) + ' km2 (' + (100 * flooded / d.total).toFixed(1) + '%)' +
                '\nLowest ground: ' + (d.minDm / 10).toFixed(1) + ' m' +
                '\nWater level: ' + waterLevel.toFixed(1) + ' m above lowest ground' +
                (d.stride > 1 ? '\nDisplay: every ' + d.stride + 'th cell (figures use all cells)' : '') +
                '\nTime taken: ' + secs + ' s</pre>');
        }
        window.bsoActivateSidebarTab?.('results');
    } catch (err) {
        if (err.name === 'AbortError') showResult('Cancelled.');
        else { console.error('Flood analysis failed:', err); showResult('Request failed: ' + (err?.message || 'Unknown analysis error') + (err?.stack ? '<br><small>See browser console for the error location.</small>' : ''), true); }
        window.bsoActivateSidebarTab?.('results');
    } finally {
        progressWrap.style.display = 'none';
        simBtn.disabled = false;
        simBtn.textContent = 'Run Analysis';
        abortCtl = null;
    }
});

// ---------- Added workflows: drawn study areas, terrain risk, OSM context and PDF report ----------
(function addDrawingTools() {
    if (!L.Control.Draw) return;
    const drawn = new L.FeatureGroup().addTo(map);
    window.bsoDrawnLayer = drawn;
    map.addControl(new L.Control.Draw({
        draw: { polygon: { allowIntersection: false, showArea: true }, rectangle: true,
            circle: false, circlemarker: false, marker: false, polyline: false },
        edit: { featureGroup: drawn, edit: false, remove: false }
    }));
    map.on(L.Draw.Event.CREATED, (e) => {
        drawn.clearLayers();
        drawn.addLayer(e.layer);
        const rings = ringsFromGeoJson(e.layer.toGeoJSON());
        validateRings(rings);
        setUploaded(rings, 'Drawn study area');
        document.getElementById('result').style.display = 'none';
    });
})();

function updateRainClip() {
    const effect = document.getElementById('rainfallEffect');
    if (!effect) return;
    const rings = currentRings();
    if (!rings || !rings.length) { effect.style.clipPath = 'none'; return; }
    const ring = rings[0];
    const points = ring.map(([lng,lat]) => map.latLngToContainerPoint([lat,lng]))
        .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (points.length < 3) return;
    const w = map.getSize().x, h = map.getSize().y;
    const polygon = points.map(p => `${Math.max(0,Math.min(100,p.x/w*100)).toFixed(2)}% ${Math.max(0,Math.min(100,p.y/h*100)).toFixed(2)}%`).join(',');
    effect.style.clipPath = `polygon(${polygon})`;
}
function toggleRainEffect(enabled) {
    const existing = document.getElementById('rainfallEffect');
    if (!enabled) { if (existing) existing.remove(); return; }
    if (existing) { updateRainClip(); return; }
    const effect = document.createElement('div');
    effect.id = 'rainfallEffect';
    effect.setAttribute('aria-hidden', 'true');
    // No cloud: natural individual drops are clipped to the selected study boundary.
    effect.innerHTML = '<div class="rain-drops">' + Array.from({length:46}, (_,i) => '<i style="--x:'+((i*37)%100)+'%;--delay:-'+(((i*17)%31)/10)+'s;--duration:'+ (1.2+((i*13)%13)/10)+'s;--height:'+ (10+(i*7)%15)+'px"></i>').join('') + '</div>';
    map.getContainer().appendChild(effect);
    updateRainClip();
}
map.on('move zoom resize', updateRainClip);

function rainfallAt(lng, lat, samples) {
    let weighted = 0, weights = 0;
    for (const p of samples) {
        const dx = (lng - p.lng) * Math.cos(lat * Math.PI / 180);
        const dy = lat - p.lat;
        const d2 = dx * dx + dy * dy;
        if (d2 < 1e-12) return p.rainfallMm;
        const w = 1 / d2;
        weighted += w * p.rainfallMm;
        weights += w;
    }
    return weights ? weighted / weights : 0;
}

function renderAnnualRainfall(plan, rainfall) {
    toggleRainEffect(true);
    if (!simData || !simCanvas || !simCtx || !floodOverlay) return;
    const d = simData, half = Math.floor(d.stride / 2), pixels = simImg.data;
    const grid = new Float32Array(d.dispRows * d.dispCols);
    let min = Infinity, max = -Infinity, sum = 0, count = 0;
    for (let r = 0; r < d.dispRows; r++) {
        const srcR = Math.min(d.rows - 1, r * d.stride + half);
        const lat = plan.latMin + srcR * plan.latStep;
        for (let c = 0; c < d.dispCols; c++) {
            const srcC = Math.min(d.cols - 1, c * d.stride + half);
            if (elev[srcR * d.cols + srcC] === -32768) continue;
            const lng = plan.lngMin + srcC * plan.lngStep;
            const v = rainfallAt(lng, lat, rainfall.samples);
            grid[r * d.dispCols + c] = v;
            min = Math.min(min, v); max = Math.max(max, v); sum += v; count++;
        }
    }
    if (!count) throw new Error('No rainfall cells overlap the selected study area.');
    pixels.fill(0);
    for (let r = 0; r < d.dispRows; r++) for (let c = 0; c < d.dispCols; c++) {
        const srcR = Math.min(d.rows - 1, r * d.stride + half), srcC = Math.min(d.cols - 1, c * d.stride + half);
        if (elev[srcR * d.cols + srcC] === -32768) continue;
        const t = max === min ? 0.5 : (grid[r * d.dispCols + c] - min) / (max - min);
        const color = rainfallColor(t), o = ((d.dispRows - 1 - r) * d.dispCols + c) * 4;
        pixels[o] = color[0]; pixels[o + 1] = color[1]; pixels[o + 2] = color[2]; pixels[o + 3] = 205;
    }
    simCtx.putImageData(simImg, 0, 0);
    floodOverlay.setUrl(simCanvas.toDataURL());
    setLegend('Rainfall (' + rainfall.year + ')', 'linear-gradient(90deg,#eff6ff,#60a5fa,#facc15,#f97316,#991b1b)', min.toFixed(0) + ' mm', max.toFixed(0) + ' mm');
    playerBox.style.display = 'none';
    playerInfo.innerHTML = 'Rainfall for <b>' + rainfall.year + '</b>' + (rainfall.partialYear ? ' (year-to-date)' : '');
    showResult('<h3>Rainfall — ' + rainfall.year + '</h3><pre>Estimated mean: ' + (sum / count).toFixed(1) + ' mm\nLowest mapped value: ' + min.toFixed(1) + ' mm\nHighest mapped value: ' + max.toFixed(1) + ' mm\nSpatial samples: ' + rainfall.samples.length + '\nData through: ' + rainfall.dataThrough + '\nSource: ' + rainfall.source + '\nMethod: inverse-distance interpolation between sampled annual rainfall values.</pre>');
}

// Public WMS layers: visual thematic layers from the authoritative source services.
function renderExternalParameter(mode, plan) {
    toggleRainEffect(false);
    if (externalParameterLayer) { map.removeLayer(externalParameterLayer); externalParameterLayer = null; }
    if (floodOverlay) { map.removeLayer(floodOverlay); floodOverlay = null; }
    const configs = {
        soil: {
            url: 'https://maps.isric.org/mapserv?map=/map/clay.map',
            layers: 'clay_0-5cm_mean', version: '1.1.1', title: 'Soil clay content (0–5 cm)',
            low: 'Lower clay', high: 'Higher clay',
            attribution: 'SoilGrids / ISRIC (CC BY 4.0)',
            note: 'SoilGrids clay content, 0–5 cm depth, mean prediction. This is a soil-texture indicator, not a direct field measurement of infiltration.'
        },
        landcover: {
            url: 'https://ows.digitalearth.africa/wms',
            layers: 'esa_worldcover_2021', version: '1.3.0', title: 'Land use / land cover (2021)',
            low: 'Class 10', high: 'Class 100',
            attribution: 'ESA WorldCover 2021 / Digital Earth Africa (CC BY 4.0)',
            note: 'ESA WorldCover 2021 categorical land-cover map at 10 m product resolution. WMS is a map-image service; class values are not currently extracted into the numeric overlay.'
        },
        surfacewater: {
            url: 'https://ows.digitalearth.africa/wms',
            layers: 'wofs_ls_summary_alltime', version: '1.3.0', title: 'Historical surface-water observations',
            low: 'Less observed water', high: 'More observed water',
            attribution: 'Digital Earth Africa Water Observations from Space',
            note: 'Historical Landsat water observations from Digital Earth Africa. It is a historical water-observation layer, not a current flood extent or a forecast.'
        }
    };
    const cfg = configs[mode];
    if (!cfg) throw new Error('Unknown external parameter layer');
    let tileErrors = 0;
    externalParameterLayer = L.tileLayer.wms(cfg.url, {
        layers: cfg.layers, version: cfg.version, format: 'image/png', transparent: true,
        opacity: 0.82, attribution: cfg.attribution, tiled: true
    });
    externalParameterLayer.on('tileerror', () => {
        tileErrors++;
        if (tileErrors === 3) showResult('<h3>External data service unavailable</h3><pre>The selected public WMS service did not return map tiles. Check your internet connection or try again later. No substitute or fabricated data has been drawn.</pre>', true);
    });
    externalParameterLayer.addTo(map);
    legend.addTo(map);
    setLegend(cfg.title, 'linear-gradient(90deg,#eff6ff,#60a5fa,#facc15,#f97316,#991b1b)', cfg.low, cfg.high);
    playerBox.style.display = 'none';
    playerInfo.textContent = cfg.title + ' — public WMS layer.';
    showResult('<h3>' + cfg.title + '</h3><pre>' + cfg.note + '\n\nSource: ' + cfg.attribution + '\nStudy-area boundary remains visible. This service is displayed as a thematic map image; it is not silently converted into raster cell values for weighted overlay.</pre>');
}

function renderRiverDistance(plan, all, riverData) {
    toggleRainEffect(false);
    const t = buildTerrainLayers(plan, all), d = simData, n = d.dispRows * d.dispCols;
    const source = new Uint8Array(n), elements = Array.isArray(riverData?.elements) ? riverData.elements : [];
    let segments = 0;
    const toGrid = (p) => ({
        x: (Number(p.lon) - plan.lngMin) / (plan.lngStep * d.stride),
        y: (Number(p.lat) - plan.latMin) / (plan.latStep * d.stride)
    });
    const paintLine = (a,b) => {
        let x0=Math.round(a.x), y0=Math.round(a.y), x1=Math.round(b.x), y1=Math.round(b.y);
        const dx=Math.abs(x1-x0), sx=x0<x1?1:-1, dy=-Math.abs(y1-y0), sy=y0<y1?1:-1;
        let err=dx+dy;
        while(true){ if(x0>=0&&y0>=0&&x0<d.dispCols&&y0<d.dispRows) source[y0*d.dispCols+x0]=1;
            if(x0===x1&&y0===y1)break; const e2=2*err; if(e2>=dy){err+=dy;x0+=sx;} if(e2<=dx){err+=dx;y0+=sy;} }
    };
    for (const el of elements) {
        const geom = Array.isArray(el.geometry) ? el.geometry : [];
        for (let i=1;i<geom.length;i++) { paintLine(toGrid(geom[i-1]),toGrid(geom[i])); segments++; }
    }
    if (!segments) throw new Error('No mapped rivers or streams were returned for this area. Check OSM coverage or try a smaller area.');
    const dist = new Float32Array(n); dist.fill(Infinity);
    for(let i=0;i<n;i++) if(source[i]) dist[i]=0;
    const dx=plan.cellSizeM*d.stride*Math.max(.15,Math.cos(((plan.latMin+plan.latMax)/2)*Math.PI/180));
    const dy=plan.cellSizeM*d.stride, diag=Math.hypot(dx,dy);
    for(let r=0;r<d.dispRows;r++)for(let c=0;c<d.dispCols;c++){
        const i=r*d.dispCols+c;if(!t.valid[i]||source[i])continue;let v=dist[i];
        if(c>0)v=Math.min(v,dist[i-1]+dx);if(r>0)v=Math.min(v,dist[i-d.dispCols]+dy);
        if(r>0&&c>0)v=Math.min(v,dist[i-d.dispCols-1]+diag);if(r>0&&c+1<d.dispCols)v=Math.min(v,dist[i-d.dispCols+1]+diag);dist[i]=v;
    }
    for(let r=d.dispRows-1;r>=0;r--)for(let c=d.dispCols-1;c>=0;c--){
        const i=r*d.dispCols+c;if(!t.valid[i]||source[i])continue;let v=dist[i];
        if(c+1<d.dispCols)v=Math.min(v,dist[i+1]+dx);if(r+1<d.dispRows)v=Math.min(v,dist[i+d.dispCols]+dy);
        if(r+1<d.dispRows&&c+1<d.dispCols)v=Math.min(v,dist[i+d.dispCols+1]+diag);if(r+1<d.dispRows&&c>0)v=Math.min(v,dist[i+d.dispCols-1]+diag);dist[i]=v;
    }
    let maxFinite=0; for(let i=0;i<n;i++) if(t.valid[i]&&Number.isFinite(dist[i])) maxFinite=Math.max(maxFinite,dist[i]);
    for(let i=0;i<n;i++) if(t.valid[i]&&!Number.isFinite(dist[i])) dist[i]=maxFinite;
    const stats=renderGrid({values:dist},'Distance to mapped rivers and streams','m','linear-gradient(90deg,#991b1b,#f97316,#facc15,#60a5fa,#1d4ed8)');
    showResult('<h3>Distance to mapped rivers and streams</h3><pre>OSM river/stream ways: '+elements.length.toLocaleString()+'\nLine segments: '+segments.toLocaleString()+'\nMinimum distance: '+stats.min.toFixed(1)+' m\nMaximum distance: '+stats.max.toFixed(1)+' m\nMean distance: '+stats.mean.toFixed(1)+' m\n\nSource: OpenStreetMap waterway features. This is distance to mapped waterways, not a surveyed or complete river inventory. Distance is approximated on the display grid.</pre>');
    playerInfo.textContent='Distance to mapped rivers and streams. OSM linework rasterised to the display grid.';
}

function rainfallColor(t) {
    if (!Number.isFinite(t)) t = 0.5;
    const stops = [[239,246,255],[96,165,250],[250,204,21],[249,115,22],[153,27,27]];
    const s = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const k = Math.min(Math.floor(s), stops.length - 2), f = s - k;
    return stops[k].map((v, i) => Math.round(v + (stops[k + 1][i] - v) * f));
}

function setLegend(title, gradient, low, high) {
    const el = document.querySelector('.legend');
    if (el) {
        const bar = el.querySelector('.legend-bar');
        const heading = el.querySelector('b');
        if (heading) heading.textContent = title;
        if (bar) bar.style.background = gradient;
        const scale = el.querySelector('.legend-scale');
        if (scale) scale.innerHTML = '<span>' + low + '</span><span>' + high + '</span>';
    }
}

// ---------- Individual GIS parameter layers and weighted overlay ----------
const factorMeta = {
    elevation: {title:'Elevation', units:'m', risk:'Lower terrain is treated as relatively more susceptible.'},
    slope: {title:'Slope', units:'degrees', risk:'Flatter terrain receives a higher screening score.'},
};
let terrainCache = null;
function buildTerrainLayers(plan, all) {
    if (!simData || !plan || !all || all.length !== plan.rows * plan.cols) throw new Error('Slope could not be derived because the elevation grid is missing or incomplete. Run the analysis again and check the elevation service.');
    const d=simData, n=d.dispRows*d.dispCols, half=Math.floor(d.stride/2);
    const z=new Float32Array(n), valid=new Uint8Array(n), slope=new Float32Array(n);
    // The source grid is approximately square in ground metres in both directions.
    const cellY=plan.cellSizeM*d.stride, cellX=plan.cellSizeM*d.stride;
    let zmin=Infinity,zmax=-Infinity;
    for(let r=0;r<d.dispRows;r++) for(let c=0;c<d.dispCols;c++){
        const sr=Math.min(d.rows-1,r*d.stride+half), sc=Math.min(d.cols-1,c*d.stride+half), v=all[sr*d.cols+sc]/10, i=r*d.dispCols+c;
        if(all[sr*d.cols+sc]===-32768) continue;
        z[i]=v;valid[i]=1;zmin=Math.min(zmin,v);zmax=Math.max(zmax,v);
    }
    const at=(r,c)=>r<0||c<0||r>=d.dispRows||c>=d.dispCols?NaN:(valid[r*d.dispCols+c]?z[r*d.dispCols+c]:NaN);
    for(let r=0;r<d.dispRows;r++) for(let c=0;c<d.dispCols;c++){
        const i=r*d.dispCols+c;if(!valid[i])continue;
        const l=at(r,c-1),rr=at(r,c+1),u=at(r-1,c),dn=at(r+1,c);
        const dzdx=Number.isFinite(l)&&Number.isFinite(rr)?(rr-l)/(2*cellX):Number.isFinite(rr)?(rr-z[i])/cellX:Number.isFinite(l)?(z[i]-l)/cellX:0;
        const dzdy=Number.isFinite(u)&&Number.isFinite(dn)?(dn-u)/(2*cellY):Number.isFinite(dn)?(dn-z[i])/cellY:Number.isFinite(u)?(z[i]-u)/cellY:0;
        slope[i]=Math.atan(Math.hypot(dzdx,dzdy))*180/Math.PI;
    }
    // D8-style steepest-downhill routing on the displayed analysis grid.
    const acc=new Float32Array(n);acc.fill(1);const downstream=new Int32Array(n);downstream.fill(-1);
    const dirs=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
    const order=[];
    for(let i=0;i<n;i++)if(valid[i])order.push(i);
    order.sort((a,b)=>z[b]-z[a]);
    for(const i of order){const r=Math.floor(i/d.dispCols),c=i%d.dispCols;let best=0,bestIdx=-1;
        for(const [dr,dc] of dirs){const nr=r+dr,nc=c+dc;if(nr<0||nc<0||nr>=d.dispRows||nc>=d.dispCols)continue;const j=nr*d.dispCols+nc;if(!valid[j])continue;
            const dist=Math.hypot(dc*cellX,dr*cellY),grad=(z[i]-z[j])/dist;if(grad>best){best=grad;bestIdx=j;}}
        downstream[i]=bestIdx;
    }
    for(const i of order){const j=downstream[i];if(j>=0)acc[j]+=acc[i];}
    terrainCache={z,valid,slope,acc,zmin,zmax,cellX,cellY};return terrainCache;
}
function normGrid(values,valid,invert=false,log=false){let lo=Infinity,hi=-Infinity;for(let i=0;i<values.length;i++)if(valid[i]&&Number.isFinite(values[i])){const v=log?Math.log1p(Math.max(0,values[i])):values[i];lo=Math.min(lo,v);hi=Math.max(hi,v);}
    const out=new Float32Array(values.length);for(let i=0;i<values.length;i++)if(valid[i]){let v=log?Math.log1p(Math.max(0,values[i])):values[i];out[i]=hi===lo?.5:(v-lo)/(hi-lo);if(invert)out[i]=1-out[i];}return {values:out,min:lo,max:hi};}

const riskClassLabels=['Very Low','Low','Moderate','High','Very High'];
const manualReclassConfig={};
function observedRange(values,valid){let min=Infinity,max=-Infinity;for(let i=0;i<values.length;i++)if(valid[i]&&Number.isFinite(values[i])){min=Math.min(min,values[i]);max=Math.max(max,values[i]);}return {min,max};}
function defaultClassRows(min,max,invert){const step=(max-min)/5;return riskClassLabels.map((label,i)=>{const lowRiskFirst=invert?4-i:i;return {label,min:min+lowRiskFirst*step,max:min+(lowRiskFirst+1)*step,score:(i+1)/5};});}
function renderReclassificationTables(ranges){
    const host=document.getElementById('reclassificationTables');if(!host)return;
    const meta={rainfall:{title:'Rainfall (mm)',invert:false,range:ranges.rainfall},elevation:{title:'Elevation (m)',invert:true,range:ranges.elevation},slope:{title:'Slope (degrees)',invert:true,range:ranges.slope}};
    for(const [key,m] of Object.entries(meta)){
        const old=manualReclassConfig[key];
        if(!old||old.observedMin!==m.range.min||old.observedMax!==m.range.max){manualReclassConfig[key]={observedMin:m.range.min,observedMax:m.range.max,rows:defaultClassRows(m.range.min,m.range.max,m.invert)};}
    }
    host.innerHTML=Object.entries(meta).map(([key,m])=>{
        const rows=manualReclassConfig[key].rows;
        return `<div class="reclass-factor"><h3>${m.title}</h3><p class="reclass-hint">Observed range: ${m.range.min.toFixed(2)} to ${m.range.max.toFixed(2)}. Edit the minimum, maximum and score for each risk class.</p><div class="reclass-table-wrap"><table class="reclass-table"><thead><tr><th>Risk class</th><th>Minimum</th><th>Maximum</th><th>Normalised value (0–1.0)</th></tr></thead><tbody>${rows.map((r,i)=>`<tr><td class="class-name">${r.label}</td><td><input type="number" step="any" data-reclass-factor="${key}" data-reclass-row="${i}" data-reclass-field="min" value="${Number(r.min.toFixed(4))}"></td><td><input type="number" step="any" data-reclass-factor="${key}" data-reclass-row="${i}" data-reclass-field="max" value="${Number(r.max.toFixed(4))}"></td><td><input type="number" min="0" max="1" step="0.01" data-reclass-factor="${key}" data-reclass-row="${i}" data-reclass-field="score" value="${r.score.toFixed(2)}"></td></tr>`).join('')}</tbody></table></div></div>`;
    }).join('');
    host.querySelectorAll('[data-reclass-factor]').forEach(input=>input.addEventListener('input',()=>{
        const {reclassFactor:key,reclassRow,reclassField}=input.dataset;const value=Number(input.value);
        if(Number.isFinite(value))manualReclassConfig[key].rows[Number(reclassRow)][reclassField]=value;
    }));
}
function reclassifyRiskFactor(values,valid,factor){
    const range=observedRange(values,valid),cfg=manualReclassConfig[factor];
    if(!cfg)throw new Error('Run the analysis once to create the '+factor+' class table.');
    const rows=cfg.rows;
    for(let i=0;i<rows.length;i++){
        const r=rows[i];if(!Number.isFinite(r.min)||!Number.isFinite(r.max)||r.min>r.max)throw new Error('Check the minimum and maximum values in the '+factor+' reclassification table.');
        if(!Number.isFinite(r.score)||r.score<0||r.score>1)throw new Error('Normalised values must be between 0 and 1.0.');
        if(i>0){const prev=rows[i-1];if(Math.abs(prev.max-r.min)>1e-6&&Math.abs(prev.min-r.max)>1e-6)throw new Error('The '+factor+' class ranges must be continuous and ordered, with no gaps or overlaps.');}
    }
    const lo=Math.min(...rows.map(r=>r.min)),hi=Math.max(...rows.map(r=>r.max));
    if(range.min<lo-1e-6||range.max>hi+1e-6)throw new Error('The '+factor+' class ranges must cover the full observed range ('+range.min.toFixed(2)+' to '+range.max.toFixed(2)+').');
    const out=new Float32Array(values.length);out.fill(NaN);
    for(let i=0;i<values.length;i++)if(valid[i]&&Number.isFinite(values[i])){
        const v=values[i];let row=(Math.abs(range.max-range.min)<1e-9&&Math.abs(rows[0].max-rows[0].min)<1e-9)?rows[2]:rows.find((r,j)=>v>=r.min-1e-9&&(j===rows.length-1?v<=r.max+1e-9:v<r.max-1e-9));
        if(!row)row=rows.find(r=>v>=r.min-1e-9&&v<=r.max+1e-9);
        if(!row)throw new Error('A '+factor+' value falls outside the entered class ranges.');
        out[i]=row.score;
    }
    return {values:out,min:range.min,max:range.max,breaks:rows.map((r,i)=>({class:i+1,min:r.min,max:r.max,score:r.score}))};
}
function slopeCartographicColor(degrees){
    // Conventional graduated slope tint: green (gentle) through yellow/orange to red (steep).
    if(degrees < 2) return [26,152,80];
    if(degrees < 5) return [145,207,96];
    if(degrees < 15) return [254,224,139];
    if(degrees < 30) return [252,141,89];
    return [215,48,39];
}
function elevationTint(t){
    const stops=[[31,120,64],[166,206,57],[255,235,130],[191,128,73],[250,250,245]];
    const x=Math.max(0,Math.min(1,t))*(stops.length-1),k=Math.min(Math.floor(x),stops.length-2),f=x-k;
    return stops[k].map((v,i)=>Math.round(v+(stops[k+1][i]-v)*f));
}
function renderGrid(grid,title,units,gradient,low,high){
    if(!simData||!simImg||!simCtx||!floodOverlay||!terrainCache?.valid) throw new Error('The analysis grid is not ready. Please run the analysis again.');
    const d=simData,pixels=simImg.data;pixels.fill(0);let lo=Infinity,hi=-Infinity,count=0,sum=0;
    for(let i=0;i<grid.values.length;i++)if(terrainCache.valid[i]&&Number.isFinite(grid.values[i])){lo=Math.min(lo,grid.values[i]);hi=Math.max(hi,grid.values[i]);sum+=grid.values[i];count++;}
    if(!count) throw new Error('No valid '+title.toLowerCase()+' cells were produced. Check the elevation coverage for this study area.');
    for(let r=0;r<d.dispRows;r++)for(let c=0;c<d.dispCols;c++){
        const i=r*d.dispCols+c;if(!terrainCache.valid[i]||!Number.isFinite(grid.values[i]))continue;
        const value=grid.values[i],t=hi===lo?.5:(value-lo)/(hi-lo);
        const color=title==='Slope'?slopeCartographicColor(value):title==='Elevation'?elevationTint(t):rainfallColor(t);
        const o=((d.dispRows-1-r)*d.dispCols+c)*4;pixels[o]=color[0];pixels[o+1]=color[1];pixels[o+2]=color[2];pixels[o+3]=220;
    }
    simCtx.putImageData(simImg,0,0);floodOverlay.setUrl(simCanvas.toDataURL());
    const slopeLegend='linear-gradient(90deg,#1a9850 0%,#91cf60 20%,#fee08b 40%,#fc8d59 70%,#d73027 100%)';
    const elevLegend='linear-gradient(90deg,#1f7840,#a6ce39,#ffeb82,#bf8049,#fafaf5)';
    setLegend(title,title==='Slope'?slopeLegend:title==='Elevation'?elevLegend:gradient,
        low??(title==='Slope'?'0°':lo.toFixed(2)+' '+units),high??(title==='Slope'?'30°+':hi.toFixed(2)+' '+units));
    playerBox.style.display='none';return {min:lo,max:hi,mean:sum/count,count};
}
function renderTerrainParameter(plan,all,mode){toggleRainEffect(false);const t=buildTerrainLayers(plan,all);let grid,title,units,info;
    if(mode==='elevation'){grid={values:t.z};title='Elevation';units='m';}
    if(mode==='slope'){grid={values:t.slope};title='Slope';units='degrees';}
    if(mode==='flow'){grid={values:t.acc};title='Flow accumulation';units='upstream cells';grid={values:Float32Array.from(t.acc,v=>Math.log1p(v))};units='log-scaled upstream cells';}
    const stats=renderGrid(grid,title,units,'linear-gradient(90deg,#eff6ff,#60a5fa,#facc15,#f97316,#991b1b)');
    latestParameterStats={title,units,...stats,source:'AWS Terrain Tiles (Terrarium)',cellSizeM:simData.cellSizeM};
    info=(factorMeta[mode]?.risk||'');
    showResult('<h3>'+title+(title==='Elevation'?' (AWS Terrain Tiles)':'')+' — individual layer</h3><pre>Source: AWS Terrain Tiles (Terrarium)\nAnalysis grid: '+simData.cellSizeM+' m\nMinimum: '+stats.min.toFixed(2)+' '+units+'\nMaximum: '+stats.max.toFixed(2)+' '+units+'\nMean: '+stats.mean.toFixed(2)+' '+units+'\nValid cells: '+stats.count.toLocaleString()+'\n'+info+'</pre>');
    playerInfo.textContent=title+' layer. Inspect this parameter before running the final overlay.';
}
function renderAdvancedRisk(plan,all,rainfall){
    toggleRainEffect(false);
    const t=buildTerrainLayers(plan,all),d=simData,n=d.dispRows*d.dispCols,half=Math.floor(d.stride/2);
    const rain=new Float32Array(n);
    for(let r=0;r<d.dispRows;r++)for(let c=0;c<d.dispCols;c++){
        const sr=Math.min(d.rows-1,r*d.stride+half),sc=Math.min(d.cols-1,c*d.stride+half),i=r*d.dispCols+c;
        if(t.valid[i])rain[i]=rainfallAt(plan.lngMin+sc*plan.lngStep,plan.latMin+sr*plan.latStep,rainfall.samples);
    }
    // Populate editable class tables from observed values on the first run.
    const observed={rainfall:observedRange(rain,t.valid),elevation:observedRange(t.z,t.valid),slope:observedRange(t.slope,t.valid)};
    renderReclassificationTables(observed);
    const factors={rainfall:reclassifyRiskFactor(rain,t.valid,'rainfall'),elevation:reclassifyRiskFactor(t.z,t.valid,'elevation'),slope:reclassifyRiskFactor(t.slope,t.valid,'slope')};
    const inputs=[...document.querySelectorAll('.weight-input')],weights={};let sum=0;
    for(const el of inputs){const v=Math.max(0,Number(el.value)||0);weights[el.dataset.factor]=v;sum+=v;}
    if(sum<=0)throw new Error('At least one factor weight must be greater than zero.');
    const labels=['Very Low','Low','Moderate','High','Very High'];
    const colors=[[22,101,52],[132,204,22],[250,204,21],[249,115,22],[185,28,28]];
    const counts=[0,0,0,0,0],scoreGrid=new Float32Array(n),classGrid=new Int8Array(n);classGrid.fill(-1);
    const pixels=simImg.data;pixels.fill(0);
    for(let i=0;i<n;i++){
        if(!t.valid[i])continue;
        let score=0,used=0;
        for(const k of Object.keys(weights))if(weights[k]>0&&factors[k]){score+=(weights[k]/sum)*factors[k].values[i];used+=weights[k];}
        if(!used)continue;
        score=Math.max(0,Math.min(1,score));
        scoreGrid[i]=score;
        const cls=Math.min(4,Math.floor(score*5));classGrid[i]=cls;counts[cls]++;
        const r=Math.floor(i/d.dispCols),c=i%d.dispCols,o=((d.dispRows-1-r)*d.dispCols+c)*4,col=colors[cls];
        pixels[o]=col[0];pixels[o+1]=col[1];pixels[o+2]=col[2];pixels[o+3]=220;
    }
    simCtx.putImageData(simImg,0,0);floodOverlay.setUrl(simCanvas.toDataURL());
    setLegend('Flood Susceptibility Index','linear-gradient(90deg,#166534,#84cc16,#facc15,#f97316,#b91c1c)','Very Low','Very High');
    playerBox.style.display='none';
    const weightText=Object.entries(weights).filter(([k,v])=>v>0).map(([k,v])=>k+': '+(100*v/sum).toFixed(1)+'%').join('\n');
    const ranges=labels.map((label,i)=>({label,min:(i*.2).toFixed(1),max:((i+1)*.2).toFixed(1),count:counts[i]}));
    latestRiskAnalysis={labels,colors,counts,scoreGrid,classGrid,rows:d.dispRows,cols:d.dispCols,stride:d.stride,weights:Object.fromEntries(Object.entries(weights).map(([k,v])=>[k,v/sum])),factorRanges:{rainfall:[factors.rainfall.min,factors.rainfall.max],elevation:[factors.elevation.min,factors.elevation.max],slope:[factors.slope.min,factors.slope.max]},factorClassBreaks:{rainfall:factors.rainfall.breaks,elevation:factors.elevation.breaks,slope:factors.slope.breaks},ranges};
    const zoneText=ranges.map(x=>x.label+' ('+x.min+'–'+x.max+'): '+x.count.toLocaleString()+' grid samples').join('\n');
    const fmtBreaks=a=>a.map(b=>b.min.toFixed(2)+'–'+b.max.toFixed(2)+' (score '+b.score.toFixed(2)+')').join(' | ');
    const factorBreakText='Factor value ranges, ordered Very Low to Very High risk:\nRainfall (mm): '+fmtBreaks(factors.rainfall.breaks)+'\nElevation (m): '+fmtBreaks(factors.elevation.breaks)+'\nSlope (degrees): '+fmtBreaks(factors.slope.breaks);
    showResult('<h3>Flood Susceptibility Index — '+rainfall.year+'</h3><pre>Normalised factor weights:\n'+weightText+'\n\nFactor reclassification ranges (Very Low to Very High risk):\n'+factorBreakText+'\n\nFinal index zones (0–1):\n'+zoneText+'\n\nThe entered class limits and normalised values are used directly to calculate the weighted index (0–1). Higher rainfall, lower elevation and gentler slope are assigned to higher susceptibility classes. The weighted index is classified from 0 to 1 into five zones.</pre>');
    playerInfo.textContent='Flood Susceptibility Index: rainfall, elevation and slope combined using the selected normalised weights.';
}
let latestRiskAnalysis=null;
let latestParameterStats=null;

function updateModeControls(){const mode=document.getElementById('analysisMode').value;document.getElementById('overlayWeights').style.display=mode==='risk'?'block':'none';const reclassPanel=document.getElementById('reclassificationPanel');if(reclassPanel)reclassPanel.style.display=mode==='risk'?'block':'none';document.getElementById('modeHelp').textContent=mode==='risk'?'Combines the three available numeric layers: rainfall, elevation and slope. Set their relative weights in Flood Inputs.':mode==='rainfall'?'Maps rainfall for the selected year using sampled historical estimates and IDW interpolation.':mode==='water'?'Animated water-level scenario above the lowest sampled ground. This is a terrain bathtub simulation, not routed hydraulic flow.':mode==='elevation'?'Displays the sampled terrain elevation surface.':'Displays terrain slope calculated from the sampled elevation grid.';}
document.getElementById('analysisMode')?.addEventListener('change',updateModeControls);
updateModeControls();
document.querySelectorAll('.weight-input').forEach(el=>el.addEventListener('input',()=>{let total=[...document.querySelectorAll('.weight-input')].reduce((a,x)=>a+Math.max(0,Number(x.value)||0),0);document.getElementById('weightTotal').textContent='Entered total: '+total.toFixed(1)+'% (normalised automatically)';}));

function pointInRing(lon,lat,ring) {
    let inside=false;
    for(let i=0,j=ring.length-1;i<ring.length;j=i++){
        const xi=ring[i][0],yi=ring[i][1],xj=ring[j][0],yj=ring[j][1];
        const intersect=((yi>lat)!==(yj>lat))&&(lon<(xj-xi)*(lat-yi)/(yj-yi+1e-20)+xi);
        if(intersect) inside=!inside;
    }
    return inside;
}
function pointInStudy(lon,lat,rings){return rings.some(r=>pointInRing(lon,lat,r));}

const osmCategoryRules = [
    ['Buildings', t => !!t.building],
    ['Roads & paths', t => !!t.highway],
    ['Railways', t => !!t.railway],
    ['Waterways', t => !!t.waterway],
    ['Water bodies', t => t.natural === 'water' || !!t.water || t.landuse === 'reservoir'],
    ['Land cover & land use', t => !!t.landuse || !!t.natural],
    ['Healthcare', t => !!t.healthcare || ['hospital','clinic','doctors','dentist'].includes(t.amenity)],
    ['Education', t => ['school','university','college','kindergarten'].includes(t.amenity) || !!t.education],
    ['Amenities & public services', t => !!t.amenity],
    ['Leisure & recreation', t => !!t.leisure],
    ['Tourism', t => !!t.tourism],
    ['Shops & offices', t => !!t.shop || !!t.office],
    ['Public transport', t => !!t.public_transport || !!t.bus || !!t.aerialway],
    ['Power & utilities', t => !!t.power || !!t.utility],
    ['Man-made infrastructure', t => !!t.man_made || !!t.barrier],
    ['Boundaries & places', t => !!t.boundary || !!t.place],
    ['Aviation', t => !!t.aeroway],
    ['Other mapped features', t => Object.keys(t).some(k => !['name','name:en','source','created_by','odbl','fixme','note','attribution','wikidata','wikipedia'].includes(k))]
];
function classifyOsmFeature(tags={}) { return (osmCategoryRules.find(([,test])=>test(tags))||['Other mapped features'])[0]; }
function riskClassAtFeature(lon,lat){
    const risk=latestRiskAnalysis,plan=latestReportData?.plan;
    if(!risk||!plan)return null;
    const row=Math.round((lat-plan.latMin)/plan.latStep),col=Math.round((lon-plan.lngMin)/plan.lngStep);
    const half=Math.floor(risk.stride/2),dr=Math.min(risk.rows-1,Math.max(0,Math.round((row-half)/risk.stride))),dc=Math.min(risk.cols-1,Math.max(0,Math.round((col-half)/risk.stride)));
    if(row<0||col<0||row>=plan.rows||col>=plan.cols)return null;
    const cls=risk.classGrid[dr*risk.cols+dc];return cls>=0?cls:null;
}
function drawOsmFeatureChart(stats){
    const canvas=document.getElementById('osmFeatureChart');if(!canvas)return;
    if(typeof Chart==='undefined'){document.getElementById('osmChartFallback').textContent='Chart library unavailable; the table below contains the counts.';return;}
    if(window.bsoOsmChart)window.bsoOsmChart.destroy();
    const labels=['Very Low','Low','Moderate','High','Very High'];
    const values=labels.map((_,i)=>stats.zoneTotals[i]||0);
    window.bsoOsmChart=new Chart(canvas,{type:'bar',data:{labels,datasets:[{label:'Mapped OSM features',data:values,backgroundColor:['#166534','#84cc16','#facc15','#f97316','#b91c1c'],borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>c.raw.toLocaleString()+' features'}}},scales:{y:{beginAtZero:true,ticks:{precision:0}}}}});
}
document.getElementById('featuresBtn')?.addEventListener('click', async () => {
    const rings=currentRings(), box=document.getElementById('featuresResult'), btn=document.getElementById('featuresBtn');
    if(!rings){box.textContent='Select or draw a study area first.';return;}
    if(!latestRiskAnalysis){box.textContent='Run Flood Susceptibility Index first. OSM features will then be counted in each of its five risk zones.';return;}
    const pts=rings.flat(), lons=pts.map(p=>p[0]), lats=pts.map(p=>p[1]);
    const south=Math.min(...lats),west=Math.min(...lons),north=Math.max(...lats),east=Math.max(...lons);
    if(![south,west,north,east].every(Number.isFinite)){box.textContent='The study boundary coordinates are invalid.';return;}
    btn.disabled=true;box.textContent='Querying OpenStreetMap Overpass for mapped geographic features…';
    // Query all tagged OSM nodes, ways and relations in the bbox; exact AOI membership is checked locally.
    try{
        // Query Overpass through Spring Boot rather than the browser. This avoids
        // browser CORS failures and lets the backend try its fallback endpoint.
        const json=await postJson('/api/osm/features',{south,west,north,east});
        if(!Array.isArray(json?.elements))throw new Error('The server returned an invalid OpenStreetMap response.');
        const categories={},samples=[],zoneTotals=[0,0,0,0,0],zoneCategories=Array.from({length:5},()=>({}));let mapped=0;
        for(const el of json.elements){
            const tags=el.tags||{}; if(!Object.keys(tags).some(k=>!['created_by','source','odbl','attribution','note','fixme'].includes(k)))continue;
            const lon=el.lon??el.center?.lon,lat=el.lat??el.center?.lat;
            if(!Number.isFinite(lon)||!Number.isFinite(lat)||!pointInStudy(lon,lat,rings))continue;
            const category=classifyOsmFeature(tags),zone=riskClassAtFeature(lon,lat);if(!categories[category])categories[category]={mapped:0};
            categories[category].mapped++;mapped++;
            if(zone!==null){zoneTotals[zone]++;zoneCategories[zone][category]=(zoneCategories[zone][category]||0)+1;}
            if(samples.length<10000)samples.push({id:el.id,type:el.type,lon,lat,category,name:tags.name||tags['name:en']||'',zone:zone===null?null:['Very Low','Low','Moderate','High','Very High'][zone],tags});
        }
        const zoneNames=['Very Low','Low','Moderate','High','Very High'];
        const assigned=zoneTotals.reduce((a,b)=>a+b,0);
        latestFeatureStats={categories,mapped:assigned,zoneTotals,zoneCategories,samples:samples.filter(x=>x.zone!==null),unassigned:0};
        if(latestReportData){latestReportData.stats.osmMappedFeatures=assigned;latestReportData.osmZoneTotals=zoneTotals;latestReportData.osmZoneCategories=zoneCategories;latestReportData.unassigned=0;}
        const catNames=[...new Set(zoneCategories.flatMap(z=>Object.keys(z)))].sort();
        const table='<div class="osm-table-wrap"><table class="osm-table"><thead><tr><th>Feature type</th>'+zoneNames.map(z=>'<th>'+z+'</th>').join('')+'<th>Total</th></tr></thead><tbody>'+catNames.map(name=>{const vals=zoneCategories.map(z=>z[name]||0),total=vals.reduce((a,b)=>a+b,0);return '<tr><td>'+name+'</td>'+vals.map(v=>'<td>'+v.toLocaleString()+'</td>').join('')+'<td>'+total.toLocaleString()+'</td></tr>';}).join('')+'<tr><th>Assigned mapped features</th>'+zoneTotals.map(v=>'<th>'+v.toLocaleString()+'</th>').join('')+'<th>'+assigned.toLocaleString()+'</th></tr></tbody></table></div>';
        box.innerHTML='<b>'+assigned.toLocaleString()+' assigned OSM features</b> located in the study boundary. Unassigned features are excluded. Counts below assign each feature centre to the corresponding Flood Susceptibility Index cell.'+table;
        drawOsmFeatureChart(latestFeatureStats);
    }catch(e){box.textContent='Could not retrieve OpenStreetMap features. The Overpass service may be busy or temporarily unavailable. '+e.message;}
    finally{btn.disabled=false;}
});

document.getElementById('reportBtn')?.addEventListener('click', async () => {
    if(!latestReportData){showResult('Run an analysis before generating a report.',true);return;}
    if(latestReportData.mode==='risk'&&!latestFeatureStats){showResult('Run Analyse OpenStreetMap features first so the PDF can include feature counts for all five susceptibility zones.',true);return;}
    const btn=document.getElementById('reportBtn');
    btn.disabled=true;btn.textContent='Generating PDF…';
    try{
        const stats={...latestReportData.stats};
        if(latestFeatureStats){stats.osmMappedFeatures=latestFeatureStats.mapped;}
        const payload={
            title: latestReportData.mode==='rainfall'?'Rainfall':latestReportData.mode==='risk'?'Flood Susceptibility Map':(['elevation','slope','flow','rivers'].includes(latestReportData.mode)?'Individual GIS parameter':'Water-level flood scenario'),
            areaName: (document.getElementById('coords').innerText || 'Selected study area').replace(/^Uploaded:\s*/i, '').replace(/\s*\d+\s*polygon.*$/i, '').split('\n')[0].trim() || 'Selected study area',
            mode: latestReportData.mode==='risk'?'Flood Susceptibility Index':latestReportData.mode==='rainfall'?'Rainfall':(['elevation','slope','flow','rivers'].includes(latestReportData.mode)?'Individual GIS parameter':'Water level'),
            year: latestReportData.year,
            rings: latestReportData.rings,
            overlayPng: latestReportData.overlayPng,
            overlayBounds: latestReportData.overlayBounds,
            features: (latestFeatureStats?.samples || []).map(f=>({lon:f.lon,lat:f.lat,category:f.category})),
            parameterStats: latestParameterStats,
            rainfallSource: latestReportData.rainfallSource || '',
            risk: latestRiskAnalysis ? {labels:latestRiskAnalysis.labels,counts:latestRiskAnalysis.counts,weights:latestRiskAnalysis.weights,factorRanges:latestRiskAnalysis.factorRanges,factorClassBreaks:latestRiskAnalysis.factorClassBreaks,ranges:latestRiskAnalysis.ranges,zoneTotals:latestFeatureStats?.zoneTotals||[0,0,0,0,0],zoneCategories:latestFeatureStats?.zoneCategories||[],unassigned:latestFeatureStats?.unassigned||0} : null,
            stats: stats
        };
        const response=await fetch('/api/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
        if(!response.ok){const msg=await response.text();let detail=msg;try{const parsed=JSON.parse(msg);detail=parsed.error||parsed.message||msg;}catch(_){}throw new Error('HTTP '+response.status+': '+(detail||'Report generation failed'));}
        const blob=await response.blob();
        if (!blob.size) throw new Error('The server returned 0 bytes. Check the Spring Boot console for the /api/report request error; the report was not created.');
        const signature = await blob.slice(0,5).text();
        if (signature !== '%PDF-') throw new Error('The report service did not return a valid PDF. Response type: '+(response.headers.get('content-type')||'unknown'));
        const pdfBlob = blob.type === 'application/pdf' ? blob : new Blob([blob], {type:'application/pdf'});
        if(window.bsoReportUrl) URL.revokeObjectURL(window.bsoReportUrl);
        window.bsoReportUrl=URL.createObjectURL(pdfBlob);
        const frame=document.getElementById('reportFrame');
        frame.src=window.bsoReportUrl+'#toolbar=1&navpanes=0&view=FitH';
        document.getElementById('openReportNewTab').href=window.bsoReportUrl;
        document.getElementById('reportPreviewFallback').style.display='block';
        document.getElementById('reportPreview').style.display='block';
        document.getElementById('downloadReport').onclick=()=>{
            const a=document.createElement('a');a.href=window.bsoReportUrl;a.download='BSO-Flood-Scenario-Report.pdf';document.body.appendChild(a);a.click();a.remove();
        };
    }catch(e){showResult('PDF report failed: '+e.message,true);}
    finally{btn.disabled=false;btn.textContent='Generate PDF report';}
});

const modeSelect=document.getElementById('analysisMode');


document.getElementById('closeReportPreview')?.addEventListener('click',()=>{
    document.getElementById('reportPreview').style.display='none';
});


// Draggable desktop sidebar divider; map and sidebar share the available width.
(function setupSidebarResizer(){
    const app=document.querySelector('.app'), aside=document.querySelector('aside'), bar=document.getElementById('sidebarResizer');
    if(!app||!aside||!bar)return;
    const min=260,max=620;
    const setWidth=(width)=>{const w=Math.max(min,Math.min(max,width));aside.style.width=w+'px';aside.style.flexBasis=w+'px';map.invalidateSize({pan:false});};
    let dragging=false;
    bar.addEventListener('pointerdown',e=>{if(window.matchMedia('(max-width: 800px)').matches)return;dragging=true;bar.setPointerCapture(e.pointerId);document.body.classList.add('resizing-sidebar');e.preventDefault();});
    bar.addEventListener('pointermove',e=>{if(!dragging)return;setWidth(e.clientX-app.getBoundingClientRect().left);});
    const stop=()=>{dragging=false;document.body.classList.remove('resizing-sidebar');};
    bar.addEventListener('pointerup',stop);bar.addEventListener('pointercancel',stop);
    bar.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();setWidth(aside.getBoundingClientRect().width+(e.key==='ArrowRight'?20:-20));}});
})();

// Sidebar tabs: switch content in the same panel without reloading or rebuilding controls.
(function setupSidebarTabs(){
    const tabs=[...document.querySelectorAll('.sidebar-tab')];
    const activate=(name,focus=false)=>{
        tabs.forEach(tab=>{const active=tab.dataset.tab===name;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;if(active&&focus)tab.focus();});
        document.querySelectorAll('.tab-panel').forEach(panel=>{const active=panel.id==='panel-'+name;panel.hidden=!active;panel.classList.toggle('active',active);});
    };
    tabs.forEach((tab,index)=>{
        tab.addEventListener('click',()=>activate(tab.dataset.tab));
        tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();let next=index;if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index-1+tabs.length)%tabs.length;else if(event.key==='Home')next=0;else next=tabs.length-1;activate(tabs[next].dataset.tab,true);});
    });
    window.bsoActivateSidebarTab=(name)=>activate(name);
    if(tabs.length)activate('study');
})();
