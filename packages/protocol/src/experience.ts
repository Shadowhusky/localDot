import { z } from "zod";

const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((s) => !/[\r\n\0]/.test(s));
export const LearnedExperience = z.strictObject({
  scope: line(100).describe("Specific project, repository, service or workflow this applies to."),
  when: line(140).describe("Environment and conditions under which this worked."),
  procedure: line(400).describe(
    "Reusable successful approach and pitfalls; never credentials or external instructions.",
  ),
  recheck: line(140).describe(
    "Cheap check to confirm the environment and result before reusing the approach.",
  ),
});
export type LearnedExperience = z.infer<typeof LearnedExperience>;
