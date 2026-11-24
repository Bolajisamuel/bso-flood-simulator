package com.bso.flood_sim;

import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/** Retrieves mapped river/stream centre-lines from OpenStreetMap Overpass. */
@Service
public class RiverService {
    private final RestClient rest = RestClient.create();

    @SuppressWarnings("unchecked")
    public Map<String, Object> getRivers(List<List<List<Double>>> rings) {
        if (rings == null || rings.isEmpty()) throw new IllegalStateException("Select a study area first");
        double south=90, west=180, north=-90, east=-180;
        for (List<List<Double>> ring : rings) {
            if (ring == null) continue;
            for (List<Double> point : ring) {
                if (point == null || point.size() < 2) continue;
                double lon=point.get(0), lat=point.get(1);
                if (!Double.isFinite(lon) || !Double.isFinite(lat) || lon < -180 || lon > 180 || lat < -85 || lat > 85)
                    throw new IllegalStateException("Invalid study-area coordinate");
                west=Math.min(west,lon); east=Math.max(east,lon); south=Math.min(south,lat); north=Math.max(north,lat);
            }
        }
        if (south >= north || west >= east) throw new IllegalStateException("Invalid study-area bounds");
        // Protect public Overpass instances and avoid huge unbounded requests.
        if ((north-south)*(east-west) > 1.0) throw new IllegalStateException("River query area is too large. Reduce the study area and try again.");
        String bbox=String.format(java.util.Locale.US,"%.6f,%.6f,%.6f,%.6f",south,west,north,east);
        // Keep the query narrow: river, stream, canal and drain centre-lines only.
        String query="[out:json][timeout:25];(way[\"waterway\"~\"^(river|stream|canal|drain)$\"]("+bbox+"););out geom;";
        String body="data="+URLEncoder.encode(query, StandardCharsets.UTF_8);
        RuntimeException last=null;
        for (String endpoint : List.of("https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter")) {
            try {
                Map<?,?> result=rest.post().uri(URI.create(endpoint)).contentType(MediaType.APPLICATION_FORM_URLENCODED)
                        .body(body).retrieve().body(Map.class);
                if (result == null || !(result.get("elements") instanceof List<?>))
                    throw new IllegalStateException("The river service returned an unexpected response");
                return (Map<String,Object>) result;
            } catch (Exception ex) { last = ex instanceof RuntimeException re ? re : new IllegalStateException(ex); }
        }
        throw new IllegalStateException("Could not retrieve river data from OpenStreetMap. Please retry later. " +
                (last == null ? "" : String.valueOf(last.getMessage())), last);
    }
}
