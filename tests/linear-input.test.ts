import { expect, test } from "bun:test";
import { parseLinearInput } from "../src/linear/input";

test("Linear selectors accept the ticket grammar in any case and return it uppercase", () => {
  for (const key of ["ENG-123", "A1-0", "ENG-001"]) expect(parseLinearInput(`linear:${key}`)).toEqual({ key });
  for (const key of ["eng-123", "Eng-123", "a1-0"]) expect(parseLinearInput(`linear:${key}`)).toEqual({ key: key.toUpperCase() });
  for (const input of ["ENG-123", "Linear:ENG-123", " linear:ENG-123", "feature"]) expect(parseLinearInput(input)).toBeNull();
  for (const suffix of ["", " ENG-123", "ENG-123 ", "ENG-123 extra", "ENG-123\n", "ENG", "https://linear.app/a/issue/ENG-123"]) {
    expect(() => parseLinearInput(`linear:${suffix}`)).toThrow("Invalid Linear issue selector");
  }
});
