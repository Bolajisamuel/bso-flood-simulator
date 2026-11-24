package com.bso.flood_sim;

import org.springframework.http.ResponseEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ContentDisposition;
import org.springframework.core.io.ByteArrayResource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class SimulationController {

    private static final Logger log = LoggerFactory.getLogger(SimulationController.class);

    private final SimulationService simulationService;
    private final RainfallService rainfallService;
    private final ReportService reportService;
    private final RiverService riverService;
    private final OsmFeatureService osmFeatureService;

    public SimulationController(SimulationService simulationService, RainfallService rainfallService,
                                ReportService reportService, RiverService riverService, OsmFeatureService osmFeatureService) {
        this.simulationService = simulationService;
        this.rainfallService = rainfallService;
        this.reportService = reportService;
        this.riverService = riverService;
        this.osmFeatureService = osmFeatureService;
    }

    public record PlanRequest(List<List<List<Double>>> rings) {}

    public record BandRequest(List<List<List<Double>>> rings, int row0, int row1) {}

    @PostMapping("/plan")
    public Map<String, Object> plan(@RequestBody PlanRequest req) {
        return simulationService.plan(req.rings());
    }

    @PostMapping("/band")
    public Map<String, Object> band(@RequestBody BandRequest req) {
        return simulationService.band(req.rings(), req.row0(), req.row1());
    }

    @PostMapping("/rainfall/spatial")
    public Map<String, Object> spatialRainfall(@RequestBody RainfallRequest req) {
        return rainfallService.getSpatialYearGrid(req.rings(), req.year());
    }

    public record RainfallRequest(List<List<List<Double>>> rings, int year) {}

    @PostMapping("/rivers")
    public Map<String, Object> rivers(@RequestBody PlanRequest req) {
        return riverService.getRivers(req.rings());
    }

    public record OsmFeatureRequest(double south, double west, double north, double east) {}

    @PostMapping("/osm/features")
    public Map<String, Object> osmFeatures(@RequestBody OsmFeatureRequest req) {
        return osmFeatureService.getFeatures(req.south(), req.west(), req.north(), req.east());
    }

    @PostMapping(value="/report", produces="application/pdf")
    public ResponseEntity<ByteArrayResource> report(@RequestBody JsonNode request) {
        byte[] pdf = reportService.create(request);
        if (pdf == null || pdf.length < 500 || pdf[0] != '%' || pdf[1] != 'P' || pdf[2] != 'D' || pdf[3] != 'F' || pdf[4] != '-') {
            throw new IllegalStateException("The report generator did not produce a valid PDF byte stream.");
        }
        log.info("PDF report generated successfully: {} bytes", pdf.length);
        ByteArrayResource resource = new ByteArrayResource(pdf);
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment()
                        .filename("BSO-Flood-Scenario-Report.pdf").build().toString())
                .contentType(MediaType.APPLICATION_PDF)
                .contentLength(pdf.length)
                .body(resource);
    }

    @ExceptionHandler(IllegalStateException.class)
    public ResponseEntity<Map<String, String>> handleError(IllegalStateException e) {
        log.error("/api/report failed: {}", e.getMessage(), e);
        return ResponseEntity.status(500).contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("error", String.valueOf(e.getMessage())));
    }
}