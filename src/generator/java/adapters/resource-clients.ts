import type { DataSourceIR, StorageIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { upperFirst } from "../../../util/naming.js";

// ---------------------------------------------------------------------------
// Java ResourceAdapter — client classes for the non-persistence
// infrastructure kinds (objectStore / queue / api).  Sibling of the
// hono / .NET `resource-clients.ts`; emits one static class per
// sourceType under `<base>.resources.<SourceType>Resources`, with one
// method per (resource, verb).  The render layer's `resource-op` arm
// calls `<Cls>.<resourceName><Verb>(…)` — synchronous (the java
// backend has no async surface), exceptions ride the shared
// DomainException → problem+json path.
// ---------------------------------------------------------------------------

export interface JavaResourceAdapter {
  readonly name: string;
  /** Gradle `implementation(...)` coordinates merged into build.gradle.kts. */
  gradleDeps(): Record<string, string>;
  /** A full java file body for the resources of this kind. */
  emitClientClass(
    resources: readonly DataSourceIR[],
    stores: readonly StorageIR[],
    pkg: string,
  ): string;
}

function cfg(store: StorageIR | undefined, key: string): string | undefined {
  const entry = store?.config?.find((c) => c.key === key);
  return entry && entry.value.kind === "string" ? entry.value.value : undefined;
}

function envVar(resourceName: string): string {
  return `${resourceName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}_URL`;
}

function storeOf(resource: DataSourceIR, stores: readonly StorageIR[]): StorageIR | undefined {
  return stores.find((s) => s.name === resource.storageName);
}

/** Class name for a sourceType's resource helpers, e.g. `S3Resources`. */
export function javaResourceClassName(sourceType: string): string {
  return `${upperFirst(sourceType)}Resources`;
}

const s3JavaAdapter: JavaResourceAdapter = {
  name: "s3",
  gradleDeps: () => ({ "software.amazon.awssdk:s3": "2.29.52" }),
  emitClientClass(resources, stores, pkg): string {
    const blocks = resources.flatMap((r) => {
      const bucket = cfg(storeOf(r, stores), "bucket") ?? "";
      const n = r.name;
      return [
        `    private static final String ${n}Bucket =`,
        `        System.getenv().getOrDefault("${envVar(n)}_BUCKET", ${JSON.stringify(bucket)});`,
        `    private static final S3Client ${n}Client = S3Client.create();`,
        ``,
        `    public static void ${n}Put(String key, String body) {`,
        `        ${n}Client.putObject(`,
        `            PutObjectRequest.builder().bucket(${n}Bucket).key(key).contentType("application/json").build(),`,
        `            RequestBody.fromString(body));`,
        `    }`,
        ``,
        `    public static String ${n}Get(String key) {`,
        `        try {`,
        `            return ${n}Client.getObjectAsBytes(GetObjectRequest.builder().bucket(${n}Bucket).key(key).build()).asUtf8String();`,
        `        } catch (NoSuchKeyException e) {`,
        `            return null;`,
        `        }`,
        `    }`,
        ``,
        `    public static List<String> ${n}List(String prefix) {`,
        `        var res = ${n}Client.listObjectsV2(ListObjectsV2Request.builder().bucket(${n}Bucket).prefix(prefix).build());`,
        `        return res.contents().stream().map(S3Object::key).toList();`,
        `    }`,
        ``,
        `    public static String ${n}SignedUrl(String key) {`,
        `        try (var presigner = S3Presigner.create()) {`,
        `            return presigner.presignGetObject(GetObjectPresignRequest.builder()`,
        `                .signatureDuration(Duration.ofHours(1))`,
        `                .getObjectRequest(GetObjectRequest.builder().bucket(${n}Bucket).key(key).build())`,
        `                .build()).url().toString();`,
        `        }`,
        `    }`,
        ``,
        `    public static void ${n}Delete(String key) {`,
        `        ${n}Client.deleteObject(DeleteObjectRequest.builder().bucket(${n}Bucket).key(key).build());`,
        `    }`,
        ``,
      ];
    });
    while (blocks[blocks.length - 1] === "") blocks.pop();
    return lines(
      `package ${pkg};`,
      ``,
      `import java.time.Duration;`,
      `import java.util.List;`,
      ``,
      `import software.amazon.awssdk.core.sync.RequestBody;`,
      `import software.amazon.awssdk.services.s3.S3Client;`,
      `import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;`,
      `import software.amazon.awssdk.services.s3.model.GetObjectRequest;`,
      `import software.amazon.awssdk.services.s3.model.ListObjectsV2Request;`,
      `import software.amazon.awssdk.services.s3.model.NoSuchKeyException;`,
      `import software.amazon.awssdk.services.s3.model.PutObjectRequest;`,
      `import software.amazon.awssdk.services.s3.model.S3Object;`,
      `import software.amazon.awssdk.services.s3.presigner.S3Presigner;`,
      `import software.amazon.awssdk.services.s3.presigner.model.GetObjectPresignRequest;`,
      ``,
      `public final class S3Resources {`,
      `    private S3Resources() {`,
      `    }`,
      ``,
      ...blocks,
      `}`,
      ``,
    );
  },
};

const rabbitmqJavaAdapter: JavaResourceAdapter = {
  name: "rabbitmq",
  gradleDeps: () => ({ "com.rabbitmq:amqp-client": "5.25.0" }),
  emitClientClass(resources, _stores, pkg): string {
    const blocks = resources.flatMap((r) => {
      const n = r.name;
      return [
        `    private static final String ${n}Url =`,
        `        System.getenv().getOrDefault("${envVar(n)}", "amqp://guest:guest@${n}:5672");`,
        `    private static Channel ${n}Channel;`,
        ``,
        `    private static synchronized Channel ${n}channel() throws Exception {`,
        `        if (${n}Channel == null) {`,
        `            var factory = new ConnectionFactory();`,
        `            factory.setUri(${n}Url);`,
        `            ${n}Channel = factory.newConnection().createChannel();`,
        `        }`,
        `        return ${n}Channel;`,
        `    }`,
        ``,
        `    /** enqueue → default exchange, routing key = queue name (asserted durable). */`,
        `    public static void ${n}Enqueue(Object message) {`,
        `        try {`,
        `            var ch = ${n}channel();`,
        `            ch.queueDeclare("${n}", true, false, false, null);`,
        `            ch.basicPublish("", "${n}", PERSISTENT, JSON.writeValueAsBytes(message));`,
        `        } catch (Exception e) {`,
        `            throw new RuntimeException("${n} enqueue failed", e);`,
        `        }`,
        `    }`,
        ``,
        `    /** publish → named topic exchange (asserted durable). */`,
        `    public static void ${n}Publish(String topic, Object message) {`,
        `        try {`,
        `            var ch = ${n}channel();`,
        `            ch.exchangeDeclare("${n}", "topic", true);`,
        `            ch.basicPublish("${n}", topic, PERSISTENT, JSON.writeValueAsBytes(message));`,
        `        } catch (Exception e) {`,
        `            throw new RuntimeException("${n} publish failed", e);`,
        `        }`,
        `    }`,
        ``,
      ];
    });
    while (blocks[blocks.length - 1] === "") blocks.pop();
    return lines(
      `package ${pkg};`,
      ``,
      `import com.fasterxml.jackson.databind.ObjectMapper;`,
      `import com.rabbitmq.client.AMQP;`,
      `import com.rabbitmq.client.Channel;`,
      `import com.rabbitmq.client.ConnectionFactory;`,
      `import com.rabbitmq.client.MessageProperties;`,
      ``,
      `public final class RabbitmqResources {`,
      `    private static final ObjectMapper JSON = new ObjectMapper();`,
      `    private static final AMQP.BasicProperties PERSISTENT = MessageProperties.PERSISTENT_TEXT_PLAIN;`,
      ``,
      `    private RabbitmqResources() {`,
      `    }`,
      ``,
      ...blocks,
      `}`,
      ``,
    );
  },
};

const restApiJavaAdapter: JavaResourceAdapter = {
  name: "restApi",
  gradleDeps: () => ({}),
  emitClientClass(resources, stores, pkg): string {
    const blocks = resources.flatMap((r) => {
      const baseUrl = cfg(storeOf(r, stores), "baseUrl") ?? "";
      const n = r.name;
      return [
        `    private static final String ${n}BaseUrl =`,
        `        System.getenv().getOrDefault("${envVar(n)}", ${JSON.stringify(baseUrl)});`,
        ``,
        `    public static JsonNode ${n}Get(String path) {`,
        `        try {`,
        `            var res = CLIENT.send(HttpRequest.newBuilder(URI.create(${n}BaseUrl).resolve(path)).GET().build(),`,
        `                HttpResponse.BodyHandlers.ofString());`,
        `            if (res.statusCode() / 100 != 2) throw new RuntimeException("${n} GET " + path + " failed: " + res.statusCode());`,
        `            return JSON.readTree(res.body());`,
        `        } catch (java.io.IOException | InterruptedException e) {`,
        `            throw new RuntimeException("${n} GET " + path + " failed", e);`,
        `        }`,
        `    }`,
        ``,
        `    public static JsonNode ${n}Post(String path, Object body) {`,
        `        try {`,
        `            var res = CLIENT.send(HttpRequest.newBuilder(URI.create(${n}BaseUrl).resolve(path))`,
        `                .header("content-type", "application/json")`,
        `                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body))).build(),`,
        `                HttpResponse.BodyHandlers.ofString());`,
        `            if (res.statusCode() / 100 != 2) throw new RuntimeException("${n} POST " + path + " failed: " + res.statusCode());`,
        `            return JSON.readTree(res.body());`,
        `        } catch (java.io.IOException | InterruptedException e) {`,
        `            throw new RuntimeException("${n} POST " + path + " failed", e);`,
        `        }`,
        `    }`,
        ``,
      ];
    });
    while (blocks[blocks.length - 1] === "") blocks.pop();
    return lines(
      `package ${pkg};`,
      ``,
      `import java.net.URI;`,
      `import java.net.http.HttpClient;`,
      `import java.net.http.HttpRequest;`,
      `import java.net.http.HttpResponse;`,
      ``,
      `import com.fasterxml.jackson.databind.JsonNode;`,
      `import com.fasterxml.jackson.databind.ObjectMapper;`,
      ``,
      `public final class RestApiResources {`,
      `    private static final HttpClient CLIENT = HttpClient.newHttpClient();`,
      `    private static final ObjectMapper JSON = new ObjectMapper();`,
      ``,
      `    private RestApiResources() {`,
      `    }`,
      ``,
      ...blocks,
      `}`,
      ``,
    );
  },
};

/** The env-overridable `from:` sender address literal for a mailer. */
function mailFrom(r: DataSourceIR, stores: readonly StorageIR[]): string {
  return cfg(storeOf(r, stores), "from") ?? "no-reply@example.test";
}

const smtpJavaAdapter: JavaResourceAdapter = {
  name: "smtp",
  // Jakarta Mail API + the Angus reference implementation (runtime).
  gradleDeps: () => ({
    "jakarta.mail:jakarta.mail-api": "2.1.3",
    "org.eclipse.angus:angus-mail": "2.0.3",
  }),
  emitClientClass(resources, stores, pkg): string {
    const blocks = resources.flatMap((r) => {
      const n = r.name;
      return [
        `    private static final String ${n}Url =`,
        `        System.getenv().getOrDefault("${envVar(n)}", "smtp://localhost:1025");`,
        `    private static final String ${n}From =`,
        `        System.getenv().getOrDefault("${envVar(n).replace(/_URL$/, "")}_FROM", ${JSON.stringify(mailFrom(r, stores))});`,
        ``,
        `    public static void ${n}Send(String to, String subject, String body) {`,
        `        try {`,
        `            var uri = URI.create(${n}Url);`,
        `            var props = new Properties();`,
        `            props.put("mail.smtp.host", uri.getHost());`,
        `            props.put("mail.smtp.port", String.valueOf(uri.getPort() < 0 ? 25 : uri.getPort()));`,
        `            var session = Session.getInstance(props);`,
        `            var msg = new MimeMessage(session);`,
        `            msg.setFrom(new InternetAddress(${n}From));`,
        `            msg.setRecipients(Message.RecipientType.TO, InternetAddress.parse(to));`,
        `            msg.setSubject(subject);`,
        `            msg.setText(body);`,
        `            Transport.send(msg);`,
        `        } catch (MessagingException e) {`,
        `            throw new RuntimeException("${n} send failed", e);`,
        `        }`,
        `    }`,
        ``,
      ];
    });
    while (blocks[blocks.length - 1] === "") blocks.pop();
    return lines(
      `package ${pkg};`,
      ``,
      `import java.net.URI;`,
      `import java.util.Properties;`,
      ``,
      `import jakarta.mail.Message;`,
      `import jakarta.mail.MessagingException;`,
      `import jakarta.mail.Session;`,
      `import jakarta.mail.Transport;`,
      `import jakarta.mail.internet.InternetAddress;`,
      `import jakarta.mail.internet.MimeMessage;`,
      ``,
      `public final class SmtpResources {`,
      `    private SmtpResources() {`,
      `    }`,
      ``,
      ...blocks,
      `}`,
      ``,
    );
  },
};

const sesJavaAdapter: JavaResourceAdapter = {
  name: "ses",
  gradleDeps: () => ({ "software.amazon.awssdk:ses": "2.29.52" }),
  emitClientClass(resources, stores, pkg): string {
    const blocks = resources.flatMap((r) => {
      const n = r.name;
      return [
        `    private static final SesClient ${n}Client = SesClient.create();`,
        `    private static final String ${n}From =`,
        `        System.getenv().getOrDefault("${envVar(n).replace(/_URL$/, "")}_FROM", ${JSON.stringify(mailFrom(r, stores))});`,
        ``,
        `    public static void ${n}Send(String to, String subject, String body) {`,
        `        ${n}Client.sendEmail(SendEmailRequest.builder()`,
        `            .source(${n}From)`,
        `            .destination(Destination.builder().toAddresses(to).build())`,
        `            .message(Message.builder()`,
        `                .subject(Content.builder().data(subject).build())`,
        `                .body(Body.builder().text(Content.builder().data(body).build()).build())`,
        `                .build())`,
        `            .build());`,
        `    }`,
        ``,
      ];
    });
    while (blocks[blocks.length - 1] === "") blocks.pop();
    return lines(
      `package ${pkg};`,
      ``,
      `import software.amazon.awssdk.services.ses.SesClient;`,
      `import software.amazon.awssdk.services.ses.model.Body;`,
      `import software.amazon.awssdk.services.ses.model.Content;`,
      `import software.amazon.awssdk.services.ses.model.Destination;`,
      `import software.amazon.awssdk.services.ses.model.Message;`,
      `import software.amazon.awssdk.services.ses.model.SendEmailRequest;`,
      ``,
      `public final class SesResources {`,
      `    private SesResources() {`,
      `    }`,
      ``,
      ...blocks,
      `}`,
      ``,
    );
  },
};

const sendgridJavaAdapter: JavaResourceAdapter = {
  name: "sendgrid",
  gradleDeps: () => ({ "com.sendgrid:sendgrid-java": "4.10.3" }),
  emitClientClass(resources, stores, pkg): string {
    const blocks = resources.flatMap((r) => {
      const n = r.name;
      return [
        `    private static final SendGrid ${n}Client =`,
        `        new SendGrid(System.getenv().getOrDefault("SENDGRID_API_KEY", ""));`,
        `    private static final String ${n}From =`,
        `        System.getenv().getOrDefault("${envVar(n).replace(/_URL$/, "")}_FROM", ${JSON.stringify(mailFrom(r, stores))});`,
        ``,
        `    public static void ${n}Send(String to, String subject, String body) {`,
        `        var mail = new Mail(new Email(${n}From), subject, new Email(to), new Content("text/plain", body));`,
        `        var req = new Request();`,
        `        req.setMethod(Method.POST);`,
        `        req.setEndpoint("mail/send");`,
        `        try {`,
        `            req.setBody(mail.build());`,
        `            ${n}Client.api(req);`,
        `        } catch (java.io.IOException e) {`,
        `            throw new RuntimeException("${n} send failed", e);`,
        `        }`,
        `    }`,
        ``,
      ];
    });
    while (blocks[blocks.length - 1] === "") blocks.pop();
    return lines(
      `package ${pkg};`,
      ``,
      `import com.sendgrid.Method;`,
      `import com.sendgrid.Request;`,
      `import com.sendgrid.SendGrid;`,
      `import com.sendgrid.helpers.mail.Mail;`,
      `import com.sendgrid.helpers.mail.objects.Content;`,
      `import com.sendgrid.helpers.mail.objects.Email;`,
      ``,
      `public final class SendgridResources {`,
      `    private SendgridResources() {`,
      `    }`,
      ``,
      ...blocks,
      `}`,
      ``,
    );
  },
};

const ADAPTERS: readonly JavaResourceAdapter[] = [
  s3JavaAdapter,
  rabbitmqJavaAdapter,
  restApiJavaAdapter,
  smtpJavaAdapter,
  sesJavaAdapter,
  sendgridJavaAdapter,
];

export function javaResourceAdapterFor(sourceType: string): JavaResourceAdapter | undefined {
  return ADAPTERS.find((a) => a.name === sourceType);
}

/** Per-deployable resource emission: one client class per consumable
 *  sourceType the deployable wires + the Gradle deps they need, plus
 *  the resourceName → class map the render layer's `resource-op` arm
 *  dispatches through. */
export function emitJavaResourceFiles(
  sys: { dataSources: readonly DataSourceIR[]; storages: readonly StorageIR[] } | undefined,
  wiredNames: ReadonlySet<string>,
  pkg: string,
): { files: Map<string, string>; deps: Record<string, string>; classes: Map<string, string> } {
  const files = new Map<string, string>();
  const deps: Record<string, string> = {};
  const classes = new Map<string, string>();
  if (!sys) return { files, deps, classes };
  const storeType = new Map(sys.storages.map((s) => [s.name, s.type] as const));
  const bySourceType = new Map<string, DataSourceIR[]>();
  for (const r of sys.dataSources) {
    if (!wiredNames.has(r.name)) continue;
    if (r.kind !== "objectStore" && r.kind !== "queue" && r.kind !== "api" && r.kind !== "mailer")
      continue;
    const st = storeType.get(r.storageName);
    if (!st || !javaResourceAdapterFor(st)) continue;
    classes.set(r.name, javaResourceClassName(st));
    const group = bySourceType.get(st);
    if (group) group.push(r);
    else bySourceType.set(st, [r]);
  }
  for (const [sourceType, group] of bySourceType) {
    const adapter = javaResourceAdapterFor(sourceType)!;
    files.set(
      `${javaResourceClassName(sourceType)}.java`,
      adapter.emitClientClass(group, sys.storages, pkg),
    );
    Object.assign(deps, adapter.gradleDeps());
  }
  return { files, deps, classes };
}
