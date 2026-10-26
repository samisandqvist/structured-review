// Page URLs.
import { describe, it, expect } from "vitest";
import { mapUrl, sessionUrl } from "../src/navigation.js";

describe("page URLs", () => {
  it("links a session and its component map levels", () => {
    expect(sessionUrl("s 1")).toBe("/?session=s%201");
    expect(mapUrl("s1")).toBe("/?session=s1&view=map");
    expect(mapUrl("s1", "a b")).toBe("/?session=s1&view=map&level=a%20b");
  });
});
