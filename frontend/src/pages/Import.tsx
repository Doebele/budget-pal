import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { importsApi, accountsApi } from "@/lib/api";
import { Upload, FileText, CheckCircle2, AlertCircle, Clock } from "lucide-react";
import { format } from "date-fns";
import { clsx } from "clsx";
import { formatCHF } from "@/lib/theme";

const BANKS = [
  { value: "ubs", label: "UBS" },
  { value: "n26", label: "N26" },
  { value: "revolut", label: "Revolut" },
  { value: "comdirect", label: "comdirect" },
];

export default function Import() {
  const queryClient = useQueryClient();
  const csvRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);
  const [selectedAccount, setSelectedAccount] = useState("");
  const [selectedBank, setSelectedBank] = useState("");
  const [importResult, setImportResult] = useState<{
    rows_imported: number;
    rows_skipped: number;
    bank: string;
    preview: Array<{ date: string; description: string; amount: number; category?: string; is_duplicate: boolean }>;
  } | null>(null);

  const { data: accounts } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => accountsApi.list().then((r) => r.data),
  });

  const { data: history } = useQuery({
    queryKey: ["import-history"],
    queryFn: () => importsApi.history().then((r) => r.data),
  });

  const csvMutation = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("account_id", selectedAccount);
      if (selectedBank) fd.append("bank", selectedBank);
      return importsApi.uploadCsv(fd).then((r) => r.data);
    },
    onSuccess: (data) => {
      setImportResult(data);
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      queryClient.invalidateQueries({ queryKey: ["import-history"] });
    },
  });

  const pdfMutation = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("account_id", selectedAccount);
      if (selectedBank) fd.append("bank", selectedBank);
      return importsApi.uploadPdf(fd).then((r) => r.data);
    },
    onSuccess: (data) => {
      setImportResult(data);
      queryClient.invalidateQueries({ queryKey: ["transactions"] });
      queryClient.invalidateQueries({ queryKey: ["import-history"] });
    },
  });

  const handleCsvChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && selectedAccount) csvMutation.mutate(file);
  };

  const handlePdfChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && selectedAccount) pdfMutation.mutate(file);
  };

  const isLoading = csvMutation.isPending || pdfMutation.isPending;

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-display text-text-primary">Import</h1>
        <p className="text-text-tertiary text-sm mt-0.5">CSV und PDF Kontoauszüge importieren</p>
      </div>

      {/* Config */}
      <div className="card">
        <h2 className="text-text-primary font-semibold text-sm mb-4">Import-Einstellungen</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Ziel-Konto</label>
            <select className="input" value={selectedAccount} onChange={(e) => setSelectedAccount(e.target.value)}>
              <option value="">Konto wählen...</option>
              {(accounts || []).map((a: { id: number; name: string; bank: string }) => (
                <option key={a.id} value={String(a.id)}>{a.name} ({a.bank})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Bank (optional, auto-erkannt)</label>
            <select className="input" value={selectedBank} onChange={(e) => setSelectedBank(e.target.value)}>
              <option value="">Auto-Erkennung</option>
              {BANKS.map((b) => (
                <option key={b.value} value={b.value}>{b.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Upload areas */}
      <div className="grid grid-cols-2 gap-4">
        <div
          className={clsx(
            "card border-2 border-dashed cursor-pointer hover:border-accent/50 transition-colors text-center py-10",
            !selectedAccount && "opacity-50 cursor-not-allowed"
          )}
          onClick={() => selectedAccount && csvRef.current?.click()}
        >
          <Upload className="w-8 h-8 text-text-tertiary mx-auto mb-3" />
          <p className="text-text-primary font-medium text-sm">CSV importieren</p>
          <p className="text-text-tertiary text-xs mt-1">UBS · N26 · Revolut · comdirect</p>
          <input ref={csvRef} type="file" accept=".csv" className="hidden" onChange={handleCsvChange} />
        </div>

        <div
          className={clsx(
            "card border-2 border-dashed cursor-pointer hover:border-accent/50 transition-colors text-center py-10",
            !selectedAccount && "opacity-50 cursor-not-allowed"
          )}
          onClick={() => selectedAccount && pdfRef.current?.click()}
        >
          <FileText className="w-8 h-8 text-text-tertiary mx-auto mb-3" />
          <p className="text-text-primary font-medium text-sm">PDF importieren</p>
          <p className="text-text-tertiary text-xs mt-1">OCR-Extraktion</p>
          <input ref={pdfRef} type="file" accept=".pdf" className="hidden" onChange={handlePdfChange} />
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="card flex items-center gap-4">
          <div className="w-8 h-8 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
          <div>
            <p className="text-text-primary text-sm font-medium">Import läuft...</p>
            <p className="text-text-tertiary text-xs">KI-Kategorisierung wird durchgeführt</p>
          </div>
        </div>
      )}

      {/* Result */}
      {importResult && !isLoading && (
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <CheckCircle2 className="w-5 h-5 text-gain" />
            <div>
              <p className="text-text-primary font-semibold text-sm">Import abgeschlossen</p>
              <p className="text-text-tertiary text-xs">
                {importResult.rows_imported} importiert · {importResult.rows_skipped} Duplikate übersprungen · Bank: {importResult.bank.toUpperCase()}
              </p>
            </div>
          </div>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {importResult.preview?.map((p, i) => (
              <div key={i} className={clsx("flex items-center justify-between py-1.5 px-2 rounded", p.is_duplicate ? "opacity-40" : "")}>
                <div>
                  <p className="text-text-primary text-xs">{p.description.slice(0, 50)}</p>
                  <p className="text-text-tertiary text-xs">{p.date} · {p.category || "?"}</p>
                </div>
                <span className={clsx("text-xs font-mono", p.amount >= 0 ? "text-gain" : "text-loss")}>
                  {formatCHF(p.amount)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* History */}
      <div className="card">
        <h2 className="text-text-primary font-semibold text-sm mb-4">Import-Historie</h2>
        <div className="space-y-2">
          {(history || []).slice(0, 10).map((log: {
            id: number; filename: string; bank?: string; rows_imported: number;
            rows_skipped: number; status: string; created_at: string; file_type: string;
          }) => (
            <div key={log.id} className="flex items-center gap-4 py-2">
              <div className={clsx("w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0",
                log.status === "completed" ? "bg-gain/15" : log.status === "failed" ? "bg-loss/15" : "bg-warning/15"
              )}>
                {log.status === "completed" ? <CheckCircle2 className="w-3.5 h-3.5 text-gain" />
                  : log.status === "failed" ? <AlertCircle className="w-3.5 h-3.5 text-loss" />
                  : <Clock className="w-3.5 h-3.5 text-warning" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-text-primary text-xs font-medium truncate">{log.filename}</p>
                <p className="text-text-tertiary text-xs">
                  {log.bank?.toUpperCase()} · {log.rows_imported} Einträge · {format(new Date(log.created_at), "dd.MM.yyyy HH:mm")}
                </p>
              </div>
            </div>
          ))}
          {(!history || history.length === 0) && (
            <p className="text-text-tertiary text-sm text-center py-6">Noch keine Importe</p>
          )}
        </div>
      </div>
    </div>
  );
}
