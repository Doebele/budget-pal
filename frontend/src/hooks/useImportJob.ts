import { useQuery } from "@tanstack/react-query";
import { importsApi, isImportJobRunning, type ImportJob } from "@/lib/api";

// Wie oft der Job-Status abgefragt wird, solange er läuft.
const POLL_INTERVAL_MS = 2_000;

/**
 * Läuft gerade ein PDF-Import dieses Nutzers?
 *
 * Fragt den Server, nicht den lokalen Zustand — deshalb überlebt die Anzeige
 * Seitenwechsel UND ein Neuladen. Wird sowohl von der Import-Seite als auch
 * von der globalen Anzeige im App-Rahmen genutzt; beide teilen sich denselben
 * Query-Key, es entsteht also nur ein Poll.
 */
export function useActiveImportJob() {
  return useQuery({
    queryKey: ["import-job", "active"],
    queryFn: async () => (await importsApi.activeImportJob()).data,
    // Solange etwas läuft, häufig nachfragen; danach nur noch gelegentlich,
    // damit ein in einem anderen Tab gestarteter Import auch hier auftaucht.
    refetchInterval: (query) =>
      isImportJobRunning(query.state.data) ? POLL_INTERVAL_MS : 15_000,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
}

/**
 * Einen bestimmten Job verfolgen, bis er fertig ist.
 * `enabled` ist false, solange keine ID vorliegt.
 */
export function useImportJob(importId: number | null) {
  return useQuery({
    queryKey: ["import-job", importId],
    queryFn: async () => (await importsApi.importJob(importId as number)).data,
    enabled: importId !== null,
    refetchInterval: (query) =>
      isImportJobRunning(query.state.data) ? POLL_INTERVAL_MS : false,
    staleTime: 0,
  });
}

export function importJobProgressLabel(job?: ImportJob | null): string {
  if (!job) return "";
  if (job.chunks_total > 0) {
    return `Abschnitt ${Math.min(job.chunks_done + 1, job.chunks_total)} von ${job.chunks_total}`;
  }
  return job.status === "pending" ? "wird vorbereitet" : "wird gelesen";
}
