package com.bso.flood_sim;

import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.stream.IntStream;

@Service
public class ElevationService {

    public static final double CELL_M = 30;   // fixed cell size = resolution of the satellite elevation data
    private static final int ZOOM = 13;       // tile pixels (about 19 m) are finer than the 30 m source
    private static final String TILE_URL =
            "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/%d/%d/%d.png";

    private final RestClient rest = RestClient.create();
    // key = tile x and y packed into one long; value = 256 x 256 elevations in decimetres
    private final Map<Long, short[]> tileCache = new ConcurrentHashMap<>();

    // The full grid of an area: row 0 is the southern edge, column 0 the western edge
    public record GridSpec(int rows, int cols, double latMin, double lngMin,
                           double latStep, double lngStep) {}

    public GridSpec spec(double latMin, double lngMin, double latMax, double lngMax) {
        double latMid = (latMin + latMax) / 2;
        double latStep = CELL_M / 111320.0;
        double lngStep = CELL_M / (111320.0 * Math.cos(Math.toRadians(latMid)));
        int rows = (int) Math.ceil((latMax - latMin) / latStep) + 1;
        int cols = (int) Math.ceil((lngMax - lngMin) / lngStep) + 1;
        return new GridSpec(rows, cols, latMin, lngMin, latStep, lngStep);
    }

    // Number of terrain tiles the whole grid touches
    public long estimateTiles(GridSpec s) {
        double latMax = s.latMin() + (s.rows() - 1) * s.latStep();
        double lngMax = s.lngMin() + (s.cols() - 1) * s.lngStep();
        long w = tileX(lngMax) - tileX(s.lngMin()) + 1;
        long h = tileY(s.latMin()) - tileY(latMax) + 1;
        return w * h;
    }

    // Elevations (decimetres) for grid rows [row0, row1), all columns, row-major
    public short[] sampleRows(GridSpec s, int row0, int row1) {
        int nr = row1 - row0;
        int cols = s.cols();
        double latLo = s.latMin() + row0 * s.latStep();
        double latHi = s.latMin() + (row1 - 1) * s.latStep();
        double lngLo = s.lngMin();
        double lngHi = s.lngMin() + (cols - 1) * s.lngStep();

        prefetchTiles(latLo, lngLo, latHi, lngHi);

        short[] dm = new short[nr * cols];
        final double n = 1 << ZOOM;
        final double latMin = s.latMin(), lngMin = s.lngMin();
        final double latStep = s.latStep(), lngStep = s.lngStep();

        IntStream.range(0, nr).parallel().forEach(r -> {
            double lat = latMin + (row0 + r) * latStep;
            double latRad = Math.toRadians(lat);
            double y = (1.0 - Math.log(Math.tan(latRad) + 1.0 / Math.cos(latRad)) / Math.PI) / 2.0 * n;
            int tileY = (int) Math.floor(y);
            int py = clamp((int) ((y - tileY) * 256), 0, 255);

            int currentTileX = Integer.MIN_VALUE;
            short[] tile = null;
            for (int j = 0; j < cols; j++) {
                double lng = lngMin + j * lngStep;
                double x = (lng + 180.0) / 360.0 * n;
                int tileX = (int) Math.floor(x);
                int px = clamp((int) ((x - tileX) * 256), 0, 255);
                if (tileX != currentTileX) {
                    tile = getTile(tileX, tileY);
                    currentTileX = tileX;
                }
                dm[r * cols + j] = tile[py * 256 + px];
            }
        });
        return dm;
    }

    // Download every tile the strip needs, 8 at a time
    private void prefetchTiles(double latLo, double lngLo, double latHi, double lngHi) {
        int x0 = tileX(lngLo), x1 = tileX(lngHi);
        int y0 = tileY(latHi), y1 = tileY(latLo);

        ExecutorService pool = Executors.newFixedThreadPool(8);
        try {
            List<Future<?>> jobs = new ArrayList<>();
            for (int x = x0; x <= x1; x++) {
                for (int y = y0; y <= y1; y++) {
                    final int fx = x, fy = y;
                    jobs.add(pool.submit(() -> getTile(fx, fy)));
                }
            }
            for (Future<?> job : jobs) job.get();
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() != null ? e.getCause() : e;
            throw new IllegalStateException(String.valueOf(cause.getMessage()), cause);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("The elevation download was interrupted");
        } finally {
            pool.shutdown();
        }
    }

    private short[] getTile(int x, int y) {
        long key = (((long) x) << 32) | (y & 0xFFFFFFFFL);
        short[] cached = tileCache.get(key);
        if (cached != null) return cached;

        String name = ZOOM + "/" + x + "/" + y;
        try {
            byte[] bytes = rest.get()
                    .uri(URI.create(String.format(TILE_URL, ZOOM, x, y)))
                    .retrieve()
                    .body(byte[].class);
            if (bytes == null) throw new IllegalStateException("Empty tile response");

            BufferedImage img = ImageIO.read(new ByteArrayInputStream(bytes));
            if (img == null || img.getWidth() != 256 || img.getHeight() != 256)
                throw new IllegalStateException("Could not decode tile " + name);

            short[] out = new short[256 * 256];
            for (int py = 0; py < 256; py++) {
                for (int px = 0; px < 256; px++) {
                    int rgb = img.getRGB(px, py);
                    int r = (rgb >> 16) & 0xFF;
                    int g = (rgb >> 8) & 0xFF;
                    int b = rgb & 0xFF;
                    double metres = (r * 256 + g + b / 256.0) - 32768.0;
                    out[py * 256 + px] = (short) Math.round(metres * 10.0);
                }
            }

            if (tileCache.size() >= 800) tileCache.clear(); // keep memory bounded
            tileCache.put(key, out);
            return out;
        } catch (Exception ex) {
            throw new IllegalStateException("Failed to load elevation tile " + name + ": " + ex.getMessage(), ex);
        }
    }

    private static int tileX(double lng) {
        int t = (int) Math.floor((lng + 180.0) / 360.0 * (1 << ZOOM));
        return clamp(t, 0, (1 << ZOOM) - 1);
    }

    private static int tileY(double lat) {
        double r = Math.toRadians(lat);
        double y = (1.0 - Math.log(Math.tan(r) + 1.0 / Math.cos(r)) / Math.PI) / 2.0;
        return clamp((int) Math.floor(y * (1 << ZOOM)), 0, (1 << ZOOM) - 1);
    }

    private static int clamp(int v, int lo, int hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}