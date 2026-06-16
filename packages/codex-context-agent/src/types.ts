export interface CodeAnalysisNote {
  type: 'componente' | 'api' | 'patron' | 'utilidad' | 'arquitectura' | 'integracion';
  area: 'general' | 'backend' | 'frontend' | 'devops' | 'infraestructura';
  title: string;
  resumen: string;
  content: string;
  tags: string[];
  vigente_desde?: string;
  version?: number;
  expires_at?: string;
  depends_on?: string[];
  exports?: string[];
  language?: string;
  files?: string[];
}

export interface CodeAnalysisResponse {
  notes: CodeAnalysisNote[];
}

export interface CodeAnalysisResult {
  notesWritten: string[];
  notesSkipped: string[];
  errors: string[];
  durationMs: number;
  filesAnalyzed?: string[];
}

export interface AssociatedDocs {
  codeFile: string;
  docFile?: string;
  contextFile?: string;
  readmeFile?: string;
}

export interface FileAnalysisContext {
  fullPath: string;
  relativePath: string;
  language: string;
  codeContent: string;
  docContent?: string;
  contextContent?: string;
  readmeContent?: string;
}
