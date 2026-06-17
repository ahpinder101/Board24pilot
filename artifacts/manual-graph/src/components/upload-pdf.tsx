import { useState } from "react";
import { UploadCloud, File, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useUpload } from "@workspace/object-storage-web";
import { useCreateManual, useProcessManual } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";

export function UploadPDF() {
  const queryClient = useQueryClient();
  const [fileInfo, setFileInfo] = useState<{name: string, size: number} | null>(null);
  
  const createManual = useCreateManual();
  const processManual = useProcessManual();

  const { uploadFile, isUploading, progress } = useUpload({
    onSuccess: async (response) => {
      if (!fileInfo) return;
      try {
        const manualName = fileInfo.name.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ');
        const manual = await createManual.mutateAsync({
          data: {
            name: manualName,
            filename: fileInfo.name,
            objectPath: response.objectPath,
          }
        });
        
        await processManual.mutateAsync({ id: manual.id });
        queryClient.invalidateQueries({ queryKey: ["/api/manuals"] });
        queryClient.invalidateQueries({ queryKey: ["/api/graph"] });
        
        toast.success("Upload complete", {
          description: "Extraction process started.",
        });
        setFileInfo(null);
      } catch (err) {
        toast.error("Failed to start processing");
      }
    },
    onError: (err) => {
      toast.error("Upload failed", {
        description: err.message,
      });
      setFileInfo(null);
    }
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (file.type !== "application/pdf") {
      toast.error("Invalid file type", { description: "Please upload a PDF document." });
      return;
    }
    
    setFileInfo({ name: file.name, size: file.size });
    uploadFile(file);
    e.target.value = ''; // reset input
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
              <p className="text-sm text-muted-foreground mt-1 font-mono">PDF format only. Max 50MB.</p>
            </div>
            <div className="relative">
              <input
                type="file"
                accept="application/pdf"
                onChange={handleFileSelect}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={isUploading}
              />
              <Button className="font-mono" variant="secondary">Select File</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center space-y-4 w-full max-w-md mx-auto">
            <div className="flex items-center space-x-3 w-full">
              <File className="w-8 h-8 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">{fileInfo?.name}</p>
                <div className="flex justify-between items-center mt-1">
                  <p className="text-xs text-muted-foreground font-mono">
                    {fileInfo ? (fileInfo.size / 1024 / 1024).toFixed(2) : 0} MB
                  </p>
                  <p className="text-xs text-primary font-mono font-medium">{Math.round(progress)}%</p>
                </div>
              </div>
            </div>
            <Progress value={progress} className="h-2 w-full" />
            <p className="text-xs text-muted-foreground font-mono flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" /> Uploading to secure storage...
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
