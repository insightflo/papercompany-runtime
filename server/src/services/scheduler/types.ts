/**
 * Scheduler Service Types
 *
 * Defines interfaces for scheduled agent wakeups using cron expressions.
 */

/**
 * A schedule defines when an agent should be automatically woken up.
 */
export interface Schedule {
  id: string;
  companyId: string;
  agentId: string;
  cronExpression: string;
  timezone: string;
  missionId: string | null;
  enabled: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input to create a new schedule.
 */
export interface CreateScheduleInput {
  companyId: string;
  agentId: string;
  cronExpression: string;
  timezone?: string;
  missionId?: string;
  enabled?: boolean;
}

/**
 * Input to update a schedule.
 */
export interface UpdateScheduleInput {
  cronExpression?: string;
  timezone?: string;
  missionId?: string | null;
  enabled?: boolean;
}

/**
 * Result of a schedule claim operation.
 */
export interface ScheduleClaimResult {
  claimed: Array<{
    id: string;
    agentId: string;
    missionId: string | null;
  }>;
}

/**
 * Scheduler state and statistics.
 */
export interface SchedulerState {
  running: boolean;
  lastPollAt: Date | null;
  activeScheduleCount: number;
  totalWakeupCount: number;
}
