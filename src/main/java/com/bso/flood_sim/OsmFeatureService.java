package com.bso.flood_sim;

import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/** Retrieves tagged OpenStreetMap features through Overpass from the server side. */
@Service
public class OsmFeatureService {
    private final RestClient rest = RestClient.create();

    @SuppressWarnings("unchecked")
    public Map<String, Object> getFeatures(double south, double west, double north, double east) {
        if (!Double.isFinite(south) || !Double.isFinite(west) || !Double.isFinite(north) || !Double.isFinite(east)
                || south < -85 || north > 85 || west < -180 || east > 180 || south >= north || west >= east) {
            throw new IllegalStateException("Invalid study-area bounds for OpenStreetMap lookup.");
        }
        if ((north - south) * (east - west) > 1.0) {
            throw new IllegalStateException("The study area is too large for the OpenStreetMap feature query. Reduce the study area and try again.");
        }
        String bbox = String.format(java.util.Locale.US, "%.6f,%.6f,%.6f,%.6f", south, west, north, east);
        String query = "[out:json][timeout:60];nwr(" + bbox + ");out center tags;";
        String body = "data=" + URLEncoder.encode(query, StandardCharsets.UTF_8);
        RuntimeException last = null;
        for (String endpoint : List.of(
                "https://overpass-api.de/api/interpreter",
                "https://overpass.kumi.systems/api/interpreter")) {
            try {
                Map<?, ?> result = rest.post().uri(URI.create(endpoint))
                        .contentType(MediaType.APPLICATION_FORM_URLENCODED)
                        .body(body).retrieve().body(Map.class);
                if (result == null || !(result.get("elements") instanceof List<?>)) {
                    throw new IllegalStateException("Overpass returned an unexpected response.");
                }
                return (Map<String, Object>) result;
            } catch (Exception ex) {
                last = ex instanceof RuntimeException re ? re : new IllegalStateException(ex);
            }
        }
        throw new IllegalStateException("Both OpenStreetMap Overpass endpoints failed. Please retry shortly.", last);
    }
}
