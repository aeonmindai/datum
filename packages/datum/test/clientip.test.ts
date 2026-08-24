import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { clientIp } from "../src/http/admin.js";

/**
 * The login rate limit is keyed on this value, so a caller who can choose it can defeat the
 * limit. Datum sits behind Cloudflare in front of Fly, and both proxies APPEND to any
 * `X-Forwarded-For` the client sent — so the leftmost entry is attacker-controlled and must
 * never be believed.
 */

const req = (headers: Record<string, string | string[]>, ip = "10.0.0.1"): FastifyRequest =>
  ({ headers, ip }) as unknown as FastifyRequest;

describe("clientIp", () => {
  it("prefers Cloudflare's header, which Cloudflare strips from client input", () => {
    expect(
      clientIp(
        req({
          "cf-connecting-ip": "203.0.113.9",
          "x-forwarded-for": "1.2.3.4, 203.0.113.9, 172.16.0.1",
          "fly-client-ip": "198.51.100.1",
        }),
      ),
    ).toBe("203.0.113.9");
  });

  it("falls back to Fly's edge header", () => {
    expect(clientIp(req({ "fly-client-ip": "198.51.100.1", "x-forwarded-for": "1.2.3.4" }))).toBe(
      "198.51.100.1",
    );
  });

  it("ignores a spoofed leading X-Forwarded-For entry", () => {
    // The attack: send a fresh fake IP each attempt to get a fresh rate-limit bucket.
    const spoofed = clientIp(req({ "x-forwarded-for": "1.2.3.4, 203.0.113.9" }));
    expect(spoofed).not.toBe("1.2.3.4");
    expect(spoofed).toBe("203.0.113.9");
  });

  it("does not let a client invent a bucket by sending only a fake XFF", () => {
    // One hop of client-supplied garbage collapses to that garbage, which is why this is the
    // last resort and why the socket peer is the floor when there is no proxy at all.
    expect(clientIp(req({}, "192.0.2.7"))).toBe("192.0.2.7");
    expect(clientIp(req({ "x-forwarded-for": "   " }, "192.0.2.7"))).toBe("192.0.2.7");
  });

  it("handles repeated headers without trusting the wrong one", () => {
    expect(clientIp(req({ "cf-connecting-ip": ["203.0.113.9", "1.2.3.4"] }))).toBe("203.0.113.9");
  });
});
