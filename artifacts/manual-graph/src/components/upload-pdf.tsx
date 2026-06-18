import { useState, useRef } from "react";
import { UploadCloud, File, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { useLocation } from "wouter";

export function UploadPDF() {
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentFile, setCurrentFile] = useState<{ name: string; size: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    if (file.type !== "application/pdf") {
      toast.error("Invalid file type", { description: "Please upload a PDF document." });
      return;
    }

    setCurrentFile({ name: file.name, size: file.size });
    setIsUploading(true);
    setProgress(10);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", (ev) => {
        if (ev.lengthComputable) {
          setProgress(10 + Math.round((ev.loaded / ev.total) * 80));
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

      toast.success("Upload complete", { description: "Navigating to manual page…" });
      navigate(`/manuals/${result.id}`);
    } catch (err) {
      toast.error("Upload failed", { description: err instanceof Error ? err.message : "Unknown error" });
      setIsUploading(false);
      setCurrentFile(null);
      setProgress(0);
    }
  };

  return (
    <Card className="border-border bg-card border-dashed">
      <CardContent className="p-6">
        {!isUploading ? (
          <div className="flex flex-col items-center justify-center space-y-4 text-center">
            <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center">
              <UploadCloud className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h3 className="text-lg font-medium text-foreground">Upload Engineering Manual</h3>
              <p className="text-sm text-muted-foreground mt-1 font-mono">PDF format only. Max 100MB.</p>
            </div>
            <div className="relative">
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf"
                onChange={handleFileSelect}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
              <Button className="font-mono" variant="secondary">Select File</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center space-y-4 w-full max-w-md mx-auto">
            <div className="flex items-center space-x-3 w-full">
              <File className="w-8 h-8 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{currentFile?.name}</p>
                <div className="flex justify-between items-center mt-1">
                  <p className="text-xs text-muted-foreground font-mono">
                    {currentFile ? (currentFile.size / 1024 / 1024).toFixed(2) : 0} MB
                  </p>
                  <p className="text-xs text-primary font-mono font-medium">{progress}%</p>
                </div>
              </div>
            </div>
            <Progress value={progress} className="h-2 w-full" />
            <p className="text-xs text-muted-foreground font-mono flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" />
              {progress < 90 ? "Uploading to server..." : "Processing upload..."}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
