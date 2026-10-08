// Vite environment variables type declaration
declare global {
  interface ImportMetaEnv {
    readonly VITE_APP_TAG: string;
    readonly VITE_API_URL?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  icon?: string;
}

export interface STLModel {
  id: string;
  name: string;
  folderId: string;
  url: string; // Blob URL
  size: number;
  dateAdded: number;
  tags: string[];
  description: string;
  dimensions?: { x: number; y: number; z: number };
  thumbnail?: string;
  manual?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  // Mesh processing (backend pipeline): volume in mL (cm³) and the
  // estimated material cost in BRL. previewUrl points at the decimated
  // .glb proxy when proxyStatus === 'done', otherwise it equals url.
  volumeMl?: number | null;
  estimatedCost?: number | null;
  proxyStatus?: "pending" | "done" | "failed" | "skipped" | null;
  previewUrl?: string;
  // scaleWarning: the piece is larger than a typical resin build plate —
  // probably exported at the wrong scale (unitless STL, e.g. Meshy AI
  // normalizing to ~2m). Shown as a warning, never auto-rescaled.
  scaleWarning?: boolean;
}

// ── Production (Kanban) ──
export type ProductionStatus = "queue" | "printing" | "washing" | "done";

export interface ProductionJob {
  id: string;
  modelId: string;
  status: ProductionStatus;
  createdAt: number;
  updatedAt?: number;
  modelName: string;
  volumeMl?: number | null;
  estimatedCost?: number | null;
  thumbnailUrl?: string;
}

export interface ModelGroup {
  id: string;
  name: string;
  dateAdded: number;
  modelIds: string[];
}

export interface STLModelCollection {
  source?: string;
  parentId: string;
  id: string;
  name: string;
  folder: string | null;
  previewPath: string;
  typeName: string;
}

export interface StorageStats {
  used: number;
  total: number;
}

export enum ViewMode {
  GRID = "GRID",
  LIST = "LIST",
}

export type AppState = {
  folders: Folder[];
  models: STLModel[];
  currentFolderId: string;
  selectedModelId: string | null;
  sidebarOpen: boolean;
};
