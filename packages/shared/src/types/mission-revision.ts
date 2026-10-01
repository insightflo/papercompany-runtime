/** Immutable source pointers; omission is an ordinary mission, not implicit reuse. */
export interface MissionRevisionSource {
  sourceMissionId: string | null;
  sourceWorkflowRunId: string | null;
}
export type MissionRevisionSourceInput = Partial<MissionRevisionSource>;
