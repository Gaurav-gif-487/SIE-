# EXPERIMENT_PROTOCOL.md

## Protocol Overview

This document defines the experimental protocol for measuring AI coding agent performance in Agent Mirror.

### 1. Experimental Conditions

- **CONTROL**: Task → Normal Tools → Repository. No Agent Mirror intervention.
- **TREATMENT**: Task → Normal Tools → Agent Mirror Observation → Detector → Intervention → Agent Response → Outcome.

### 2. Randomization & Assignment

Tasks are randomly assigned to control and treatment arms using Fisher-Yates shuffle with a configurable control rate (default 0.5).

### 3. Execution Isolation

Every task executes in an isolated workspace snapshot with pre-and-post automated ground truth test evaluation.

### 4. Data Provenance

All recorded data strictly carries:
- `task_id`
- `session_id`
- `repository_state` (initial & final git commit SHA)
- `execution_mode` (`real` | `synthetic`)
- `data_label` (`REAL` | `SYNTHETIC` | `HUMAN_LABELED` | `SIMULATED`)
- `timestamp`
- `trajectory_path`
