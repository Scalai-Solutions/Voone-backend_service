import { describe, expect, it } from "vitest";

import { OVERRIDE_VARIABLE, assertLocalDatabaseUrl } from "../assert-local-database";

describe("assertLocalDatabaseUrl", () => {
  it.each([
    "postgresql://voone:voone@localhost:5432/voone?schema=public",
    "postgresql://weekend@127.0.0.1:5432/voone",
    "postgresql://user@[::1]:5432/voone",
    "postgresql://user@host.docker.internal:5432/voone",
    // A unix socket has no host at all.
    "postgresql:///voone"
  ])("allows %s", (url) => {
    expect(() => assertLocalDatabaseUrl(url, undefined)).not.toThrow();
  });

  it("refuses the hosted Supabase pooler", () => {
    const url =
      "postgresql://postgres.ref:pass%40word@aws-1-eu-west-3.pooler.supabase.com:5432/postgres";

    expect(() => assertLocalDatabaseUrl(url, undefined)).toThrow(/Refusing to run/);
    expect(() => assertLocalDatabaseUrl(url, undefined)).toThrow(/pooler\.supabase\.com/);
  });

  it("never echoes the credentials in the refusal", () => {
    const url = "postgresql://postgres.ref:sup3rs3cret@db.example.com:5432/postgres";

    try {
      assertLocalDatabaseUrl(url, undefined);
      expect.unreachable("expected a refusal");
    } catch (error) {
      expect((error as Error).message).not.toContain("sup3rs3cret");
    }
  });

  it("names the override in the refusal so the way out is discoverable", () => {
    expect(() => assertLocalDatabaseUrl("postgresql://u@db.example.com/x", undefined)).toThrow(
      new RegExp(OVERRIDE_VARIABLE)
    );
  });

  it("allows a remote database with an explicit override", () => {
    expect(() => assertLocalDatabaseUrl("postgresql://u@db.example.com/x", "true")).not.toThrow();
  });

  it("does not accept a truthy-ish override that is not exactly true", () => {
    expect(() => assertLocalDatabaseUrl("postgresql://u@db.example.com/x", "1")).toThrow();
    expect(() => assertLocalDatabaseUrl("postgresql://u@db.example.com/x", "yes")).toThrow();
  });

  it("refuses a missing or unparseable url rather than assuming it is local", () => {
    expect(() => assertLocalDatabaseUrl(undefined, undefined)).toThrow(/not set/);
    expect(() => assertLocalDatabaseUrl("not a url", undefined)).toThrow(/could not be parsed/);
  });

  it("refuses a url with an unencoded @ in the password rather than trusting it", () => {
    // Node's URL splits the authority on the LAST "@" while libpq splits on the first, so
    // this parses here (hostname "host") even though libpq could never connect with it.
    // Either way it is not demonstrably local, so it must not pass.
    expect(() => assertLocalDatabaseUrl("postgres://u:pa@ss@host/db", undefined)).toThrow(
      /Refusing to run/
    );
  });
});
