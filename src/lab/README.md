# Agent Mirror Experimental Intelligence Lab

An executable research and experimentation ecosystem for Agent Mirror.

The lab measures AI coding-agent performance using immutable trajectories, deterministic detectors, intervention policy testing, objective ground truth outcome evaluation, and conservative statistical analysis.

---

## Core Principle

Agent Mirror separates:

`OBSERVATION → DETECTION → EVIDENCE → INTERVENTION → INTELLIGENCE`

- **Never** claim intelligence merely because a detector fires.
- **Never** fabricate experimental results.
- **Never** simulate an agent trajectory and present it as real evidence.
- Every experimental result has full provenance (task ID, session ID, repository state, model/provider, condition, timestamp, trajectory, intervention, test execution, outcome).
- Synthetic fixtures are used strictly for infrastructure testing and are explicitly marked `execution_mode = synthetic` and `data_label = SYNTHETIC`.

---

## Quickstart: Run First End-to-End Experiment

Execute the following commands from the repository root:

### 1. Create an Experiment
```bash
npx tsx src/lab/cli/mirror.ts experiment create --name pilot-001 --tasks 10 --condition randomized
```

### 2. Run the Experiment
```bash
npx tsx src/lab/cli/mirror.ts experiment run --name pilot-001 --tasks 10 --randomized --control-rate 0.5
```

### 3. Check Experiment Status
```bash
npx tsx src/lab/cli/mirror.ts experiment status --experiment pilot-001
```

### 4. Analyze Results
```bash
npx tsx src/lab/cli/mirror.ts experiment analyze --experiment pilot-001
```

### 5. Generate Evidence Report
```bash
npx tsx src/lab/cli/mirror.ts experiment report --experiment pilot-001
```

---

## Trajectory Verification & Replay

Verify trajectory hash chain integrity and replay event sequences:

```bash
# Verify hash chain and event ordering
npx tsx src/lab/cli/mirror.ts trajectory verify data/trajectories/<experiment_id>/<task_id>.jsonl

# Replay event sequence and state transitions
npx tsx src/lab/cli/mirror.ts trajectory replay data/trajectories/<experiment_id>/<task_id>.jsonl
```

---

## Running Lab Unit & E2E Tests

```bash
# Run all lab tests
npx vitest run tests/lab/
```

---

## Minimal UI Explorer

Open `src/lab/ui/index.html` in any web browser to view the experiment pipeline explorer.
