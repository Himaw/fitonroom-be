import { describe, expect, it } from "vitest";
import { hashInstallId } from "./hash";

describe("hashInstallId", () => {
  it("is deterministic for the same secret and install ID", () => {
    expect(hashInstallId("install-1", "secret-secret-secret")).toEqual(
      hashInstallId("install-1", "secret-secret-secret")
    );
  });

  it("changes when the secret changes", () => {
    expect(hashInstallId("install-1", "secret-secret-secret")).not.toEqual(
      hashInstallId("install-1", "different-secret-secret")
    );
  });
});
