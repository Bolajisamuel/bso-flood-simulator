# Build the Spring Boot application with Java 21
FROM maven:3.9.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml .
COPY src ./src
RUN mvn -B -DskipTests package

# Run the packaged application with a smaller Java 21 runtime
FROM eclipse-temurin:21-jre
WORKDIR /app
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=70.0 -Djava.awt.headless=true"
COPY --from=build /app/target/flood-sim-0.0.1-SNAPSHOT.jar app.jar
EXPOSE 10000
ENTRYPOINT ["sh", "-c", "java $JAVA_TOOL_OPTIONS -jar app.jar --server.port=${PORT:-10000} --server.address=0.0.0.0"]
