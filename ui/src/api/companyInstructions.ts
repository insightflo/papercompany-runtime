import type {
  CompanyInstructionFileDetail,
  CompanyInstructionsBundle,
} from "@paperclipai/shared";
import { api } from "./client";

function companyInstructionsPath(companyId: string, suffix = "") {
  return `/companies/${encodeURIComponent(companyId)}/instructions${suffix}`;
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
