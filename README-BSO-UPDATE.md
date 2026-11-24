# BSO Flood Simulator — analysis and report update

## Sidebar

The application keeps the four-tab sidebar:

1. **Study Area** — search, select, draw, upload or clear a study area.
2. **Analysis Mode** — Water Level Simulation, Rainfall, Elevation, Slope or Flood Susceptibility Index.
3. **Flood Inputs** — water level, the existing rainfall-year selector and the three factor weights.
4. **Results & Report** — analysis results, OSM feature counts, charts and PDF preview/download.

The map remains visible while switching tabs.

## Analysis

- **Rainfall:** the year dropdown selects the year. Rainfall is sampled from Open-Meteo historical precipitation and spatially interpolated for display.
- **Elevation:** AWS Terrain Tiles (Terrarium), sampled on the application's 30 m analysis grid. Results show minimum, maximum and mean elevation.
- **Slope:** calculated in degrees from neighbouring elevation cells.
- **Flood Susceptibility Index:** combines rainfall, elevation and slope using the user-entered weights, normalised to 100%.

Each factor is reclassified into five equal-interval classes using that factor's observed minimum and maximum. Class ranks 1–5 are normalised to 0.2–1.0. Higher rainfall receives a higher susceptibility rank; lower elevation and gentler slope receive higher ranks. The weighted composite is rescaled to 0–1 and classified into five equal-interval zones: Very Low (0.00–0.20), Low (0.20–0.40), Moderate (0.40–0.60), High (0.60–0.80), and Very High (0.80–1.00). The displayed results and PDF include the actual factor value ranges used for reclassification.

## OpenStreetMap analysis

Run the Flood Susceptibility Index first, then choose **Analyse OpenStreetMap features**. Each mapped OSM feature is assigned to the susceptibility class at its node location or way/relation centre. Results show feature-category counts for all five zones, a total by zone, and an unassigned count for features without a valid raster cell. Counts depend on OpenStreetMap coverage.

## PDF report

The report contains the thematic map with study boundary, coordinate frame, north arrow, scale and legend; analysis statistics; a bar chart of susceptibility-zone samples and OSM feature counts; factor reclassification ranges and weights; and a feature-category-by-zone table.

The report endpoint validates the generated PDF signature and returns a byte-backed resource with an explicit content length. Successful generations are logged with their byte count; failures are logged with a stack trace and returned to the browser as a JSON HTTP 500 message. The browser displays that server error instead of masking it as an empty PDF. The browser also validates the PDF signature before previewing or downloading it.

## Welcome page

The app opens on a welcome screen with the supplied portrait in a circular frame. **Explore Web App** reveals the existing simulator; it does not change the analysis workflows.

## Run

1. Install Java 21.
2. Open this folder in IntelliJ IDEA as a Maven project.
3. Reload Maven dependencies and build the project.
4. Run `com.bso.flood_sim.FloodSimApplication`.
5. Open `http://localhost:8080`.

Internet access is required for terrain tiles, Open-Meteo rainfall, OpenStreetMap Overpass queries and browser map tiles.

## Validation status

- JavaScript syntax check: passed with Node.js `--check`.
- HTML parsing: passed.
- Maven package build and live PDF endpoint test: not completed because the Maven wrapper could not download Maven 3.10.1 from Maven Central in this environment. Run the project in IntelliJ and generate a report once to confirm the PDF endpoint against your local data and server logs.


## Latest fixes (24 November 2026)
- Flood Inputs now displays the five-class reclassification tables before the overlay weight controls.
- Users can edit each class minimum, maximum and normalised score (0 to 1). The weighted index is calculated directly from those entered scores and the editable factor weights.
- OpenStreetMap feature queries now go through the Spring Boot `/api/osm/features` endpoint. The backend tries two Overpass endpoints, avoiding browser-side CORS failures.
- Unassigned OSM features remain excluded from risk-zone tables, charts and PDF counts.
- Welcome screen reduced to the circular portrait, a short note and the Explore Web App button. Static asset URLs are versioned to avoid stale browser cache.

## PDF report refinements (24 Nov 2026)
- Made the study-boundary outline red and increased its visibility in the map legend.
- Strengthened the map scale bar and simplified its label to an approximate distance.
- Calculated affected area and percentage for Flood Susceptibility Index reports from the High and Very High raster-cell counts and analysis cell size.
- Omitted unavailable metrics rather than printing question marks or empty metric cards.
- Removed repeated study-area text from the statistics page and cleaned uploaded study-area names.
- Repositioned the statistics-page footer and OSM zone summary to prevent overlap.
- Improved PDF text sanitisation so superscript 2 and degree symbols no longer turn into question marks.
- Adjusted methods-page paragraph spacing based on wrapped line count.
