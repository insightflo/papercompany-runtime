export interface CompanyInstructionFileSummary {
  path: string;
  size: number;
  language: string;
  markdown: boolean;
  editable: boolean;
}

export interface CompanyInstructionFileDetail extends CompanyInstructionFileSummary {
  content: string;
}

export interface CompanyInstructionsBundle {
  companyId: string;
  rootPath: string;
  files: CompanyInstructionFileSummary[];
}

export interface CompanyInstructionFileUpdateRequest {
  path: string;
  content: string;
}
