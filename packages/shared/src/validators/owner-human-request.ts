import { z } from "zod";

// The key identifies a request, not permission. Preserve its bytes for later exact-key comparison.
export const ownerHumanRequestSchema = z.object({
  schemaVersion: z.literal(1),
  requestKey: z.string().min(1).refine((value) => value.trim().length > 0, {
    message: "requestKey must not be blank",
  }),
  expectedCurrentLifetimeId: z.string().uuid().nullable(),
}).strict();
