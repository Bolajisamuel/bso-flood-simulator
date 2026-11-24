package com.bso.flood_sim;

import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

import java.net.URI;
import java.time.LocalDate;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Annual spatial rainfall samples from the Open-Meteo Historical Weather API.
 * Samples are queried at a regular set of locations inside the study polygon;
 * the browser interpolates them to the elevation display grid for visualization.
 */
@Service
public class RainfallService {
    private static final int GRID_SIDE = 5; // at most 25 annual sample locations per study area
    private final RestClient rest = RestClient.create();
    private final Map<String, Map<String, Object>> cache = new ConcurrentHashMap<>();

    public Map<String, Object> getSpatialYearGrid(List<List<List<Double>>> rings, int year) {
        if (rings == null || rings.isEmpty()) throw new IllegalStateException("Select a study area first");
        if (year < 1940 || year > LocalDate.now().getYear()) throw new IllegalStateException("Choose a year from 1940 to the current year");

        double minLat=90, maxLat=-90, minLng=180, maxLng=-180;
        for (List<List<Double>> ring : rings) for (List<Double> p : ring) {
            minLng=Math.min(minLng,p.get(0)); maxLng=Math.max(maxLng,p.get(0));
            minLat=Math.min(minLat,p.get(1)); maxLat=Math.max(maxLat,p.get(1));
        }
        String cacheKey = String.format(Locale.US, "%d|%.4f|%.4f|%.4f|%.4f|%d", year,minLat,minLng,maxLat,maxLng,rings.hashCode());
        Map<String,Object> old=cache.get(cacheKey); if(old!=null)return old;

        List<double[]> locations = makeSamples(rings,minLat,minLng,maxLat,maxLng);
        if(locations.isEmpty()) throw new IllegalStateException("Could not create rainfall sample locations inside the study area");

        LocalDate start=LocalDate.of(year,1,1);
        LocalDate end=LocalDate.of(year,12,31);
        LocalDate latest=LocalDate.now().minusDays(7);
        boolean partial=false;
        if(end.isAfter(latest)){end=latest;partial=true;}
        if(end.isBefore(start)) throw new IllegalStateException("Annual rainfall data is not yet available for " + year);

        String latitudes=join(locations,1), longitudes=join(locations,0);
        String url="https://archive-api.open-meteo.com/v1/archive?latitude="+latitudes+
                "&longitude="+longitudes+"&start_date="+start+"&end_date="+end+
                "&daily=precipitation_sum&timezone=GMT";
        Object raw=rest.get().uri(URI.create(url)).retrieve().body(Object.class);
        List<?> responses;
        if(raw instanceof List<?> list) responses=list;
        else if(raw instanceof Map<?,?>) responses=List.of(raw);
        else throw new IllegalStateException("Rainfall provider returned an unexpected response");
        if(responses.size()!=locations.size()) throw new IllegalStateException("Rainfall provider returned an incomplete set of spatial samples");

        List<Map<String,Object>> samples=new ArrayList<>();
        double min=Double.POSITIVE_INFINITY,max=Double.NEGATIVE_INFINITY,sum=0;
        for(int i=0;i<responses.size();i++){
            Map<?,?> response=(Map<?,?>)responses.get(i);
            Object dailyObj=response.get("daily");
            if(!(dailyObj instanceof Map<?,?> daily) || !(daily.get("precipitation_sum") instanceof List<?> values))
                throw new IllegalStateException("Rainfall data is missing for one or more sample locations");
            double total=0;
            for(Object value:values) if(value instanceof Number n) total+=n.doubleValue();
            total=Math.round(total*10.0)/10.0;
            double[] loc=locations.get(i);
            Map<String,Object> sample=new LinkedHashMap<>();
            sample.put("lng",loc[0]); sample.put("lat",loc[1]); sample.put("rainfallMm",total);
            samples.add(sample); min=Math.min(min,total); max=Math.max(max,total); sum+=total;
        }
        Map<String,Object> result=new LinkedHashMap<>();
        result.put("year",year); result.put("partialYear",partial); result.put("dataThrough",end.toString());
        result.put("source","Open-Meteo Historical Weather API (ERA5-based reanalysis; spatial point samples)");
        result.put("units","mm/year"); result.put("samples",samples);
        result.put("minSampleMm",round1(min)); result.put("maxSampleMm",round1(max));
        result.put("meanSampleMm",round1(sum/samples.size()));
        if(cache.size()>100)cache.clear(); cache.put(cacheKey,result);
        return result;
    }

    private List<double[]> makeSamples(List<List<List<Double>>> rings,double minLat,double minLng,double maxLat,double maxLng){
        List<double[]> out=new ArrayList<>();
        for(int r=0;r<GRID_SIDE;r++) for(int c=0;c<GRID_SIDE;c++){
            double lat=minLat+(maxLat-minLat)*(r+0.5)/GRID_SIDE;
            double lng=minLng+(maxLng-minLng)*(c+0.5)/GRID_SIDE;
            if(insideAny(lng,lat,rings))out.add(new double[]{lng,lat});
        }
        if(out.size()<4){
            double lng=(minLng+maxLng)/2,lat=(minLat+maxLat)/2;
            if(insideAny(lng,lat,rings))out.add(new double[]{lng,lat});
            for(List<List<Double>> ring:rings){
                for(int i=0;i<ring.size() && out.size()<9;i++){
                    List<Double> p=ring.get(i); double x=p.get(0),y=p.get(1);
                    double cx=(x+lng)/2,cy=(y+lat)/2;
                    if(insideAny(cx,cy,rings))out.add(new double[]{cx,cy});
                }
            }
        }
        // Deduplicate nearly coincident locations.
        Map<String,double[]> unique=new LinkedHashMap<>();
        for(double[] p:out)unique.put(String.format(Locale.US,"%.5f,%.5f",p[0],p[1]),p);
        return new ArrayList<>(unique.values());
    }
    private boolean insideAny(double x,double y,List<List<List<Double>>> rings){
        for(List<List<Double>> ring:rings){boolean inside=false;for(int i=0,j=ring.size()-1;i<ring.size();j=i++){
            double xi=ring.get(i).get(0),yi=ring.get(i).get(1),xj=ring.get(j).get(0),yj=ring.get(j).get(1);
            if(((yi>y)!=(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi+1e-20)+xi))inside=!inside;
        }if(inside)return true;}return false;
    }
    private String join(List<double[]> locations,int index){StringJoiner j=new StringJoiner(",");for(double[] p:locations)j.add(String.format(Locale.US,"%.5f",p[index]));return j.toString();}
    private double round1(double v){return Math.round(v*10.0)/10.0;}
}
