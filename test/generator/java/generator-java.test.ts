// ---------------------------------------------------------------------------
// Java backend — walking-skeleton emission (slice S1 of
// docs/plans/java-backend-implementation.md).  A system with a
// `platform: java` deployable produces a bootable Maven/Spring Boot
// project shell: pom.xml (Boot parent), Application.java, health/ready
// probes, application.yml reading the compose-provided datasource env,
// a multi-stage Dockerfile, and a docker-compose service stanza.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order { code: string }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable shopApi {
    platform: java
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 8081
  }
}
`;

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("java generator — project shell (S1)", () => {
  it("emits a Gradle (Kotlin DSL) build with the Boot plugin and JPA/Web/Postgres deps", async () => {
    const f = await files();
    const build = f.get("shop_api/build.gradle.kts")!;
    expect(build).toContain('id("org.springframework.boot") version');
    expect(build).toContain('implementation("org.springframework.boot:spring-boot-starter-web")');
    expect(build).toContain(
      'implementation("org.springframework.boot:spring-boot-starter-data-jpa")',
    );
    expect(build).toContain('runtimeOnly("org.postgresql:postgresql")');
    expect(build).toContain("JavaLanguageVersion.of(21)");
    expect(f.get("shop_api/settings.gradle.kts")).toContain('rootProject.name = "shopapi"');
  });

  it("emits Application.java under the base package", async () => {
    const app = (await files()).get("shop_api/src/main/java/com/loom/shopapi/Application.java")!;
    expect(app).toContain("package com.loom.shopapi;");
    expect(app).toContain("@SpringBootApplication");
    expect(app).toContain("SpringApplication.run(Application.class, args);");
  });

  it("emits /health (static) and /ready (DB-aware) probes", async () => {
    const health = (await files()).get(
      "shop_api/src/main/java/com/loom/shopapi/api/HealthController.java",
    )!;
    expect(health).toContain('@GetMapping("/health")');
    expect(health).toContain('@GetMapping("/ready")');
    expect(health).toContain("dataSource.getConnection()");
    expect(health).toContain("ResponseEntity.status(503)");
  });

  it("application.yml reads the compose-provided datasource env with local fallbacks", async () => {
    const yml = (await files()).get("shop_api/src/main/resources/application.yml")!;
    expect(yml).toContain("url: ${SPRING_DATASOURCE_URL:jdbc:postgresql://localhost:5432/shopapi}");
    expect(yml).toContain("ddl-auto: none");
    expect(yml).toContain("open-in-view: false");
  });

  it("emits a multi-stage Gradle Dockerfile", async () => {
    const docker = (await files()).get("shop_api/Dockerfile")!;
    expect(docker).toContain("FROM gradle:8-jdk21 AS build");
    expect(docker).toContain("RUN gradle --no-daemon -q bootJar");
    expect(docker).toContain("FROM eclipse-temurin:21-jre");
    expect(docker).toContain('ENTRYPOINT ["java", "-jar", "app.jar"]');
  });

  it("compose stanza wires the Spring datasource env + /ready healthcheck", async () => {
    const compose = (await files()).get("docker-compose.yml")!;
    expect(compose).toContain('SPRING_DATASOURCE_URL: "jdbc:postgresql://db:5432/shop_api"');
    expect(compose).toMatch(/shop_api:/);
    expect(compose).toContain("/ready");
  });
});
