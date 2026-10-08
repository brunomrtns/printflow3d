import React, { useState, useMemo, useCallback, useEffect } from "react";
import {
  Folder as FolderIcon,
  Plus,
  Box,
  LayoutGrid,
  Pencil,
  Trash2,
  Check,
  X,
  ChevronRight,
  KanbanSquare,
  Settings,
  PlusIcon,
} from "lucide-react";
import { Folder, STLModel, StorageStats } from "../types";

import Stack from "@mui/material/Stack";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { TreeViewDefaultItemModelProperties } from "@mui/x-tree-view/models";
import { useTreeItemUtils } from "@mui/x-tree-view/hooks";
import {
  UseTreeItemContentSlotOwnProps,
  UseTreeItemLabelSlotOwnProps,
  UseTreeItemStatus,
} from "@mui/x-tree-view/useTreeItem";
import { RichTreeView } from "@mui/x-tree-view/RichTreeView";
import { SimpleTreeView } from "@mui/x-tree-view/SimpleTreeView";
import {
  TreeItem,
  TreeItemProps,
  TreeItemSlotProps,
} from "@mui/x-tree-view/TreeItem";
import Container from "@mui/material/Container";
import Button from "@mui/material/Button";
import OutlinedInput from "@mui/material/OutlinedInput";
import Badge from "@mui/material/Badge";
import { useTranslation } from "react-i18next";

const APP_TAG = import.meta.env.VITE_APP_TAG || "dev";

interface SidebarProps {
  folders: Folder[];
  models: STLModel[];
  currentFolderId: string;
  storageStats: StorageStats;
  onSelectFolder: (id: string) => void;
  onCreateFolder: (name: string, parentId: string | null) => void;
  onRenameFolder: (id: string, newName: string) => void;
  onDeleteFolder: (id: string) => void;
  onMoveToFolder: (folderId: string, modelIds: string[]) => void;
  onUploadToFolder: (folderId: string, files: FileList) => void;
  onOpenSettings: () => void;
  onOpenProduction: () => void;
  variant?: "desktop" | "mobile";
}

const Sidebar: React.FC<SidebarProps> = ({
  folders,
  models,
  currentFolderId,
  storageStats,
  onSelectFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveToFolder,
  onUploadToFolder,
  onOpenSettings,
  onOpenProduction,
  variant = "desktop",
}) => {
  const { t } = useTranslation();
  const isDesktopVariant = variant === "desktop";
  const [isCreatingRoot, setIsCreatingRoot] = useState(false);
  const [newRootName, setNewRootName] = useState("");

  // State for tree interactions
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creatingSubfolderId, setCreatingSubfolderId] = useState<string | null>(
    null,
  );
  const [dragTargetId, setDragTargetId] = useState<string | null>(null);

  // Resize state
  const [width, setWidth] = useState(330);
  const [isResizing, setIsResizing] = useState(false);

  const startResizing = useCallback(
    (e: React.MouseEvent) => {
      if (!isDesktopVariant) return;
      e.preventDefault(); // Prevent text selection
      setIsResizing(true);
    },
    [isDesktopVariant],
  );

  // Calculate direct counts only (not recursive, matching file system behavior usually)
  const folderCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    models.forEach((m) => {
      counts[m.folderId] = (counts[m.folderId] || 0) + 1;
    });
    folders.forEach((f) => {
      counts[f.parentId] = (counts[f.parentId] || 0) + 1;
    });
    return counts;
  }, [models, folders]);

  useEffect(() => {
    if (!isDesktopVariant) return;
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Limit width between 200px and 600px
      const newWidth = Math.min(Math.max(e.clientX, 200), 600);
      setWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    // Add grabbing cursor to body during resize
    document.body.style.cursor = "col-resize";

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
    };
  }, [isResizing, isDesktopVariant]);

  // Ensure parents of current folder are expanded
  useEffect(() => {
    if (currentFolderId && currentFolderId !== "all") {
      const expandPath = (id: string, path: Set<string>) => {
        const folder = folders.find((f) => f.id === id);
        if (folder && folder.parentId) {
          path.add(folder.parentId);
          expandPath(folder.parentId, path);
        }
      };

      setExpandedIds((prev) => {
        const next = new Set<string>(prev);
        expandPath(currentFolderId, next);
        return next;
      });
    }
  }, [currentFolderId, folders]);

  const handleCreateFolderSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (newRootName.trim() && !creatingSubfolderId) {
      onCreateFolder(newRootName.trim(), null);
      setNewRootName("");
      setIsCreatingRoot(false);
    } else if (newRootName.trim() && creatingSubfolderId != "") {
      onCreateFolder(newRootName.trim(), creatingSubfolderId);
      setNewRootName("");
      setIsCreatingRoot(false);
      setCreatingSubfolderId("");
    }
  };

  const toggleExpand = (id: string) => {
    onSelectFolder(id);
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleExpand = (e) => {
    e.stopPropagation();
    e.preventDefault();
  };

  const handleDeleteRequest = (id: string, count: number) => {
    if (count > 0) {
      alert(t("sidebar.folderNotEmpty"));
      return;
    }
    onDeleteFolder(id);
  };

  // Drag Handlers
  const handleDragOver = (e: React.DragEvent, folderId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragTargetId !== folderId) {
      setDragTargetId(folderId);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent, folderId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragTargetId(null);

    // Check for Files first (Upload to folder)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onUploadToFolder(folderId, e.dataTransfer.files);
      return;
    }

    // Check for internal move (Move existing cards to folder)
    try {
      const data = e.dataTransfer.getData("application/json");
      if (data) {
        const { modelIds } = JSON.parse(data);
        if (Array.isArray(modelIds) && modelIds.length > 0) {
          onMoveToFolder(folderId, modelIds);
        }
      }
    } catch (err) {
      console.error("Failed to process drop", err);
    }
  };

  // Format Storage Display
  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const percentUsed =
    storageStats.total > 0
      ? Math.min((storageStats.used / storageStats.total) * 100, 100)
      : 0;

  // Root folders
  const rootFolders = folders.filter((f) => f.parentId === null);

  //builds the treeview structure
  const treefolders = () => {
    const treeitems: TreeViewDefaultItemModelProperties[] = [];
    rootFolders.map((folder) => {
      treeitems.push({
        id: folder.id,
        label: folder.name,
        children: [],
      });
    });
    treeitems.map((folder) => {
      folders.map((subfolder) => {
        if (subfolder.parentId === folder.id) {
          folder.children.push({ id: subfolder.id, label: subfolder.name });
        }
      });
      folder.children.sort((a, b) => {
        return a.label.localeCompare(b.label);
      });
    });
    treeitems.sort((a, b) => {
      return a.label.localeCompare(b.label);
    });
    return treeitems;
  };

  interface CustomLabelProps extends UseTreeItemLabelSlotOwnProps {
    status: UseTreeItemStatus;
    onClick: React.MouseEventHandler<HTMLElement>;
    onPlusClick: React.MouseEventHandler<HTMLElement>;
  }

  function CustomLabel({
    children,
    status,
    onClick,
    onPlusClick,
    ...props
  }: CustomLabelProps) {
    return (
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        flexGrow={1}
        sx={{ minWidth: 0 }}
        {...props}
      >
        <Typography noWrap>{children}</Typography>
        <Stack direction="row">
          <IconButton
            onClick={onPlusClick}
            aria-label={t("sidebar.createSubfolder")}
            size="small"
            sx={{ color: "grey.300" }}
          >
            <PlusIcon />
          </IconButton>
          <IconButton
            onClick={onClick}
            aria-label={t("sidebar.deleteFolder")}
            size="small"
            edge="end"
            sx={{ color: "grey.300" }}
          >
            <Trash2 />
          </IconButton>
        </Stack>
      </Stack>
    );
  }

  const CustomTreeItem = React.forwardRef(function CustomTreeItem(
    props: TreeItemProps,
    ref: React.Ref<HTMLLIElement>,
  ) {
    const { interactions, status } = useTreeItemUtils({
      itemId: props.itemId,
      children: props.children,
    });

    const handleContentClick: UseTreeItemContentSlotOwnProps["onClick"] = (
      event,
    ) => {
      onSelectFolder(props.itemId);
    };
    const count = folderCounts[props.itemId] || 0;

    const handleIconButtonClick = (event: React.MouseEvent) => {
      event.stopPropagation();
      handleDeleteRequest(props.itemId, count);
    };

    const handlePlusClick = (event: React.MouseEvent) => {
      event.stopPropagation();
      setCreatingSubfolderId(props.itemId);
      setIsCreatingRoot(true);
      document.getElementById("folder-name-input").focus();
    };

    return (
      <TreeItem
        {...props}
        ref={ref}
        onDragOver={(e) => handleDragOver(e, props.itemId)}
        onDragLeave={handleDragLeave}
        onDrop={(e) => handleDrop(e, props.itemId)}
        className={
          props.itemId === dragTargetId
            ? "bg-white/10 rounded-md ring-2 ring-white"
            : ""
        }
        slots={{
          label: CustomLabel,
        }}
        slotProps={
          {
            label: {
              onClick: handleIconButtonClick,
              onPlusClick: handlePlusClick,
              status,
            },
            content: { onClick: handleContentClick },
          } as TreeItemSlotProps
        }
      />
    );
  });

  return (
    <Container
      disableGutters
      sx={{ bgcolor: "background.paper" }}
      className="border-r border-border flex flex-col h-full select-none relative shrink-0 group/sidebar mr-6"
      style={isDesktopVariant ? { width } : undefined}
      onDragLeave={() => setDragTargetId(null)}
    >
      <div className="p-6 flex items-center gap-3">
        <Stack
          direction="row"
          gap={1}
          sx={{
            justifyContent: "flex-start",
            alignItems: "baseline",
            minWidth: 0,
          }}
        >
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 pt-1 bg-gradient-to-br from-accent to-accent-hover glow-accent text-bg">
            <Box className="w-5 h-5 text-white pb-1" />
          </div>
          <Typography noWrap variant="h4">
            PrintFlow3D
          </Typography>
          <Typography
            noWrap
            variant="subtitle2"
            sx={{ color: "text.secondary" }}
          >
            v{APP_TAG}
          </Typography>
        </Stack>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 space-y-0.5 scrollbar-thin scrollbar-thumb-vault-700 scrollbar-track-transparent overflow-y-scroll">
        <div className="px-4 mb-4">
          <Button
            fullWidth
            startIcon={<Plus />}
            onClick={() => {
              setIsCreatingRoot(true);
              document.getElementById("folder-name-input").focus();
            }}
            variant="outlined"
          >
            {t("sidebar.newRootFolder")}
          </Button>
        </div>

        <form
          onSubmit={handleCreateFolderSubmit}
          className={`px-4 mb-4 transition-all duration-400 ${
            isCreatingRoot ? "opacity-100" : "opacity-0 origin-top h-0"
          }`}
        >
          <div className="flex items-center gap-1 mb-3">
            <OutlinedInput
              id="folder-name-input"
              type="text"
              className="w-full"
              placeholder={t("sidebar.folderNamePlaceholder")}
              value={newRootName}
              onChange={(e) => setNewRootName(e.target.value)}
              onBlur={() => {
                !newRootName.trim();
                setIsCreatingRoot(false);
                setCreatingSubfolderId("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setIsCreatingRoot(false);
                  setCreatingSubfolderId("");
                }
              }}
            />
          </div>
        </form>

        <Button
          variant="contained"
          startIcon={<LayoutGrid />}
          color={currentFolderId === "all" ? "info" : "primary"}
          onClick={() => onSelectFolder("all")}
          endIcon={
            <Badge badgeContent={models.length} className="mr-2"></Badge>
          }
          className="w-full"
          sx={{ alignItems: "center", justifyContent: "space-between" }}
        >
          {t("sidebar.allModels")}
        </Button>

        <Button
          variant="contained"
          startIcon={<KanbanSquare />}
          color="primary"
          onClick={onOpenProduction}
          className="w-full mt-2"
          sx={{ alignItems: "center", justifyContent: "space-between" }}
        >
          {t("production.navItem")}
        </Button>

        <div className="pt-2 pb-1 px-3 text-xs font-semibold text-slate-500 uppercase tracking-wider flex justify-between items-center">
          <Typography variant="subtitle1">{t("sidebar.library")}</Typography>
        </div>

        <div className="space-y-1 pb-4 ">
          <RichTreeView
            items={treefolders()}
            slots={{ item: CustomTreeItem }}
            expansionTrigger="iconContainer"
            onItemExpansionToggle={handleExpand}
            isItemEditable
            onItemLabelChange={(itemId, label) => onRenameFolder(itemId, label)}
          />
        </div>
      </nav>

      <div className="p-4 border-t border-vault-700 z-10 gap-3 flex flex-col">
        <Button
          variant="outlined"
          startIcon={<Settings />}
          color="info"
          onClick={onOpenSettings}
          className="w-full"
          sx={{ alignItems: "center", justifyContent: "center" }}
        >
          {t("common.settings")}
        </Button>

        <div className="bg-gradient-to-r from-blue-600 to-indigo-600 rounded-md p-3 shadow-lg">
          <p className="text-xs text-white/80 font-medium mb-1 truncate mb-2">
            {t("sidebar.storageUsed")}
          </p>
          <div className="w-full bg-black/20 rounded-full h-1.5 mb-1 overflow-hidden">
            <div
              className="bg-white h-full rounded-full transition-all duration-500 ease-out"
              style={{ width: `${percentUsed}%` }}
            ></div>
          </div>
          <p className="text-[10px] text-white/60 flex justify-between">
            <span>{formatSize(storageStats.used)}</span>
            <span>{formatSize(storageStats.total)}</span>
          </p>
        </div>
      </div>

      {/* Resizer Handle */}
      {isDesktopVariant && (
        <div
          className={`absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-500 transition-colors z-50 ${
            isResizing ? "bg-blue-500" : "bg-transparent"
          }`}
          onMouseDown={startResizing}
        />
      )}
    </Container>
  );
};

export default Sidebar;
