// D3: pluggable handle-type registry.
// Run: node --import tsx/esm --test src/registry.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HANDLE_TYPES,
  enabledHandleTypes,
  getHandleType,
  assertDisjointIdentityProviders,
  handleTypeForCanonical,
} from "@zeekpay/shared";

// One representative raw input per enabled type, chosen to exercise the "@"
// stripping / casing normalization each parser does.
const SAMPLE_INPUT: Record<string, string> = {
  google: "Alice@Example.com",
  x: "@Alice",
  email: "Alice@Example.com",
  github: "@Torvalds",
  discord: "Alice.B_2",
  telegram: "@Alice_Bot_99",
};

describe("handle registry: parse/format round trip", () => {
  for (const handleType of enabledHandleTypes()) {
    it(`${handleType.id}: parse -> format -> parse is stable`, () => {
      const raw = SAMPLE_INPUT[handleType.id];
      assert.ok(raw, `no sample input configured for ${handleType.id}`);

      const canonical = handleType.parse(raw);
      assert.ok(canonical, `${handleType.id}.parse(${JSON.stringify(raw)}) returned null`);

      const displayed = handleType.format(canonical!);
      assert.equal(typeof displayed, "string");

      // Formatting only ever adds or removes display sugar (a leading "@", a
      // "<type>:" namespace); parsing the displayed form must recover the exact
      // same canonical value.
      const reparsed = handleType.parse(displayed);
      assert.equal(reparsed, canonical);
    });

    it(`${handleType.id}: parse rejects empty input`, () => {
      assert.equal(handleType.parse(""), null);
    });
  }

  it("all three SOW handle types are enabled", () => {
    const ids = enabledHandleTypes().map((h) => h.id);
    for (const id of ["github", "discord", "telegram"] as const) assert.ok(ids.includes(id), id);
  });
});

// The resolver keys on one handle_normalized column with one unique index over
// it (backend/sql/handles_unique.sql), so two types producing the same
// canonical form means two people sharing a payment address. Only google and
// email may collide, and only because they are the same person at the same
// address.
describe("handle registry: canonical forms are globally unique", () => {
  // Types whose input is a bare name, so nothing in the value itself says which
  // provider issued it. These are the ones that need a namespace; x is exempt
  // because the "@" it prepends is one, and email/google canonicalize to an
  // address that is already globally unique.
  const BARE_NAME_TYPES = ["github", "discord", "telegram"] as const;

  it("every bare-name type prefixes its canonical form with its own id", () => {
    // This is the rule that makes the collision check below hold for types that
    // do not exist yet. Checked per type, because a single un-namespaced type
    // collides with nothing until the next one is added, and by then the
    // handles table already holds rows that cannot be told apart.
    for (const id of BARE_NAME_TYPES) {
      const canonical = getHandleType(id)!.parse("alice");
      assert.equal(canonical, `${id}:alice`);
    }
  });

  it("no two types canonicalize the same input to the same string", () => {
    // "alice" parses under every bare-name type and under x; "alice_99" adds
    // telegram's minimum length; the address is the google/email pair.
    for (const raw of ["alice", "alice_99", "Alice@Example.com"]) {
      const seen = new Map<string, string>();
      for (const handleType of HANDLE_TYPES) {
        const canonical = handleType.parse(raw);
        if (!canonical) continue;
        const owner = seen.get(canonical);
        assert.ok(
          owner === undefined || (owner === "google" && handleType.id === "email"),
          `${handleType.id} and ${owner} both canonicalize "${raw}" to "${canonical}"`
        );
        seen.set(canonical, handleType.id);
      }
    }
  });

  it("google and email share one canonical form on purpose", () => {
    const addr = "Alice@Example.com";
    assert.equal(
      getHandleType("google")!.parse(addr),
      getHandleType("email")!.parse(addr)
    );
  });
});

describe("handle registry: identityProviders are pairwise disjoint", () => {
  it("the real registry does not throw", () => {
    assert.doesNotThrow(() => assertDisjointIdentityProviders(HANDLE_TYPES));
  });

  it("throws when two types claim the same raw provider id", () => {
    const overlapping = [
      { id: "a", identityProviders: ["shared_provider"] },
      { id: "b", identityProviders: ["shared_provider"] },
    ];
    assert.throws(
      () => assertDisjointIdentityProviders(overlapping),
      /identityProviders value "shared_provider" is claimed by both "a" and "b"/
    );
  });
});

describe("handle registry: github canonical form", () => {
  const github = getHandleType("github")!;

  it("namespaces and lowercases the login", () => {
    assert.equal(github.parse("Torvalds"), "github:torvalds");
    assert.equal(github.parse("@Torvalds"), "github:torvalds");
    assert.equal(github.parse("  torvalds  "), "github:torvalds");
  });

  it("accepts its own canonical form back (idempotent)", () => {
    assert.equal(github.parse("github:torvalds"), "github:torvalds");
    assert.equal(github.parse("GitHub:Torvalds"), "github:torvalds");
  });

  it("displays the bare login, no @ and no namespace", () => {
    // The UI puts the GitHub icon and label next to it, so the prefix would be
    // noise on screen.
    assert.equal(github.format("github:torvalds"), "torvalds");
  });

  it("rejects logins GitHub itself would reject", () => {
    assert.equal(github.parse("-leading-dash"), null);
    assert.equal(github.parse("trailing-dash-"), null);
    assert.equal(github.parse("has space"), null);
    assert.equal(github.parse("under_score"), null);
    assert.equal(github.parse("a".repeat(40)), null);
    // The namespace is not a way in: the body still has to be a real login.
    assert.equal(github.parse("github:has space"), null);
  });

  it("matches the charset the SQL trigger guards on", () => {
    // backend/sql/handles_github.sql refuses anything this regex rejects. The
    // two must agree or the trigger writes rows the registry cannot parse.
    const sqlGuard = /^github:[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
    for (const login of ["torvalds", "a", "a-b", "a1-b2-c3", "a".repeat(39)]) {
      const canonical = github.parse(login);
      assert.ok(canonical, `registry rejected ${login}`);
      assert.match(canonical!, sqlGuard);
    }
    for (const login of ["-a", "a-", "a b", "a_b", "a".repeat(40)]) {
      assert.equal(github.parse(login), null, `registry accepted ${login}`);
      assert.doesNotMatch(`github:${login.toLowerCase()}`, sqlGuard);
    }
  });
});

// discord is enabled now; its own namespace/charset tests moved to the
// "discord canonical form" block below, mirroring github's. telegram stays
// disabled but is parsed here anyway: the namespace rule is what keeps it
// from colliding with github/discord the day it's turned on too, and a rule
// nothing tests is a rule that quietly rots. The round-trip and
// handleTypeForCanonical checks below cover discord and telegram together
// since both hold regardless of a type's enabled flag.
describe("handle registry: bare-name type namespacing", () => {
  const discord = getHandleType("discord")!;
  const telegram = getHandleType("telegram")!;

  it("telegram: parse namespaces and lowercases", () => {
    assert.equal(telegram.parse("Alice_99"), "telegram:alice_99");
    assert.equal(telegram.parse("@alice_99"), "telegram:alice_99");
    assert.equal(telegram.parse("telegram:Alice_99"), "telegram:alice_99");
    assert.equal(telegram.parse("abcd"), null, "four characters is below the minimum");
    assert.equal(telegram.parse("a".repeat(33)), null);
    assert.equal(telegram.format("telegram:alice_99"), "@alice_99");
  });

  it("both round-trip through format", () => {
    for (const handleType of [discord, telegram]) {
      const canonical = handleType.parse("alice_99")!;
      assert.ok(canonical);
      assert.equal(handleType.parse(handleType.format(canonical)), canonical);
    }
  });

  it("handleTypeForCanonical maps a stored canonical to its type whether or not the type is currently enabled", () => {
    // A row written while discord was disabled (or restored from a backup)
    // must not become unlabelable now that it's on, and the same must hold
    // for telegram if it stays off: enabledHandleTypes() gates parsing new
    // input, not looking up what a canonical string already is.
    assert.equal(handleTypeForCanonical("discord:alice")?.id, "discord");
    assert.equal(handleTypeForCanonical("telegram:alice_99")?.id, "telegram");
  });
});

describe("handle registry: discord canonical form", () => {
  const discord = getHandleType("discord")!;

  it("namespaces and lowercases the username", () => {
    assert.equal(discord.parse("Alice"), "discord:alice");
    assert.equal(discord.parse("@Alice.B_2"), "discord:alice.b_2");
    assert.equal(discord.parse("discord:Alice"), "discord:alice");
  });

  it("accepts its own canonical form back (idempotent)", () => {
    assert.equal(discord.parse("discord:alice"), "discord:alice");
    assert.equal(discord.parse("Discord:Alice"), "discord:alice");
  });

  it("displays the bare username, no @ and no namespace", () => {
    assert.equal(discord.format("discord:alice"), "alice");
  });

  it("rejects usernames Discord itself would reject", () => {
    assert.equal(discord.parse("a"), null, "one character is below the minimum");
    assert.equal(discord.parse("a".repeat(33)), null, "33 characters is above the maximum");
    assert.equal(discord.parse("has space"), null);
    assert.equal(discord.parse("a..b"), null, "consecutive periods are not allowed");
    assert.equal(discord.parse("a-b"), null, "hyphen is not in Discord's username charset");
    // The namespace is not a way in: the body still has to be a real username.
    assert.equal(discord.parse("discord:a..b"), null);
  });

  it("matches the charset the SQL trigger guards on", () => {
    // backend/sql/handles_discord.sql refuses anything this regex rejects. The
    // two must agree or the trigger writes rows the registry cannot parse.
    const sqlGuard = /^discord:(?!.*\.\.)[a-z0-9._]{2,32}$/;
    for (const name of ["alice", "a1", "a.b_c", "a".repeat(32)]) {
      const canonical = discord.parse(name);
      assert.ok(canonical, `registry rejected ${name}`);
      assert.match(canonical!, sqlGuard);
    }
    for (const name of ["a", "a..b", "a-b", "a".repeat(33)]) {
      assert.equal(discord.parse(name), null, `registry accepted ${name}`);
      assert.doesNotMatch(`discord:${name.toLowerCase()}`, sqlGuard);
    }
  });
});

describe("handle registry: profileUrl", () => {
  it("github: bare login and namespaced canonical give the same profile URL", () => {
    const github = getHandleType("github")!;
    const bare = github.parse("torvalds")!;
    const namespaced = github.parse("github:torvalds")!;
    assert.equal(bare, namespaced);
    assert.equal(github.profileUrl(bare), "https://github.com/torvalds");
    assert.equal(github.profileUrl(namespaced), "https://github.com/torvalds");
  });

  it("x: profile URL strips the leading @", () => {
    const x = getHandleType("x")!;
    const canonical = x.parse("@muskaroo")!;
    assert.equal(canonical, "@muskaroo");
    assert.equal(x.profileUrl(canonical), "https://x.com/muskaroo");
  });

  it("telegram: bare name and namespaced canonical give the same t.me URL", () => {
    const telegram = getHandleType("telegram")!;
    const bare = telegram.parse("alice_99")!;
    const namespaced = telegram.parse("telegram:alice_99")!;
    assert.equal(bare, namespaced);
    assert.equal(telegram.profileUrl(bare), "https://t.me/alice_99");
    assert.equal(telegram.profileUrl(namespaced), "https://t.me/alice_99");
  });

  it("discord has no profile URL", () => {
    const discord = getHandleType("discord")!;
    assert.equal(discord.profileUrl(discord.parse("alice")!), null);
  });

  it("google and email have no profile URL", () => {
    const google = getHandleType("google")!;
    const email = getHandleType("email")!;
    const addr = "alice@example.com";
    assert.equal(google.profileUrl(google.parse(addr)!), null);
    assert.equal(email.profileUrl(email.parse(addr)!), null);
  });
});
