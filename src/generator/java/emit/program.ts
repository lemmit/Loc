// ---------------------------------------------------------------------------
// Project-shell emitters for the Java backend: build.gradle.kts +
// settings.gradle.kts, Application.java, application.yml, the /health +
// /ready endpoints, Dockerfile.
//
// Gradle (Kotlin DSL) is the build — the right default for the Java
// ecosystem and for future multi-module emission (composite builds).
// The Spring Boot plugin's dependency management pins every version we
// don't set explicitly (Hibernate, Jackson, the Postgres driver, Flyway),
// so the generated build file stays small and upgrade-friendly.  No
// gradle-wrapper.jar is committed: the generator emits text files only,
// and every environment the toolchain controls provides Gradle itself
// (the Dockerfile's `gradle` base image, CI's runner toolchain, local
// dev with Gradle ≥ 8 — or run `gradle wrapper` once to add one).
// ---------------------------------------------------------------------------

import { lines } from "../../../util/code-builder.js";

/** Spring Boot release the generated projects build against.  Bumping it
 *  is a single-constant change validated by `LOOM_JAVA_BUILD=1`. */
export const SPRING_BOOT_VERSION = "4.1.0";

/** Spring's Gradle dependency-management plugin (BOM import). */
export const DEPENDENCY_MANAGEMENT_VERSION = "1.1.7";

/** Java language level for the generated projects. */
export const JAVA_VERSION = "21";

/** jMolecules DDD/event annotation libraries — metadata-only deps that
 *  make the generated domain idiomatically DDD (@AggregateRoot /
 *  @ValueObject / @DomainEvent) and enable ArchUnit verification. */
export const JMOLECULES_VERSION = "1.10.0";

/** springdoc serves the OpenAPI document (`/openapi.json`) the
 *  cross-backend conformance harness diffs. */
export const SPRINGDOC_VERSION = "3.0.3";

/** Nimbus JOSE+JWT — the JWKS/JWT library the generated OIDC verifier uses
 *  (D-AUTH-OIDC).  Pinned explicitly: unlike Flyway / Spring Security, the
 *  Spring Boot BOM does NOT manage `nimbus-jose-jwt` on its own (only when
 *  spring-security-oauth2-jose is on the classpath, which the generated
 *  backend doesn't pull), so a version-less coordinate fails to resolve. */
export const NIMBUS_JOSE_JWT_VERSION = "10.3";

/** java-uuid-generator — supplies UUIDv7 (time-ordered epoch UUIDs) via
 *  `Generators.timeBasedEpochGenerator()`; the JDK's `UUID` has no v7 factory
 *  through 21.  Used by the aggregate/part id factories (`XId.newId()`). */
export const JAVA_UUID_GENERATOR_VERSION = "5.1.0";

/** ASM — the bytecode library the emitted `injectSmap` Gradle task (below)
 *  uses to attach a `.smap` sidecar as a compiled class's
 *  `SourceDebugExtension` attribute (JSR-45, M10 phase 6b).  Only pulled
 *  onto the BUILDSCRIPT classpath — the build script itself imports
 *  `org.objectweb.asm.*` to define the task — never onto the generated
 *  app's own runtime classpath. */
export const ASM_VERSION = "9.7.1";

/** Marker comments fencing the `--sourcemap` additions to `build.gradle.kts`
 *  (M10 phase 6b) so the byte-identical gate (test/system/sourcemap.test.ts)
 *  can strip them cleanly with one regex, leaving the flag-off file exactly
 *  as if they were never there. */
const SOURCEMAP_FENCE_BEGIN = "// loom:sourcemap-begin";
const SOURCEMAP_FENCE_END = "// loom:sourcemap-end";

/** `buildscript {}` block supplying ASM's classpath to the build SCRIPT
 *  ITSELF (the task below imports `org.objectweb.asm.*` directly).  In
 *  Gradle's Kotlin DSL, `plugins {}` is extracted and applied before the
 *  rest of the script compiles, so nothing but a leading `buildscript {}`
 *  may sit above it — this is why the block is emitted at the very TOP of
 *  the file rather than alongside `dependencies {}` further down (that
 *  block only affects the generated APP's classpath, not the script's
 *  own). */
const SOURCEMAP_BUILDSCRIPT_BLOCK: string[] = [
  SOURCEMAP_FENCE_BEGIN,
  `buildscript {`,
  `    repositories {`,
  `        mavenCentral()`,
  `    }`,
  `    dependencies {`,
  `        classpath("org.ow2.asm:asm:${ASM_VERSION}")`,
  `    }`,
  `}`,
  SOURCEMAP_FENCE_END,
  ``,
];

/** The `injectSmap` task registration + task-graph wiring.  Walks every
 *  `src/main/java/**\/*.smap` sidecar `compileJava` leaves behind (the java
 *  backend co-emits each `.smap` next to its `.java` source — see
 *  `src/system/index.ts`'s `--sourcemap` loop), locates the matching
 *  compiled class(es) (`X.class` and any inner/lambda `X$*.class`) under
 *  `build/classes/java/main/<same package dir>/`, and re-writes each via
 *  ASM `ClassReader`/`ClassWriter` with a `visitSource` override supplying
 *  the SMAP text as the `debug` argument — ASM attaches that as the
 *  class's `SourceDebugExtension` attribute (the same mechanism the
 *  JSP/Kotlin compilers use).  A class that already carries one (its
 *  `debug` argument arrives non-null, parsed off the existing attribute by
 *  `ClassReader` itself) is passed through unchanged rather than
 *  double-injected.
 *
 *  Wiring: `compileJava` `finalizedBy` `injectSmap` schedules it right
 *  after compilation; `jar` / `bootJar` / `testClasses` each `dependsOn`
 *  it so packaging always sees the patched classes regardless of which
 *  entry point invoked the build. */
const SOURCEMAP_TASK_BLOCK: string[] = [
  SOURCEMAP_FENCE_BEGIN,
  `tasks.register("injectSmap") {`,
  `    group = "build"`,
  `    description = "Attaches emitted .smap sidecars (JSR-45) to their compiled classes' SourceDebugExtension attribute."`,
  `    doLast {`,
  `        val srcRoot = file("src/main/java")`,
  `        val classesRoot = file("build/classes/java/main")`,
  `        fileTree(srcRoot) { include("**/*.smap") }.forEach { smapFile ->`,
  `            val smapText = smapFile.readText()`,
  `            val relDir = smapFile.parentFile.relativeTo(srcRoot)`,
  `            val classesDir = classesRoot.resolve(relDir)`,
  `            if (!classesDir.isDirectory) return@forEach`,
  `            val baseName = smapFile.name.removeSuffix(".smap").removeSuffix(".java")`,
  `            val classFiles = classesDir.listFiles { f ->`,
  `                f.name == "$baseName.class" || f.name.startsWith("$baseName$")`,
  `            } ?: emptyArray()`,
  `            classFiles.forEach { classFile ->`,
  `                val reader = org.objectweb.asm.ClassReader(classFile.readBytes())`,
  `                val writer = org.objectweb.asm.ClassWriter(0)`,
  `                val visitor = object : org.objectweb.asm.ClassVisitor(org.objectweb.asm.Opcodes.ASM9, writer) {`,
  `                    override fun visitSource(source: String?, debug: String?) {`,
  `                        // Already-patched classes surface their existing`,
  `                        // SourceDebugExtension as \`debug\` here (ASM parses`,
  `                        // it off the class file) — pass it through`,
  `                        // unchanged rather than double-inject.`,
  `                        super.visitSource(source, debug ?: smapText)`,
  `                    }`,
  `                }`,
  `                reader.accept(visitor, 0)`,
  `                classFile.writeBytes(writer.toByteArray())`,
  `            }`,
  `        }`,
  `    }`,
  `}`,
  ``,
  `tasks.named("compileJava") { finalizedBy("injectSmap") }`,
  `tasks.named("jar") { dependsOn("injectSmap") }`,
  `tasks.named("bootJar") { dependsOn("injectSmap") }`,
  `tasks.named("testClasses") { dependsOn("injectSmap") }`,
  SOURCEMAP_FENCE_END,
  ``,
];

export function renderGradleBuild(
  options: {
    flyway?: boolean;
    oidc?: boolean;
    extraDeps?: Record<string, string>;
    /** `--sourcemap` — gated on the SourceMapRecorder's PRESENCE alone (the
     *  java generator never threads `sourceTexts` — see
     *  `generateJavaForContexts`).  Appends the `injectSmap` task (M10
     *  phase 6b); flag-off output stays byte-identical (no fenced block
     *  emitted at all). */
    sourcemap?: boolean;
  } = {},
): string {
  return lines(
    options.sourcemap ? SOURCEMAP_BUILDSCRIPT_BLOCK : null,
    `plugins {`,
    `    java`,
    `    id("org.springframework.boot") version "${SPRING_BOOT_VERSION}"`,
    `    id("io.spring.dependency-management") version "${DEPENDENCY_MANAGEMENT_VERSION}"`,
    `}`,
    ``,
    `group = "com.loom"`,
    `version = "0.1.0"`,
    `description = "Generated by Loom - do not edit by hand."`,
    ``,
    `java {`,
    `    toolchain {`,
    `        languageVersion = JavaLanguageVersion.of(${JAVA_VERSION})`,
    `    }`,
    `}`,
    ``,
    `repositories {`,
    `    mavenCentral()`,
    `}`,
    ``,
    `dependencies {`,
    `    implementation("org.springframework.boot:spring-boot-starter-web")`,
    `    implementation("org.springframework.boot:spring-boot-starter-data-jpa")`,
    `    runtimeOnly("org.postgresql:postgresql")`,
    `    implementation("org.jmolecules:jmolecules-ddd:${JMOLECULES_VERSION}")`,
    `    implementation("org.jmolecules:jmolecules-events:${JMOLECULES_VERSION}")`,
    `    implementation("org.springdoc:springdoc-openapi-starter-webmvc-ui:${SPRINGDOC_VERSION}")`,
    // UUIDv7 (time-ordered) id generation — the JDK has no v7 factory.
    `    implementation("com.fasterxml.uuid:java-uuid-generator:${JAVA_UUID_GENERATOR_VERSION}")`,
    // Flyway runs the emitted db/migration/V*.sql on boot.  Spring Boot 4.x
    // no longer auto-configures Flyway from `flyway-core` alone — the
    // `spring-boot-starter-flyway` starter is what wires the
    // FlywayAutoConfiguration, so migrations would silently skip without it.
    // (versions managed by the imported BOM).  Only shipped when the
    // deployable owns migrations.
    options.flyway
      ? `    implementation("org.springframework.boot:spring-boot-starter-flyway")`
      : null,
    options.flyway ? `    implementation("org.flywaydb:flyway-database-postgresql")` : null,
    // OIDC turnkey auth (D-AUTH-OIDC): Nimbus JOSE+JWT — the lightweight
    // JWKS/JWT library Spring Security itself uses, for the generated
    // OidcUserVerifier.  Version pinned (NOT BOM-managed — see the const).
    // Shipped only when an `auth { oidc }` block targets this deployable.
    options.oidc
      ? `    implementation("com.nimbusds:nimbus-jose-jwt:${NIMBUS_JOSE_JWT_VERSION}")`
      : null,
    // Resource-client deps (objectStore / queue adapters) — empty for
    // deployables wiring no consumable resources.
    ...Object.entries(options.extraDeps ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([coord, version]) => `    implementation("${coord}:${version}")`),
    `    testImplementation("org.springframework.boot:spring-boot-starter-test")`,
    `    testRuntimeOnly("org.junit.platform:junit-platform-launcher")`,
    `}`,
    ``,
    `tasks.withType<Test> {`,
    `    useJUnitPlatform()`,
    `}`,
    ``,
    options.sourcemap ? SOURCEMAP_TASK_BLOCK : null,
  );
}

export function renderGradleSettings(artifactId: string): string {
  return lines(`rootProject.name = "${artifactId}"`, ``);
}

export function renderApplication(basePkg: string): string {
  return lines(
    `package ${basePkg};`,
    ``,
    `import org.springframework.boot.SpringApplication;`,
    `import org.springframework.boot.autoconfigure.SpringBootApplication;`,
    ``,
    `import ${basePkg}.config.CatalogLog;`,
    ``,
    `@SpringBootApplication`,
    `public class Application {`,
    `    public static void main(String[] args) {`,
    `        CatalogLog.event("server_starting", "info");`,
    `        SpringApplication.run(Application.class, args);`,
    `    }`,
    `}`,
    ``,
  );
}

export function renderApplicationYml(slug: string): string {
  return lines(
    `server:`,
    `  port: 8080`,
    `spring:`,
    `  application:`,
    `    name: ${slug}`,
    `  datasource:`,
    `    url: \${SPRING_DATASOURCE_URL:jdbc:postgresql://localhost:5432/${slug}}`,
    `    username: \${SPRING_DATASOURCE_USERNAME:postgres}`,
    `    password: \${SPRING_DATASOURCE_PASSWORD:postgres}`,
    `  jpa:`,
    `    hibernate:`,
    `      ddl-auto: none`,
    `    open-in-view: false`,
    `springdoc:`,
    `  api-docs:`,
    `    path: /openapi.json`,
    `  swagger-ui:`,
    // Interactive Swagger UI (/swagger-ui.html) is gated OFF in production via
    // LOOM_OPENAPI_UI=false (the k8s chart sets it); the /openapi.json spec
    // (api-docs) stays available.  Default on for dev / compose / conformance.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Spring property placeholder emitted into application.yml, not a JS template literal
    "    enabled: ${LOOM_OPENAPI_UI:true}",
    ``,
  );
}

/** Liveness (`/health`, static) + readiness (`/ready`, DB-aware) probes.
 *  Compose health-checks point at `/ready` so dependents never race the
 *  schema bootstrap; `/health` stays cheap for liveness probing.
 *  Mirrors the dotnet backend's pair. */
export function renderHealthController(basePkg: string): string {
  return lines(
    `package ${basePkg}.api;`,
    ``,
    `import java.util.Map;`,
    `import javax.sql.DataSource;`,
    `import org.springframework.http.ResponseEntity;`,
    `import org.springframework.web.bind.annotation.GetMapping;`,
    `import org.springframework.web.bind.annotation.RestController;`,
    ``,
    `@RestController`,
    `public class HealthController {`,
    `    private final DataSource dataSource;`,
    ``,
    `    public HealthController(DataSource dataSource) {`,
    `        this.dataSource = dataSource;`,
    `    }`,
    ``,
    `    @GetMapping("/health")`,
    `    public Map<String, String> health() {`,
    `        return Map.of("status", "ok");`,
    `    }`,
    ``,
    `    @GetMapping("/ready")`,
    `    public ResponseEntity<Map<String, String>> ready() {`,
    `        try (var connection = dataSource.getConnection()) {`,
    `            if (connection.isValid(2)) {`,
    `                return ResponseEntity.ok(Map.of("status", "ready"));`,
    `            }`,
    `        } catch (Exception ignored) {`,
    `            // fall through to 503`,
    `        }`,
    `        return ResponseEntity.status(503).body(Map.of("status", "unavailable"));`,
    `    }`,
    `}`,
    ``,
  );
}

export function renderDockerfile(
  options: { embeddedSpa?: boolean; spaOutDir?: string } = {},
): string {
  // Fullstack: a node stage builds the embedded React SPA (ClientApp/)
  // and the runtime image serves the bundle from /app/ui on the same
  // origin as the /api/* controllers (SpaWebConfig).
  const spaStage = options.embeddedSpa
    ? [
        `FROM node:22-alpine AS spa-build`,
        `WORKDIR /spa`,
        `COPY ClientApp/package.json ClientApp/package-lock.json* ./`,
        `RUN npm ci --prefer-offline --no-audit --no-fund || npm install`,
        `COPY ClientApp/ ./`,
        `RUN npm run build`,
        ``,
      ]
    : [];
  return lines(
    ...spaStage,
    `FROM gradle:8-jdk${JAVA_VERSION} AS build`,
    `WORKDIR /src`,
    `# Optional proxy CAs — drop *.crt files into ./certs/ to make Gradle`,
    `# trust them.  The directory always exists (with a .gitkeep), so the`,
    `# COPY is a no-op when no CAs are configured.  Gradle resolves over`,
    `# the JDK's own truststore (not the OS bundle), so import there.`,
    `COPY certs/ /tmp/loom-certs/`,
    `RUN for c in /tmp/loom-certs/*.crt; do [ -f "$c" ] && keytool -importcert -noprompt -trustcacerts -cacerts -storepass changeit -alias "loom-$(basename "$c" .crt)" -file "$c"; done || true`,
    `COPY build.gradle.kts settings.gradle.kts ./`,
    // Resolve the dependency graph in its own layer so source edits
    // don't re-download the world.
    `RUN gradle --no-daemon dependencies > /dev/null || true`,
    `COPY src ./src`,
    `RUN gradle --no-daemon -q bootJar`,
    ``,
    `FROM eclipse-temurin:${JAVA_VERSION}-jre`,
    `WORKDIR /app`,
    `COPY --from=build /src/build/libs/*.jar app.jar`,
    options.embeddedSpa
      ? `COPY --from=spa-build /spa/${options.spaOutDir ?? "dist"} /app/ui`
      : null,
    `EXPOSE 8080`,
    `ENTRYPOINT ["java", "-jar", "app.jar"]`,
    ``,
  );
}

export function renderDockerignore(
  options: { embeddedSpa?: boolean; spaOutDir?: string } = {},
): string {
  return lines(
    `build/`,
    `.gradle/`,
    `.idea/`,
    `*.iml`,
    options.embeddedSpa ? `ClientApp/node_modules/` : null,
    options.embeddedSpa ? `ClientApp/${options.spaOutDir ?? "dist"}/` : null,
    options.embeddedSpa && options.spaOutDir === "build" ? `ClientApp/.svelte-kit/` : null,
    ``,
  );
}

/** `shape(embedded)` — Hibernate's default Jackson FormatMapper only
 *  sees getters; the generated part classes carry package-private
 *  fields with record-style accessors, so the JSON columns ride a
 *  field-visibility mapper installed via HibernatePropertiesCustomizer.
 *  Emitted once per project when any embedded aggregate exists. */
export function renderJsonFormatMapperConfig(basePkg: string): string {
  return lines(
    `package ${basePkg}.config;`,
    ``,
    `import com.fasterxml.jackson.annotation.JsonAutoDetect;`,
    `import com.fasterxml.jackson.annotation.PropertyAccessor;`,
    `import tools.jackson.databind.MapperFeature;`,
    `import tools.jackson.databind.json.JsonMapper;`,
    `import org.hibernate.cfg.AvailableSettings;`,
    `import org.hibernate.type.format.jackson.Jackson3JsonFormatMapper;`,
    `import org.springframework.boot.hibernate.autoconfigure.HibernatePropertiesCustomizer;`,
    `import org.springframework.context.annotation.Bean;`,
    `import org.springframework.context.annotation.Configuration;`,
    ``,
    `@Configuration`,
    `public class LoomJsonFormatMapperConfig {`,
    `    @Bean`,
    `    public HibernatePropertiesCustomizer loomJsonFormatMapper() {`,
    `        var mapper = JsonMapper.builder()`,
    `            .findAndAddModules()`,
    `            .configure(MapperFeature.PROPAGATE_TRANSIENT_MARKER, true)`,
    `            .changeDefaultVisibility(vc -> vc`,
    `                .withVisibility(PropertyAccessor.FIELD, JsonAutoDetect.Visibility.ANY)`,
    `                .withVisibility(PropertyAccessor.GETTER, JsonAutoDetect.Visibility.NONE)`,
    `                .withVisibility(PropertyAccessor.IS_GETTER, JsonAutoDetect.Visibility.NONE)`,
    `                .withVisibility(PropertyAccessor.CREATOR, JsonAutoDetect.Visibility.ANY))`,
    `            .build();`,
    `        return props -> props.put(AvailableSettings.JSON_FORMAT_MAPPER, new Jackson3JsonFormatMapper(mapper));`,
    `    }`,
    `}`,
    ``,
  );
}

/** Fullstack mode — serve the embedded SPA bundle (UI_DIR, default
 *  /app/ui) on the same origin as the /api/* controllers, with the
 *  index.html fallback client-side routers need.  Controller mappings
 *  take precedence over resource handlers, so /api, /health, /ready
 *  and /openapi.json are unaffected. */
export function renderSpaWebConfig(basePkg: string): string {
  return lines(
    `package ${basePkg}.config;`,
    ``,
    `import java.io.IOException;`,
    ``,
    `import org.springframework.context.annotation.Configuration;`,
    `import org.springframework.core.io.Resource;`,
    `import org.springframework.web.servlet.config.annotation.ResourceHandlerRegistry;`,
    `import org.springframework.web.servlet.config.annotation.ViewControllerRegistry;`,
    `import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;`,
    `import org.springframework.web.servlet.resource.PathResourceResolver;`,
    ``,
    `@Configuration`,
    `public class SpaWebConfig implements WebMvcConfigurer {`,
    `    @Override`,
    `    public void addViewControllers(ViewControllerRegistry registry) {`,
    `        // "/" never reaches the resource resolver (empty path) — forward it.`,
    `        registry.addViewController("/").setViewName("forward:/index.html");`,
    `    }`,
    ``,
    `    @Override`,
    `    public void addResourceHandlers(ResourceHandlerRegistry registry) {`,
    `        var uiDir = System.getenv().getOrDefault("UI_DIR", "/app/ui");`,
    `        registry.addResourceHandler("/**")`,
    `            .addResourceLocations("file:" + uiDir + "/")`,
    `            .resourceChain(true)`,
    `            .addResolver(new PathResourceResolver() {`,
    `                @Override`,
    `                protected Resource getResource(String resourcePath, Resource location) throws IOException {`,
    `                    if (!resourcePath.isEmpty()) {`,
    `                        var requested = location.createRelative(resourcePath);`,
    `                        if (requested.isFile() && requested.exists() && requested.isReadable()) {`,
    `                            return requested;`,
    `                        }`,
    `                    }`,
    `                    // "/" and client-side routes → the SPA entry point.`,
    `                    return location.createRelative("index.html");`,
    `                }`,
    `            });`,
    `    }`,
    `}`,
    ``,
  );
}
