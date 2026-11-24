package com.bso.flood_sim;

import org.springframework.stereotype.Service;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

@Service
public class SimulationService {

    private static final long MAX_CELLS_TOTAL = 40_000_000L; // about 36,000 km2 at 30 m
    private static final int BAND_CELLS = 1_200_000;         // target cells per strip

    private final ElevationService elevationService;

    public SimulationService(ElevationService elevationService) {
        this.elevationService = elevationService;
    }

    private record Parsed(List<double[][]> rings, double latMin, double lngMin,
                          double latMax, double lngMax) {}

    // Step 1: describe the grid and how it will be cut into strips
    public Map<String, Object> plan(List<List<List<Double>>> ringsIn) {
        Parsed p = parse(ringsIn);
        ElevationService.GridSpec s = elevationService.spec(p.latMin(), p.lngMin(), p.latMax(), p.lngMax());

        long cells = (long) s.rows() * s.cols();
        if (cells > MAX_CELLS_TOTAL) {
            throw new IllegalStateException(String.format(Locale.US,
                    "The bounding box of this area is about %,d km2, above the current ceiling of about %,d km2.",
                    Math.round(cells * 0.0009), Math.round(MAX_CELLS_TOTAL * 0.0009)));
        }

        int bandRows = (int) Math.max(1, Math.min(s.rows(), BAND_CELLS / s.cols()));
        int bands = (int) Math.ceil((double) s.rows() / bandRows);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("rows", s.rows());
        result.put("cols", s.cols());
        result.put("latMin", s.latMin());
        result.put("lngMin", s.lngMin());
        result.put("latStep", s.latStep());
        result.put("lngStep", s.lngStep());
        result.put("cellSizeM", (int) ElevationService.CELL_M);
        result.put("bandRows", bandRows);
        result.put("bands", bands);
        result.put("estimatedTiles", elevationService.estimateTiles(s));
        return result;
    }

    // Step 2: elevations for one strip of rows, with cells outside the polygon marked as no data
    public Map<String, Object> band(List<List<List<Double>>> ringsIn, int row0, int row1) {
        Parsed p = parse(ringsIn);
        ElevationService.GridSpec s = elevationService.spec(p.latMin(), p.lngMin(), p.latMax(), p.lngMax());

        if (row0 < 0 || row1 > s.rows() || row0 >= row1)
            throw new IllegalStateException("Invalid strip range");
        if ((long) (row1 - row0) * s.cols() > 3L * BAND_CELLS && row1 - row0 > 1)
            throw new IllegalStateException("The requested strip is too large");

        int cols = s.cols();
        int nr = row1 - row0;

        boolean[] inside = new boolean[nr * cols];
        for (double[][] ring : p.rings()) fillRing(ring, s, row0, row1, inside);

        boolean any = false;
        for (boolean b : inside) { if (b) { any = true; break; } }

        // Skip the terrain download for strips that miss the polygon entirely
        short[] dm = any ? elevationService.sampleRows(s, row0, row1) : new short[nr * cols];
        for (int idx = 0; idx < dm.length; idx++) {
            if (!inside[idx]) dm[idx] = Short.MIN_VALUE;   // outside the study area
        }

        ByteBuffer buf = ByteBuffer.allocate(dm.length * 2).order(ByteOrder.LITTLE_ENDIAN);
        buf.asShortBuffer().put(dm);

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("row0", row0);
        result.put("row1", row1);
        result.put("elevations", Base64.getEncoder().encodeToString(buf.array()));
        return result;
    }

    // Read and validate the polygons, and find their bounding box
    private Parsed parse(List<List<List<Double>>> ringsIn) {
        if (ringsIn == null || ringsIn.isEmpty())
            throw new IllegalStateException("No study area was provided");

        List<double[][]> rings = new ArrayList<>();
        double latMin = Double.MAX_VALUE, latMax = -Double.MAX_VALUE;
        double lngMin = Double.MAX_VALUE, lngMax = -Double.MAX_VALUE;

        for (List<List<Double>> r : ringsIn) {
            if (r == null || r.size() < 3)
                throw new IllegalStateException("Each polygon needs at least 3 points");
            double[][] ring = new double[r.size()][2];
            for (int k = 0; k < r.size(); k++) {
                double lng = r.get(k).get(0);
                double lat = r.get(k).get(1);
                if (lat < -85 || lat > 85 || lng < -180 || lng > 180)
                    throw new IllegalStateException("A coordinate is outside the valid range");
                ring[k][0] = lng;
                ring[k][1] = lat;
                latMin = Math.min(latMin, lat);
                latMax = Math.max(latMax, lat);
                lngMin = Math.min(lngMin, lng);
                lngMax = Math.max(lngMax, lng);
            }
            rings.add(ring);
        }
        if (latMax - latMin < 1e-5 || lngMax - lngMin < 1e-5)
            throw new IllegalStateException("The study area is too small");

        return new Parsed(rings, latMin, lngMin, latMax, lngMax);
    }

    // Scanline fill for rows [row0, row1): mark every cell whose centre lies inside the ring
    private void fillRing(double[][] ring, ElevationService.GridSpec g, int row0, int row1, boolean[] inside) {
        int m = ring.length;
        List<Double> xs = new ArrayList<>();

        for (int i = row0; i < row1; i++) {
            double y = g.latMin() + i * g.latStep();
            xs.clear();
            for (int k = 0, prev = m - 1; k < m; prev = k++) {
                double x1 = ring[prev][0], y1 = ring[prev][1];
                double x2 = ring[k][0], y2 = ring[k][1];
                if ((y1 > y) != (y2 > y)) {
                    xs.add(x1 + (y - y1) * (x2 - x1) / (y2 - y1));
                }
            }
            Collections.sort(xs);
            for (int q = 0; q + 1 < xs.size(); q += 2) {
                int j0 = (int) Math.ceil((xs.get(q) - g.lngMin()) / g.lngStep());
                int j1 = (int) Math.floor((xs.get(q + 1) - g.lngMin()) / g.lngStep());
                for (int j = Math.max(0, j0); j <= Math.min(g.cols() - 1, j1); j++) {
                    inside[(i - row0) * g.cols() + j] = true;
                }
            }
        }
    }
}