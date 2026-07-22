import type {
  CompanyInstructionFileDetail,
  CompanyInstructionsBundle,
  CreateMissionPlanTemplateRequest,
  DuplicateMissionPlanTemplateRequest,
  MissionPlanTemplate,
  MissionPlanTemplateList,
  UpdateMissionPlanTemplateRequest,
} from "@paperclipai/shared";
import { api } from "./client";

function companyInstructionsPath(companyId: string, suffix = "") {
  return `/companies/${encodeURIComponent(companyId)}/instructions${suffix}`;
}

function missionPlanTemplatesPath(companyId: string, suffix = "") {
  return `/companies/${encodeURIComponent(companyId)}/mission-plan-templates${suffix}`;
}

export const companyInstructionsApi = {
  bundle: (companyId: string) =>
    api.get<CompanyInstructionsBundle>(companyInstructionsPath(companyId)),
  file: (companyId: string, relativePath: string) =>
    api.get<CompanyInstructionFileDetail>(
      companyInstructionsPath(companyId, `/file?path=${encodeURIComponent(relativePath)}`),
    ),
  updateFile: (companyId: string, relativePath: string, content: string) =>
    api.put<CompanyInstructionFileDetail>(
      companyInstructionsPath(companyId, "/file"),
      { path: relativePath, content },
    ),
  deleteFile: (companyId: string, relativePath: string) =>
    api.delete<{ path: string }>(
      companyInstructionsPath(companyId, `/file?path=${encodeURIComponent(relativePath)}`),
    ),
};

export const missionPlanTemplatesApi = {
  list: (companyId: string) =>
    api.get<MissionPlanTemplateList>(`${missionPlanTemplatesPath(companyId)}?includeDisabled=true`),
  create: (companyId: string, input: CreateMissionPlanTemplateRequest) =>
    api.post<MissionPlanTemplate>(missionPlanTemplatesPath(companyId), input),
  update: (companyId: string, templateId: string, input: UpdateMissionPlanTemplateRequest) =>
    api.patch<MissionPlanTemplate>(missionPlanTemplatesPath(companyId, `/${encodeURIComponent(templateId)}`), input),
  duplicate: (companyId: string, templateId: string, input: DuplicateMissionPlanTemplateRequest = {}) =>
    api.post<MissionPlanTemplate>(missionPlanTemplatesPath(companyId, `/${encodeURIComponent(templateId)}/duplicate`), input),
  remove: (companyId: string, templateId: string) =>
    api.delete<void>(missionPlanTemplatesPath(companyId, `/${encodeURIComponent(templateId)}`)),
};
