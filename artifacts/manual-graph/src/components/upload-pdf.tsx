import { useState, useRef, forwardRef, useImperativeHandle } from "react";
import { UploadCloud, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useLocation } from "wouter";

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function UploadOverlay({ fileName, fileSize, progress }: { fileName: string; fileSize: number; progress: number }) {
  const isDone = progress >= 100;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md mx-4 flex flex-col items-center gap-6">
        <div className="relative w-16 h-16 flex items-center justify-center">
          {isDone ? (
            <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center">
              <CheckCircle2 className="w-8 h-8 text-green-600" />
            </div>
          ) : (
            <>
              <div className="absolute inset-0 rounded-full bg-blue-100 animate-ping opacity-30" />
              <div className="relative w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center">
                <UploadCloud className="w-8 h-8 text-blue-600" />
              </div>
            </>
          )}
        </div>
        <div className="text-center">
          <h2 className="text-lg font-semibold text-gray-900">
            {isDone ? "Upload complete" : "Uploading PDF…"}
          </h2>
          <p className="text-sm text-gray-500 mt-1 font-mono truncate max-w-xs">{fileName}</p>
          <p className="text-xs text-gray-400 font-mono">{formatBytes(fileSize)}</p>
        </div>
        <div className="w-full space-y-2">
          <Progress value={progress} className="h-3 w-full rounded-full" />
          <div className="flex justify-between text-xs font-mono text-gray-500">
            <span>{isDone ? "Saving to server…" : "Transferring…"}</span>
            <span className="font-semibold text-blue-600">{progress}%</span>
          </div>
        </div>
        {!isDone && (
          <p className="text-xs text-gray-400 text-center">
            Large files may take a minute or two — please keep this tab open.
          </p>
        )}
      </div>
    </div>
  );
}

export interface UploadPDFRef {
  uploadFile: (file: File) => void;
}

interface UploadPDFProps {
  onUploaded?: (id: number) => void;
}

export const UploadPDF = forwardRef<UploadPDFRef, UploadPDFProps>(function UploadPDFInner({ onUploaded }: UploadPDFProps, ref) {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentFile, setCurrentFile] = useState<{ name: string; size: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function doUpload(file: File) {
    if (file.type !== "application/pdf") {
      toast.error("Invalid file type", { description: "Please upload a PDF document." });
      return;
    }

    setCurrentFile({ name: file.name, size: file.size });
    setIsUploading(true);
    setProgress(5);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", (ev) => {
        if (ev.lengthComputable) {
          setProgress(5 + Math.round((ev.loaded / ev.total) * 85));
        }
      });

      const result = await new Promise<{ id: number }>((resolve, reject) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(JSON.parse(xhr.responseText));
          } else {
            const msg = (() => {
              try { return JSON.parse(xhr.responseText).error; } catch { return "Upload failed"; }
            })();
            reject(new Error(msg));
          }
        };
        xhr.onerror = () => reject(new Error("Network error during upload"));
        xhr.open("POST", "/api/manuals/upload");
        xhr.send(formData);
      });

      setProgress(100);
      queryClient.invalidateQueries({ queryKey: ["/api/manuals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      await new Promise((r) => setTimeout(r, 600));

      if (onUploaded) {
        onUploaded(result.id);
      } else {
        navigate(`/manuals/${result.id}`);
      }
    } catch (err) {
      toast.error("Upload failed", { description: err instanceof Error ? err.message : "Unknown error" });
    } finally {
      setIsUploading(false);
      setCurrentFile(null);
      setProgress(0);
    }
  }

  useImperativeHandle(ref, () => ({
    uploadFile: (file: File) => { doUpload(file); },
  }));

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    doUpload(file);
  };

  return (
    <>
      {isUploading && currentFile && (
        <UploadOverlay fileName={currentFile.name} fileSize={currentFile.size} progress={progress} />
      )}
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        onChange={handleFileSelect}
        disabled={isUploading}
        className="hidden"
      />
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 text-gray-600 font-medium"
        disabled={isUploading}
        onClick={() => inputRef.current?.click()}
      >
        {isUploading ? (
          <><Loader2 className="w-3.5 h-3.5 animate-spin" />Uploading…</>
        ) : (
          <><UploadCloud className="w-3.5 h-3.5" />Upload PDF</>
        )}
      </Button>
    </>
  );
});
