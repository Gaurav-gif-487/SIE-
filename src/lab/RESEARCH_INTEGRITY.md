# RESEARCH_INTEGRITY.md

## Research Integrity Non-Negotiable Rules

1. **Never fabricate trajectories**: All events must originate from observable tool/agent actions.
2. **Never fabricate model outputs**: Agent responses must be recorded verbatim or clearly marked mock.
3. **Never fabricate test results**: Ground truth comes strictly from automated test runners.
4. **Never fabricate statistical significance**: Minimum sample size rules are strictly enforced (n >= 10 per arm). Sample sizes below threshold output `INSUFFICIENT_SAMPLE`.
5. **Never mix synthetic and real datasets**: Mocks are strictly marked `execution_mode = synthetic` and `data_label = SYNTHETIC`.
6. **Never label correlation as causation**: Detectors correlating with failures are NOT automatically promoted.
7. **Never claim intervention effectiveness without control comparison**: Promotion to `EFFECTIVE` requires verified treatment arm outcome lift against control arm.
