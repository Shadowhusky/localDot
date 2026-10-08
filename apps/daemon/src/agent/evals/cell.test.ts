import { describe, expect, it } from "vitest";
import { evalCellOptions, scopeFilters } from "./cell.ts";

const lane = { label: "dev.localdot.test=l5", namePrefix: "ldtest-l5-" };

describe("evalCellOptions", () => {
  it("defaults to the suite's own label and name prefix", () => {
    expect(evalCellOptions({})).toMatchObject({
      label: "dev.localdot.test=eval",
      namePrefix: "ldtest-eval-",
    });
  });

  it("accepts a lane's own test label and prefix", () => {
    expect(
      evalCellOptions({
        LOCALDOT_EVAL_LABEL: lane.label,
        LOCALDOT_EVAL_NAME_PREFIX: lane.namePrefix,
      }),
    ).toMatchObject(lane);
  });

  it("refuses the live computer's labels and any other label key", () => {
    for (const label of [
      "localdot.role=desktop",
      "localdot.cell=x",
      "dev.localdot.test=",
      "dev.localdot.test=L5",
      "dev.localdot.test=l5.x",
      "dev.localdot.testx=l5",
      "x.dev.localdot.test=l5",
    ])
      expect(() => evalCellOptions({ LOCALDOT_EVAL_LABEL: label }), label).toThrow(
        /LOCALDOT_EVAL_LABEL/,
      );
  });

  it("refuses a localdot name prefix and anything that is not a prefix", () => {
    for (const prefix of ["localdot-", "localdot-desktop-", "ldtest", "LDTEST-", "-x-"])
      expect(() => evalCellOptions({ LOCALDOT_EVAL_NAME_PREFIX: prefix }), prefix).toThrow(
        /LOCALDOT_EVAL_NAME_PREFIX/,
      );
  });
});

describe("scopeFilters", () => {
  it("matches the suite's label and name prefix together", () => {
    expect(scopeFilters(lane)).toEqual([
      "--filter",
      "label=dev.localdot.test=l5",
      "--filter",
      "name=^/ldtest-l5-",
    ]);
  });

  it("narrows to one container by its full name", () => {
    expect(scopeFilters(lane, "ldtest-l5-calc-fill")).toEqual([
      "--filter",
      "label=dev.localdot.test=l5",
      "--filter",
      "name=^/ldtest-l5-calc-fill$",
    ]);
  });

  it("refuses a scope that could reach the live computer's containers", () => {
    expect(() => scopeFilters({ ...lane, label: "localdot.role=desktop" })).toThrow();
    expect(() => scopeFilters({ ...lane, namePrefix: "localdot-" })).toThrow();
  });

  it("refuses a name outside the suite's prefix, or no name at all", () => {
    for (const name of [
      "",
      "ldtest-l5-",
      "localdot-desktop",
      "ldtest-l6-calc-fill",
      "ldtest-l5-a$",
    ])
      expect(() => scopeFilters(lane, name), name).toThrow();
  });
});
