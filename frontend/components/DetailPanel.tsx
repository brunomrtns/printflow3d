import React, { useState, useCallback, useRef, useEffect } from "react";
import { STLModel } from "../types";
import Viewer3D from "./Viewer3D";
import {
  X,
  Download,
  Tag as TagIcon,
  Sparkles,
  Save,
  Edit,
  Trash2,
  Calendar,
  HardDrive,
  FileUp,
  RefreshCw,
  AlertTriangle,
  ScreenShareIcon,
  BookOpen,
} from "lucide-react";

import { generateThumbnail } from "../services/thumbnailGenerator";
import {
  api,
  getEnabledLaunchSlicers,
  SLICERS,
  SlicerType,
} from "../services/api";
import { Typography } from "@mui/material";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Divider from "@mui/material/Divider";
import OutlinedInput from "@mui/material/OutlinedInput";
import TextField from "@mui/material/TextField";
import Badge from "@mui/material/Badge";
import Chip from "@mui/material/Chip";
import Grid from "@mui/material/Grid";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import { useTranslation } from "react-i18next";

interface DetailPanelProps {
  model: STLModel | null;
  onClose: () => void;
  onUpdate: (id: string, updates: Partial<STLModel>) => void;
  onDelete: (id: string) => void;
  onOpenManual: (model: STLModel) => void;
  onEditManual: (model: STLModel) => void;
  onUploadManual: (id: string, file: File) => void | Promise<unknown>;
  onDeleteManual: (id: string) => void | Promise<void>;
}

const DetailPanel: React.FC<DetailPanelProps> = ({
  model,
  onClose,
  onUpdate,
  onDelete,
  onOpenManual,
  onEditManual,
  onUploadManual,
  onDeleteManual,
}) => {
  const { t } = useTranslation();
  const [isReplacing, setIsReplacing] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editTags, setEditTags] = useState("");
  const [tempThumb, setTempThumb] = useState("");
  const [errorState, setErrorState] = useState<{
    show: boolean;
    message: string;
  }>({ show: false, message: "" });

  const [slicerAnchorEl, setSlicerAnchorEl] = useState<null | HTMLElement>(
    null,
  );
  const [enabledSlicers, setEnabledSlicers] = useState<SlicerType[]>(() =>
    getEnabledLaunchSlicers(),
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const manualInputRef = useRef<HTMLInputElement>(null);

  // Reset local state when model changes
  React.useEffect(() => {
    if (model) {
      setEditName(model.name);
      setEditDesc(model.description || "");
      setEditTags(model.tags.join(", "));
      setIsEditing(false);
      setIsReplacing(false);
      setTempThumb("");
      setErrorState({ show: false, message: "" });
    }
  }, [model]);

  useEffect(() => {
    const refreshEnabledSlicers = () =>
      setEnabledSlicers(getEnabledLaunchSlicers());
    window.addEventListener("focus", refreshEnabledSlicers);
    window.addEventListener("storage", refreshEnabledSlicers);
    return () => {
      window.removeEventListener("focus", refreshEnabledSlicers);
      window.removeEventListener("storage", refreshEnabledSlicers);
    };
  }, []);

  const openSlicerLauncher = (event: React.MouseEvent<HTMLElement>) => {
    const launchSlicers = getEnabledLaunchSlicers();
    setEnabledSlicers(launchSlicers);
    if (launchSlicers.length === 1) {
      window.location.href = api.getSlicerUrl(model!, launchSlicers[0]);
      return;
    }
    setSlicerAnchorEl(event.currentTarget);
  };

  const handleModelLoaded = useCallback(
    (dimensions: { x: number; y: number; z: number }) => {
      if (model && !model.dimensions) {
        onUpdate(model.id, { dimensions });
      }
    },
    [model, onUpdate],
  );

  if (!model) return null;

  const handleReplaceFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !model) return;

    // Extension check
    const getExtension = (filename: string) => {
      const parts = filename.split(".");
      return parts.length > 1 ? parts.pop()?.toLowerCase() : "";
    };

    const currentExt = getExtension(model.name);
    const newExt = getExtension(file.name);

    if (currentExt && newExt && currentExt !== newExt) {
      setErrorState({
        show: true,
        message: t("detail.extMismatch", {
          current: currentExt,
          next: newExt,
        }),
      });
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setIsReplacing(true);
    try {
      // Generate thumbnail
      let thumb: string | undefined;
      try {
        thumb = await generateThumbnail(file);
      } catch (err) {
        console.warn("Thumbnail failed", err);
      }

      const updated = await api.replaceModelFile(model.id, file, thumb);
      onUpdate(model.id, {
        url: updated.url,
        size: updated.size,
        thumbnail: updated.thumbnail,
      });
      // Note: The name and other metadata are preserved unless the user explicitly changes them in the text fields
    } catch (e) {
      console.error("Failed to replace", e);
      alert(t("detail.replaceFailed"));
    } finally {
      setIsReplacing(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleReplaceThumbnail = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file || !model) return;

    setIsReplacing(true);
    try {
      const updated = await api.replaceModelThumbnail(model.id, file);
      onUpdate(model.id, {
        url: updated.url,
        size: updated.size,
        thumbnail: updated.thumbnail,
      });
      // Note: The name and other metadata are preserved unless the user explicitly changes them in the text fields
    } catch (e) {
      console.error("Failed to replace", e);
      alert(t("detail.replaceFailed"));
    } finally {
      setIsReplacing(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleGenerateThumbnail = (dataurl: string) => {
    setTempThumb(dataurl);
  };

  const handleManualUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !model) return;
    try {
      await onUploadManual(model.id, file);
    } finally {
      if (manualInputRef.current) manualInputRef.current.value = "";
    }
  };

  const handleSave = () => {
    const getExtension = (filename: string) => {
      const parts = filename.split(".");
      return parts.length > 1 ? parts.pop()?.toLowerCase() : "";
    };

    const currentExt = getExtension(model.name);
    const editExt = getExtension(editName);
    let newName = "";
    if (editExt != currentExt) {
      newName = editName + "." + currentExt;
    } else {
      newName = editName;
    }

    const newTags = editTags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    if (tempThumb != "") {
      onUpdate(model.id, {
        name: newName,
        description: editDesc,
        tags: newTags,
        thumbnail: tempThumb,
      });
    } else {
      onUpdate(model.id, {
        name: newName,
        description: editDesc,
        tags: newTags,
      });
    }

    setIsEditing(false);
  };

  return (
    <div className="w-screen sm:w-96 border-l border-vault-700 bg-black flex flex-col h-full shadow-2xl z-20 relative">
      {/* Header */}

      <div className="p-4 border-b border-vault-700 flex justify-between items-center">
        <Typography variant="h6">{t("detail.title")}</Typography>
        <Button onClick={onClose} variant="outlined" color="primary">
          <X />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Viewer */}
        <div className="-m-4 aspect-square bg-black overflow-hidden shadow-inner -mb-2">
          <Viewer3D
            url={model.url}
            filename={model.name}
            thumbnail={model.thumbnail}
            editing={isEditing}
            onMakeThumbnail={handleGenerateThumbnail}
            onLoaded={handleModelLoaded}
          />
        </div>

        {/* Actions */}
        <Stack
          direction="row"
          spacing={1}
          sx={{
            justifyContent: "space-between",
            alignItems: "center",
            minWidth: 0,
          }}
        >
          <Button
            fullWidth
            href={api.getDownloadUrl(model)}
            download={model.name}
            variant="contained"
            startIcon={<Download />}
          >
            {t("common.download")}
          </Button>

          <Button
            fullWidth
            variant="outlined"
            startIcon={<ScreenShareIcon />}
            onClick={openSlicerLauncher}
          >
            <Typography noWrap variant="subtitle2">
              {t("modelList.openInSlicer")}
            </Typography>
          </Button>
          <Menu
            anchorEl={slicerAnchorEl}
            open={Boolean(slicerAnchorEl)}
            onClose={() => setSlicerAnchorEl(null)}
          >
            {enabledSlicers.map((slicer) => (
              <MenuItem
                key={slicer}
                onClick={() => {
                  window.location.href = api.getSlicerUrl(model, slicer);
                  setSlicerAnchorEl(null);
                }}
              >
                {SLICERS[slicer].name}
              </MenuItem>
            ))}
          </Menu>
        </Stack>

        {/* Info Form */}
        <div className="space-y-4">
          <div>
            <Typography variant="h6" gutterBottom>
              {t("detail.name")}
            </Typography>
            {isEditing ? (
              <OutlinedInput
                fullWidth
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            ) : (
              <Typography variant="body1" sx={{ color: "text.secondary" }}>
                {model.name}
              </Typography>
            )}
          </div>

          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("detail.filename")} <br></br>
            {model.id}.{model.name.split(".").pop()}
          </Typography>
          <Divider />
          <div>
            <Typography variant="body1" gutterBottom>
              {t("detail.description")}
            </Typography>

            {isEditing ? (
              <TextField
                fullWidth
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder={t("detail.descriptionPlaceholder")}
                multiline
              />
            ) : (
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                {model.description || t("detail.noDescription")}
              </Typography>
            )}
          </div>
          <Divider />

          <div>
            <Typography variant="body1" gutterBottom>
              {t("common.manual")}
            </Typography>

            {isEditing ? (
              model.manual ? (
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{ alignItems: "center", minWidth: 0 }}
                >
                  <Typography
                    variant="body2"
                    sx={{
                      color: "text.secondary",
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {model.manual}
                  </Typography>
                  <Tooltip title={t("detail.editManual")}>
                    <IconButton
                      size="small"
                      onClick={() => onEditManual(model)}
                      aria-label={t("detail.editManual")}
                    >
                      <Edit className="w-4 h-4" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={t("detail.deleteManual")}>
                    <IconButton
                      size="small"
                      color="error"
                      onClick={() => onDeleteManual(model.id)}
                      aria-label={t("detail.deleteManual")}
                    >
                      <Trash2 className="w-4 h-4" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              ) : (
                <Stack direction="column" spacing={1}>
                  <Button
                    fullWidth
                    component="label"
                    variant="contained"
                    startIcon={<FileUp />}
                  >
                    {t("detail.uploadManual")}
                    <input
                      type="file"
                      ref={manualInputRef}
                      className="hidden"
                      accept=".md,.markdown,text/markdown"
                      onChange={handleManualUpload}
                    />
                  </Button>
                  <Button
                    fullWidth
                    variant="outlined"
                    startIcon={<Edit />}
                    onClick={() => onEditManual(model)}
                  >
                    {t("detail.orPaste")}
                  </Button>
                </Stack>
              )
            ) : model.manual ? (
              <Button
                fullWidth
                onClick={() => onOpenManual(model)}
                variant="outlined"
                startIcon={<BookOpen />}
              >
                {t("detail.openManual")}
              </Button>
            ) : (
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                {t("detail.noManual")}
              </Typography>
            )}
          </div>
          <Divider />

          <Typography variant="subtitle1">{t("detail.metadata")}</Typography>

          <div className="space-y-3">
            {/* Quick Stats Grid */}
            <div className="grid grid-cols-2 gap-3 p-3 rounded-md border border-vault-700/50 -mt-2">
              <div className="col-span-2">
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{
                    justifyContent: "flex-start",
                    alignItems: "center",
                    minWidth: 0,
                  }}
                >
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    {t("detail.tags")}
                  </Typography>
                  {isEditing ? (
                    <TextField
                      fullWidth
                      value={editTags}
                      onChange={(e) => setEditTags(e.target.value)}
                      placeholder={t("detail.tagsPlaceholder")}
                      multiline
                    />
                  ) : (
                    <Grid container spacing={1} columns={12}>
                      {model.tags.length > 0 ? (
                        model.tags.map((tag) => (
                          <Grid
                            display="flex"
                            justifyContent="center"
                            alignItems="center"
                            size="auto"
                          >
                            <Chip
                              size="small"
                              key={tag}
                              label={tag}
                              icon={<TagIcon className="w-4 pl-1" />}
                            ></Chip>
                          </Grid>
                        ))
                      ) : (
                        <span className="text-slate-600 italic text-sm">
                          {t("detail.noTags")}
                        </span>
                      )}
                    </Grid>
                  )}
                </Stack>
              </div>
              <Divider className="col-span-2" />

              <div className="space-y-1">
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{
                    justifyContent: "flex-start",
                    alignItems: "baseline",
                    minWidth: 0,
                  }}
                >
                  <Calendar className="w-3 h-3" />
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    {t("detail.added")}
                  </Typography>
                  <Typography variant="caption">
                    {new Date(model.dateAdded).toLocaleDateString()}
                  </Typography>
                </Stack>
              </div>
              <div className="space-y-1">
                <Stack
                  direction="row"
                  spacing={1}
                  sx={{
                    justifyContent: "flex-start",
                    alignItems: "baseline",
                    minWidth: 0,
                  }}
                >
                  <HardDrive className="w-3 h-3" />
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    {t("detail.fileSize")}
                  </Typography>
                  <Typography variant="caption">
                    {(model.size / (1024 * 1024)).toFixed(2)} MB
                  </Typography>
                </Stack>
              </div>
            </div>
            <Divider />

            {/* File Replacement Section (Edit Mode Only) */}
            {isEditing && (
              <div className="pb-3 border-b border-vault-700 mb-3">
                <Typography variant="h6" gutterBottom>
                  {t("detail.fileEditing")}
                </Typography>

                <Typography variant="body1">{t("detail.sourceFile")}</Typography>
                <Typography
                  variant="body2"
                  sx={{ color: "text.secondary" }}
                  gutterBottom
                >
                  {model.id}.{model.name.split(".").pop()}
                </Typography>
                <div className="flex items-center gap-2 mb-4">
                  <Button
                    fullWidth
                    disabled={isReplacing}
                    component="label"
                    variant="contained"
                    startIcon={!isReplacing ? <FileUp /> : <RefreshCw />}
                  >
                    {isReplacing
                      ? t("common.uploading")
                      : t("detail.replaceModel")}
                    <input
                      type="file"
                      ref={fileInputRef}
                      className="hidden"
                      accept=".stl,.step,.stp,.3mf"
                      onChange={handleReplaceFile}
                    />
                  </Button>
                </div>

                <Typography variant="body1" gutterBottom>
                  {t("detail.thumbnail")}
                </Typography>
                <Stack direction="column" spacing={1}>
                  <div className="w-full object-cover mb-4 ">
                    <img
                      className="h-60 w-60 mx-auto rounded-md"
                      src={tempThumb != "" ? tempThumb : model.thumbnail}
                      alt="thumbnail"
                    />
                  </div>
                  <Button
                    disabled={isReplacing}
                    component="label"
                    variant="contained"
                    startIcon={!isReplacing ? <FileUp /> : <RefreshCw />}
                  >
                    {isReplacing
                      ? t("common.uploading")
                      : t("detail.replaceThumbnail")}
                    <input
                      type="file"
                      ref={fileInputRef}
                      className="hidden"
                      accept=".jpeg,.png,.jpg"
                      onChange={handleReplaceThumbnail}
                    />
                  </Button>
                  <Button
                    disabled={isReplacing}
                    onClick={() => {
                      setTempThumb("");
                    }}
                    component="label"
                    variant="contained"
                    color="warning"
                    startIcon={<X />}
                  >
                    {t("detail.clearThumbnail")}
                  </Button>
                </Stack>
              </div>
            )}

            {isEditing && (
              <div className="flex gap-2 pt-2">
                <Button
                  fullWidth
                  onClick={handleSave}
                  startIcon={<Save />}
                  variant="contained"
                  color="success"
                >
                  {t("detail.saveChanges")}
                </Button>
                <Button
                  fullWidth
                  onClick={() => setIsEditing(false)}
                  variant="contained"
                  color="secondary"
                >
                  {t("common.cancel")}
                </Button>
              </div>
            )}
          </div>
        </div>

        <Stack
          direction="column"
          spacing={1}
          sx={{
            justifyContent: "space-between",
            alignItems: "center",
            minWidth: 0,
          }}
        >
          {!isEditing && (
            <Button
              fullWidth
              onClick={() => setIsEditing(true)}
              variant="outlined"
              endIcon={<Edit />}
            >
              {t("common.edit")}
            </Button>
          )}
          <Divider />
          <Typography variant="h6" color="error" gutterBottom>
            {t("detail.warningZone")}
          </Typography>

          <Button
            fullWidth
            onClick={() => onDelete(model.id)}
            endIcon={<Trash2 />}
            color="error"
            variant="contained"
          >
            {t("detail.deleteModel")}
          </Button>
        </Stack>

        {/* Error Modal Overlay */}
        {errorState.show && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-[2px] p-6 animate-in fade-in duration-200">
            <div className="bg-vault-800 border border-red-500/50 rounded-xl shadow-2xl w-full animate-in zoom-in-95 duration-200 p-5">
              <div className="flex flex-col items-center text-center gap-3">
                <div className="w-12 h-12 rounded-full bg-red-900/30 flex items-center justify-center">
                  <AlertTriangle className="w-6 h-6 text-red-500" />
                </div>
                <div>
                  <h3 className="font-bold text-white">
                    {t("detail.fileMismatch")}
                  </h3>
                  <p className="text-sm text-slate-300 mt-2 leading-relaxed">
                    {errorState.message}
                  </p>
                </div>
                <button
                  onClick={() => setErrorState({ show: false, message: "" })}
                  className="w-full mt-2 py-2 bg-vault-700 hover:bg-vault-600 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {t("detail.okGotIt")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DetailPanel;
