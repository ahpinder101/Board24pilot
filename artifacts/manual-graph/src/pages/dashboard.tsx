import { GlobalStatsDashboard } from "@/components/stats";
import { UploadPDF } from "@/components/upload-pdf";
import { ManualList } from "@/components/manual-list";

export default function Dashboard() {
  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold font-mono tracking-tight text-foreground">SYSTEM_DASHBOARD</h1>
        <p className="text-muted-foreground font-mono mt-2">Engineering Manual Knowledge Graph status and operations.</p>
      </div>

      <GlobalStatsDashboard />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-1">
          <UploadPDF />
        </div>
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-mono font-bold text-foreground">INGESTED_MANUALS</h2>
            <div className="h-px flex-1 bg-border ml-4"></div>
          </div>
          <ManualList />
        </div>
      </div>
    </div>
  );
}
