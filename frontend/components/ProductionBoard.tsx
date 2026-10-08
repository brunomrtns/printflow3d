import React, { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft,
  ClipboardList,
  Printer,
  FlaskConical,
  CircleCheck,
  Trash2,
  RefreshCw,
  Plus,
  Search,
  X,
} from "lucide-react";
import { api } from "../services/api";
import { ProductionJob, ProductionStatus, STLModel } from "../types";

interface ProductionBoardProps {
  onBack: () => void;
}

const COLUMNS: {
  status: ProductionStatus;
  icon: React.ReactNode;
  accent: string;
}[] = [
  { status: "queue", icon: <ClipboardList className="w-4 h-4" />, accent: "text-slate-300" },
  { status: "printing", icon: <Printer className="w-4 h-4" />, accent: "text-accent" },
  { status: "washing", icon: <FlaskConical className="w-4 h-4" />, accent: "text-accent-warm" },
  { status: "done", icon: <CircleCheck className="w-4 h-4" />, accent: "text-emerald-400" },
];

const ProductionBoard: React.FC<ProductionBoardProps> = ({ onBack }) => {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<ProductionJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [dragOver, setDragOver] = useState<ProductionStatus | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [library, setLibrary] = useState<STLModel[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);

  const fetchJobs = useCallback(() => {
    api
      .getProductionJobs()
      .then((data) => {
        setJobs(data);
        setError(false);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(fetchJobs, [fetchJobs]);

  const moveJob = async (jobId: string, status: ProductionStatus) => {
    const job = jobs.find((j) => j.id === jobId);
    if (!job || job.status === status) return;
    // Optimistic update — revert on failure
    setJobs((prev) =>
      prev.map((j) => (j.id === jobId ? { ...j, status } : j)),
    );
    try {
      await api.updateProductionJobStatus(jobId, status);
    } catch {
      fetchJobs();
    }
  };

  const removeJob = async (jobId: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
    try {
      await api.deleteProductionJob(jobId);
    } catch {
      fetchJobs();
    }
  };

  const openPicker = () => {
    setPickerOpen(true);
    setSearch("");
    setLibraryLoading(true);
    api
      .getModels()
      .then((data) => setLibrary(data))
      .catch(() => setLibrary([]))
      .finally(() => setLibraryLoading(false));
  };

  const addJob = async (modelId: string) => {
    if (adding) return;
    setAdding(true);
    try {
      await api.createProductionJob(modelId);
      setPickerOpen(false);
      fetchJobs();
    } finally {
      setAdding(false);
    }
  };

  const filteredLibrary = library.filter((m) =>
    m.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const onDrop = (e: React.DragEvent, status: ProductionStatus) => {
    e.preventDefault();
    setDragOver(null);
    const jobId = e.dataTransfer.getData("text/plain");
    if (jobId) moveJob(jobId, status);
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden p-4 sm:p-8">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <button
          onClick={onBack}
          className="flex items-center justify-center w-10 h-10 rounded-lg bg-vault-700 hover:bg-vault-600 text-slate-300 hover:text-white transition-colors"
          aria-label={t("common.goBack")}
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <h2 className="text-2xl font-bold text-white mb-1">
            {t("production.title")}
          </h2>
          <p className="text-sm text-slate-400">{t("production.subtitle")}</p>
        </div>
        <button
          onClick={() => {
            setLoading(true);
            fetchJobs();
          }}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-vault-800 hover:bg-vault-700 border border-border text-slate-300 hover:text-white transition-colors text-sm"
        >
          <RefreshCw className="w-4 h-4" />
          {t("production.refresh")}
        </button>
      </div>

      {/* Board */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent" />
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center text-red-400">
          {t("production.loadError")}
        </div>
      ) : (
        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 overflow-y-auto pb-4">
          {COLUMNS.map((col) => {
            const columnJobs = jobs.filter((j) => j.status === col.status);
            const isOver = dragOver === col.status;
            return (
              <div
                key={col.status}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(col.status);
                }}
                onDragLeave={() =>
                  setDragOver((prev) => (prev === col.status ? null : prev))
                }
                onDrop={(e) => onDrop(e, col.status)}
                className={`flex flex-col rounded-xl border p-3 min-h-[220px] transition-colors ${
                  isOver
                    ? "border-accent bg-vault-800/70"
                    : "border-border bg-vault-900/40"
                }`}
              >
                <div className="flex items-center justify-between mb-3 px-1">
                  <div className="flex items-center gap-2">
                    <span className={col.accent}>{col.icon}</span>
                    <span className="text-sm font-semibold text-white">
                      {t(`production.columns.${col.status}`)}
                    </span>
                  </div>
                  <span className="text-xs text-slate-400 bg-vault-800 rounded-full px-2 py-0.5">
                    {columnJobs.length}
                  </span>
                </div>

                <div className="flex-1 space-y-2 overflow-y-auto">
                  {columnJobs.map((job, i) => (
                    // Outer plain div owns the HTML5 drag (framer-motion
                    // overrides onDragStart on motion.div with its own
                    // PointerEvent signature — dataTransfer wouldn't exist).
                    <div
                      key={job.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", job.id);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      className="cursor-grab active:cursor-grabbing"
                    >
                      <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                          duration: 0.25,
                          delay: Math.min(i * 0.04, 0.3),
                          ease: [0.16, 1, 0.3, 1],
                        }}
                        className="group relative rounded-lg border border-border bg-surface hover:border-bright hover:bg-elevated transition-colors p-3"
                      >
                      <div className="flex gap-3">
                        {job.thumbnailUrl ? (
                          <img
                            src={job.thumbnailUrl}
                            alt={job.modelName}
                            className="w-14 h-14 rounded-md object-cover bg-vault-800 shrink-0"
                            draggable={false}
                          />
                        ) : (
                          <div className="w-14 h-14 rounded-md bg-vault-800 flex items-center justify-center text-slate-600 shrink-0">
                            <Printer className="w-6 h-6" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-white truncate">
                            {job.modelName}
                          </p>
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-[11px] text-slate-400">
                            {job.volumeMl != null && (
                              <span>
                                {job.volumeMl.toLocaleString("pt-BR", {
                                  maximumFractionDigits: 2,
                                })}{" "}
                                mL
                              </span>
                            )}
                            {job.estimatedCost != null && (
                              <span className="text-accent">
                                {job.estimatedCost.toLocaleString("pt-BR", {
                                  style: "currency",
                                  currency: "BRL",
                                })}
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => removeJob(job.id)}
                          title={t("production.removeJob")}
                          className="opacity-0 group-hover:opacity-100 transition-opacity self-start text-slate-500 hover:text-red-400"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                      </motion.div>
                    </div>
                  ))}
                  {columnJobs.length === 0 && (
                    <div
                      className={`rounded-lg border border-dashed px-3 py-6 text-center text-xs transition-colors ${
                        isOver
                          ? "border-accent text-accent"
                          : "border-border text-slate-500"
                      }`}
                    >
                      {col.status === "queue"
                        ? t("production.emptyQueue")
                        : t("production.emptyColumn")}
                    </div>
                  )}
                </div>

                {/* "+ Novo pedido" lives at the queue column bottom — the
                    board must never be a dead end */}
                {col.status === "queue" && (
                  <button
                    onClick={openPicker}
                    className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-slate-400 transition-colors hover:border-accent hover:text-accent"
                  >
                    <Plus className="w-4 h-4" />
                    {t("production.addJob")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Model picker modal */}
      {pickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="glass-card w-full max-w-lg max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h3 className="text-lg font-semibold text-white">
                {t("production.addJobTitle")}
              </h3>
              <button
                onClick={() => setPickerOpen(false)}
                className="text-slate-400 hover:text-white transition-colors"
                aria-label={t("common.close")}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 border-b border-border">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                <input
                  autoFocus
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("production.searchPlaceholder")}
                  className="w-full bg-vault-900 border border-border rounded-md pl-9 pr-3 py-2 text-sm text-white outline-none focus:border-accent placeholder:text-slate-600"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {libraryLoading ? (
                <div className="flex items-center justify-center py-10">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent" />
                </div>
              ) : filteredLibrary.length === 0 ? (
                <div className="py-10 text-center text-sm text-slate-500">
                  {t("production.noModelsFound")}
                </div>
              ) : (
                filteredLibrary.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => addJob(m.id)}
                    disabled={adding}
                    className="w-full flex items-center gap-3 rounded-lg p-2.5 text-left transition-colors hover:bg-vault-800 disabled:opacity-50"
                  >
                    {m.thumbnail ? (
                      <img
                        src={m.thumbnail}
                        alt={m.name}
                        className="w-11 h-11 rounded-md object-cover bg-vault-800 shrink-0"
                      />
                    ) : (
                      <div className="w-11 h-11 rounded-md bg-vault-800 flex items-center justify-center text-slate-600 shrink-0">
                        <Printer className="w-5 h-5" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-white truncate">
                        {m.name}
                      </p>
                      <div className="flex gap-3 text-[11px] text-slate-400 mt-0.5">
                        {m.volumeMl != null && (
                          <span>
                            {m.volumeMl.toLocaleString("pt-BR", {
                              maximumFractionDigits: 2,
                            })}{" "}
                            mL
                          </span>
                        )}
                        {m.estimatedCost != null && (
                          <span className="text-accent">
                            {m.estimatedCost.toLocaleString("pt-BR", {
                              style: "currency",
                              currency: "BRL",
                            })}
                          </span>
                        )}
                      </div>
                    </div>
                    <Plus className="w-4 h-4 text-slate-500 shrink-0" />
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProductionBoard;
