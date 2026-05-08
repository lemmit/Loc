# syntax=docker/dockerfile:1
# Auto-generated.

FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
# Optional proxy CAs — drop *.crt files into ./certs/ to make the
# build trust them.  The directory always exists (with a .gitkeep),
# so this COPY is a no-op when no CAs are configured.
COPY certs/ /usr/local/share/ca-certificates/
RUN update-ca-certificates 2>&1 | tail -1 || true
COPY CatalogApi.csproj ./
RUN dotnet restore CatalogApi.csproj
COPY . .
RUN dotnet publish CatalogApi.csproj -c Release -o /app/publish --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
COPY --from=build /app/publish ./
ENTRYPOINT ["dotnet", "CatalogApi.dll"]
