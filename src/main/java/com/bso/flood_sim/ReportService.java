package com.bso.flood_sim;

import tools.jackson.databind.JsonNode;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDType1Font;
import org.apache.pdfbox.pdmodel.font.Standard14Fonts;
import org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory;
import org.springframework.stereotype.Service;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.awt.*;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.*;
import java.util.List;

@Service
public class ReportService {
    private static final Logger log=LoggerFactory.getLogger(ReportService.class);
    private static final Color NAVY = new Color(11,31,58);
    private static final Color TEAL = new Color(20,184,166);

    public byte[] create(JsonNode request) {
        String title = text(request, "title", "Flood Scenario Report");
        String area = cleanArea(text(request, "areaName", "Selected study area"));
        String mode = text(request, "mode", "Water level");
        String year = text(request, "year", "");
        try (PDDocument doc = new PDDocument(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            PDPage mapPage = new PDPage(new PDRectangle(842,595));
            doc.addPage(mapPage);
            BufferedImage map = drawMap(request, title, area, mode, year);
            try (PDPageContentStream cs = new PDPageContentStream(doc,mapPage)) {
                var img = LosslessFactory.createFromImage(doc,map);
                cs.drawImage(img,28,28,786,539);
            }

            PDPage summary = new PDPage(new PDRectangle(842,595));
            doc.addPage(summary);
            try (PDPageContentStream cs = new PDPageContentStream(doc,summary)) {
                header(cs,"ANALYSIS RESULTS & STATISTICS");
                JsonNode stats=request.path("stats");
                JsonNode risk=request.path("risk");
                List<String[]> metricCards = new ArrayList<>();
                addMetric(metricCards, stats, "studyAreaKm2", "Study area (km2)");
                if (risk.isObject() && risk.path("counts").isArray() && risk.path("counts").size() >= 5) {
                    double cell = stats.path("cellSizeM").asDouble(0);
                    double totalCells = 0;
                    for (JsonNode count : risk.path("counts")) totalCells += count.asDouble(0);
                    double affectedCells = risk.path("counts").path(3).asDouble(0) + risk.path("counts").path(4).asDouble(0);
                    if (cell > 0 && totalCells > 0) {
                        double affectedKm2 = affectedCells * cell * cell / 1_000_000d;
                        double studyKm2 = stats.path("studyAreaKm2").asDouble(0);
                        metricCards.add(new String[]{"Affected area (km2)", fmt(affectedKm2)});
                        if (studyKm2 > 0) metricCards.add(new String[]{"Affected area (%)", fmt(100d * affectedKm2 / studyKm2)});
                    }
                } else {
                    addMetric(metricCards, stats, "floodedAreaKm2", "Affected area (km2)");
                    addMetric(metricCards, stats, "floodedPercent", "Affected area (%)");
                }
                addMetric(metricCards, stats, "rainfallMeanMm", "Mean rainfall (mm)");
                addMetric(metricCards, stats, "rainfallMaxMm", "Maximum rainfall (mm)");
                addMetric(metricCards, stats, "waterLevelM", "Water level (m)");
                addMetric(metricCards, stats, "osmMappedFeatures", "Mapped OSM features");
                for (int i = 0; i < metricCards.size(); i++) {
                    float bx = 45 + (i % 4) * 195, by = 420 - (i / 4) * 112;
                    card(cs, bx, by, 175, 82, metricCards.get(i)[0], metricCards.get(i)[1]);
                }
                if(risk.isObject() && risk.path("counts").isArray()){
                    text(cs,45,285,"FLOOD SUSCEPTIBILITY ZONES",12,NAVY);
                    String[] zoneNames={"Very Low","Low","Moderate","High","Very High"};
                    Color[] zoneColors={new Color(22,101,52),new Color(132,204,22),new Color(250,204,21),new Color(249,115,22),new Color(185,28,28)};
                    double max=1;for(JsonNode v:risk.path("counts"))max=Math.max(max,v.asDouble(0));
                    for(int i=0;i<5;i++){
                        double v=risk.path("counts").path(i).asDouble(0);
                        float y=250-i*31;
                        text(cs,48,y+4,zoneNames[i],9,Color.DARK_GRAY);
                        cs.setNonStrokingColor(new Color(232,237,242));cs.addRect(145,y,330,13);cs.fill();
                        cs.setNonStrokingColor(zoneColors[i]);cs.addRect(145,y,(float)(330*v/max),13);cs.fill();
                        text(cs,485,y+2,String.format(Locale.US,"%,.0f",v),9,NAVY);
                    }
                    text(cs,610,285,"OSM FEATURES",11,NAVY);
                    JsonNode zones=risk.path("zoneTotals");
                    double featureMax=1;for(JsonNode v:zones)featureMax=Math.max(featureMax,v.asDouble(0));
                    for(int i=0;i<5;i++){
                        double v=zones.path(i).asDouble(0);float y=250-i*31;
                        text(cs,610,y+4,zoneNames[i],8,Color.DARK_GRAY);
                        cs.setNonStrokingColor(new Color(232,237,242));cs.addRect(670,y,105,11);cs.fill();
                        cs.setNonStrokingColor(zoneColors[i]);cs.addRect(670,y,(float)(105*v/featureMax),11);cs.fill();
                        text(cs,780,y+2,String.format(Locale.US,"%,d",(int)v),8,NAVY);
                    }
                    text(cs,45,82,"OSM FEATURE COUNTS BY ZONE",11,NAVY);
                    float tx=45,ty=60,cellW=145;
                    String[] heads={"Very Low","Low","Moderate","High","Very High"};
                    for(int i=0;i<5;i++){
                        text(cs,tx+i*cellW,ty,heads[i],8,Color.DARK_GRAY);
                        text(cs,tx+i*cellW,ty-16,String.format(Locale.US,"%,d",zones.path(i).asInt(0)),11,NAVY);
                    }
                } else {
                    double flooded=stats.path("floodedPercent").asDouble(0);
                    bar(cs,45,255,600,"Affected area (%)",flooded,100);
                }
                footer(cs);
            }

            PDPage methods = new PDPage(new PDRectangle(842,595));
            doc.addPage(methods);
            try (PDPageContentStream cs = new PDPageContentStream(doc,methods)) {
                header(cs,"DATA, RECLASSIFICATION & METHODS");
                JsonNode risk=request.path("risk");
                List<String> lines=new ArrayList<>();
                lines.add("Analysis: "+mode+(year.isBlank()?"":" | rainfall year: "+year));
                lines.add("Elevation source: AWS Terrain Tiles (Terrarium); analysis grid spacing: "+text(request.path("stats"),"cellSizeM","30")+" m.");
                lines.add("Rainfall: annual precipitation for the selected year; source: "+text(request,"rainfallSource","Open-Meteo historical precipitation")+"; spatial surface interpolated from sampled locations.");
                lines.add("Slope: calculated in degrees from neighbouring elevation cells.");
                JsonNode parameter=request.path("parameterStats");
                if(parameter.isObject()){
                    lines.add(text(parameter,"title","Parameter")+" statistics: minimum "+value(parameter.path("min"))+"; maximum "+value(parameter.path("max"))+"; mean "+value(parameter.path("mean"))+" "+text(parameter,"units","")+"; valid cells "+value(parameter.path("count"))+".");
                }
                if(risk.isObject()){
                    lines.add("Each factor uses the five user-defined class ranges and normalised scores listed below.");
                    lines.add("Rainfall classes are ordered from lower to higher rainfall; elevation and slope classes follow the user-defined susceptibility direction.");
                    lines.add("Composite index: weighted sum of the three user-entered normalised factor scores (0-1).");
                    lines.add("Final index classes: Very Low 0.00-0.20; Low 0.20-0.40; Moderate 0.40-0.60; High 0.60-0.80; Very High 0.80-1.00.");
                    lines.add("Rainfall class ranges (Very Low to Very High): "+classBreaks(risk.path("factorClassBreaks").path("rainfall"))+" mm.");
                    lines.add("Elevation class ranges (Very Low to Very High): "+classBreaks(risk.path("factorClassBreaks").path("elevation"))+" m.");
                    lines.add("Slope class ranges (Very Low to Very High): "+classBreaks(risk.path("factorClassBreaks").path("slope"))+" degrees.");
                    JsonNode weights=risk.path("weights");
                    lines.add("Applied weights: rainfall "+pct(weights.path("rainfall"))+"; elevation "+pct(weights.path("elevation"))+"; slope "+pct(weights.path("slope"))+".");
                    lines.add("Factor source ranges: rainfall "+range(risk.path("factorRanges").path("rainfall"))+" mm; elevation "+range(risk.path("factorRanges").path("elevation"))+" m; slope "+range(risk.path("factorRanges").path("slope"))+" degrees.");
                }
                lines.add("OpenStreetMap feature counts include only features successfully assigned to a valid susceptibility zone.");
                lines.add("Produced: "+java.time.OffsetDateTime.now());
                float y=500;
                for(String line:lines){ y -= paragraph(cs,45,y,line,9) + 8; }
                footer(cs);
            }
            JsonNode riskData=request.path("risk");
            JsonNode zoneCats=riskData.path("zoneCategories");
            if(zoneCats.isArray() && zoneCats.size()>0){
                PDPage featurePage=new PDPage(new PDRectangle(842,595));doc.addPage(featurePage);
                try(PDPageContentStream cs=new PDPageContentStream(doc,featurePage)){
                    header(cs,"OPENSTREETMAP FEATURES BY SUSCEPTIBILITY ZONE");
                    String[] zoneLabels={"Very Low","Low","Moderate","High","Very High"};
                    float[] xs={45,315,405,495,585,675,770};
                    text(cs,45,505,"Feature category",9,NAVY);
                    for(int i=0;i<5;i++)text(cs,xs[i+1],505,zoneLabels[i],8,NAVY);
                    text(cs,770,505,"Total",8,NAVY);
                    line(cs,45,493,800,493,TEAL,1);
                    Set<String> names=new TreeSet<>();
                    for(JsonNode zone:zoneCats)if(zone.isObject())zone.properties().forEach(entry -> names.add(entry.getKey()));
                    float y=472;int shown=0;
                    for(String name:names){
                        if(shown>=22)break;
                        text(cs,45,y,name,8,Color.DARK_GRAY);int total=0;
                        for(int i=0;i<5;i++){int v=zoneCats.path(i).path(name).asInt(0);total+=v;text(cs,xs[i+1],y,String.format(Locale.US,"%,d",v),8,NAVY);}
                        text(cs,770,y,String.format(Locale.US,"%,d",total),8,NAVY);
                        y-=19;shown++;
                    }
                    if(names.isEmpty())text(cs,45,465,"No OpenStreetMap feature counts were supplied for this analysis.",10,Color.DARK_GRAY);
                    JsonNode zoneTotals=riskData.path("zoneTotals");
                    text(cs,45,y-4,"Assigned mapped features",8,NAVY);
                    for(int i=0;i<5;i++)text(cs,xs[i+1],y-4,String.format(Locale.US,"%,d",zoneTotals.path(i).asInt(0)),8,NAVY);
                    text(cs,770,y-4,String.format(Locale.US,"%,d",zoneTotals.path(0).asInt(0)+zoneTotals.path(1).asInt(0)+zoneTotals.path(2).asInt(0)+zoneTotals.path(3).asInt(0)+zoneTotals.path(4).asInt(0)),8,NAVY);
                    footer(cs);
                }
            }
            doc.save(out);
            byte[] result=out.toByteArray();
            if(result.length<500 || result[0]!='%' || result[1]!='P' || result[2]!='D' || result[3]!='F') throw new IllegalStateException("PDF generation produced an invalid or empty document");
            return result;
        } catch(Exception e) {
            log.error("PDF report generation failed for mode={} and year={}",mode,year,e);
            throw new IllegalStateException("Could not generate PDF report: "+e.getMessage(),e);
        }
    }

    private BufferedImage drawMap(JsonNode req,String title,String area,String mode,String year) {
        int W=1500,H=960;
        BufferedImage image=new BufferedImage(W,H,BufferedImage.TYPE_INT_RGB);
        Graphics2D g=image.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING,RenderingHints.VALUE_ANTIALIAS_ON);
        g.setColor(Color.WHITE);g.fillRect(0,0,W,H);
        g.setColor(NAVY);g.fillRect(0,0,W,115);
        g.setColor(Color.WHITE);g.setFont(new Font("SansSerif",Font.BOLD,34));g.drawString("BSO GEOSPATIAL & ENGINEERING CONSULTS",45,48);
        g.setFont(new Font("SansSerif",Font.PLAIN,23));g.drawString(title+(year.isBlank()?"":" | Rainfall year: "+year),45,86);
        g.setFont(new Font("SansSerif",Font.PLAIN,17));g.drawString(area,45,110);
        try(java.io.InputStream logoStream=new org.springframework.core.io.ClassPathResource("static/img/logo.png").getInputStream()){
            BufferedImage logo=javax.imageio.ImageIO.read(logoStream);
            if(logo!=null)g.drawImage(logo,1320,18,125,78,null);
        }catch(Exception ignored){}
        int left=75,top=160,mw=1120,mh=690;
        g.setColor(new Color(246,249,252));g.fillRect(left,top,mw,mh);
        g.setColor(new Color(220,228,236));g.setStroke(new BasicStroke(1));
        for(int i=0;i<=8;i++){int x=left+i*mw/8;g.drawLine(x,top,x,top+mh);int y=top+i*mh/8;g.drawLine(left,y,left+mw,y);}
        JsonNode rings=req.path("rings");
        double minX=Double.POSITIVE_INFINITY,minY=Double.POSITIVE_INFINITY,maxX=Double.NEGATIVE_INFINITY,maxY=Double.NEGATIVE_INFINITY;
        for(JsonNode ring:rings) for(JsonNode p:ring){if(p.size()>=2){double x=p.get(0).asDouble(),y=p.get(1).asDouble();minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}}
        if(!Double.isFinite(minX)){minX=3;maxX=4;minY=6;maxY=7;}
        double dx=Math.max(maxX-minX,0.0001),dy=Math.max(maxY-minY,0.0001);
        double padX=dx*.06,padY=dy*.06;minX-=padX;maxX+=padX;minY-=padY;maxY+=padY;dx=maxX-minX;dy=maxY-minY;
        // The simulation raster is supplied by the browser as a PNG and is placed by its geographic bounds.
        JsonNode overlay=req.path("overlayPng");
        JsonNode ob=req.path("overlayBounds");
        if(overlay.isTextual() && ob.isArray() && ob.size()==4){
            try{
                String raw=overlay.asText();
                byte[] png=Base64.getDecoder().decode(raw.substring(raw.indexOf(",")+1));
                BufferedImage raster=javax.imageio.ImageIO.read(new java.io.ByteArrayInputStream(png));
                double south=ob.get(0).asDouble(),west=ob.get(1).asDouble(),north=ob.get(2).asDouble(),east=ob.get(3).asDouble();
                int x1=left+(int)((west-minX)/dx*mw),x2=left+(int)((east-minX)/dx*mw);
                int y1=top+mh-(int)((north-minY)/dy*mh),y2=top+mh-(int)((south-minY)/dy*mh);
                if(raster!=null) g.drawImage(raster,x1,y1,Math.max(1,x2-x1),Math.max(1,y2-y1),null);
            }catch(Exception ignored){ /* keep the map boundary and frame if raster decoding fails */ }
        }
        for(JsonNode ring:rings){
            Polygon poly=new Polygon();
            for(JsonNode p:ring){if(p.size()<2)continue;int x=left+(int)((p.get(0).asDouble()-minX)/dx*mw);int y=top+mh-(int)((p.get(1).asDouble()-minY)/dy*mh);poly.addPoint(x,y);}
            g.setColor(new Color(220,38,38));g.setStroke(new BasicStroke(5));g.drawPolygon(poly);
        }
        // Frame, coordinate ticks, north arrow and scale bar
        g.setColor(NAVY);g.setStroke(new BasicStroke(3));g.drawRect(left,top,mw,mh);
        g.setFont(new Font("SansSerif",Font.PLAIN,15));g.setColor(Color.DARK_GRAY);
        for(int i=0;i<=4;i++){double lon=minX+dx*i/4,lat=minY+dy*i/4;g.drawString(String.format(Locale.US,"%.3f°",lon),left+i*mw/4-25,top+mh+25);g.drawString(String.format(Locale.US,"%.3f°",lat),left-65,top+mh-i*mh/4+5);}
        g.setColor(NAVY);g.setFont(new Font("SansSerif",Font.BOLD,22));g.drawString("N",1260,190);g.fillPolygon(new int[]{1275,1258,1292},new int[]{205,245,245},3);
        g.setFont(new Font("SansSerif",Font.BOLD,18));g.drawString("LEGEND",1240,310);
        g.setColor(new Color(220,38,38));g.setStroke(new BasicStroke(4));g.drawRect(1240,330,26,18);g.setColor(Color.DARK_GRAY);g.setFont(new Font("SansSerif",Font.PLAIN,16));g.drawString("Study boundary",1278,346);
        if(mode.toLowerCase(Locale.ROOT).contains("susceptibility")){
            String[] riskLabels={"Very Low","Low","Moderate","High","Very High"};
            Color[] riskColors={new Color(22,101,52),new Color(132,204,22),new Color(250,204,21),new Color(249,115,22),new Color(185,28,28)};
            for(int i=0;i<5;i++){g.setColor(riskColors[i]);g.fillRect(1240,370+i*34,26,18);g.setColor(Color.DARK_GRAY);g.drawString(riskLabels[i],1278,386+i*34);}
        } else {g.setColor(new Color(37,99,235,120));g.fillRect(1240,370,26,18);g.setColor(Color.DARK_GRAY);g.drawString(mode+" raster",1278,386);}
        double midLat=(minY+maxY)/2.0;
        double barKm=dx*111.32*Math.cos(Math.toRadians(midLat))*220.0/mw;
        g.setColor(Color.BLACK);g.setStroke(new BasicStroke(6));g.drawLine(80,900,300,900);
        g.setStroke(new BasicStroke(3));g.drawLine(80,888,80,912);g.drawLine(190,892,190,908);g.drawLine(300,888,300,912);
        g.setFont(new Font("SansSerif",Font.BOLD,18));g.drawString(String.format(Locale.US,"Approx. %.1f km",barKm),80,934);
        g.setColor(NAVY);g.fillRect(0,945,W,15);g.dispose();return image;
    }
    private void header(PDPageContentStream cs,String title)throws Exception{ text(cs,40,550,title,18,NAVY);line(cs,40,535,802,535,TEAL,2); }
    private void footer(PDPageContentStream cs)throws Exception{text(cs,40,16,"BSO Geospatial & Engineering Consults  |  Flood Susceptibility Assessment",8,Color.GRAY);}
    private void card(PDPageContentStream cs,float x,float y,float w,float h,String label,String val)throws Exception{
        cs.setNonStrokingColor(new Color(244,247,251));cs.addRect(x,y,w,h);cs.fill();
        text(cs,x+12,y+h-24,label,9,Color.DARK_GRAY);text(cs,x+12,y+28,val,19,NAVY);
    }
    private void bar(PDPageContentStream cs,float x,float y,float w,String label,double value,double max)throws Exception{
        text(cs,x,y+28,label,10,Color.DARK_GRAY);
        cs.setNonStrokingColor(new Color(226,232,240));cs.addRect(x,y,w,12);cs.fill();
        float fill=(float)(w*Math.max(0,Math.min(1,value/max)));
        cs.setNonStrokingColor(TEAL);cs.addRect(x,y,fill,12);cs.fill();
        text(cs,x+w+8,y+1,String.format(Locale.US,"%.1f",value),9,NAVY);
    }
    private String cleanArea(String raw) {
        if (raw == null || raw.isBlank()) return "Selected study area";
        String cleaned = raw.replaceFirst("(?i)^\\s*Uploaded:\\s*", "");
        cleaned = cleaned.replaceFirst("\\s*\\d+\\s*polygon.*$", "").trim();
        cleaned = cleaned.split("\\R", 2)[0].trim();
        return cleaned.isBlank() ? "Selected study area" : cleaned;
    }
    private void addMetric(List<String[]> cards, JsonNode stats, String key, String label) {
        JsonNode n = stats.path(key);
        if (n == null || n.isMissingNode() || n.isNull() || (n.isTextual() && n.asText().isBlank())) return;
        String v;
        if (key.equals("osmMappedFeatures")) v = String.format(Locale.US, "%,d", n.asLong());
        else v = fmt(n.asDouble());
        cards.add(new String[]{label, v});
    }
    private String fmt(double n) { return String.format(Locale.US, "%,.2f", n); }
    private String pct(JsonNode n){return String.format(Locale.US,"%.0f%%",n.asDouble(0)*100);}
    private String range(JsonNode n){if(!n.isArray()||n.size()<2)return "n/a";return String.format(Locale.US,"%.2f-%.2f",n.get(0).asDouble(),n.get(1).asDouble());}
    private String classBreaks(JsonNode n){
        if(!n.isArray()||n.size()==0)return "not available";
        List<String> parts=new ArrayList<>();
        for(JsonNode b:n)parts.add(String.format(Locale.US,"%.2f-%.2f (score %.2f)",b.path("min").asDouble(),b.path("max").asDouble(),b.path("score").asDouble()));
        return String.join("; ",parts);
    }
    private float paragraph(PDPageContentStream cs,float x,float y,String s,int size)throws Exception{
        String clean=safe(s);int max=112;int offset=0;int lineCount=0;
        while(offset<clean.length()){
            int end=Math.min(clean.length(),offset+max);
            if(end<clean.length()){int split=clean.lastIndexOf(' ',end);if(split>offset)end=split;}
            text(cs,x,y,clean.substring(offset,end),size,Color.DARK_GRAY);y-=13;offset=end;lineCount++;
            while(offset<clean.length()&&clean.charAt(offset)==' ')offset++;
        }
        return Math.max(1,lineCount)*13f;
    }
    private void text(PDPageContentStream cs,float x,float y,String s,int size,Color c)throws Exception{
        cs.beginText();cs.setFont(new PDType1Font(Standard14Fonts.FontName.HELVETICA),size);cs.setNonStrokingColor(c);cs.newLineAtOffset(x,y);cs.showText(safe(s));cs.endText();
    }
    private void line(PDPageContentStream cs,float x1,float y1,float x2,float y2,Color c,float width)throws Exception{cs.setStrokingColor(c);cs.setLineWidth(width);cs.moveTo(x1,y1);cs.lineTo(x2,y2);cs.stroke();}
    private String safe(String s){
        if (s == null) return "";
        return s.replace("²", "2").replace("°", " deg").replace("–", "-").replace("—", "-")
                .replace("’", "'").replace("“", "\"").replace("”", "\"")
                .replaceAll("[^\\x20-\\x7E]", "");
    }
    private String text(JsonNode n,String key,String d){return n.path(key).isMissingNode()?d:n.path(key).asText(d);}
    private String value(JsonNode n){if(n==null||n.isMissingNode()||n.isNull())return "—";return n.isNumber()?String.format(Locale.US,"%.2f",n.asDouble()):n.asText();}
}
