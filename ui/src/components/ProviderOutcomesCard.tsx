import type { ProviderModelOutcomeRow } from "@paperclipai/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatCents, providerDisplayName } from "../lib/utils";

function formatDuration(seconds: number): string {
  if (!seconds) return "—";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

function successRateTone(rate: number): string {
  if (rate >= 0.9) return "text-emerald-600 dark:text-emerald-400";
  if (rate >= 0.75) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

/**
 * Route memory for adapter/model choices: per (provider, model) run outcomes,
 * latency percentiles, and cost per successful run. The population is runs
 * that reported provider usage in the selected range.
 */
export function ProviderOutcomesCard({ rows }: { rows: ProviderModelOutcomeRow[] }) {
  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">Provider × model outcomes</CardTitle>
        <CardDescription>
          How runs actually ended on each provider + model — success rate, run-time percentiles, and
          cost per successful run. Check this before assigning adapters or models (route memory).
          Covers runs that reported provider usage in this period.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-2">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No provider usage recorded in this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="px-3 py-2 font-medium">Provider</th>
                  <th className="px-3 py-2 font-medium">Model</th>
                  <th className="px-3 py-2 font-medium text-right">Runs</th>
                  <th className="px-3 py-2 font-medium text-right">Success</th>
                  <th className="px-3 py-2 font-medium text-right">p50 / p95</th>
                  <th className="px-3 py-2 font-medium text-right">Cost</th>
                  <th className="px-3 py-2 font-medium text-right">Cost / OK run</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.provider}/${row.model}`} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-2 whitespace-nowrap">{providerDisplayName(row.provider)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{row.model}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.runs}</td>
                    <td className={cn("px-3 py-2 text-right tabular-nums font-medium", successRateTone(row.successRate))}>
                      {(row.successRate * 100).toFixed(1)}%
                      <span className="block text-xs font-normal text-muted-foreground">
                        {row.succeededRuns} ok · {row.failedRuns} fail · {row.timedOutRuns + row.cancelledRuns + row.otherRuns} other
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                      {formatDuration(row.medianDurationSec)} / {formatDuration(row.p95DurationSec)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatCents(row.costCents)}</td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                      {row.succeededRuns > 0 ? formatCents(Math.round(row.costPerSucceededRunCents)) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
