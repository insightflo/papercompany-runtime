import { z } from "zod";

const readable = (max: number) => z.string().trim().min(1).max(max);

export const humanReviewEvidenceRefSchema = z.object({
  label: readable(160),
  href: readable(2_000).refine(
    (value) => value.startsWith("/") || value.startsWith("http://") || value.startsWith("https://"),
    "Evidence href must be an application path or HTTP(S) URL",
  ),
  location: readable(300),
  description: z.string().trim().max(1_000).nullable().default(null),
}).strict();

export const humanReviewPacketSchema = z.object({
  schemaVersion: z.literal("human-review-v1"),
  decisionSubject: readable(300),
  evidence: z.array(humanReviewEvidenceRefSchema).min(1).max(20),
  interpretation: readable(4_000),
  impact: z.object({
    ifApproved: readable(2_000),
    ifRejected: readable(2_000),
    ifWrong: readable(2_000),
  }).strict(),
  unresolvedFacts: z.array(readable(1_000)).max(30),
  questions: z.array(readable(1_000)).max(30),
  recommendedNextStep: readable(2_000),
  requiredReviewer: readable(200),
}).strict();

export type HumanReviewPacketInput = z.infer<typeof humanReviewPacketSchema>;

export function readHumanReviewPacket(value: unknown): HumanReviewPacketInput | null {
  const parsed = humanReviewPacketSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
