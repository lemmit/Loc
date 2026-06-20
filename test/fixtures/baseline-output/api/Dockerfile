# syntax=docker/dockerfile:1
# Auto-generated.

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
# Optional proxy CAs — drop *.crt files into ./certs/ to make the
# build trust them.  The directory always exists (with a .gitkeep),
# so this COPY is a no-op when no CAs are configured.
COPY certs/ /usr/local/share/ca-certificates/
RUN update-ca-certificates 2>&1 | tail -1 || true
COPY Api.csproj ./
RUN dotnet restore Api.csproj
COPY . .
RUN dotnet publish Api.csproj -c Release -o /app/publish --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
# wget is here so the compose healthcheck (which shells out to wget) works
# inside the aspnet image — without it the container reports unhealthy
# even though the API is responding on /health.
RUN apt-get update -y && apt-get install -y --no-install-recommends wget \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
COPY --from=build /app/publish ./
ENTRYPOINT ["dotnet", "Api.dll"]
