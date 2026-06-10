// ---------------------------------------------------------------------------
// Java backend — retrievals + reified criteria: the `<Agg>Criteria`
// Specification factories (java is the first backend consuming
// CriterionIR directly), the repository retrieval surface (reified →
// JpaSpecificationExecutor delegation with Sort; composed → @Query JPQL
// with order by), and the workflow `Repo.run` / `for` loop arms.
// Boot-verified end-to-end against Postgres via
// test/e2e/fixtures/java-build/retrieval.ddd.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system RetrievalShop {
  subdomain Sales {
    context Crm {
      aggregate Customer {
        active: bool
        region: string
        name: string
        score: int
        operation deactivate() { active := false }
      }
      repository Customers for Customer { }

      criterion ActiveCustomer of Customer = active
      criterion InRegion(rgn: string) of Customer = region == rgn
      criterion HighScore(min: int) of Customer = score >= min

      retrieval ByRegion(rgn: string) of Customer {
        where: InRegion(rgn)
        sort:  [name asc]
      }
      retrieval ActiveHighScorers(min: int) of Customer {
        where: ActiveCustomer && HighScore(min)
        sort:  [score desc, name asc]
      }

      workflow deactivateRegion {
        create(rgn: string) {
          let matched = Customers.run(ByRegion(rgn))
          for c in matched {
            c.deactivate()
          }
        }
      }
    }
  }
  api CrmApi from Sales
  storage primary { type: postgres }
  resource crmState { for: Crm, kind: state, use: primary }
  deployable crmApi {
    platform: java
    contexts: [Crm]
    dataSources: [crmState]
    serves: CrmApi
    port: 8081
  }
}
`;

const ROOT = "crm_api/src/main/java/com/loom/crmapi";

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("java generator — reified criteria (Specification factories)", () => {
  it("emits one <Agg>Criteria class with a static Specification factory per criterion", async () => {
    const crit = (await files()).get(`${ROOT}/domain/criteria/CustomerCriteria.java`)!;
    expect(crit).toContain("public final class CustomerCriteria {");
    expect(crit).toContain("import org.springframework.data.jpa.domain.Specification;");
    expect(crit).toContain("    public static Specification<Customer> ActiveCustomer() {");
    expect(crit).toContain("    public static Specification<Customer> InRegion(String rgn) {");
    expect(crit).toContain("    public static Specification<Customer> HighScore(int min) {");
  });

  it("renders predicate bodies through CriteriaBuilder with typed root.get witnesses", async () => {
    const crit = (await files()).get(`${ROOT}/domain/criteria/CustomerCriteria.java`)!;
    expect(crit).toContain('(root, query, cb) -> cb.isTrue(root.<Boolean>get("active"))');
    expect(crit).toContain('(root, query, cb) -> cb.equal(root.<String>get("region"), rgn)');
    expect(crit).toContain(
      '(root, query, cb) -> cb.greaterThanOrEqualTo(root.<Integer>get("score"), min)',
    );
  });
});

describe("java generator — retrieval repository surface", () => {
  it("adds a run<Retrieval> method per retrieval to the domain port", async () => {
    const port = (await files()).get(`${ROOT}/features/customers/CustomerRepository.java`)!;
    expect(port).toContain("    List<Customer> runByRegion(String rgn);");
    expect(port).toContain("    List<Customer> runActiveHighScorers(int min);");
  });

  it("reified retrieval (exact criterion ref) rides JpaSpecificationExecutor + Sort", async () => {
    const files_ = await files();
    const jpa = files_.get(`${ROOT}/features/customers/CustomerJpaRepository.java`)!;
    expect(jpa).toContain(
      "extends JpaRepository<Customer, CustomerId>, JpaSpecificationExecutor<Customer>",
    );
    const impl = files_.get(`${ROOT}/features/customers/CustomerRepositoryImpl.java`)!;
    expect(impl).toContain(
      'return jpa.findAll(CustomerCriteria.InRegion(rgn), Sort.by(Sort.Order.asc("name")));',
    );
    expect(impl).toContain("import com.loom.crmapi.domain.criteria.CustomerCriteria;");
  });

  it("composed retrieval falls back to a @Query JPQL with order by", async () => {
    const jpa = (await files()).get(`${ROOT}/features/customers/CustomerJpaRepository.java`)!;
    expect(jpa).toContain(
      '@Query("select e from Customer e where e.active and e.score >= :min order by e.score desc, e.name asc")',
    );
    expect(jpa).toContain('    List<Customer> runActiveHighScorers(@Param("min") int min);');
  });
});

describe("java generator — workflow Repo.run + for loop", () => {
  it("lowers repo-run to the port retrieval call and for-each to an enhanced for with saves", async () => {
    const wf = (await files()).get(`${ROOT}/application/workflows/CrmWorkflows.java`)!;
    expect(wf).toContain("        var matched = customersRepository.runByRegion(rgn);");
    expect(wf).toContain("        for (var c : matched) {");
    expect(wf).toContain("            c.deactivate();");
    expect(wf).toContain("            customersRepository.save(c);");
  });
});
