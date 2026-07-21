export type MissionPlanTemplateOrigin = "system_default" | "custom";

export interface MissionPlanTemplate {
  id: string;
  companyId: string;
  key: string;
  name: string;
  selectionDescription: string;
  instructions: string;
  origin: MissionPlanTemplateOrigin;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MissionPlanTemplateList {
  companyId: string;
  templates: MissionPlanTemplate[];
}

export interface CreateMissionPlanTemplateRequest {
  name: string;
  selectionDescription: string;
  instructions: string;
}

export type UpdateMissionPlanTemplateRequest = Partial<CreateMissionPlanTemplateRequest> & {
  enabled?: boolean;
};

export interface DuplicateMissionPlanTemplateRequest {
  name?: string;
}
