/**
 * Evidence Report Generator.
 *
 * Generates machine-readable JSON reports and human-readable Markdown reports.
 *
 * Research Integrity Rules:
 *   - Conclusion MUST be conservative: "Evidence suggests...", "Insufficient evidence...", etc.
 *   - Forbidden: "Agent Mirror is intelligent" unless configured evidence criteria are satisfied.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExperimentResult } from "../types.js";
import { StatisticsEngine } from "./statistics.js";

export interface ReportOutput {
  jsonReportPath: string;
  markdownReportPath: string;
  summaryText: string;
}

export class ReportGenerator {
  private readonly statsEngine: StatisticsEngine;
  private readonly reportsDir: string;

  constructor(reportsDir?: string) {
    this.statsEngine = new StatisticsEngine();
    this.reportsDir = reportsDir ?? path.join(process.cwd(), "data", "reports");
    fs.mkdirSync(this.reportsDir, { recursive: true });
  }

  generateReport(expResult: ExperimentResult): ReportOutput {
    const stats = this.statsEngine.calculateExperimentStats(expResult.task_results);

    const jsonReport = {
      experiment_id: expResult.experiment_id,
      name: expResult.name,
      completed_at: expResult.completed_at,
      data_label: expResult.data_label,
      execution_mode: expResult.execution_mode,
      total_tasks: expResult.task_results.length,
      statistics: stats,
      provenance: {
        generated_at: new Date().toISOString(),
      },
    };

    const jsonReportPath = path.join(this.reportsDir, `${expResult.experiment_id}-report.json`);
    fs.writeFileSync(jsonReportPath, JSON.stringify(jsonReport, null, 2));

    // Formulate conservative conclusion
    let conclusion = "Insufficient evidence to assert intervention efficacy due to sample size or effect limits.";
    if (stats.statistically_significant === true) {
      conclusion = "Intervention produced statistically detectable improvement in task completion rate.";
    } else if (stats.sample_warning) {
      conclusion = "Insufficient evidence: Experiment sample size is below required statistical power threshold.";
    } else {
      conclusion = "Evidence suggests no statistically significant difference between treatment and control arms.";
    }

    const markdownContent = `# Experiment Evidence Report: ${expResult.name}

- **Experiment ID**: \`${expResult.experiment_id}\`
- **Execution Mode**: \`${expResult.execution_mode}\`
- **Data Label**: \`${expResult.data_label}\`
- **Completed At**: ${expResult.completed_at}

## Experimental Conditions Summary

| Condition | Tasks (N) | Success Rate | Absolute Effect | Relative Effect |
| :--- | :--- | :--- | :--- | :--- |
| **Control** | ${stats.control_n} | ${(stats.control_success_rate * 100).toFixed(1)}% | - | - |
| **Treatment** | ${stats.treatment_n} | ${(stats.treatment_success_rate * 100).toFixed(1)}% | **${(stats.absolute_treatment_effect * 100).toFixed(1)}%** | **${(stats.relative_treatment_effect * 100).toFixed(1)}%** |

## Statistical Significance Analysis

- **Sample Size Check**: ${stats.sample_warning ?? "PASS (Sample size adequate)"}
- **P-Value**: ${typeof stats.p_value === "number" ? stats.p_value.toFixed(4) : stats.p_value}
- **95% Confidence Interval**: ${Array.isArray(stats.confidence_interval_95) ? `[${stats.confidence_interval_95[0].toFixed(3)}, ${stats.confidence_interval_95[1].toFixed(3)}]` : stats.confidence_interval_95}
- **Statistically Significant**: \`${stats.statistically_significant}\`

## Conclusion

> [!IMPORTANT]
> ${conclusion}
`;

    const markdownReportPath = path.join(this.reportsDir, `${expResult.experiment_id}-report.md`);
    fs.writeFileSync(markdownReportPath, markdownContent);

    return {
      jsonReportPath,
      markdownReportPath,
      summaryText: conclusion,
    };
  }
}
