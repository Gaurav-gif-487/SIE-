# results/

Raw JSON output from `npm run bench`, `npm run bench:verification` and the
experiment runner in `src/experiment/`, run across the fixture repos under
`tests/fixtures/` and the pinned third-party corpus.

These files are committed because `docs/benchmark-report.md`,
`docs/verification-report.md` and `docs/experiments/` cite numbers from them.

To regenerate: `npm run bench` / `npm run bench:verification`, or for the
real-repo experiments see the README. Filenames follow
`<fixture>-<mode>-<cold|warm>.json` and `arm-<repo>-<system>-<workload>.json`.
