/**
 * Minimal UI Application Logic.
 *
 * Visualizes experiment execution results, task trajectories, signals, interventions,
 * and statistical evidence without framework dependencies.
 */

document.addEventListener("DOMContentLoaded", () => {
  const select = document.getElementById("experimentSelect");
  const overview = document.getElementById("overviewContent");
  const details = document.getElementById("experimentDetails");
  const tableCard = document.getElementById("taskResults");
  const tableBody = document.getElementById("taskTableBody");

  // Sample static loader for demonstration
  const sampleData = {
    experiment_id: "exp_sample_001",
    name: "Sample Pilot Experiment",
    completed_at: new Date().toISOString(),
    data_label: "SYNTHETIC",
    execution_mode: "synthetic",
    task_results: [
      {
        task_id: "task-01-bug-fix",
        condition: "control",
        execution_mode: "synthetic",
        data_label: "SYNTHETIC",
        outcome: { task_success: true, time_to_completion_ms: 1200 },
        detector_signals: [],
        interventions: [],
      },
      {
        task_id: "task-09-retry-prone",
        condition: "treatment",
        execution_mode: "synthetic",
        data_label: "SYNTHETIC",
        outcome: { task_success: true, time_to_completion_ms: 2400 },
        detector_signals: [{ signal: "retry_loop", confidence: 0.85 }],
        interventions: [{ policy: "SUGGEST_STOP_RETRYING", delivered: true }],
      },
    ],
  };

  const option = document.createElement("option");
  option.value = "sample";
  option.textContent = `${sampleData.name} (${sampleData.experiment_id})`;
  select.appendChild(option);

  select.addEventListener("change", (e) => {
    if (e.target.value === "sample") {
      renderExperiment(sampleData);
    } else {
      details.style.display = "none";
      tableCard.style.display = "none";
    }
  });

  function renderExperiment(data) {
    details.style.display = "block";
    tableCard.style.display = "block";

    overview.innerHTML = `
      <p><strong>Name:</strong> ${data.name}</p>
      <p><strong>ID:</strong> <code>${data.experiment_id}</code></p>
      <p><strong>Execution Mode:</strong> ${data.execution_mode}</p>
      <p><strong>Data Label:</strong> <span class="badge badge-synthetic">${data.data_label}</span></p>
      <p><strong>Total Tasks:</strong> ${data.task_results.length}</p>
    `;

    tableBody.innerHTML = "";
    for (const res of data.task_results) {
      const tr = document.createElement("tr");
      const statusBadge = res.outcome.task_success
        ? '<span class="badge badge-pass">PASS</span>'
        : '<span class="badge badge-fail">FAIL</span>';

      tr.innerHTML = `
        <td><code>${res.task_id}</code></td>
        <td>${res.condition}</td>
        <td><span class="badge badge-synthetic">${res.data_label}</span></td>
        <td>${statusBadge}</td>
        <td>${res.outcome.time_to_completion_ms} ms</td>
        <td>${res.detector_signals.length} signal(s)</td>
        <td>${res.interventions.length} intervention(s)</td>
      `;
      tableBody.appendChild(tr);
    }
  }
});
