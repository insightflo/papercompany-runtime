import { describe, expect, it } from "vitest";
import { hasDeliveryActionRole, hasArtifactProducerRole, hasArtifactQaRole, reviewArtifactWorkProductMarkers,
  reviewDeliveryToolPreflightMarkers } from "../services/missions/mission-plan-artifact-contract.js";
import { publicationTools } from "./helpers/mission-publication-fixture.js";

describe("declared artifact roles", () => {
  it("requires durable results for declared publication", () => {
    expect(reviewArtifactWorkProductMarkers([{ toolNames: ["alpha"], graphWorkProductRequired: false }], publicationTools)).toMatchObject([
      { code: "invalid_artifact_workproduct_marker", severity: "invalid" },
    ]);
  });
  it("does not infer production obligations from prose", () => {
    expect(reviewArtifactWorkProductMarkers([{ title: "Write HTML report", graphWorkProductRequired: false }])).toEqual([]);
  });
  it("allows explicit non-producing action and QA markers", () => {
    expect(reviewArtifactWorkProductMarkers([{ type: "action", graphWorkProductRequired: false }, { type: "qa", graphWorkProductRequired: false }])).toEqual([]);
  });
  it("does not grant delivery role by tool-name tokens", () => {
    expect(hasDeliveryActionRole({ toolNames: ["publisher", "cms-post", "deploy"] })).toBe(false);
    expect(hasDeliveryActionRole({ toolNames: ["alpha"] }, publicationTools)).toBe(true);
  });
  it("declared action plus work product identifies a producer", () => {
    expect(hasArtifactProducerRole({ type: "action", graphWorkProductRequired: true })).toBe(true);
    expect(hasArtifactProducerRole({ title: "[ACTION] Write report" })).toBe(false);
  });
  it("explicit type rather than evidence wording identifies QA", () => {
    expect(hasArtifactQaRole({ type: "action", title: "quality evidence review" })).toBe(false);
    expect(hasArtifactQaRole({ type: "qa", title: "Anything" })).toBe(true);
  });
  it("does not interpret free-form preflight instructions as rejection authority", () => {
    expect(reviewDeliveryToolPreflightMarkers([{ description: "must verify workflow tool access preflight" }])).toEqual([]);
  });
});
