# DATA_SCHEMA.md

## Trajectory Event JSONL Schema

Every event stored in `data/trajectories/<experiment>/<task>.jsonl` conforms to:

```json
{
  "event_id": "evt_...",
  "task_id": "task-01-bug-fix",
  "experiment_id": "exp_...",
  "session_id": "ses_...",
  "timestamp": "2026-08-06T22:00:00.000Z",
  "condition": "treatment",
  "event_type": "file_modified",
  "actor": "agent",
  "execution_mode": "synthetic",
  "repository_state": "a1b2c3d4",
  "path": "src/math.js",
  "command": null,
  "payload": { "diff": "+line" },
  "previous_event_hash": "...",
  "event_hash": "..."
}
```

### Hash Chaining Specification

`event_hash` = SHA-256(JSON string of all event fields except `event_hash` itself).
`previous_event_hash` = `event_hash` of event N-1 (null for event 0).
